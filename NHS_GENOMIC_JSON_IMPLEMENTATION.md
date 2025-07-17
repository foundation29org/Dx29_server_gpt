# NHS Genomic Service - JSON Implementation

## Resumen de Cambios

Se ha modificado el servicio de genómica NHS para devolver respuestas en formato JSON estructurado en lugar de HTML, mejorando la consistencia y facilidad de procesamiento.

## Cambios Principales

### 1. Servicio Azure AI Genomic (`services/azureAIGenomicService.js`)

**Cambios realizados:**
- Modificado el prompt para solicitar específicamente un formato JSON
- Agregado ejemplo detallado del formato JSON esperado
- Implementado parsing robusto de la respuesta JSON
- Agregado manejo de errores con estructura JSON de fallback
- Actualizado las instrucciones del assistant para devolver solo JSON

**Formato JSON esperado (con pruebas disponibles):**
```json
{
  "recommendedTests": [
    {
      "testCode": "R59.3",
      "testName": "Early onset or syndromic epilepsy",
      "targetGenes": "Early onset or syndromic epilepsy (402)",
      "testMethod": "WGS (Whole Genome Sequencing)",
      "category": "Specialized"
    }
  ],
  "eligibilityCriteria": {
    "documentSection": "XVII Neurology",
    "nhsCriteria": "Unexplained epilepsy with clinical suspicion...",
    "specialties": ["Clinical Genetics", "Neurology", "Metabolic Medicine"]
  },
  "additionalInformation": {
    "applicationProcess": "Referrals for tests will be classified...",
    "expectedResponseTimes": "Generally, it varies according to...",
    "specialConsiderations": "Occasionally, tests may be appropriate..."
  },
  "source": "NHS Genomic Test Directory"
}
```

**Formato JSON cuando no hay pruebas disponibles:**
```json
{
  "recommendedTests": [],
  "eligibilityCriteria": {
    "documentSection": "Not applicable",
    "nhsCriteria": "No specific genetic tests available for this condition in the NHS Genomic Test Directory.",
    "specialties": []
  },
  "additionalInformation": {
    "applicationProcess": "Please consult with a clinical geneticist for alternative testing options or referral to specialist services.",
    "expectedResponseTimes": "Not applicable",
    "specialConsiderations": "Consider referral to clinical genetics for assessment of whether genetic testing might be appropriate through other pathways."
  },
  "source": "NHS Genomic Test Directory",
  "noTestsFound": true,
  "reason": "Condition not covered by NHS genetic testing directory"
}
```

### 2. Servicio DxGPT (`services/servicedxgpt.js`)

**Cambios realizados:**
- Modificado el caso 5 en `callInfoDisease` para procesar JSON en lugar de HTML
- Implementado conversión de JSON a HTML estructurado
- Mantenido el formato de respuesta consistente con otros tipos de pregunta
- Agregado manejo de casos donde no hay recomendaciones

**Estructura HTML generada (con pruebas disponibles):**
```html
<p><strong>LISTA DE PRUEBAS RECOMENDADAS:</strong></p>
<ul>
  <li><strong>prueba:</strong> R59.3</li>
  <li><strong>Nombre de la prueba:</strong> Early onset or syndromic epilepsy</li>
  <li><strong>Genes diana:</strong> Early onset or syndromic epilepsy (402)</li>
  <li><strong>Método de prueba:</strong> WGS (Whole Genome Sequencing)</li>
  <li><strong>Categoría:</strong> Specialized</li>
</ul>
<p><strong>CRITERIOS DE ELEGIBILIDAD:</strong></p>
<ul>
  <li><strong>Sección del documento de elegibilidad:</strong> XVII Neurology</li>
  <li><strong>Criterios específicos del NHS:</strong> ...</li>
  <li><strong>Especialidades que pueden solicitar la prueba:</strong> ...</li>
</ul>
<p><strong>INFORMACIÓN ADICIONAL:</strong></p>
<ul>
  <li><strong>Proceso de solicitud:</strong> ...</li>
  <li><strong>Tiempos de respuesta esperados:</strong> ...</li>
  <li><strong>Consideraciones especiales:</strong> ...</li>
</ul>
<p>Fuente: Directorio de pruebas genómicas del NHS</p>
```

**Estructura HTML generada (sin pruebas disponibles):**
```html
<p><strong>RESULTADO DE LA CONSULTA:</strong></p>
<p><strong>No se encontraron pruebas genéticas específicas en el directorio del NHS para esta condición.</strong></p>
<p><strong>Razón:</strong> Condition not covered by NHS genetic testing directory</p>
<p><strong>RECOMENDACIONES ALTERNATIVAS:</strong></p>
<ul>
  <li><strong>Proceso de solicitud:</strong> Please consult with a clinical geneticist...</li>
  <li><strong>Consideraciones especiales:</strong> Consider referral to clinical genetics...</li>
</ul>
<p><strong>PRÓXIMOS PASOS SUGERIDOS:</strong></p>
<ul>
  <li>Consultar con un genetista clínico para evaluación individualizada</li>
  <li>Considerar si la condición podría calificar para pruebas a través de otras vías</li>
  <li>Evaluar si existen pruebas de investigación o comerciales disponibles</li>
  <li>Revisar si hay criterios de elegibilidad especiales que podrían aplicarse</li>
</ul>
<p>Fuente: Directorio de pruebas genómicas del NHS</p>
```

## Archivos Creados

### 1. Script de Prueba (`test/test-nhs-genomic-json.js`)
- Pruebas para validar el formato JSON
- Verificación de estructura de datos
- Tests para diferentes tipos de consultas
- Validación de conexión con Azure AI Studio

### 2. Ejemplo de Formato (`examples/nhs-genomic-json-example.js`)
- Ejemplos de respuestas JSON esperadas
- Formato para casos exitosos
- Formato para casos sin recomendaciones
- Formato para casos de error

## Ventajas del Nuevo Enfoque

1. **Consistencia**: Formato JSON estructurado y predecible
2. **Robustez**: Manejo de errores mejorado con estructuras de fallback
3. **Mantenibilidad**: Más fácil de debuggear y modificar
4. **Escalabilidad**: Fácil agregar nuevos campos o modificar estructura
5. **Validación**: Posibilidad de validar estructura de datos
6. **Flexibilidad**: JSON puede ser convertido a cualquier formato de presentación
7. **Manejo de casos límite**: Respuestas apropiadas cuando no hay pruebas disponibles
8. **Orientación clínica**: Proporciona alternativas y próximos pasos útiles

## Flujo de Procesamiento

1. **Entrada**: Usuario solicita recomendaciones genéticas (questionType: 5)
2. **Azure AI Studio**: Procesa consulta y devuelve JSON estructurado
3. **Parsing**: Servicio valida y parsea la respuesta JSON
4. **Detección de caso**: Determina si hay pruebas disponibles o no
5. **Conversión**: JSON se convierte a HTML apropiado según el caso
6. **Traducción**: HTML se traduce si es necesario
7. **Respuesta**: Se devuelve HTML formateado al cliente

### Casos de Respuesta

**Caso 1: Pruebas disponibles**
- Muestra lista de pruebas recomendadas
- Incluye criterios de elegibilidad
- Proporciona información adicional

**Caso 2: No hay pruebas disponibles**
- Informa claramente que no hay pruebas específicas
- Proporciona razón de la ausencia
- Ofrece recomendaciones alternativas
- Sugiere próximos pasos clínicos

## Próximos Pasos

1. Ejecutar pruebas para validar el nuevo formato
2. Monitorear respuestas del assistant para asegurar consistencia
3. Considerar agregar validación de esquema JSON
4. Evaluar posibilidad de devolver JSON directamente al cliente si es necesario

## Notas Técnicas

- El assistant de Azure AI Studio debe estar configurado para devolver solo JSON
- Se mantiene compatibilidad con el formato de respuesta existente
- El procesamiento de errores es robusto y proporciona respuestas útiles
- La traducción se aplica después de la conversión a HTML 