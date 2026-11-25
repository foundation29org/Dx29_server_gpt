'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function stubModule(modulePath, exports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = { id: resolvedPath, filename: resolvedPath, loaded: true, exports };
}

const state = { content: undefined, finishReason: 'stop', events: [] };

stubModule('../services/aiUtils', {
  getEndpointsByTimezone: () => [{ url: 'https://example.test/anon', apiKey: 'test-key' }]
});
stubModule('../services/insights', {
  error: () => {},
  trackEvent: (name, properties) => state.events.push({ name, properties })
});
stubModule('axios', {
  post: async () => ({
    data: {
      usage: { prompt_tokens: 10, completion_tokens: 10 },
      choices: [{ finish_reason: state.finishReason, message: { content: state.content } }]
    }
  })
});

const { anonymizeText } = require('../services/anonymizeService');

function respond(content, finishReason = 'stop') {
  state.content = content;
  state.finishReason = finishReason;
  state.events = [];
}

test('sin datos personales devuelve el texto tal cual y no marca fallo', async () => {
  respond('Fiebre de 3 días y tos.');
  const result = await anonymizeText('Fiebre de 3 días y tos.', 'Europe/Madrid');
  assert.equal(result.hasPersonalInfo, false);
  assert.equal(result.anonymizationFailed, false);
  assert.equal(result.anonymizedText, 'Fiebre de 3 días y tos.');
  assert.deepEqual(state.events, []);
});

test('con datos personales tapa los marcadores', async () => {
  respond('Paciente [ANON-10], fiebre.');
  const result = await anonymizeText('Paciente Juan Pérez, fiebre.', 'Europe/Madrid');
  assert.equal(result.hasPersonalInfo, true);
  assert.equal(result.anonymizationFailed, false);
  assert.equal(result.anonymizedText, 'Paciente **********, fiebre.');
});

test('sin contenido (filtro, null o solo comillas) marca el fallo y deja un evento', async () => {
  for (const [content, finishReason] of [[null, 'content_filter'], ['', 'stop'], ['  """  """ ', 'stop'], [undefined, 'length']]) {
    respond(content, finishReason);
    const result = await anonymizeText('Paciente Juan Pérez, fiebre.', 'Europe/Madrid', 'tenant', 'sub', 'uuid');
    assert.equal(result.anonymizationFailed, true, JSON.stringify(content));
    assert.equal(result.hasPersonalInfo, false);
    assert.equal(result.anonymizedText, '');
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0].name, 'AnonymizationEmpty');
    assert.equal(state.events[0].properties.finishReason, finishReason);
  }
});
