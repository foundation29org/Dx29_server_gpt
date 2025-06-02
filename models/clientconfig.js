'use strict';

const mongoose = require('../db_connect');
const Schema = mongoose.Schema;

const ClientConfigSchema = new Schema({
  // ID corto para referencias externas (basado en IV)
  clientId: { type: String, required: true, unique: true },
  // Datos de encriptación
  subscription: {
    encrypted: { type: String, required: true },
    iv: { type: String, required: true },
    tag: { type: String, required: true }
  },
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

// Método para obtener la subscription key desencriptada
ClientConfigSchema.methods.getSubscriptionKey = async function() {
  const decryptSubscriptionKey = require('../services/servicedxgpt').decryptSubscriptionKey;
  return decryptSubscriptionKey(
    this.subscription.encrypted,
    this.subscription.iv,
    this.subscription.tag
  );
};

module.exports = mongoose.model('ClientConfig', ClientConfigSchema); 