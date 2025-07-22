'use strict';

const express = require('express');
const router = express.Router();
const CostTrackingService = require('../services/costTrackingService');
const insights = require('../services/insights');

// Middleware para validar tenant
function validateTenant(req, res, next) {
  const tenantId = req.headers['x-tenant-id'];
  if (!tenantId) {
    return res.status(400).send({
      result: 'error',
      message: 'X-Tenant-Id header is required'
    });
  }
  req.tenantId = tenantId;
  next();
}

// GET /cost-tracking/stats - Obtener estadísticas de costos
router.get('/stats', validateTenant, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const tenantId = req.tenantId;
    
    // Validar fechas
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // Últimos 30 días por defecto
    const end = endDate ? new Date(endDate) : new Date();
    
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).send({
        result: 'error',
        message: 'Invalid date format. Use ISO 8601 format (YYYY-MM-DD)'
      });
    }
    
    const stats = await CostTrackingService.getCostStats(tenantId, start, end);
    
    res.status(200).send({
      result: 'success',
      data: {
        tenantId: tenantId,
        period: {
          startDate: start.toISOString(),
          endDate: end.toISOString()
        },
        stats: stats
      }
    });
    
  } catch (error) {
    console.error('Error obteniendo estadísticas de costos:', error);
    insights.error({
      message: 'Error obteniendo estadísticas de costos',
      error: error.message,
      tenantId: req.tenantId,
      query: req.query
    });
    
    res.status(500).send({
      result: 'error',
      message: 'Error obteniendo estadísticas de costos'
    });
  }
});

// GET /cost-tracking/stage-stats - Obtener estadísticas por etapa
router.get('/stage-stats', validateTenant, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const tenantId = req.tenantId;
    
    // Validar fechas
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();
    
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).send({
        result: 'error',
        message: 'Invalid date format. Use ISO 8601 format (YYYY-MM-DD)'
      });
    }
    
    const stageStats = await CostTrackingService.getStageStats(tenantId, start, end);
    
    res.status(200).send({
      result: 'success',
      data: {
        tenantId: tenantId,
        period: {
          startDate: start.toISOString(),
          endDate: end.toISOString()
        },
        stageStats: stageStats
      }
    });
    
  } catch (error) {
    console.error('Error obteniendo estadísticas por etapa:', error);
    insights.error({
      message: 'Error obteniendo estadísticas por etapa',
      error: error.message,
      tenantId: req.tenantId,
      query: req.query
    });
    
    res.status(500).send({
      result: 'error',
      message: 'Error obteniendo estadísticas por etapa'
    });
  }
});

// GET /cost-tracking/total - Obtener costo total
router.get('/total', validateTenant, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const tenantId = req.tenantId;
    
    // Validar fechas
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();
    
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).send({
        result: 'error',
        message: 'Invalid date format. Use ISO 8601 format (YYYY-MM-DD)'
      });
    }
    
    const total = await CostTrackingService.getTotalCost(tenantId, start, end);
    
    res.status(200).send({
      result: 'success',
      data: {
        tenantId: tenantId,
        period: {
          startDate: start.toISOString(),
          endDate: end.toISOString()
        },
        total: {
          cost: parseFloat(total.totalCost.toFixed(6)),
          tokens: total.totalTokens,
          operations: total.totalOperations,
          avgCostPerOperation: parseFloat(total.avgCostPerOperation.toFixed(6))
        }
      }
    });
    
  } catch (error) {
    console.error('Error obteniendo costo total:', error);
    insights.error({
      message: 'Error obteniendo costo total',
      error: error.message,
      tenantId: req.tenantId,
      query: req.query
    });
    
    res.status(500).send({
      result: 'error',
      message: 'Error obteniendo costo total'
    });
  }
});

// GET /cost-tracking/recent - Obtener costos recientes
router.get('/recent', validateTenant, async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    const tenantId = req.tenantId;
    
    const recentCosts = await CostTrackingService.getRecentCosts(tenantId, parseInt(limit));
    
    res.status(200).send({
      result: 'success',
      data: {
        tenantId: tenantId,
        recentCosts: recentCosts.map(cost => ({
          operation: cost.operation,
          model: cost.model,
          cost: parseFloat(cost.totalCost.toFixed(6)),
          tokens: cost.totalTokens.total,
          status: cost.status,
          createdAt: cost.createdAt,
          stages: cost.stages.map(stage => ({
            name: stage.name,
            cost: parseFloat(stage.cost.toFixed(6)),
            tokens: stage.tokens.total,
            model: stage.model,
            duration: stage.duration
          }))
        }))
      }
    });
    
  } catch (error) {
    console.error('Error obteniendo costos recientes:', error);
    insights.error({
      message: 'Error obteniendo costos recientes',
      error: error.message,
      tenantId: req.tenantId,
      query: req.query
    });
    
    res.status(500).send({
      result: 'error',
      message: 'Error obteniendo costos recientes'
    });
  }
});

module.exports = router; 