'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const routingConfig = require('../services/multimodalImageRoutingConfig');

test('uses the same fixed V1 routing settings in every environment', () => {
  assert.equal(routingConfig.getImageClassifierModel(), 'gpt56terra');
  assert.equal(routingConfig.getImageClassifierConfidence(), 0.9);
  assert.equal(routingConfig.getImageClassifierConcurrency(), 2);
  assert.equal(routingConfig.getImageOcrMinChars(), 20);
});
