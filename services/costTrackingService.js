'use strict';

const CostTracking = require('../models/costTracking');
const insights = require('./insights');

class CostTrackingService {
  
  /**
   * Guarda un registro de costo en la base de datos
   * @param {Object} data - Datos del costo a guardar
   * @returns {Promise<Object>} - Registro guardado
   */
  static async saveCostRecord(data) {
    try {
      const costRecord = await CostTracking.createCostRecord(data);
      
      console.log(`💰 Costo guardado en DB: ${data.operation} - ${data.model} - $${data.totalCost.toFixed(6)}`);
      
      return costRecord;
    } catch (error) {
      console.error('Error guardando registro de costo:', error);
      insights.error({
        message: 'Error guardando registro de costo',
        error: error.message,
        data: data
      });
      throw error;
    }
  }
  
  /**
   * Crea un registro de costo para la operación diagnose
   * @param {Object} data - Datos de la operación
   * @param {Array} stages - Array de etapas con costos
   * @param {String} status - Estado de la operación
   * @param {Object} error - Información de error (opcional)
   */
  static async saveDiagnoseCost(data, stages, status = 'success', error = null, options = {}) {
    const totalCost = stages.reduce((sum, stage) => sum + (stage.cost || 0), 0);
    const totalTokens = {
      input: stages.reduce((sum, stage) => sum + (stage.tokens?.input || 0), 0),
      output: stages.reduce((sum, stage) => sum + (stage.tokens?.output || 0), 0),
      total: stages.reduce((sum, stage) => sum + (stage.tokens?.total || 0), 0)
    };
    const intent = options.intent || data.queryType || (error && error.queryType) || 'unknown';
    const queryType = options.queryType || data.queryType || (error && error.queryType);
    
    const costData = {
      myuuid: data.myuuid,
      tenantId: data.tenantId,
      subscriptionId: data.subscriptionId,
      operation: 'diagnose',
      intent: intent,
      model: data.model || 'gpt4o',
      lang: data.lang,
      timezone: data.timezone,
      stages: stages,
      totalCost: totalCost,
      totalTokens: totalTokens,
      descriptionLength: data.description ? data.description.length : 0, // Solo guardamos la longitud
      status: status,
      error: error,
      iframeParams: data.iframeParams || {},
      operationData: {
        diseasesList: data.diseases_list,
        detectedLanguage: data.detectedLanguage,
        queryType: queryType
      }
    };
    
    return this.saveCostRecord(costData);
  }
  
  /**
   * Crea un registro de costo para operaciones simples (1 llamada AI)
   * @param {Object} data - Datos de la operación
   * @param {String} operation - Tipo de operación
   * @param {Object} aiStage - Datos de la etapa de IA
   * @param {String} status - Estado de la operación
   * @param {Object} error - Información de error (opcional)
   * 
   */
  static async saveSimpleOperationCost(data, operation, aiStage, status = 'success', error = null) {
    const stages = [aiStage];
    
    const totalCost = stages.reduce((sum, stage) => sum + (stage.cost || 0), 0);
    const totalTokens = {
      input: stages.reduce((sum, stage) => sum + (stage.tokens?.input || 0), 0),
      output: stages.reduce((sum, stage) => sum + (stage.tokens?.output || 0), 0),
      total: stages.reduce((sum, stage) => sum + (stage.tokens?.total || 0), 0)
    };
    
    const costData = {
      myuuid: data.myuuid,
      tenantId: data.tenantId,
      subscriptionId: data.subscriptionId,
      operation: operation,
      model: aiStage.model,
      lang: data.lang,
      timezone: data.timezone,
      stages: stages,
      totalCost: totalCost,
      totalTokens: totalTokens,
      descriptionLength: data.description ? data.description.length : 0, // Solo guardamos la longitud
      status: status,
      error: error,
      iframeParams: data.iframeParams || {},
      operationData: {
        questionType: data.questionType,
        disease: data.disease,
        detectedLanguage: data.detectedLanguage
      }
    };
    
    return this.saveCostRecord(costData);
  }
  
  /**
   * Crea un registro para operaciones sin IA (solo BD)
   * @param {Object} data - Datos de la operación
   * @param {String} operation - Tipo de operación
   * @param {String} status - Estado de la operación
   * @param {Object} error - Información de error (opcional)
   */
  static async saveDatabaseOnlyOperation(data, operation, status = 'success', error = null) {
    const stages = [{
      name: 'database_save',
      cost: 0,
      tokens: { input: 0, output: 0, total: 0 },
      model: 'database',
      duration: data.saveDuration || 0,
      success: status === 'success'
    }];
    
    const costData = {
      myuuid: data.myuuid,
      tenantId: data.tenantId,
      subscriptionId: data.subscriptionId,
      operation: operation,
      model: 'database',
      lang: data.lang,
      timezone: data.timezone,
      stages: stages,
      totalCost: 0,
      totalTokens: { input: 0, output: 0, total: 0 },
      descriptionLength: data.description ? data.description.length : 0, // Solo guardamos la longitud
      status: status,
      error: error,
      iframeParams: data.iframeParams || {},
      operationData: data.operationData || {}
    };
    
    return this.saveCostRecord(costData);
  }
  
  /**
   * Obtiene estadísticas de costos para un tenant en un período específico
   * @param {String} tenantId - ID del tenant
   * @param {Date} startDate - Fecha de inicio
   * @param {Date} endDate - Fecha de fin
   * @returns {Promise<Array>} - Estadísticas de costos
   */
  static async getCostStats(tenantId, startDate, endDate) {
    try {
      const stats = await CostTracking.getCostStats(tenantId, startDate, endDate);
      return stats;
    } catch (error) {
      console.error('Error obteniendo estadísticas de costos:', error);
      insights.error({
        message: 'Error obteniendo estadísticas de costos',
        error: error.message,
        tenantId: tenantId,
        startDate: startDate,
        endDate: endDate
      });
      throw error;
    }
  }
  
  /**
   * Obtiene estadísticas por etapa
   * @param {String} tenantId - ID del tenant
   * @param {Date} startDate - Fecha de inicio
   * @param {Date} endDate - Fecha de fin
   * @returns {Promise<Array>} - Estadísticas por etapa
   */
  static async getStageStats(tenantId, startDate, endDate) {
    try {
      const stats = await CostTracking.getStageStats(tenantId, startDate, endDate);
      return stats;
    } catch (error) {
      console.error('Error obteniendo estadísticas por etapa:', error);
      insights.error({
        message: 'Error obteniendo estadísticas por etapa',
        error: error.message,
        tenantId: tenantId,
        startDate: startDate,
        endDate: endDate
      });
      throw error;
    }
  }
  
  /**
   * Obtiene el costo total de un tenant en un período específico
   * @param {String} tenantId - ID del tenant
   * @param {Date} startDate - Fecha de inicio
   * @param {Date} endDate - Fecha de fin
   * @returns {Promise<Object>} - Resumen de costos
   */
  static async getTotalCost(tenantId, startDate, endDate) {
    try {
      const result = await CostTracking.aggregate([
        {
          $match: {
            tenantId: tenantId,
            createdAt: {
              $gte: startDate,
              $lte: endDate
            }
          }
        },
        {
          $group: {
            _id: null,
            totalCost: { $sum: '$totalCost' },
            totalTokens: { $sum: '$totalTokens.total' },
            totalOperations: { $sum: 1 },
            avgCostPerOperation: { $avg: '$totalCost' }
          }
        }
      ]);
      
      return result[0] || {
        totalCost: 0,
        totalTokens: 0,
        totalOperations: 0,
        avgCostPerOperation: 0
      };
    } catch (error) {
      console.error('Error obteniendo costo total:', error);
      insights.error({
        message: 'Error obteniendo costo total',
        error: error.message,
        tenantId: tenantId
      });
      throw error;
    }
  }
  
  /**
   * Obtiene los últimos registros de costo para un tenant
   * @param {String} tenantId - ID del tenant
   * @param {Number} limit - Número máximo de registros
   * @returns {Promise<Array>} - Registros de costo
   */
  static async getRecentCosts(tenantId, limit = 10) {
    try {
      const costs = await CostTracking.find({ tenantId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .select('operation model totalCost totalTokens createdAt status stages');
      
      return costs;
    } catch (error) {
      console.error('Error obteniendo costos recientes:', error);
      insights.error({
        message: 'Error obteniendo costos recientes',
        error: error.message,
        tenantId: tenantId
      });
      throw error;
    }
  }
}

module.exports = CostTrackingService; 