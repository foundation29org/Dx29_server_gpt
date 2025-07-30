'use strict';

const mongoose = require('../db_connect');
const Schema = mongoose.Schema;

const DiagnoseSessionSchema = new Schema({
  myuuid: {
    type: String,
    required: true,
    index: true
  },
  tenantId: {
    type: String,
    required: true,
    index: true
  },
  subscriptionId: {
    type: String,
    required: false,
    index: true
  },
  iframeParams: {
    type: Schema.Types.Mixed,
    default: {}
  },
  question: {
    originalText: {
      type: String,
      required: true
    },
    detectedLanguage: {
      type: String,
      required: true
    },
    translatedText: {
      type: String,
      required: true
    },
    anonymizedText: {
      type: String,
      default: ''
    },
    anonymizedTextHtml: {
      type: String,
      default: ''
    }
  },
  answer: {
    medicalAnswer: {
      type: String,
      default: ''
    },
    queryType: {
      type: String,
      required: true,
      enum: ['diagnostic', 'error', 'non-diagnostic', 'general', 'medical', 'other' ]
    },
    model: {
      type: String,
      required: true,
      default: 'o3-dxgpt'
    }
  },
  timezone: {
    type: String,
    required: true
  },
  lang: {
    type: String,
    required: true,
    default: 'en'
  },
  processingTime: {
    type: Number,
    required: true
  },
  status: {
    type: String,
    required: true,
    enum: ['success', 'error'],
    default: 'success'
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  }
});

// Índices compuestos para consultas eficientes
DiagnoseSessionSchema.index({ myuuid: 1, timestamp: -1 });
DiagnoseSessionSchema.index({ tenantId: 1, subscriptionId: 1, timestamp: -1 });
DiagnoseSessionSchema.index({ status: 1, timestamp: -1 });
DiagnoseSessionSchema.index({ 'answer.queryType': 1, timestamp: -1 });

module.exports = mongoose.model('DiagnoseSession', DiagnoseSessionSchema); 