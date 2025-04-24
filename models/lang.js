'use strict';

const mongoose = require('../db_connect'); // mongoose completo
const Schema = mongoose.Schema;

const LangSchema = new Schema({
  name: { type: String, unique: true, required: true },
  code: { type: String, index: true, unique: true, required: true }
}, { versionKey: false });

module.exports = mongoose.model('Lang', LangSchema);