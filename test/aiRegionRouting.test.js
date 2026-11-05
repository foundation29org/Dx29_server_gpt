'use strict';

// Enrutado por región de las llamadas a Azure OpenAI: la zona horaria elige
// la región primaria y el orden de failover. Antes había además una cola de
// Service Bus por modelo-región, pero nunca decidía a qué región se llamaba.
const REGIONS = ['as1', 'as2', 'eu1', 'us1', 'us2'];
process.env.IS_SELF_HOSTED = 'false';
for (const region of REGIONS) {
  const key = region.toUpperCase();
  process.env[`AZURE_OPENAI_${key}_BASE_URL`] = `https://${region}.openai.test`;
  process.env[`AZURE_OPENAI_${key}_KEY`] = `key-${region}`;
}

const test = require('node:test');
const assert = require('node:assert/strict');

const { getEndpointsByTimezone, DEFAULT_AI_MODEL } = require('../services/aiUtils');

const regionsFor = (timezone, model) =>
  getEndpointsByTimezone(timezone, model).map((endpoint) => endpoint.region);

test('Terra goes to the region closest to the user, with a failover in another region', () => {
  assert.equal(DEFAULT_AI_MODEL, 'gpt56terra');
  assert.deepEqual(regionsFor('Europe/Madrid', 'gpt56terra'), ['eu1', 'us2']);
  assert.deepEqual(regionsFor('Africa/Lagos', 'gpt56terra'), ['eu1', 'us2']);
  assert.deepEqual(regionsFor('America/Mexico_City', 'gpt56terra'), ['us2', 'us1']);
  assert.deepEqual(regionsFor('America/Sao_Paulo', 'gpt56terra'), ['us2', 'us1']);
  assert.deepEqual(regionsFor('Asia/Kolkata', 'gpt56terra'), ['as1', 'us1']);
  assert.deepEqual(regionsFor('Australia/Sydney', 'gpt56terra'), ['as1', 'us1']);
  assert.deepEqual(regionsFor('Pacific/Auckland', 'gpt56terra'), ['as1', 'us1']);
});

test('a timezone without a continent uses the default regions', () => {
  assert.deepEqual(regionsFor('UTC', 'gpt56terra'), ['us2', 'eu1']);
  assert.deepEqual(regionsFor(undefined, 'gpt56terra'), ['us2', 'eu1']);
});

test('each model keeps its own region list', () => {
  assert.deepEqual(regionsFor('Europe/Madrid', 'gpt54mini'), ['eu1', 'us1']);
  assert.deepEqual(regionsFor('Asia/Tokyo', 'gpt54mini'), ['as1', 'as2']);
  assert.deepEqual(regionsFor('America/New_York', 'gpt5nano'), ['us2', 'eu1']);
  assert.deepEqual(regionsFor('America/New_York', 'gpt61sol'), ['us2', 'us1', 'eu1']);
});

test('an unknown model is routed as Terra', () => {
  assert.deepEqual(
    regionsFor('Europe/Madrid', 'not-a-model'),
    regionsFor('Europe/Madrid', 'gpt56terra')
  );
});

test('every endpoint points at its region and at the model deployment', () => {
  for (const endpoint of getEndpointsByTimezone('Asia/Kolkata', 'gpt56terra')) {
    assert.ok(endpoint.url.startsWith(`https://${endpoint.region}.openai.test/`), endpoint.url);
    assert.match(endpoint.url, /\/openai\/deployments\/gpt-5\.6-terra\/chat\/completions\?api-version=/);
    assert.equal(endpoint.apiKey, `key-${endpoint.region}`);
  }
});
