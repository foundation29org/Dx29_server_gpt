'use strict';

const mongoose = require('../db_connect');
const Schema = mongoose.Schema;

const ClientConfigSchema = new Schema({
  // Puede ser tenantId o subscriptionKeyHash
  clientId: { type: String, required: true, unique: true },
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

module.exports = mongoose.model('ClientConfig', ClientConfigSchema); 