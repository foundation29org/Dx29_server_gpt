# Roadmap multimodal de DxGPT

Estado: en ejecución  
Ámbito: `DxGPT/Server`, `DxGPT/Client` y OpenAPI/APIM

## Objetivo

Mejorar la fiabilidad, seguridad y UX de la carga de documentos e imágenes sin modificar el flujo clínico que ya ha sido validado.

## Arquitectura que se mantiene

El flujo actual tiene dos ramas:

```text
Texto + documentos
  → extracción de texto
  → concatenación
  → resumen si supera 1.000 caracteres
  → description
                                      ┐
Imágenes                              ├→ Terra → diagnóstico
  → Blob → image_url original         ┘
```

Decisiones:

- Las imágenes originales seguirán llegando directamente a Terra.
- No se aplicará OCR obligatorio a todas las imágenes.
- Se mantiene por ahora el umbral actual de resumen de 1.000 caracteres.
- No se introducirá resumen por documento sin una evaluación específica.
- El benchmark MedReaMM seguirá siendo la prueba de regresión multimodal.

MedReaMM validó imágenes médicas reales junto con texto, pero no fotografías de informes, manuscritos o PDFs escaneados. Esos casos requieren un benchmark documental separado.

## Comportamiento actual de las imágenes

`/medical/analyze` solo se llama para un caso nuevo, y siempre parte de cero. Cada llamada crea un `uploadId` aleatorio; las imágenes se guardan en `tenants/<tenant>/files/uploads/<myuuid>/<uploadId>/NN.ext` con su ruta (`vision` u `ocr_text`) en metadatos del blob. El cliente guarda solo el `uploadId` y lo reenvía en:

- editar la descripción y recalcular;
- cargar más diagnósticos;
- responder preguntas y volver a diagnosticar;
- consultar información de una enfermedad.

El servidor lista el prefijo del usuario, filtra las imágenes con ruta `vision`, descarga los bytes y los envía al modelo como `data:` URL justo antes de la llamada. No hay SAS en ningún punto: ni en la respuesta, ni en el prompt, ni en logs.

Borrado en dos capas. El cliente llama a `DELETE /medical/upload/:uploadId` (con `myuuid` en el body) en cuanto la subida deja de referenciarse: nuevo paciente, cambio de ficheros o nuevo análisis. Si esa llamada no llega (pestaña cerrada, error de red), `billing-fn/blobCleanup` borra el blob a las 24 h; pasado ese plazo `/diagnose` responde 400 `INVALID_UPLOAD_REFERENCE` y el cliente pide volver a analizar. El DELETE es idempotente y solo alcanza el prefijo tenant + `myuuid` + `uploadId`, así que un `uploadId` filtrado no basta para borrar nada ajeno.

Solo persisten las imágenes con ruta `vision`, porque `/diagnose` las necesita en llamadas posteriores. Los documentos (PDF, DOCX, XLSX, TXT) y las imágenes documentales (`ocr_text`) se extraen desde el buffer en memoria y se descartan: su texto ya está en la descripción y nadie los vuelve a leer. Si todas las imágenes son documentales, `uploadId` es `null` y no se escribe nada en blob.

Tras el análisis el conjunto de ficheros queda congelado: añadir o quitar uno en el cliente invalida el `uploadId` y obliga a un análisis completo nuevo. No hay reanálisis incremental ni reutilización de imágenes entre análisis.

Problemas que resolvía el diseño anterior y que ya no existen:

- Desajuste SAS 1 h vs blob 24 h.
- URLs SAS en cliente, prompt o logs.
- El servidor aceptaba URLs de imágenes aportadas por el cliente.
- Registro en Cosmos (`MultimodalAsset`) con reintentos y fallo de persistencia de la ruta.

## Orden de trabajo

## 1. Robustez y seguridad inmediatas

Prioridad: crítica

- [x] Promisificar Multer para capturar los errores del callback asíncrono.
- [x] Validar multipart después de su parseo: `myuuid`, idioma, zona horaria y presencia de contenido.
- [x] Aplicar en backend un límite acumulado de 20 MB durante la lectura, además de límites por fichero y cantidad.
- [x] Validar firma real del fichero, no solo MIME o extensión, y detectar TXT binario.
- [x] Evitar registrar URLs SAS completas.
- [x] Proteger el acceso a `summaryResult.data.summary` cuando el resumen falle o sea inválido.
- [x] Garantizar una única respuesta HTTP final y no responder `processing` si Diagnose rechaza la petición.
- [x] Añadir pruebas unitarias de errores y del envío directo de imágenes a Terra.
- [ ] Ejecutar el benchmark multimodal de inferencia contra un despliegue con estos cambios.

Comprobaciones realizadas:

- 27 pruebas unitarias/integración del servidor superadas.
- `dry-run` válido para los 25 casos del piloto MedReaMM.
- Las 68 imágenes del piloto superan la nueva validación de firma.
- La inferencia completa queda pendiente: no existe `bench/multimodal_beta/config.yaml` ni un servidor local configurado con estos cambios.

Criterio de aceptación: el pipeline actual produce los mismos inputs para Terra, pero sin promesas rechazadas, respuestas colgadas o límites dependientes solo del cliente.

Comportamiento actual ante varios ficheros:

- Multer valida el multipart completo: si un fichero incumple tipo, tamaño individual o cantidad, se rechaza toda la petición con HTTP 400.
- Los documentos se extraen con concurrencia 2 y éxito parcial (fase 3).
- Si falla la subida de una imagen, se aborta toda la petición.

## 2. `uploadId` y reutilización segura

Prioridad: crítica

- [x] Sustituir `imageUrls` y `assetId` por un único `uploadId` por análisis.
- [x] Aislar cada subida por prefijo de blob: tenant/suscripción autenticados + `myuuid` + `uploadId` aleatorio.
- [x] Eliminar las SAS: el servidor descarga el blob y envía `data:` URL al modelo y `base64Source` a Document Intelligence.
- [x] Rechazar `assetIds`, `imageUrls` y `uploadId` ajenos (prefijo de otro usuario = subida vacía = 400).
- [x] Guardar solo las imágenes `vision`, con su ruta y clasificación en metadatos del blob, en la misma escritura que la imagen. Las `ocr_text` no se persisten.
- [x] Congelar los ficheros tras el análisis: cualquier cambio invalida el `uploadId` y exige un análisis nuevo.
- [x] Si la subida ya no existe (24 h o ID inválido), pedir que se vuelva a analizar.
- [x] Borrado activo: `DELETE /medical/upload/:uploadId` desde el cliente al descartar la subida; blobCleanup queda como red de seguridad.
- [x] Retirar miniaturas, `MultimodalAsset` en Cosmos y la lógica de reanálisis incremental.

Qué hace ahora, en claro:

- **uploadId**: UUID aleatorio creado en cada `/medical/analyze`. Se devuelve en la respuesta junto con `images[]` (`uploadId`, `index`, `name`, `size`, `mimeType`, `routing`, `diagnosticUse`; sin URL). El cliente lo reenvía en `/diagnose` y `/disease/info`.
- **Propiedad**: el prefijo del blob se construye con el tenant/suscripción de la cabecera autenticada y el `myuuid` del cuerpo. Un `uploadId` de otro usuario lista un prefijo vacío y se rechaza con 400 `INVALID_UPLOAD_REFERENCE`. `/medical/analyze` no acepta `uploadId` de entrada.
- **Ruta**: cada imagen se clasifica y, si procede, pasa por OCR desde el buffer en memoria; después se sube con metadatos `routing`, `classification`, `confidence`, `hasdocumenttext`, `hasmedicalvisual`. `/diagnose` filtra `routing=vision` en servidor; el cliente no puede forzar una imagen documental hacia el modelo.
- **Coste**: base64 no cambia el coste de entrada del modelo (los tokens de imagen dependen de los píxeles, no de los bytes del payload). El único coste añadido es la transferencia blob → servidor en cada llamada, dentro de la misma región.
- **Expiración**: el cliente borra la subida con `DELETE /medical/upload/:uploadId` al descartarla; lo que se escape lo borra `billing-fn/blobCleanup` a las 24 h. No hay TTL de SAS que sincronizar.
- **assetIds / imageUrls**: si llegan con contenido, 400 con `reason: No longer supported`.

Criterio de aceptación: editar, cargar más o completar preguntas reutiliza las imágenes del análisis en curso durante 24 h, sin URLs firmadas, sin base de datos y sin aceptar referencias arbitrarias.

## 3. Extracción documental resistente

Prioridad: alta

- [x] Extraer la lógica de Document Intelligence a un servicio reutilizable.
- [x] Mantener TXT como lectura directa.
- [x] Añadir reintentos para timeouts, 408, 429 y errores 5xx.
- [x] Respetar `Retry-After` y usar backoff con jitter.
- [x] No reintentar archivos corruptos o formatos inválidos.
- [x] Procesar varios documentos con concurrencia limitada (2).
- [x] Usar éxito parcial: un documento defectuoso no invalida los demás.
- [x] Devolver por fichero estado, páginas, duración, método, avisos y error.
- [x] Corregir el nombre de operación a `multimodal_extract_document`.

Qué hace ahora:

- TXT se lee en el servidor. PDF/Word/Excel van a Document Intelligence.
- Un PDF ilegible no tumba la petición si hay texto, imágenes u otro documento válido.
- Si fallan todos los documentos y no hay nada más, HTTP 400.
- Durante el procesamiento y en resultados aparece un aviso con los nombres que no se pudieron leer.
- Reintentos: 3 intentos, `Retry-After` si viene, si no espera creciente. Un PDF corrupto no se reintenta.

Criterio de aceptación: los documentos válidos continúan hasta Terra aunque otro documento de la misma petición falle.

## 4. Benchmark documental

Prioridad: alta, antes de modificar resumen u OCR

Preparar casos sintéticos sin PII:

- [x] PDF nativo.
- [x] PDF escaneado.
- [x] Fotografía de informe.
- [x] Texto manuscrito simulado.
- [x] Varios informes con fechas diferentes.
- [x] Valores, unidades y negaciones.
- [x] Informes con datos contradictorios.
- [x] Informe con gráfica o imagen clínica.
- [x] Controles de imágenes médicas reales procedentes de MedReaMM.
- [x] Evaluador de clasificación, seguridad de ruta y conservación de hechos.
- [x] Ejecutar el clasificador visual y la inferencia end-to-end.
- [ ] Revisión clínica de los diez casos y sus hechos esperados.

Implementación:

- `eval/bench/document_image_beta/` genera 10 casos sintéticos, 50 entradas
  end-to-end y 45 imágenes para clasificación.
- [x] V1 implementada y activa con la misma configuración en todos los
  entornos: Terra, confianza 0,90, concurrencia 2 y OCR mínimo de 20 caracteres.
- Un clasificador Terra de baja inferencia distingue `document_only`,
  `contains_medical_visual` y `unknown`.
- Solo `document_only` coherente y con confianza >= 0,90 usa Document
  Intelligence y deja de enviarse a la llamada diagnóstica de visión.
- `contains_medical_visual` con texto documental sustancial y confianza >= 0,90
  usa Document Intelligence, pero también conserva la imagen para Terra.
- Imagen médica pura, `unknown`, fallo de clasificación, OCR fallido, OCR
  demasiado corto y formatos que Document Intelligence no acepta (WEBP)
  conservan Terra directo sin añadir texto OCR.
- Solo la imagen con ruta `vision` permanece como blob dentro del prefijo del
  `uploadId` durante 24 h. La imagen documental (`ocr_text`) se descarta tras
  el OCR y su texto clínico no se persiste en ningún sitio.
- Los metadatos del blob guardan solo la decisión de ruta y su instantánea de
  clasificación (`routing`, `classification`, `confidence`, `hasdocumenttext`,
  `hasmedicalvisual`), nunca texto clínico. `/diagnose` y consultas posteriores
  vuelven a filtrar por `routing` en servidor.
- No hay reanálisis incremental: cada `/medical/analyze` clasifica y extrae
  todas sus imágenes de nuevo y crea un `uploadId` distinto.
- Texto del usuario, documentos e imágenes documentales convertidas a texto se
  concatenan y se resumen juntos si superan 1.000 caracteres.
- Una imagen mixta (texto + visual médico) conserva la imagen original y añade
  el OCR al prompt; si el OCR falla o es insuficiente, continúa solo con visión.
- La comprobación de intención y `missing_patient_data` sigue en `diagnose`:
  si el texto/OCR no contiene un caso clínico suficiente, el usuario conserva
  el mensaje para decidir cómo continuar.
- El benchmark exige cero imágenes médicas puras enviadas a OCR y ninguna
  imagen mixta enviada a OCR sin conservar su visual.
- Resultado piloto anterior a la ruta híbrida: ruta correcta 45/45; 0/10
  imágenes médicas puras enviadas a OCR.
- Preauditoría posterior: 11/12 etiquetas MedReaMM confirmadas y
  `N-10000022` corregida de médica pura a mixta por su pie clínico sustancial.
  Terra y GPT-5.4-mini eligieron `OCR + imagen` en la repetición dirigida. El
  gold vigente contiene 23 documentales, 9 médicas puras y 13 mixtas; falta la
  firma independiente del biomédico.
- Comparación V1 GPT-5.4-mini: coste 56% menor, pero una imagen mixta fue
  enviada incorrectamente a OCR aislado (ruta 44/45) y su latencia media fue
  mayor (2,33 s frente a 1,98 s); Terra obtuvo 45/45 y se mantiene en V1.
- Baseline anterior a V1: PDF nativo 100% y escaneado 97,5% de hechos;
  escaneo PNG y manuscrito directos, 10%; fotografía directa, 37,5%.
- Baseline strict: PDF nativo y escaneado, cobertura 10/10 cada uno;
  escaneo y manuscrito directos, 1/10; fotografía directa, 5/10.
- [x] V1 end-to-end sobre las mismas 50 entradas: ruta 30/30; OCR correcto
  21/21 en imágenes documentales puras; visión 9/9 en imágenes mixtas.
- Las imágenes documentales puras alcanzan 100% de hechos, cobertura strict
  21/21 y R@1 15/21.
- Las mixtas con visión directa solo alcanzan 22,2% de hechos y cobertura/R@1
  2/9. Esta ruta es segura, pero insuficiente.
- Strict global mejora de cobertura/R@1 54%/44% a 86%/68%. El coste por caso
  cubierto se mantiene en ~0,0192 USD; la latencia media del documento-imagen
  diagnosticado sube de 15,38 s a 25,34 s.
- Informe: `eval/bench/document_image_beta/RESULTS.md`.

Comparaciones completadas:

- Terra con imagen directa;
- OCR;
- OCR + imagen original en nueve imágenes mixtas: hechos, cobertura y R@1
  pasan de 2/9 a 9/9; no se observó interferencia en esta muestra;
- V1 OCR sin imagen para documento puro;
- concatenación + resumen actual;

Pendiente:

- [x] implementar la ruta híbrida mixta y sus fallbacks en el servidor, con
  pruebas unitarias y de integración;
- [x] repetir las nueve regresiones mixtas contra el flujo real: OCR + visión,
  hechos y cobertura 9/9; strict repetido 9/9; coste medio 0,02676 USD y
  latencia media 28,18 s. El primer juez dio 8/9 y el segundo aceptó la misma
  equivalencia, por lo que se conserva la advertencia de inestabilidad;
- síntesis por documento, únicamente si esa comparación demuestra pérdidas.

Medir:

- conservación de fechas, valores, unidades y negaciones;
- exactitud diagnóstica;
- alucinaciones;
- latencia;
- coste.

Regla V1: una foto de informe exclusivamente documental y clasificada con alta
confianza usa OCR sin imagen en la llamada diagnóstica. Una imagen mixta usa
OCR + imagen original. Una imagen médica pura, duda o fallo usa visión directa.
El blob original no se borra.

## 5. Mejoras condicionadas por evidencia

### Resumen por documento

Solo se implementará si el benchmark demuestra pérdidas clínicas al concatenar y resumir varios documentos.

En ese caso deberá preservar:

- fuente y fecha;
- diagnósticos frente a hipótesis;
- negaciones;
- valores y unidades;
- medicación y dosis;
- incertidumbre y contradicciones.

### Gotenberg

Solo se añadirá si la telemetría muestra fallos DOC/DOCX recurrentes.

- Será fallback, nunca ruta principal.
- Debe ejecutarse en infraestructura privada.
- Tendrá feature flag, timeout y límite de tamaño.
- Convertirá DOC/DOCX a PDF y reintentará Document Intelligence.

### Procesamiento durable

Service Bus, `jobId` y cancelación real se implementarán únicamente si p95 o los timeouts de APIM muestran que `/medical/analyze` no puede mantenerse en el flujo actual.

## 6. Formatos adicionales

Prioridad: posterior a la robustez documental

### TXT

Ya soportado. Falta validar encoding, BOM y archivos binarios disfrazados.

### Markdown

- Aceptar `.md`, `.markdown` y `text/markdown`.
- Procesar como texto, sin Document Intelligence.
- Sanear HTML o scripts embebidos.

### FHIR JSON

Se tratará como funcionalidad separada, no como OCR.

- Aceptar `application/fhir+json`.
- Validar `resourceType`.
- Empezar por `Bundle`, `Condition`, `Observation`, `DiagnosticReport`, medicación, procedimientos y alergias.
- Preservar códigos, estados, fechas, valores y unidades.
- No enviar JSON bruto al prompt.

FHIR XML, DICOM, ZIP y HL7 v2 quedan fuera de la primera iteración.

## 7. UX y observabilidad

- [x] Estado por fichero en los chips: pendiente, procesando, completado, aviso
  o error. Documentos fallidos e imágenes con fallback quedan diferenciados.
- [x] Reintento selectivo de ficheros fallidos: se deja el aviso actual y el
  diagnóstico continúa con el resto. Reprocesar solo el fallido exigiría
  fusionar su texto con un resumen que el usuario ya puede haber editado.
- [x] Mostrar éxito parcial y conservar el aviso durante la revisión del
  resultado.
- [x] Mostrar qué imágenes siguen asociadas (solo nombre y ruta, sin
  miniaturas). Añadir o quitar un fichero tras el análisis invalida el
  `uploadId`: no hay botón Re-analyze ni edición parcial del conjunto.
- [x] Alinear el límite de 20 MB. Cliente, servidor y contratos publicados
  aplican 20 MB combinados a todos los ficheros de cada petición, con 5
  documentos, 5 imágenes y los mismos MIME.
- [x] Registrar por operación duración, bytes, documentos correctos/fallidos,
  reintentos, rutas de imagen y fallbacks, además del coste existente.
- [ ] Configurar en Application Insights, fuera del código, un workbook y
  alertas sobre `MultimodalAnalysisCompleted`, `MultimodalAnalysisFailed` y
  `MultimodalInputRejected`. Vistas: volumen, p50/p95 de `durationMs`,
  porcentaje de documentos fallidos, rutas de imagen y fallbacks. Alertas:
  más del 5 % de análisis fallidos en 15 minutos, excluyendo rechazos de
  validación; más del 10 % de documentos fallidos en 15 minutos; p95 por
  encima de 45 segundos; aumento de `ocr_failed`. Incluir `correlationId` y
  ningún texto clínico, nombre de fichero, URL ni SAS.
- [x] Generar o propagar `X-Correlation-Id` hasta Diagnose, devolverlo al
  cliente y añadirlo a eventos y errores. No se incluyen texto clínico,
  nombres de fichero, URLs ni SAS en la nueva telemetría; también se retiró el
  log de la respuesta multimodal del navegador.

## Secuencia acordada

1. Robustez y seguridad inmediatas.
2. `uploadId` por análisis, sin SAS.
3. Reintentos y éxito parcial documental.
4. Benchmark documental.
5. V1 de enrutamiento y OCR documental activa.
6. Resumen por documento o Gotenberg solo si los datos lo justifican.
7. Markdown y FHIR.
8. Arquitectura durable únicamente si las métricas muestran necesidad.

## Siguiente tarea

Obtener la firma independiente del biomédico sobre la preauditoría de
etiquetas, diez casos y 41 hechos; resolver sus desacuerdos y ampliar los
controles médicos difíciles antes del despliegue de producción.

En paralelo, crear en Azure el workbook y las alertas descritos en la sección
7. El contrato público queda en las exportaciones de API Management; el
reintento selectivo de un fichero queda descartado por ahora.
