'use strict';

const mongoose = require('../db_connect');
const Schema = mongoose.Schema;

const OpinionStatsSchema = new Schema({
  myuuid: String,
  lang: String,
  vote: String,
  topRelatedConditions: Array,
  isNewModel: Boolean,
  tenantId: String,
  subscriptionKeyHash: String,
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('OpinionStats', OpinionStatsSchema); 