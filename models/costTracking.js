'use strict';

const mongoose = require('../db_connect');
const Schema = mongoose.Schema;

const CostTrackingSchema = new Schema({
  // Identificación de la operación
  myuuid: {
    type: String,
    required: true,
    index: true
  },
  
  // Información del tenant
  tenantId: {
    type: String,
    index: true
  },
  subscriptionId: {
    type: String
  },
  
  // Tipo de operación
  operation: {
    type: String,
    required: true,
    enum: ['diagnose', 'info_disease', 'opinion', 'follow_up_questions', 'er_questions', 'process_follow_up', 'summarize', 'general_feedback', 'multimodal_detect_type', 'multimodal_process_image', 'emergency_questions', 'process-follow-up'],
    index: true
  },
  
  // Modelo utilizado
  model: {
    type: String,
    required: true,
    enum: ['gpt4o', 'o3', 'gpt-4o-mini', 'azure_ai_studio', 'sonar', 'gpt5nano', 'gpt5mini', 'gpt4omini', 'gpt5'],
    index: true
  },
  
  // Idioma y región
  lang: {
    type: String,
    required: true,
    index: true
  },
  timezone: {
    type: String,
    required: true
  },
  
  // Costos por etapa - Estructura flexible
  stages: [{
    name: {
      type: String,
      required: true,
      enum: [
        'translation',           // Traducción a inglés
        'ai_call',              // Llamada a IA
        'anonymization',        // Anonimización
        'reverse_translation',  // Traducción inversa
        'database_save',         // Guardado en BD
        'clinical_check', // Verificación de escenario clínico
        'general_medical_response', // Verificación de escenario clínico
        'emergency_questions' // Verificación de escenario clínico
      ]
    },
    cost: {
      type: Number,
      default: 0
    },
    tokens: {
      input: { type: Number, default: 0 },
      output: { type: Number, default: 0 },
      total: { type: Number, default: 0 }
    },
    model: {
      type: String,
      enum: ['gpt4o', 'o3', 'gpt-4o-mini', 'azure_ai_studio', 'translation_service', 'sonar', 'gpt5nano', 'gpt5mini', 'gpt4omini', 'gpt5']
    },
    duration: {
      type: Number,  // Duración en milisegundos
      default: 0
    },
    success: {
      type: Boolean,
      default: true
    },
    error: {
      message: String,
      code: String
    }
  }],
  
  // Totales agregados
  totalCost: {
    type: Number,
    default: 0
  },
  totalTokens: {
    input: { type: Number, default: 0 },
    output: { type: Number, default: 0 },
    total: { type: Number, default: 0 }
  },
  
  // Información adicional
  description: {
    type: String,
    required: true
  },
  descriptionLength: {
    type: Number,
    default: 0
  },
  
  // Estado de la operación
  status: {
    type: String,
    required: true,
    enum: ['success', 'error', 'partial'],
    default: 'success'
  },
  
  // Información de error (si aplica)
  error: {
    message: String,
    code: String,
    stage: String
  },
  
  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  
  // Información de iframe (si aplica)
  iframeParams: {
    type: Schema.Types.Mixed,
    default: {}
  },
  
  // Información específica por operación
  operationData: {
    type: Schema.Types.Mixed,
    default: {}
  }
});

// Índices compuestos para consultas eficientes
CostTrackingSchema.index({ tenantId: 1, createdAt: -1 });
CostTrackingSchema.index({ operation: 1, createdAt: -1 });
CostTrackingSchema.index({ model: 1, createdAt: -1 });
CostTrackingSchema.index({ tenantId: 1, operation: 1, createdAt: -1 });
CostTrackingSchema.index({ 'stages.name': 1, createdAt: -1 });

// Método estático para crear un registro de costo
CostTrackingSchema.statics.createCostRecord = function(data) {
  return this.create({
    myuuid: data.myuuid,
    tenantId: data.tenantId,
    subscriptionId: data.subscriptionId,
    operation: data.operation,
    model: data.model,
    lang: data.lang,
    timezone: data.timezone,
    stages: data.stages || [],
    totalCost: data.totalCost || 0,
    totalTokens: data.totalTokens || { input: 0, output: 0, total: 0 },
    description: data.description,
    descriptionLength: data.description ? data.description.length : 0,
    status: data.status || 'success',
    error: data.error,
    iframeParams: data.iframeParams || {},
    operationData: data.operationData || {}
  });
};

// Método para agregar una etapa al registro
CostTrackingSchema.methods.addStage = function(stageData) {
  this.stages.push(stageData);
  
  // Recalcular totales
  this.totalCost = this.stages.reduce((sum, stage) => sum + (stage.cost || 0), 0);
  this.totalTokens.input = this.stages.reduce((sum, stage) => sum + (stage.tokens?.input || 0), 0);
  this.totalTokens.output = this.stages.reduce((sum, stage) => sum + (stage.tokens?.output || 0), 0);
  this.totalTokens.total = this.stages.reduce((sum, stage) => sum + (stage.tokens?.total || 0), 0);
  
  return this.save();
};

// Método para obtener estadísticas de costos por tenant
CostTrackingSchema.statics.getCostStats = function(tenantId, startDate, endDate) {
  const matchStage = {
    tenantId: tenantId,
    createdAt: {
      $gte: startDate,
      $lte: endDate
    }
  };

  return this.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: {
          operation: '$operation',
          model: '$model'
        },
        totalCost: { $sum: '$totalCost' },
        totalTokens: { $sum: '$totalTokens.total' },
        count: { $sum: 1 },
        avgCost: { $avg: '$totalCost' },
        avgTokens: { $avg: '$totalTokens.total' },
        // Estadísticas por etapa
        stages: {
          $push: {
            stages: '$stages',
            totalCost: '$totalCost'
          }
        }
      }
    },
    {
      $group: {
        _id: '$_id.operation',
        models: {
          $push: {
            model: '$_id.model',
            totalCost: '$totalCost',
            totalTokens: '$totalTokens',
            count: '$count',
            avgCost: '$avgCost',
            avgTokens: '$avgTokens',
            stages: '$stages'
          }
        },
        totalCost: { $sum: '$totalCost' },
        totalTokens: { $sum: '$totalTokens' },
        totalCount: { $sum: '$count' }
      }
    },
    { $sort: { totalCost: -1 } }
  ]);
};

// Método para obtener estadísticas por etapa
CostTrackingSchema.statics.getStageStats = function(tenantId, startDate, endDate) {
  return this.aggregate([
    {
      $match: {
        tenantId: tenantId,
        createdAt: {
          $gte: startDate,
          $lte: endDate
        }
      }
    },
    { $unwind: '$stages' },
    {
      $group: {
        _id: {
          operation: '$operation',
          stage: '$stages.name',
          model: '$stages.model'
        },
        totalCost: { $sum: '$stages.cost' },
        totalTokens: { $sum: '$stages.tokens.total' },
        count: { $sum: 1 },
        avgDuration: { $avg: '$stages.duration' },
        successRate: {
          $avg: { $cond: ['$stages.success', 1, 0] }
        }
      }
    },
    {
      $group: {
        _id: {
          operation: '$_id.operation',
          stage: '$_id.stage'
        },
        models: {
          $push: {
            model: '$_id.model',
            totalCost: '$totalCost',
            totalTokens: '$totalTokens',
            count: '$count',
            avgDuration: '$avgDuration',
            successRate: '$successRate'
          }
        },
        totalCost: { $sum: '$totalCost' },
        totalTokens: { $sum: '$totalTokens' },
        totalCount: { $sum: '$count' }
      }
    },
    { $sort: { totalCost: -1 } }
  ]);
};

module.exports = mongoose.model('CostTracking', CostTrackingSchema); 