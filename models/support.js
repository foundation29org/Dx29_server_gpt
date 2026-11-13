'use strict';

const mongoose = require('../db_connect'); // importa el mongoose completo desde la conexión
const Schema = mongoose.Schema;

// Mongo es la única fuente de los mensajes de soporte (desde el 13-nov-2026 ya no se copian a
// SharePoint). status, answeredAt y unsubscribedAt los escribe la página de gestión local de la
// skill revisar-soporte, no el servidor. Unos pocos registros traen además emailOriginal o
// source = 'sharepoint' + spItemId de la migración desde SharePoint.
const SupportSchema = new Schema({
  subject: String,
  description: String,
  status: { type: String, default: 'unread' }, // 'unread' | 'answered'
  answeredAt: Date,
  email: String,
  subscribe: { type: Boolean, default: false }, // quiere recibir las novedades
  unsubscribedAt: Date, // se dio de baja de las novedades
  date: { type: Date, default: Date.now },
  tenantId: String,
  subscriptionId: String,
  myuuid: String,
  lang: String
});

module.exports = mongoose.model('Support', SupportSchema);