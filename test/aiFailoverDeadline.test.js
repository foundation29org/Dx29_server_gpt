'use strict';

// callAiWithFailover con plazo (options.deadline) y en modo silencioso
// (options.quiet), como la usa llmTranslation; y sin opciones, como siempre.
const REGIONS = ['as1', 'as2', 'eu1', 'us1', 'us2'];
for (const region of REGIONS) {
  const key = region.toUpperCase();
  process.env[`AZURE_OPENAI_${key}_BASE_URL`] = `https://${region}.openai.test`;
  process.env[`AZURE_OPENAI_${key}_KEY`] = `key-${region}`;
}

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

const state = { posts: [], responses: [], events: [], errors: [] };

stubModule('axios', {
  post: async (url, body, options) => {
    state.posts.push({ url, timeout: options.timeout });
    const next = state.responses.shift();
    if (next instanceof Error) throw next;
    return { data: next };
  }
});
stubModule('../services/insights', {
  trackEvent: (name) => state.events.push(name),
  error: (message) => state.errors.push(message)
});

const { callAiWithFailover } = require('../services/aiUtils');

function reset(responses) {
  state.posts = [];
  state.responses = responses;
  state.events = [];
  state.errors = [];
}

const networkTimeout = () => Object.assign(new Error('timeout of 300ms exceeded'), { code: 'ECONNABORTED' });
const BODY = { messages: [{ role: 'user', content: 'hola' }] };

test('the request is cut at the deadline, with no jump to another region without time left', async () => {
  reset([networkTimeout(), { ok: true }]);
  const deadline = Date.now() + 300;
  await assert.rejects(
    callAiWithFailover(BODY, 'Europe/Madrid', 'gpt61terra', 0, null, { deadline, quiet: true }),
    /timeout of 300ms/
  );
  assert.equal(state.posts.length, 1);
  assert.ok(state.posts[0].timeout <= 300);
  assert.match(state.posts[0].url, /eu1\.openai\.test\/openai\/deployments\/gpt-6\.1-terra\//);
  assert.deepEqual(state.events, ['AiAllEndpointsFailed']);
  // quiet: el fallo tiene respaldo, así que no se registra como excepción
  assert.deepEqual(state.errors, []);
});

test('a deadline already past does not call the model', async () => {
  reset([{ ok: true }]);
  await assert.rejects(
    callAiWithFailover(BODY, 'Europe/Madrid', 'gpt61terra', 0, null, { deadline: Date.now() - 1, quiet: true }),
    (error) => error.code === 'AI_DEADLINE_EXCEEDED'
  );
  assert.equal(state.posts.length, 0);
});

test('with time left, a failed region still fails over to the next one', async () => {
  const throttled = Object.assign(new Error('429'), { response: { status: 429, headers: { 'retry-after-ms': '0' } } });
  reset([throttled, { ok: true }]);
  const response = await callAiWithFailover(BODY, 'Europe/Madrid', 'gpt61terra', 0, null,
    { deadline: Date.now() + 10000, quiet: true });
  assert.deepEqual(response.data, { ok: true });
  assert.equal(state.posts.length, 2);
  assert.match(state.posts[1].url, /us1\.openai\.test/);
});

test("with a deadline, the failed region's Retry-After is not waited before trying another region", async () => {
  const unavailable = Object.assign(new Error('503'), { response: { status: 503, headers: { 'retry-after': '10' } } });
  reset([unavailable, { ok: true }]);
  const startedAt = Date.now();
  await callAiWithFailover(BODY, 'Europe/Madrid', 'gpt61terra', 0, null, { deadline: Date.now() + 8000, quiet: true });
  assert.equal(state.posts.length, 2);
  assert.ok(Date.now() - startedAt < 2000, 'it should not sleep the 10 s Retry-After');
});

test('with a deadline, there is no jump to another region with less than 3 s left', async () => {
  reset([networkTimeout(), { ok: true }]);
  await assert.rejects(
    callAiWithFailover(BODY, 'Europe/Madrid', 'gpt61terra', 0, null, { deadline: Date.now() + 2500, quiet: true })
  );
  assert.equal(state.posts.length, 1);
});

test('without options it behaves as before: long timeout and the final failure as an exception', async () => {
  const rejected = Object.assign(new Error('400'), { response: { status: 400, data: { error: { code: 'content_filter' } } } });
  reset([rejected]);
  await assert.rejects(callAiWithFailover(BODY, 'Europe/Madrid', 'gpt61terra'));
  assert.ok(state.posts[0].timeout > 15000);
  assert.deepEqual(state.events, ['AiRequestRejected']);
  assert.deepEqual(state.errors, ['AI request rejected without fallback']);
});
