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

const state = { azure: null, events: [], errors: [], costs: [] };

// multer is replaced by a middleware that "uploads" a small WebM, so the test needs no multipart.
stubModule('multer', Object.assign(
  () => ({
    single: () => (req, res, next) => {
      req.file = { buffer: Buffer.alloc(54526, 1), mimetype: 'audio/webm' };
      next();
    }
  }),
  { memoryStorage: () => ({}) }
));
stubModule('axios', { post: async () => state.azure() });
stubModule('../config', {
  AZURE_OPENAI_TRANSCRIBE: { region: 'eu1', deployment: 'gpt-4o-transcribe', apiVersion: 'v' },
  AZURE_OPENAI_REGIONS: { eu1: { baseUrl: 'https://azure.example', apiKey: 'secret' } }
});
stubModule('../services/insights', {
  error: (message, properties) => state.errors.push({ message, properties }),
  trackEvent: (name, properties) => state.events.push({ name, properties })
});
stubModule('../services/aiUtils', {
  extractProviderError: (error) => {
    const providerError = error.response?.data?.error;
    return providerError
      ? { providerErrorCode: providerError.code, providerErrorMessage: providerError.message }
      : {};
  }
});
stubModule('../services/costTrackingService', {
  saveSimpleOperationCostBestEffort: (...args) => state.costs.push(args)
});
stubModule('../services/costUtils', {
  calculateTranscriptionPrice: () => ({ totalCost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 })
});

const { transcribe, failureStatus } = require('../controllers/all/speechTranscribe');

function azureError(status, code) {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = { status, data: { error: { code, message: 'provider message' } } };
  return error;
}

async function call() {
  const res = {
    statusCode: null,
    body: null,
    set() { return this; },
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; }
  };
  const req = {
    headers: { 'x-tenant-id': 'dxgpt-prod' },
    body: { myuuid: 'u-1', language: 'en' }
  };
  await transcribe(req, res);
  return res;
}

test.beforeEach(() => {
  state.events = [];
  state.errors = [];
  state.costs = [];
});

test('Azure 400 invalid_value (unreadable audio) is answered 400 so the client does not retry', async () => {
  state.azure = () => { throw azureError(400, 'invalid_value'); };
  const res = await call();

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'Could not read the audio' });
});

test('an unreadable audio is an event, not an exception, and keeps the diagnostic properties', async () => {
  state.azure = () => { throw azureError(400, 'invalid_value'); };
  await call();

  assert.equal(state.errors.length, 0);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].name, 'AudioTranscriptionRejected');
  assert.equal(state.events[0].properties.audioBytes, '54526');
  assert.equal(state.events[0].properties.providerErrorCode, 'invalid_value');
  assert.equal(state.events[0].properties.myuuid, 'u-1');
});

test('the failed attempt is still recorded in the cost tracking', async () => {
  state.azure = () => { throw azureError(400, 'invalid_value'); };
  await call();

  assert.equal(state.costs.length, 1);
  assert.equal(state.costs[0][3], 'error');
});

test('other Azure failures are still 502 and still an exception (the client may retry them)', async () => {
  for (const status of [500, 503]) {
    state.errors = [];
    state.azure = () => { throw azureError(status, 'server_error'); };
    const res = await call();

    assert.equal(res.statusCode, 502, `status ${status}`);
    assert.equal(state.errors.length, 1, `status ${status}`);
  }
});

test('a 400 with another code is not treated as an unreadable audio', async () => {
  state.azure = () => { throw azureError(400, 'content_filter'); };
  const res = await call();

  assert.equal(res.statusCode, 502);
  assert.equal(state.errors.length, 1);
});

test('rate limiting stays 429 and a network failure stays 502', async () => {
  assert.equal(failureStatus(azureError(429, 'rate_limit')), 429);
  assert.equal(failureStatus(new Error('socket hang up')), 502);
});

test('a successful transcription is unchanged', async () => {
  state.azure = () => ({ data: { text: ' Hola doctor ', usage: {} } });
  const res = await call();

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { text: 'Hola doctor' });
  assert.equal(state.errors.length + state.events.length, 0);
});
