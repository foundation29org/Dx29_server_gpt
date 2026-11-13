'use strict';

const mongoose = require('../db_connect'); // importamos mongoose directamente
const Schema = mongoose.Schema;

// Mongo es la única fuente de las encuestas (desde el 13-nov-2026 ya no se copian a SharePoint).
// status, answeredAt y unsubscribedAt los escribe la página de gestión local de la skill
// revisar-soporte, no el servidor. Unos pocos registros traen además emailOriginal o
// source = 'sharepoint' + spItemId de la migración desde SharePoint.
const GeneralfeedbackSchema = new Schema({
  myuuid: String,
  fileNames: String,
  model: String,
  pregunta1: String,
  pregunta2: String,
  userType: String,
  moreFunct: String,
  freeText: String,
  email: String,
  healthcareSpecialty: String,
  providedHealthcareSpecialty: Boolean,
  inferenceMeta: Schema.Types.Mixed,
  date: { type: Date, default: Date.now },
  tenantId: String,
  subscriptionId: String,
  isBetaPage: Boolean,
  lang: String, // idioma de la interfaz; elige el idioma de las novedades
  status: { type: String, default: 'unread' }, // 'unread' | 'answered'
  answeredAt: Date,
  unsubscribedAt: Date, // se dio de baja de las novedades
});

module.exports = mongoose.model('Generalfeedback', GeneralfeedbackSchema);