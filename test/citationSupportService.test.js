'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function stubModule(modulePath, exports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports
  };
}

const state = { calls: [], aiContent: '{"passages":[2]}', aiError: null, costRecords: [], events: [], errors: [] };

stubModule('../services/aiUtils', {
  sanitizeInput: (input) => String(input).replace(/[{}]/g, '').trim(),
  callAiWithFailover: async (requestBody, timezone, model, retryCount, dataRequest) => {
    state.calls.push({ requestBody, timezone, model, dataRequest });
    if (state.aiError) {
      throw state.aiError;
    }
    return {
      data: {
        usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
        choices: [{ message: { content: state.aiContent } }]
      }
    };
  }
});
stubModule('../services/costUtils', {
  calculatePrice: () => ({ totalCost: 0.0001, inputTokens: 100, outputTokens: 5, totalTokens: 105 })
});
stubModule('../services/costTrackingService', {
  saveCostRecordBestEffort: async (record) => {
    state.costRecords.push(record);
  }
});
stubModule('../services/insights', {
  error: (info) => state.errors.push(info),
  trackEvent: (name, properties) => state.events.push({ name, properties })
});

const {
  findCitationSupport,
  validateCitationSupportRequest,
  parseSupportingPassages,
  MAX_BLOCKS,
  MAX_BLOCK_CHARS
} = require('../services/citationSupportService');

const MYUUID = '9e82f00f-8d3a-4f55-9a5c-2c4a7f0e6b11';
const baseBody = {
  myuuid: MYUUID,
  timezone: 'Europe/Madrid',
  lang: 'es',
  sentence: 'La dosis habitual es de 500 mg cada 8 horas.',
  blocks: [
    'Amoxicillin is a penicillin antibiotic.',
    'The usual adult dose is 500 mg every 8 hours.',
    'Store below 25 °C.'
  ]
};

function createResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    }
  };
}

function createRequest(body, headers = { 'x-tenant-id': 'dxgpt-local' }) {
  return { body, headers };
}

test.beforeEach(() => {
  state.calls = [];
  state.aiContent = '{"passages":[2]}';
  state.aiError = null;
  state.costRecords = [];
  state.events = [];
  state.errors = [];
});

test('returns the 0-based indexes of the passages the model selects and records the cost', async () => {
  const res = createResponse();
  await findCitationSupport(createRequest(baseBody), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { result: 'success', data: { blocks: [1] } });
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].model, 'gpt56luna');
  assert.equal(state.calls[0].timezone, 'Europe/Madrid');
  assert.equal(state.calls[0].dataRequest.myuuid, MYUUID);
  const userPrompt = state.calls[0].requestBody.messages[1].content;
  assert.match(userPrompt, /\[2\] The usual adult dose is 500 mg every 8 hours\./);
  assert.equal(state.costRecords.length, 1);
  assert.equal(state.costRecords[0].operation, 'citation_support');
  assert.equal(state.costRecords[0].stages[0].name, 'citation_support');
  assert.equal(state.events[0].name, 'MedicalCitationSupport');
  assert.equal(state.events[0].properties.found, 'true');
});

test('returns an empty list when no passage supports the claim', async () => {
  state.aiContent = '{"passages": []}';
  const res = createResponse();
  await findCitationSupport(createRequest(baseBody), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data.blocks, []);
  assert.equal(state.events[0].properties.found, 'false');
});

test('rejects requests without tenant or subscription headers', async () => {
  const res = createResponse();
  await findCitationSupport(createRequest(baseBody, {}), res);
  assert.equal(res.statusCode, 400);
  assert.equal(state.calls.length, 0);
});

test('rejects invalid bodies without calling the model or logging their text', async () => {
  const res = createResponse();
  await findCitationSupport(createRequest({ ...baseBody, blocks: [] }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(state.calls.length, 0);
  assert.equal(state.errors.length, 1);
  assert.equal(JSON.stringify(state.errors[0]).includes('500 mg'), false);
});

test('answers 500 when the model call fails', async () => {
  state.aiError = Object.assign(new Error('timeout'), { response: { status: 504 } });
  const res = createResponse();
  await findCitationSupport(createRequest(baseBody), res);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { result: 'error' });
  assert.equal(state.errors[0].statusCode, 504);
});

test('validation enforces sizes and types', () => {
  assert.deepEqual(validateCitationSupportRequest(baseBody), []);
  const fields = (body) => validateCitationSupportRequest(body).map(error => error.field);
  assert.deepEqual(fields(null), ['request']);
  assert.deepEqual(fields({ ...baseBody, myuuid: 'abc' }), ['myuuid']);
  assert.deepEqual(fields({ ...baseBody, sentence: '' }), ['sentence']);
  assert.deepEqual(fields({ ...baseBody, sentence: 'x'.repeat(1201) }), ['sentence']);
  assert.deepEqual(fields({ ...baseBody, blocks: 'text' }), ['blocks']);
  assert.deepEqual(fields({ ...baseBody, blocks: [1, 2] }), ['blocks']);
  assert.deepEqual(fields({ ...baseBody, blocks: ['x'.repeat(MAX_BLOCK_CHARS + 1)] }), ['blocks']);
  assert.deepEqual(fields({ ...baseBody, blocks: Array(MAX_BLOCKS + 1).fill('a') }), ['blocks']);
  assert.deepEqual(fields({ ...baseBody, blocks: Array(20).fill('x'.repeat(MAX_BLOCK_CHARS)) }), ['blocks']);
  assert.deepEqual(fields({ ...baseBody, lang: 'x' }), ['lang']);
  assert.deepEqual(fields({ ...baseBody, timezone: 5 }), ['timezone']);
});

test('parseSupportingPassages only accepts valid, unique passage numbers', () => {
  const blocks = ['a', 'b', '', 'd'];
  assert.deepEqual(parseSupportingPassages('{"passages":[2,1]}', blocks), [1, 0]);
  assert.deepEqual(parseSupportingPassages('```json\n{"passages":[4]}\n```', blocks), [3]);
  assert.deepEqual(parseSupportingPassages('{"passages":[2,2,9,0,-1,"x",1.5]}', blocks), [1]);
  // Un bloque vacío no se puede resaltar
  assert.deepEqual(parseSupportingPassages('{"passages":[3]}', blocks), []);
  assert.deepEqual(parseSupportingPassages('{"passages":[1,2,4,1]}', blocks), [0, 1, 3]);
  // Como mucho 4 bloques, en el orden que da el modelo
  assert.deepEqual(parseSupportingPassages('{"passages":[5,1,2,3,4], "x": 1}', ['a', 'b', 'c', 'd', 'e']), [4, 0, 1, 2]);
  assert.deepEqual(parseSupportingPassages('no json', blocks), []);
  assert.deepEqual(parseSupportingPassages('{"passages": "2"}', blocks), []);
  assert.deepEqual(parseSupportingPassages(undefined, blocks), []);
});
