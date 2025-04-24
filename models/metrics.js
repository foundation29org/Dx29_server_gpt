'use strict';

const mongoose = require('../db_connect'); // usamos mongoose completo desde la conexión central
const Schema = mongoose.Schema;

const MetricsSchema = new Schema({
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

// Índice compuesto
MetricsSchema.index({ timestamp: 1, region: 1, period: 1 });

module.exports = mongoose.model('Metrics', MetricsSchema);