'use strict';

const crypto = require('node:crypto');
const mongoose = require('../db_connect');
const Schema = mongoose.Schema;

const MultimodalAssetSchema = new Schema({
  assetId: {
    type: String,
    default: () => crypto.randomUUID(),
    required: true,
    unique: true,
    index: true
  },
  blobName: {
    type: String,
    required: true,
    unique: true
  },
  containerName: {
    type: String,
    required: true,
    default: 'files'
  },
  originalName: {
    type: String,
    required: true
  },
  mimeType: {
    type: String,
    required: true
  },
  size: {
    type: Number,
    required: true,
    min: 0
  },
  myuuid: {
    type: String,
    required: true,
    index: true
  },
  tenantId: {
    type: String,
    default: null,
    index: true
  },
  subscriptionId: {
    type: String,
    default: null,
    index: true
  },
  expiresAt: {
    type: Date,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// expiresAt se comprueba en query. blobCleanup borra el fichero a las 24 h.
// No usamos TTL de Mongo: en Cosmos ese índice puede fallar al arrancar.
MultimodalAssetSchema.index({ expiresAt: 1 });
MultimodalAssetSchema.index({
  assetId: 1,
  myuuid: 1,
  tenantId: 1,
  subscriptionId: 1
});

module.exports = mongoose.model('MultimodalAsset', MultimodalAssetSchema);
