'use strict';

const mongoose = require('../db_connect');
const Schema = mongoose.Schema;

const PermalinkSchema = new Schema({
  permalinkId: {
    type: String,
    required: true
  },
  medicalDescription: {
    type: String,
    required: true
  },
  anonymizedDescription: {
    type: String,
    required: true
  },
  diagnoses: {
    type: [Schema.Types.Mixed],
    required: true
  },
  lang: {
    type: String,
    required: true
  },
  createdDate: {
    type: Date,
    required: true,
    default: Date.now
  },
  myuuid: {
    type: String,
    required: true
  }
});

// Índices para optimizar consultas
PermalinkSchema.index({ permalinkId: 1 }, { unique: true });
PermalinkSchema.index({ createdDate: 1 });
PermalinkSchema.index({ myuuid: 1 });

module.exports = mongoose.model('Permalink', PermalinkSchema); 