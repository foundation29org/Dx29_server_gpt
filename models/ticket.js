'use strict';

const mongoose = require('../db_connect'); // <- usamos la conexión centralizada
const Schema = mongoose.Schema;

const TicketSchema = new Schema({
  myuuid: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  status: {
    type: String,
    required: true,
    enum: ['queued', 'processing', 'completed', 'error'],
    default: 'queued'
  },
  region: {
    type: String,
    required: true
  },
  model: {
    type: String,
    required: true,
    enum: ['gpt4o', 'o1', 'o3', 'o3pro']
  },
  position: Number,
  requestData: Schema.Types.Mixed,
  requestInfo: Schema.Types.Mixed,
  error: Schema.Types.Mixed,
  timestamp: {
    type: Date,
    default: Date.now
  },
  utilizationPercentage: Number,
  estimatedWaitTime: Number,
  result: Schema.Types.Mixed,
  processingTime: Number
});

// Índice compuesto
TicketSchema.index({ status: 1, region: 1, model: 1 });
TicketSchema.index({ timestamp: 1, model: 1 });

module.exports = mongoose.model('Ticket', TicketSchema);