'use strict';

const mongoose = require('../db_connect'); // importa el mongoose completo desde la conexión
const Schema = mongoose.Schema;

const SupportSchema = new Schema({
  subject: String,
  description: String,
  status: { type: String, default: 'unread' },
  email: String,
  subscribe: { type: Boolean, default: false },
  date: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Support', SupportSchema);