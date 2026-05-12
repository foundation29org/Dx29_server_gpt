# Sistema de Cost Tracking - Versión 2.0

Este sistema permite rastrear y analizar los costos de las operaciones de IA en tiempo real con un modelo flexible que soporta diferentes etapas por operación.

## Características

- ✅ **Modelo flexible de etapas** que se adapta a cada operación
- ✅ **Cálculo automático de costos** por etapa individual
- ✅ **Compatibilidad con múltiples modelos** (gpt4o, gpt5-mini, gpt5, o3)
- ✅ **Soporte para operaciones complejas y simples**
- ✅ **Almacenamiento en base de datos** MongoDB con índices optimizados
- ✅ **APIs para consulta** de estadísticas y costos
- ✅ **Manejo de errores** sin afectar operaciones principales
- ✅ **Métricas y logging** integrado con Application Insights
- ✅ **Información de duración** y éxito por etapa

## Arquitectura

### Modelos de Base de Datos

#### `CostTracking` (`models/costTracking.js`)
Almacena cada operación con estructura flexible:

```javascript
{
  myuuid: String,           // Identificación única
  tenantId: String,         // ID del tenant
  subscriptionId: String,   // ID de suscripción
  operation: String,        // Tipo de operación
  model: String,           // Modelo principal utilizado
  lang: String,            // Idioma
  timezone: String,        // Zona horaria
  
  // Estructura flexible de etapas
  stages: [{
    name: String,          // 'translation', 'ai_call', 'anonymization', etc.
    cost: Number,          // Costo de la etapa
    tokens: {              // Tokens utilizados
      input: Number,
      output: Number,
      total: Number
    },
    model: String,         // Modelo utilizado en esta etapa
    duration: Number,      // Duración en milisegundos
    success: Boolean,      // Éxito de la etapa
    error: {               // Error si falló
      message: String,
      code: String
    }
  }],
  
  // Totales agregados
  totalCost: Number,
  totalTokens: {
    input: Number,
    output: Number,
    total: Number
  },
  
  // Información adicional
  description: String,
  status: String,          // 'success', 'error', 'partial'
  operationData: Object,   // Datos específicos por operación
  createdAt: Date
}
```

### Servicios

#### `CostTrackingService` (`services/costTrackingService.js`)
Proporciona métodos especializados:

- `saveDiagnoseCost()` - Para operaciones complejas como diagnose
- `saveSimpleOperationCost()` - Para operaciones con 1 llamada AI
- `saveDatabaseOnlyOperation()` - Para operaciones sin IA
- `getCostStats()` - Estadísticas por operación y modelo
- `getStageStats()` - Estadísticas detalladas por etapa
- `getTotalCost()` - Costo total en período
- `getRecentCosts()` - Costos recientes con detalles

## Tipos de Operaciones

### 1. **Operaciones Complejas** (`/diagnose`)
- **Etapas**: Traducción → AI Call 1 → AI Call 2 → Anonimización → Traducción inversa
- **Método**: `saveDiagnoseCost()`

### 2. **Operaciones Simples** (`/disease/info`, `/questions/*`, `/summarize`)
- **Etapas**: Traducción → AI Call → Traducción inversa
- **Método**: `saveSimpleOperationCost()`

**Nota**: `/disease/info` tiene casos especiales:
- **questionType 0-5**: Usa GPT-4o con diferentes prompts

### 3. **Operaciones Solo BD** (`/opinion`, `/generalfeedback`)
- **Etapas**: Database Save
- **Método**: `saveDatabaseOnlyOperation()`

## Integración

### Para Operaciones Complejas (diagnose)

```javascript
// En processAIRequestInternal
// El objeto costTracking se convierte automáticamente a array de stages
const costTracking = {
  etapa1_diagnosticos: { cost: 0.000375, tokens: { input: 150, output: 50, total: 200 } },
  etapa2_expansion: { cost: 0.002750, tokens: { input: 300, output: 800, total: 1100 } },
  etapa3_anonimizacion: { cost: 0.000875, tokens: { input: 200, output: 150, total: 350 } },
  total: { cost: 0.004000, tokens: { input: 650, output: 1000, total: 1650 } }
};

// Conversión automática a stages
const stages = [];
if (costTracking.etapa1_diagnosticos.cost > 0) {
  stages.push({
    name: 'ai_call',
    cost: costTracking.etapa1_diagnosticos.cost,
    tokens: costTracking.etapa1_diagnosticos.tokens,
    model: model,
    duration: 0,
    success: true
  });
}
// ... más etapas

await CostTrackingService.saveDiagnoseCost(data, stages, 'success');
```

### Para Operaciones Simples

```javascript
// En callInfoDisease, generateFollowUpQuestions, etc.
const aiStage = {
  name: 'ai_call',
  cost: 0.001250,
  tokens: { input: 250, output: 400, total: 650 },
  model: 'gpt4o',
  duration: 1800,
  success: true
};

await CostTrackingService.saveSimpleOperationCost(
  data, 
  'info_disease', 
  aiStage, 
  'success'
);
```

**Ejemplo específico para `/disease/info`:**
```javascript
// Variables para cost tracking
const costTrackingData = {
  myuuid: req.body.myuuid,
  tenantId: tenantId,
  subscriptionId: subscriptionId,
  lang: req.body.detectedLang || 'en',
  timezone: req.body.timezone,
  description: `${req.body.questionType} - ${req.body.disease}`,
  questionType: req.body.questionType,
  disease: req.body.disease,
  iframeParams: req.body.iframeParams || {}
};

// Para questionType 0-5 (GPT-4o)
stages.push({
  name: 'ai_call',
  cost: calculatePrice(usage, 'gpt4o'),
  tokens: { input: inputTokens, output: outputTokens, total: totalTokens },
  model: 'gpt4o',
  duration: aiEndTime - aiStartTime,
  success: true
});
```

### Para Operaciones Solo BD

```javascript
// En opinion, sendGeneralFeedback
await CostTrackingService.saveDatabaseOnlyOperation(
  data,
  'opinion',
  'success'
);
```

## APIs Disponibles

### GET `/cost-tracking/stats`
Estadísticas por operación y modelo.

**Ejemplo de respuesta:**
```json
{
  "result": "success",
  "data": {
    "tenantId": "tenant-123",
    "period": {
      "startDate": "2024-01-01T00:00:00.000Z",
      "endDate": "2024-01-31T23:59:59.999Z"
    },
    "stats": [
      {
        "_id": "diagnose",
        "models": [
          {
            "model": "gpt4o",
            "totalCost": 0.045,
            "totalTokens": 15000,
            "count": 10,
            "avgCost": 0.0045,
            "avgTokens": 1500
          }
        ],
        "totalCost": 0.045,
        "totalTokens": 15000,
        "totalCount": 10
      }
    ]
  }
}
```

### GET `/cost-tracking/stage-stats`
Estadísticas detalladas por etapa.

**Ejemplo de respuesta:**
```json
{
  "result": "success",
  "data": {
    "stageStats": [
      {
        "_id": {
          "operation": "diagnose",
          "stage": "ai_call"
        },
        "models": [
          {
            "model": "gpt4o",
            "totalCost": 0.035,
            "totalTokens": 12000,
            "count": 20,
            "avgDuration": 2800,
            "successRate": 0.95
          }
        ],
        "totalCost": 0.035,
        "totalTokens": 12000,
        "totalCount": 20
      }
    ]
  }
}
```

### GET `/cost-tracking/total`
Costo total en período.

### GET `/cost-tracking/recent`
Costos recientes con detalles de etapas.

**Ejemplo de respuesta:**
```json
{
  "result": "success",
  "data": {
    "recentCosts": [
      {
        "operation": "diagnose",
        "model": "gpt4o",
        "cost": 0.004000,
        "tokens": 1650,
        "status": "success",
        "createdAt": "2024-01-15T10:30:00.000Z",
        "stages": [
          {
            "name": "translation",
            "cost": 0.000000,
            "tokens": 0,
            "model": "translation_service",
            "duration": 150
          },
          {
            "name": "ai_call",
            "cost": 0.000375,
            "tokens": 200,
            "model": "gpt4o",
            "duration": 2500
          }
        ]
      }
    ]
  }
}
```

## Logs y Monitoreo

### Console Logs
```
🚀 Iniciando processAIRequestInternal con modelo: gpt4o
💰 Etapa 1 - Diagnósticos: $0.000375 (200 tokens)
💰 Etapa 2 - Expansión: $0.002750 (1100 tokens)
💰 Etapa 3 - Anonimización: $0.000875 (350 tokens)

💰 RESUMEN DE COSTOS:
   Etapa 1 - Diagnósticos: $0.000375
   Etapa 2 - Expansión: $0.002750
   Etapa 3 - Anonimización: $0.000875
   ──────────────────────────
   TOTAL: $0.004000 (1650 tokens)

✅ Costos guardados en la base de datos
```

### Application Insights
Métricas automáticas:
- `cost_tracking_saved` - Con información de etapas
- Errores de guardado y consulta
- Estadísticas de duración por etapa

## Pruebas

### Scripts de Prueba
```bash
# Prueba general del sistema
node test-cost-tracking.js

# Prueba específica de callInfoDisease
node test-info-disease-cost.js

# Prueba de cálculo de costos de Azure AI Studio
node test-azure-ai-cost.js
```

### Prueba Manual
```bash
# Obtener estadísticas
curl -H "X-Tenant-Id: tenant-123" \
     "http://localhost:8443/cost-tracking/stats?startDate=2024-01-01&endDate=2024-01-31"

# Obtener estadísticas por etapa
curl -H "X-Tenant-Id: tenant-123" \
     "http://localhost:8443/cost-tracking/stage-stats?startDate=2024-01-01&endDate=2024-01-31"

# Obtener costos recientes
curl -H "X-Tenant-Id: tenant-123" \
     "http://localhost:8443/cost-tracking/recent?limit=5"
```

## Índices de Base de Datos

```javascript
// Índices simples
{ myuuid: 1 }
{ tenantId: 1 }
{ subscriptionId: 1 }
{ operation: 1 }
{ model: 1 }
{ lang: 1 }
{ createdAt: 1 }

// Índices compuestos
{ tenantId: 1, createdAt: -1 }
{ operation: 1, createdAt: -1 }
{ model: 1, createdAt: -1 }
{ tenantId: 1, operation: 1, createdAt: -1 }
{ 'stages.name': 1, createdAt: -1 }
```

## Ventajas del Nuevo Sistema

1. **Flexibilidad**: Cada operación puede tener sus propias etapas
2. **Granularidad**: Costos y métricas por etapa individual
3. **Escalabilidad**: Fácil agregar nuevas etapas o operaciones
4. **Análisis detallado**: Estadísticas por etapa, duración, éxito
5. **Compatibilidad**: Soporte para diferentes modelos y servicios
6. **Auditoría completa**: Trazabilidad completa de cada operación
7. **Robustez**: Manejo correcto de diferentes formatos de datos

## Correcciones Implementadas

### Error `stages.reduce is not a function`

**Problema**: En `processAIRequestInternal`, se pasaba un objeto `costTracking` al método `saveDiagnoseCost`, pero este método esperaba un array de `stages`.

**Solución**: Se implementó una conversión automática del objeto `costTracking` a un array de `stages` antes de llamar a `saveDiagnoseCost`.

**Antes**:
```javascript
// ❌ Error: costTracking es un objeto, no un array
await CostTrackingService.saveDiagnoseCost(data, costTracking, 'success');
```

**Después**:
```javascript
// ✅ Correcto: Conversión a array de stages
const stages = [];
if (costTracking.etapa1_diagnosticos.cost > 0) {
  stages.push({
    name: 'ai_call',
    cost: costTracking.etapa1_diagnosticos.cost,
    tokens: costTracking.etapa1_diagnosticos.tokens,
    model: model,
    duration: 0,
    success: true
  });
}
// ... más etapas
await CostTrackingService.saveDiagnoseCost(data, stages, 'success');
```

## Próximos Pasos

- [ ] Integrar en todas las operaciones existentes
- [ ] Dashboard web para visualización
- [ ] Alertas de costos elevados por etapa
- [ ] Exportación de reportes detallados
- [ ] Análisis de tendencias por etapa
- [ ] Optimización automática basada en costos 

## Backlog de reevaluacion (coste/latencia)

### Reevaluar traduccion con LLM (pospuesto)

- **Estado actual**: no entra en el ambito de la evaluacion actual.
- **Motivo**: en pruebas internas, traducir con LLM resulto mas barato en algunos casos, pero aumento la latencia total frente a Azure Translator.
- **Decision vigente**: mantener Azure Translator en produccion hasta nueva evidencia.

#### Datos de referencia (produccion real)

- `ai_call` (`gpt5mini`): 19.6s, $0.001835
- `reverse_diseases` (translation): 0.6s, $0.02197
- Total pipeline: ~33s, $0.02564

#### Lectura de coste actual

- El cuello de coste principal esta en `reverse_diseases`, no en el `ai_call`.
- El tiempo de `ai_call` depende del tamano del prompt (produccion corta vs dataset largo).

#### Trigger para reabrir

Reevaluar esta decision solo si se cumple al menos una condicion:

- Se identifica un modelo de traduccion LLM rapido y estable con calidad clinica aceptable.
- Cambian precios/cuotas de Azure Translator de forma relevante.
- `reverse_diseases` mantiene sobrecoste material durante al menos 2 semanas.

#### Criterio minimo para aprobar un cambio

- Calidad de traduccion clinica igual o mejor.
- Coste total por request menor (no solo por stage aislado).
- Latencia p95 end-to-end igual o menor que el baseline actual.

### Tarea prioritaria asociada: optimizar `reverse_diseases`

- Auditar payload exacto que se traduce.
- Medir tokens por idioma y por cantidad de enfermedades devueltas.
- Evaluar cache/deduplicacion/traduccion selectiva de campos visibles.