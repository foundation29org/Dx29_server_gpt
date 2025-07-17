'use strict';

const mongoose = require('../db_connect');
const Schema = mongoose.Schema;

const ClientConfigSchema = new Schema({
  // ID corto para referencias externas (basado en IV)
  clientId: { type: String, required: true, unique: true },
  // APIM Subscription ID para identificación del cliente
  subscriptionId: { type: String, index: true },
  // 'tenant' o 'marketplace'
  type: { type: String, enum: ['tenant', 'marketplace'], required: true },
  // true = guardar en blob, false = no guardar
  saveToBlob: { type: Boolean, default: true },
  // Nombre descriptivo del cliente
  name: { type: String },
  // Campo para identificar el producto de APIM
  product: { type: String },
  createdAt: { type: Date, default: Date.now }
});

// Método estático para buscar por subscriptionId
ClientConfigSchema.statics.findBySubscriptionId = function(subscriptionId) {
  return this.findOne({ subscriptionId });
};

// Método estático para buscar por cualquier identificador
ClientConfigSchema.statics.findByAnyId = function(identifier) {
  return this.findOne({
    $or: [
      { clientId: identifier },
      { subscriptionId: identifier }
    ]
  });
};

module.exports = mongoose.model('ClientConfig', ClientConfigSchema); 