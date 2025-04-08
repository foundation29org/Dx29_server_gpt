const mongoose = require('mongoose');
const { conndbaccounts } = require('../db_connect');

const MetricsSchema = new mongoose.Schema({
  timestamp: {
    type: Date,
    default: Date.now,
    required: true,
    index: true
  },
  region: {
    type: String,
    required: true,
    index: true
  },
  period: {
    type: String,
    required: true,
    enum: ['minute', 'hour', 'day']
  },
  messagesProcessed: {
    type: Number,
    default: 0
  },
  messagesFailed: {
    type: Number,
    default: 0
  },
  averageProcessingTime: {
    type: Number,
    default: 0
  },
  queueLength: {
    type: Number,
    default: 0
  },
  utilizationPercentage: {
    type: Number,
    default: 0
  }
});

// Índices para búsquedas eficientes
MetricsSchema.index({ timestamp: 1, region: 1, period: 1 });

module.exports = conndbaccounts.model('Metrics', MetricsSchema); 