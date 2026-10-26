# Auditoría de flujos DxGPT: arquitectura, deuda y calidad diagnóstica

**Alcance.** Revisión estática de `Dx29_server_gpt@main` (`68b5099`) y `Dx29_client_gpt@main` (`fec3889`), contrastada con `dxgpt-bench-lab` (pipeline_v4). No se ha cambiado código.

**Supuestos.** Las latencias son estimaciones y se miden con `scripts/daily-operation-durations.js` (media de `stages[].duration`). El enrutado multimodal V1 está validado y el resumen por documento, descartado.

**Nomenclatura.** **UND** = `undiagnosed-page.component.ts`; **BETA** = `beta-page.component.ts`. No existen `controllers/all/helpDiagnose.js` ni `sonarService.js`: `/diagnose` y `/ask` viven en `services/helpDiagnose.js` (`routes/index.js:34-35`), y Perplexity en `medicalQuestionService.js`.

**Leyenda.** `→` serie · `‖` paralelo · `⇢` sin esperar · `[PSn]` progreso Web PubSub con `await`.

## 1. Mapa real de los flujos

**1.1 Diagnóstico.** (1) **Cliente.** UND `callAI()` (1324) → `/pubsub/negotiate` → WebSocket (865) → `POST /api/diagnose` (1440). (2) **Entrada.** `handleDiagnoseOrAsk` (helpDiagnose.js:1957): validación → `resolveDiagnosticImages`. Si la utilización es ≥ 80 %, `addToQueue` (Service Bus + Ticket en Mongo) y responde `queued`; si no, `registerActiveRequest` y responde `{processing}` (2198). (3) **Preparación** (`processAIRequest`, 117, en segundo plano). [PS20] → `detectLanguageSmart` (local → Azure/gpt-5-nano) → Translator de la descripción (254) → Translator de `diseases_list` (260) → [PS30] → `classifyIntent` con gpt-5.4-mini (331). (4) **Modelo.** **Terra low** vía `callAiWithFailover` (1050; imágenes con `loadImageDataUrls`) → [PS80] → `parseJsonWithFixes`. (5) **Postproceso.** `anonymizeText` (1211) → retro-traducción del texto anonimizado (1244) → `saveQuestion` (1297) → [PS88] → retro-traducción de diagnósticos ‖ (1324) → `inferProfileAndSpecialty` (1379) → blob (1480) → ⇢ costes → [PS95] → `sendResult`. (6) **Respuesta.** UND `processAiSuccess` (1688); con PII, `dataAnonymize` sustituye el texto del usuario (2670). **Solo la retro-traducción es paralela; ~10 llamadas externas van en serie.**

**1.2 Multimodal.** (1) **Cliente.** UND `analyzeMultimodal()` (3658) → negotiate + WebSocket → multipart → `processMultimodalInput` (multimodalInput.js:290): validación → `{processing}` (408). (2) **Extracción.** Documentos **en serie** con Document Intelligence (442) → **después** `processUploadedImages` (516): clasificador Terra ‖2 → OCR con DI si es documental o mixta → blob ‖2. (3) **Resumen.** Si el texto total supera 1000 caracteres (126): `summarize()` → detección → Translator a inglés → gpt-5.4-mini → Translator al idioma. (4) **Diagnóstico.** `callDiagnoses` (865) llama a `diagnose()` con req/res simulados → **flujo 1 completo** (vuelve a detectar y traducir) → `sendPreprocessing` (742). (5) **Respuesta.** UND `applyMultimodalPreprocessing` (3984) sustituye el texto por el resumen.

**1.3 Refinamiento.** **Preguntas.** UND (3053) → `/questions/followup` (followUpService.js:126): detección → Translator de la descripción (222) → Translator de las enfermedades (228) → gpt-5.4-mini (388) → Translator por pregunta ‖ (471). Ojo: `/questions/emergency` (1146) son en realidad las preguntas iniciales de la ruta `enrich`. **Respuestas.** UND (3114) → `/patient/update` (684): detección → Translator de la descripción (779) → Translator de preguntas y respuestas (789-790) → gpt-5.4-mini **reescribe** el caso (≤ 5000 caracteres; 924) → Translator al idioma (996) → UND `callAI()` → **flujo 1**. **Load more.** UND (1984) envía `diseases_list="+A, +B…"` con los nombres **ya traducidos** → flujo 1 con `withDiseases`. **Recalcular.** UND (1247) concatena los síntomas marcados en `/disease/info` tipo 3 → flujo 1.

**1.4 Ask e info de enfermedad.** **Ask.** BETA (308) → negotiate + WebSocket → `/api/ask` → arranque igual a 1.1 (detección → Translator → router). Si el router decide `explain`: `anonymizeText` (423) → `answerMedicalQuestion` (medicalQuestionService.js:841): 3 consultas con gpt-6.1-sol (320) → Perplexity Search (una petición, 20 s; 473) → síntesis con citas con gpt-6.1-sol `medium` (561), con *fallback* a Azure `web_search` (658) → `saveQuestion` (744) → `sendResult`. **Info de enfermedad.** `/disease/info` (callInfoDiseaseService.js:101) es síncrono: prompt por `questionType` (208) → gpt-5.4-mini, o Terra con imágenes (307) → Translator del HTML (432/549).

**1.5 Resumen.** Lo llaman UND `fitDescription` (3227) / `callAIForSummary` (3271) y BETA:560 → `summarize` (summarizeService.js:57): detección (141) → Translator a inglés (194) → gpt-5.4-mini con prompt genérico y sin longitud objetivo (216) → Translator al idioma (326). Síncrono y en serie.

**1.6 Transcripción.** `VoiceDictationService` corta en pausas a los 4,5–5 min (`dictation-segmenter.ts`) y sube cada segmento ‖ mientras se dicta. Tiene 3 reintentos y cancelación por `takeUntil` (voice-dictation.service.ts:257). Servidor: `transcribe` (speechTranscribe.js:101, solo tenants) → gpt-4o-transcribe en una región EU (133) → `{text}` → flujo 1.

## 2. Ineficiencias y deuda técnica (priorizada)

**Prioridad:** **P0** fallo o coste sin control · **P1** alto retorno en latencia o calidad · **P2** fiabilidad · **P3** deuda.

| Id | Flujo | Archivo y líneas | Problema | Solución propuesta |
|---|---|---|---|---|
| P0·1 | 1,2,4 | `pubsubService.js:28-70`; UND:966-973; BETA:616-628 | Los mensajes van a `userId=myuuid` sin id de petición. Si el usuario cancela y relanza, el `result` antiguo se pinta como nuevo y el bueno se pierde, porque el socket se cierra tras el primer `result`. | `requestId` en todos los mensajes; el cliente descarta los ajenos. |
| P0·2 | 1,2,4,5 | UND:1393-1401, 3683; BETA:796; helpDiagnose.js:2198; aiUtils.js:571-611 | Cancelar solo cierra el socket. El servidor sigue gastando (Translator, router, Terra, anonimización, perfil). Ningún `axios` recibe `AbortSignal`. | `POST /api/jobs/:requestId/cancel` (ligado a `myuuid` y tenant) + `AbortController` hasta IA, Translator, Perplexity y DI; `req.on('close')` en endpoints síncronos. |
| P0·3 | 1,4 | queueService.js:385-403; helpDiagnose.js:200 | El mensaje encolado pierde `flow`, `forceDiagnosis` y `countryCode`. En pico, un `/ask` se procesa como diagnóstico. | DTO único para ruta directa y cola. |
| P0·4 | 1 | queueService.js:659-676, 746, 783; helpDiagnose.js:141; UND:3393 | Reintentos anidados: failover × 3 intentos × hasta 3 entregas (las entregas se repiten incluso con errores 400). Cada fallo emite `sendError`, el cliente cierra el socket y pierde el éxito posterior. El Ticket guarda `'Sent via WebPubSub'`, así que el sondeo nunca entrega el resultado. | Un nivel de reintento, *dead-letter*, error solo final, resultado real en el Ticket. |
| P1·5 | 1 | helpDiagnose.js:1211-1260 | La anonimización reescribe todo el texto **tras** Terra y además se retro-traduce: segundos en casos largos. | Ejecutarla ‖ con Terra sobre el original, o devolver solo los fragmentos a anonimizar. |
| P1·6 | 1,4 | helpDiagnose.js:127…1698, 1297, 1379, 1480 | 5 `await sendProgress`, Mongo, perfil (LLM) y blob bloquean el resultado. | `void sendProgress`; perfil ‖; persistir tras `sendResult`. |
| P1·7 | 1,3,4,5 | aiUtils.js:685-720; helpDiagnose.js:254-260, 1324; followUpService.js:222-228, 789 | Una petición a Translator por texto, a menudo en serie. La retro-traducción lanza ~N×(2+síntomas) peticiones (riesgo de 429). La detección va aparte. | `translateMany(texts[])` y `/translate` sin `from`, que autodetecta. |
| P1·8 | 1,4 | helpDiagnose.js:254, 331, 423 | El router espera a la traducción. En `/ask` la traducción solo sirve al router. | Router sobre el original ‖ traducción. En `/ask`, sin traducir y con anonimización ‖ router. |
| P1·9 | 3 | UND:1984, 1247, 3192 | Load more, Recalcular y re-diagnóstico repiten socket, detección, traducción, router, anonimización y perfil. | `skipIntent`; reutilizar `englishDescription`; no re-anonimizar texto sin cambios. |
| P1·10 | 2,5 | multimodalInput.js:442, 516, 631-701; summarizeService.js:194, 326 | Documentos y luego imágenes, en serie. El texto hace inglés → resumen → idioma → inglés en `/diagnose` (3 traducciones). Controladores invocados con req/res simulados. | Documentos ‖ imágenes; `summarizeCase()` y `runDiagnosis({englishDescription})` internos. |
| P1·11 | 3 | followUpService.js:996; UND:3192 | `/patient/update` → cliente → `/diagnose`: viaje extra y el texto hace inglés → idioma → inglés. | `rediagnose:true` en servidor, entrega por PubSub. |
| P2·12 | todos | UND:865-948; BETA:582-614 | Se negocia y abre un WebSocket antes de cada POST (≈ 0,3–0,8 s). | Socket persistente por página. |
| P2·13 | 1,4 | helpDiagnose.js:1119-1196; anonymizeService.js:87-127; callInfoDiseaseService.js:432 | El diagnóstico no usa JSON schema: reparaciones + GPT extra y, si falla, lista vacía con `success`. El anonimizador no tiene `timeout`. El HTML se traduce como texto plano. | `response_format` estricto (requiere pasada de banco); `callAiWithFailover`; `textType=html` o responder en el idioma destino. |
| P3·14 | 6, todos | speechTranscribe.js:71, 133; helpDiagnose.js:117-150, 2187; costes ×4 (540, 864, 1492, 1740); summarizeService.js:146-322 | Transcripción en una sola región y sin `prompt` clínico. ~600 líneas duplicadas o muertas (`isLongModel=true`, `response_mode`, código comentado, `promptsold.js`). | Región EU secundaria y `prompt` médico; `CostLedger`; limpieza. |

## 3. Cómo alcanzar mejores hipótesis diagnósticas

La calidad descansa en una sola llamada validada en el banco: Terra low con `juanjo_classic_v2`, idéntico a `assets/prompts.js`. La señal se pierde **antes y después** de esa llamada, en pasos que el banco no mide.

**Dónde se pierde señal (por impacto).**

1. **Traducciones de ida y vuelta.** El banco valida una sola ida al inglés con Azure Translator: con gpt-4o mejoró la posición media, aunque bajó el porcentaje de éxito (`experiment-log.md`). En producción, en cambio, el texto va y vuelve: en multimodal, en cada `patient/update` y cuando hay PII. En ese último caso el cliente sustituye el texto del usuario por la versión inglés → idioma (helpDiagnose.js:1244 → UND:2670), y a partir de ahí todo trabaja sobre un texto degradado en negaciones, abreviaturas y unidades. *Regla:* nada retro-traducido debe volver a entrar en el pipeline.
2. **Resumen precoz y genérico.** Multimodal resume a partir de 1000 caracteres, aunque `/diagnose` admite 8000. El prompt (summarizeService.js:216) no obliga a conservar analíticas con unidades, imagen, fármacos, antecedentes familiares, negativos ni fechas, y mezcla el relato del usuario con los documentos. El banco ya midió un −26–31 % al resumir casos (`summarization_feat`).
3. **Prompt poco especificado.** La "N" nunca se sustituye. En el run del banco de Terra low sobre `all_256_clean` salen **3,6 hipótesis de media, y una sola en el 10 % de los casos**, así que las "5 iniciales" no están garantizadas. Además, `average_position` promedia solo los aciertos (`evaluator.py:731-746`), lo que premia las listas cortas. El prompt no pide ordenar por probabilidad, ni usar edad, sexo o cronología, ni manejar negaciones. `symptoms_not_in_common` omite los hallazgos esperados ausentes, y no hay "no te lo pierdas".
4. **Refinamiento que reescribe.** Cada ronda reescribe el caso entero (con deriva) y lo limita a 5000 caracteres (followUpService.js:17). El modo `general` no tiene la regla de negativos del modo `hypothesis` (862). "Recalcular" solo añade lo marcado (UND:2167), y tras "ninguna encaja" el re-diagnóstico ignora las hipótesis rechazadas.
5. **Load more frágil.** La exclusión viaja traducida y se vuelve a traducir (UND:1972 → helpDiagnose.js:260), así que variantes como ELA/ALS reintroducen duplicados. Las posiciones 6–10 no se evalúan.

**Pasos que sobran o se fusionan.** La traducción en `/ask`. El router en las re-ejecuciones. La retro-traducción del texto anonimizado. La detección separada de la traducción. El resumen + re-traducción en multimodal. La reescritura completa en `patient/update`.

**Procesos nuevos.** (1) **Estructuración clínica previa** para entradas largas (documentos, dictado), en vez del resumen libre: un JSON barato con demografía, cronología, positivos, **negativos pertinentes**, fármacos, analíticas con unidades, antecedentes y exposiciones. Guía las preguntas y permite anexar respuestas sin reescribir. (2) **Negativos de extremo a extremo.** "Hallazgos esperados ausentes" en el prompt, sí / no / no sé en preguntas y en "Recalcular", y regla de negativos en ambos modos. (3) **Verificación tras el diferencial** (§4), con comprobaciones o información nueva. Más razonamiento en la generación no mejora en conjunto: medium empeora (1,516 frente a 1,382), y xhigh solo gana en R@1 (76,2 %) a costa de cobertura y R@3 (`reasoning-effort-and-model-size-investigation-2026-07.md`). Conviene separar la generación amplia (low) del re-ranking. (4) **Señal de insuficiencia.** Con pocas hipótesis o huecos críticos, preguntar antes de mostrar una lista pobre. (5) **Evaluar el pipeline, no solo el prompt.** Pasar el banco a través del servidor (*Docker eval*, rateLimiter.js:137) con traducción, resumen, PII y follow-up con paciente simulado. Medir R@1/3/5 con N fijo, además de `avg_pos`.

## 4. Capa agéntica después del diferencial

**Dónde se engancha.** En `processAIRequestInternal`, tras validar `parsedResponse` (helpDiagnose.js:≈1122-1150) y antes de anonimizar (1211). Trabaja en inglés sobre `englishDescription` y `parsedResponseEnglish`, y reutiliza `callAiWithFailover` y la búsqueda de `medicalQuestionService`.

| Modalidad | Funcionamiento | Valoración |
|---|---|---|
| (A) Síncrona | El resultado espera al agente | Suma toda su latencia: descartada |
| (B) Progresiva | `sendResult` inicial y luego un mensaje `refinement` con el mismo `requestId` | Exige no cerrar el socket tras `result` (UND:969-970) |
| (C) Bajo demanda | Botón "Análisis profundo", como `/disease/info` | La de menor coste |

**Qué haría.** (1) Verificación en lote de cada hipótesis: a favor, en contra, hallazgos esperados ausentes y coherencia con edad, sexo y curso (patrón de `/disease/info` tipo 4, callInfoDiseaseService.js:228-243). (2) "No te lo pierdas": diagnósticos graves o tratables compatibles que falten. (3) Solo en casos raros o multisistémicos: mapeo a HPO + Orphanet/OMIM/GeneReviews mediante la búsqueda existente. (4) Re-ranking trazable, con 3–5 preguntas o pruebas discriminantes para el follow-up `hypothesis`.

**Valor frente a coste.** En texto narrativo queda poco margen: Terra low ya tiene un 98,1 % de éxito y avg_pos 1,382. Hay dos huecos medibles. En enfermedades raras, en MyGene2 la mejor configuración del banco (gemini-3-pro) logra un 61 % de R@1 y gpt-5.4-mini un 38 %, frente al 74 % de DeepRare (*Nature* 2025), que se apoya en herramientas fenotípicas. En ordenación, Terra xhigh concentra más aciertos en P1 pero pierde cobertura: re-ordenar con más razonamiento la lista amplia de low podría sumar ambos efectos. **Coste estimado:** el verificador añade ≈ 1 llamada a Terra (+5–8 s, ≈ +100 % del coste de esa etapa); el re-ranker con herramientas, +15–40 s y entre 2× y 4× el coste. En pico, ambos duplican la ocupación de Terra y adelantan la cola. Con (B) o (C), el tiempo hasta el primer resultado no cambia.

**Recomendación: PoC *offline* ahora; aparcar la versión síncrona o siempre activa.** 2–3 semanas en `dxgpt-bench-lab` con dos brazos: (i) verificador que re-ordena la lista de low con más razonamiento y añade "no te lo pierdas" (1 llamada); (ii) re-ranker con herramientas solo en enfermedades raras. **Criterios para pasar a producción:** (i) mejora el R@1 en `all_256_clean` con N fijo sin perder R@5; (ii) gana ≥ 5 pp de R@1 en RAMEDIS, MyGene2, LIRICAL y HMS, perdiendo ≤ 1 pp en `all_256_clean`; no aumentan los hallazgos no soportados (juez LLM); el p95 añadido es ≤ 20 s en (B); el coste es ≤ 2× el de la etapa de diagnóstico.

**Requisitos previos:** P0·1, P0·2 y E1. Si pasa, primero (C) y luego (B), solo en enfermedades raras.

## 5. Hoja de ruta

**(a) Dejar como está.** Enrutado multimodal V1 y clasificador con JSON schema. Patrón "`processing` + Web PubSub", que evita el corte de ~45 s de SWA (solo falta el `requestId`). Router de intención único con *fail-open*. Terra `low` y prompt alineado con el banco. Traducción previa al inglés y retro-traducción en paralelo. Ask con Perplexity, citas verificadas y *fallback* a `web_search`. Dictado segmentado con subida en paralelo, reintentos y cancelación. Detector local de idioma. Imágenes por referencia con caducidad de 24 h. Failover multirregión con `Retry-After`. Reglas anti-deriva de `patient/update`.

**(b) Quick wins (< 2 días cada uno).**

| # | Mejora | Ítems | Esfuerzo |
|---|---|---|---|
| 1 | `requestId` en PubSub | P0·1 | ½ día |
| 2 | Cancelación de extremo a extremo | P0·2 | 1–2 días |
| 3 | Cola: DTO único, un nivel de reintento y *dead-letter* | P0·3-4 | 1 día |
| 4 | Camino crítico de `/diagnose`: anonimización ‖ Terra, perfil ‖, persistencias y progreso sin `await` (≈ 1–3 s menos por diagnóstico) | P1·5-6 | 1 día |
| 5 | Translator por lotes con autodetección; el router no espera a la traducción | P1·7-8 | 1 día |
| 6 | Re-ejecuciones sin router, con `englishDescription` y `diagnosisEn` para excluir por nombre en inglés | P1·9 | 1 día |
| 7 | Multimodal: documentos ‖ imágenes y resumen en inglés directo al diagnóstico | P1·10 | 1–1,5 días |
| 8 | Anonimizador con `timeout` (vía `callAiWithFailover`) y `textType=html` en `/disease/info` | P2·13 | 2 h |

**Calidad** (cada cambio, validado con una pasada corta de banco o E2E): regla de negativos en `patient/update` modo `general`; umbral de resumen multimodal en ~6000–7000 caracteres, con el texto del usuario literal; prompt de resumen con campos obligatorios y longitud objetivo; respuestas sí / no / no sé en las preguntas y en "Recalcular".

**Medición:** línea base y seguimiento por etapa con `daily-operation-durations.js`.

**(c) Experimentos (banco antes que producción).**

| Id | Experimento | Métrica |
|---|---|---|
| E1 | Prompt v3: N fijo (5) por probabilidad, negativos, hallazgos esperados ausentes, "no te lo pierdas" y JSON schema | R@1/3/5 con N fijo en `all_256_clean`, HPO y MedReaMM |
| E2 | 10 hipótesis en una llamada frente a 5 + Load more | R@10, latencia y coste |
| E3 | Estructuración clínica frente a texto íntegro y frente al resumen actual | R@k y omisiones (juez LLM) |
| E4 | Azure Translator frente a LLM con glosario y frente a original + "razona y responde en inglés" con Terra | R@k en casos no ingleses |
| E5 | `patient/update`: reescritura frente a anexado estructurado, con paciente simulado | Omisiones, invenciones y R@k |
| E6 | Re-diagnóstico tras "ninguna encaja", con las hipótesis previas como contexto | R@k tras el follow-up |
| E7 | Capa agéntica (§4) | Criterios de §4 |
| E8 | Banco E2E a través del servidor como puerta de calidad del pipeline | Regresión de R@k y latencia por etapa |
| E9 | Cambio de proveedor: gemini-3.5-flash low (1,284; 6,1 s) frente a Terra low (1,382; 6,9 s) con N fijo | R@1/3/5, latencia y coste |
