'use strict';

const mongoose = require('../db_connect'); // importamos mongoose directamente
const Schema = mongoose.Schema;

const GeneralfeedbackSchema = new Schema({
  myuuid: String,
  pregunta1: String,
  pregunta2: String,
  userType: String,
  moreFunct: String,
  freeText: String,
  email: String,
  date: { type: Date, default: Date.now },
  tenantId: String,
  subscriptionKeyHash: String
});

module.exports = mongoose.model('Generalfeedback', GeneralfeedbackSchema);