'use strict';

const mongoose = require('../db_connect'); // <- usamos la conexión centralizada
const Schema = mongoose.Schema;

const TicketSchema = new Schema({
  ticketId: {
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
  position: Number,
  data: Schema.Types.Mixed,
  error: Schema.Types.Mixed,
  timestamp: {
    type: Date,
    default: Date.now
  },
  requestInfo: Schema.Types.Mixed,
  utilizationPercentage: Number,
  estimatedWaitTime: Number,
  result: Schema.Types.Mixed,
  processingTime: Number
});

// Índice compuesto
TicketSchema.index({ status: 1, region: 1 });

module.exports = mongoose.model('Ticket', TicketSchema);