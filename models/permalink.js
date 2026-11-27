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
    default: ''
  },
  // Solo en los anteriores al 27-11-2026: la descripción en HTML con los datos tapados.
  anonymizedDescription: {
    type: String,
    default: ''
  },
  // Se taparon datos personales de medicalDescription (la vista lo avisa).
  anonymized: {
    type: Boolean,
    default: false
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