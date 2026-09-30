# Roadmap multimodal — pendiente

Ámbito: `DxGPT/Server`, `DxGPT/Client` y Application Insights.

Cerrado y fuera de este archivo: robustez del multipart, `uploadId` sin SAS, extracción documental con éxito parcial, benchmark documental, ruta V1 (documental → OCR, médica → visión, mixta → OCR + imagen) y la UX por fichero. La revisión clínica la firmó David el 30/09/2026 (`APROBAR`).

## Ahora

- [ ] Workbook y alertas de Application Insights, fuera del código. Spec: `eval/docs/app_insights_multimodal_alerts.md`. No tocar las reglas `errors dxgpt` ni `Failure Anomalies - insightsdxgpt`.

## Formatos

- [ ] TXT: encoding y BOM. La firma del fichero y el TXT binario ya se validan.
- [ ] Markdown: `.md`, `.markdown` y `text/markdown`, como texto y sin Document Intelligence. Sanear HTML o scripts embebidos.
- [ ] FHIR JSON, como función aparte y no como OCR: `application/fhir+json`, validar `resourceType`, empezar por `Bundle`, `Condition`, `Observation`, `DiagnosticReport`, medicación, procedimientos y alergias, y no enviar el JSON bruto al prompt.

FHIR XML, DICOM, ZIP y HL7 v2 siguen fuera.

## Solo si aparece evidencia

- Resumen por documento: la comparación no mostró pérdidas (mixtas 9/9 con OCR + imagen). No implementarlo.
- `.doc`: Gotenberg ya convierte a PDF como fallback. Dentro de unos meses, si `LegacyWordDocumentProcessed` es residual frente a `MultimodalAnalysisCompleted`, quitar `.doc` y retirar Gotenberg.
- Cola durable (`jobId`, cancelación): solo si el p95 o los timeouts de APIM impiden mantener `/medical/analyze` como está.
