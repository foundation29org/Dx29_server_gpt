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

El cliente conserva `currentImageUrls` y vuelve a incluirlas en `/diagnose`. Por ello las imágenes se reutilizan al:

- editar la descripción;
- cargar más diagnósticos;
- responder preguntas y volver a diagnosticar;
- consultar información de una enfermedad.

Problemas:

- Los blobs se eliminan mediante un proceso externo a las 24 horas, pero las SAS actuales caducan en 1 hora.
- El cliente conserva URLs SAS en vez de referencias seguras.
- Eliminar un fichero seleccionado no siempre elimina su imagen del contexto.
- Añadir ficheros y reanalizar puede volver a subir los anteriores.
- El servidor acepta URLs de imágenes aportadas por el cliente.
- Algunas URLs SAS completas se escriben en logs.

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

## 2. `assetId` y reutilización segura

Prioridad: crítica

- [x] Sustituir progresivamente `imageUrls` por referencias `assetId`.
- [x] Asociar cada recurso con tenant/suscripción, `myuuid` y expiración.
- [x] Generar una SAS nueva en el servidor antes de cada llamada a Terra.
- [x] Rechazar recursos pertenecientes a otro tenant y URLs externas.
- [x] Aceptar `imageUrls` antiguas solo si apuntan al Blob de este tenant (clientes o APIs que aún no envían `assetId`).
- [x] Diferenciar recursos ya subidos de nuevos ficheros locales.
- [x] No volver a subir imágenes existentes.
- [x] Eliminar inmediatamente del contexto una imagen retirada por el usuario.
- [x] Mostrar en la interfaz qué imágenes se usarán en la siguiente llamada.
- [x] Si el recurso ya no existe (24 h o ID inválido), pedir que se vuelva a subir.

Qué hace ahora, en claro:

- **assetId**: el cliente guarda un ID. El servidor comprueba que es del mismo usuario/tenant y genera una SAS nueva para Terra. Eso cubre el desajuste SAS 1 h vs blob 24 h.
- **imageUrls propias**: solo para clientes o APIs antiguas que aún no envían `assetId`. Se aceptan si la URL es de nuestro Blob y del mismo tenant. El cliente nuevo manda `assetId`; si Cosmos no registró el ID, manda la URL propia como respaldo.
- **filesAnalyzed**: el HTML ya tenía Search / Re-analyze, pero el flag nunca se activaba. Tras un análisis correcto, Search usa el texto extraído + `assetId` (sin volver a pagar OCR). Re-analyze vuelve a extraer documentos. Las imágenes con `assetId` no se resuben.
- Miniatura: SAS de 24 h (`blobCleanup`). Diagnóstico: SAS corta (`BLOB_READ_SAS_MINUTES`, por defecto 60).
- Cosmos: si falla el registro, el primer diagnóstico sigue. El recálculo usa la URL propia o pide volver a subir si ya no vale.
- Prueba de caducidad: `BLOB_READ_SAS_MINUTES=1`, esperar 2 minutos, recálcular. No hace falta esperar 70 minutos. Las pruebas unitarias firman una SAS de 1 minuto y leen el `se` del token.

Criterio de aceptación: editar, cargar más o completar preguntas reutiliza las imágenes seleccionadas incluso después de una hora, sin aceptar URLs arbitrarias.

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

- PDF nativo;
- PDF escaneado;
- fotografía de informe;
- texto manuscrito;
- varios informes con fechas diferentes;
- valores, unidades y negaciones;
- informes con datos contradictorios;
- informe con gráfica o imagen clínica.

Comparar:

- Terra con imagen directa;
- OCR;
- OCR + imagen original;
- concatenación + resumen actual;
- síntesis por documento.

Medir:

- conservación de fechas, valores, unidades y negaciones;
- exactitud diagnóstica;
- alucinaciones;
- latencia;
- coste.

Regla: no sustituir la imagen original por OCR. Si el benchmark demuestra ventaja, una foto de informe podrá usar OCR + imagen; una imagen médica seguirá usando visión directa.

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

- Estado por fichero: pendiente, extrayendo, completado, aviso o error.
- Reintentar únicamente los fallidos.
- Mostrar éxito parcial.
- Mostrar qué imágenes siguen asociadas.
- Separar “añadir nuevos ficheros” de “volver a procesar todo”.
- Alinear límites entre cliente, servidor y OpenAPI.
- Medir latencia, coste, reintentos, fallos por formato y uso de fallbacks.
- Usar un correlation ID sin registrar contenido clínico ni tokens SAS.

## Secuencia acordada

1. Robustez y seguridad inmediatas.
2. `assetId` y renovación SAS.
3. Reintentos y éxito parcial documental.
4. Benchmark documental.
5. Solo después: OCR híbrido, resumen por documento o Gotenberg si los datos lo justifican.
6. Markdown y FHIR.
7. Arquitectura durable únicamente si las métricas muestran necesidad.

## Siguiente tarea

Benchmark documental (fase 4): casos sintéticos sin PII antes de cambiar resumen u OCR.
