const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const { conndbaccounts } = require('../db_connect')

const TicketSchema = new Schema({
  ticketId: {
    type: String,
    required: true,
    unique: true,
    index: true  // Indexamos para búsquedas más rápidas
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
  position: {
    type: Number
  },
  data: {
    type: Schema.Types.Mixed  // Para almacenar la respuesta de OpenAI
  },
  error: {
    type: Schema.Types.Mixed  // Para almacenar detalles del error si ocurre
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  requestInfo: {
    type: Schema.Types.Mixed  // Para almacenar información adicional de la solicitud
  },
  utilizationPercentage: {
    type: Number
  },
  estimatedWaitTime: {
    type: Number
  },
  result: Schema.Types.Mixed,
  processingTime: Number
});

// Índice compuesto para búsquedas frecuentes
TicketSchema.index({ status: 1, region: 1 });

module.exports = conndbaccounts.model('Ticket', TicketSchema); 