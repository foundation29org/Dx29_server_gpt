'use strict';

const mongoose = require('../db_connect');
const Schema = mongoose.Schema;

const QuestionsFeedbackSchema = new Schema({
  myuuid: String,
  type: String,
  helpful: Boolean,
  comments: String,
  email: String,
  question: String,
  answerHtml: String,
  references: String,
  detectedLang: String,
  model: String,
  fileNames: String,
  date: { type: Date, default: Date.now },
  tenantId: String,
  subscriptionId: String
});

module.exports = mongoose.model('QuestionsFeedback', QuestionsFeedbackSchema);


