'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function stubModule(modulePath, exports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = { id: resolvedPath, filename: resolvedPath, loaded: true, exports };
}

// El adaptador de Claude en Foundry: qué se pide a Fable y cómo vuelve la respuesta
// con la forma de Azure OpenAI que espera helpDiagnose.
const config = {
  AZURE_OPENAI_TIMEOUT_MS: 180000,
  AZURE_CLAUDE: { resource: 'dxgptbot', apiKey: 'test-key', deployment: 'claude-fable-5-2', effort: 'low', maxTokens: 12000 }
};
const state = { clients: [], requests: [], events: [], reply: null };

stubModule('../config', config);
stubModule('../services/insights', {
  error: () => {},
  trackEvent: (name, properties) => state.events.push({ name, properties })
});
stubModule('@anthropic-ai/foundry-sdk', {
  AnthropicFoundry: class {
    constructor(options) {
      state.clients.push(options);
      this.messages = {
        stream: (params) => {
          state.requests.push(params);
          return { finalMessage: () => state.reply() };
        }
      };
    }
  }
});

const { callClaudeDiagnosis, resetClaudeClientForTests } = require('../services/claudeFoundry');

function reset(reply) {
  state.clients = [];
  state.requests = [];
  state.events = [];
  state.reply = reply;
  resetClaudeClientForTests();
}

test('Fable gets the prompt with low effort, and the answer comes back as choices with usage', async () => {
  reset(async () => ({
    content: [
      { type: 'thinking', thinking: '...' },
      { type: 'text', text: '[{"diagnosis":' },
      { type: 'text', text: '"X"}]' }
    ],
    stop_reason: 'end_turn',
    usage: { input_tokens: 300, cache_read_input_tokens: 20, output_tokens: 1600 },
    _request_id: 'req_1'
  }));
  const response = await callClaudeDiagnosis('the case', { dataRequest: { tenantId: 't', myuuid: 'u' } });

  assert.deepEqual(state.clients[0], { resource: 'dxgptbot', apiKey: 'test-key', maxRetries: 1, timeout: 180000 });
  assert.deepEqual(state.requests[0], {
    model: 'claude-fable-5-2',
    max_tokens: 12000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: 'the case' }]
  });
  assert.equal(response.data.choices[0].message.content, '[{"diagnosis":"X"}]');
  assert.deepEqual(response.data.usage, { prompt_tokens: 320, completion_tokens: 1600, total_tokens: 1920 });
  const [event] = state.events;
  assert.equal(event.name, 'AdvancedDiagnosisCall');
  assert.equal(event.properties.ok, 'true');
  assert.equal(event.properties.requestId, 'req_1');
});

test('images go after the text as base64 blocks with their type', async () => {
  reset(async () => ({ content: [{ type: 'text', text: '[]' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
  await callClaudeDiagnosis('the case', {
    images: [
      { name: 'a.png', url: 'data:image/png;base64,iVBOR' },
      { name: 'b.webp', url: 'data:image/webp;base64,UklGR' },
      { name: 'odd', url: 'https://example.com/x.jpg' }
    ]
  });
  assert.deepEqual(state.requests[0].messages[0].content, [
    { type: 'text', text: 'the case' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'UklGR' } }
  ]);
  assert.equal(state.events[0].properties.imageCount, '3');
});

test('an image over Claude\'s 5 MB base64 limit is rejected before calling, with its own code', async () => {
  reset(async () => { throw new Error('should not be called'); });
  const big = 'A'.repeat(5 * 1024 * 1024 + 1);
  await assert.rejects(
    callClaudeDiagnosis('the case', { images: [{ name: 'photo.jpg', url: `data:image/jpeg;base64,${big}` }] }),
    { code: 'ADVANCED_IMAGE_TOO_LARGE' }
  );
  assert.equal(state.requests.length, 0);
  // Queda en App Insights aunque no se llame a Fable
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].name, 'AdvancedDiagnosisCall');
  assert.equal(state.events[0].properties.status, 'image_too_large');
  assert.equal(state.events[0].properties.imageBase64Bytes, String(big.length));
});

test('a request that can never pass is not offered for retry; quota and server errors are', async () => {
  const failWith = (status) => async () => {
    const error = new Error(`status ${status}`);
    error.status = status;
    throw error;
  };
  for (const [status, code] of [[400, 'ADVANCED_MODEL_REJECTED'], [404, 'ADVANCED_MODEL_REJECTED'],
    [429, 'ADVANCED_MODEL_UNAVAILABLE'], [529, 'ADVANCED_MODEL_UNAVAILABLE'], [undefined, 'ADVANCED_MODEL_UNAVAILABLE']]) {
    reset(failWith(status));
    await assert.rejects(callClaudeDiagnosis('the case'), { code }, `status ${status}`);
  }
});

test('a refusal from Fable is an error with its own code', async () => {
  reset(async () => ({ content: [], stop_reason: 'refusal', usage: { input_tokens: 0, output_tokens: 0 } }));
  await assert.rejects(callClaudeDiagnosis('the case'), { code: 'ADVANCED_MODEL_REFUSED' });
});

test('a failed call is reported with its status and a code the client understands', async () => {
  reset(async () => {
    const error = new Error('rate limited');
    error.status = 429;
    error.requestID = 'req_2';
    throw error;
  });
  await assert.rejects(callClaudeDiagnosis('the case'), (error) => {
    assert.equal(error.code, 'ADVANCED_MODEL_UNAVAILABLE');
    assert.equal(error.statusCode, 429);
    return true;
  });
  assert.equal(state.events[0].properties.ok, 'false');
  assert.equal(state.events[0].properties.status, '429');
  assert.equal(state.events[0].properties.requestId, 'req_2');
});

test('without a resource or key the advanced model is unavailable', async () => {
  reset(async () => ({}));
  const saved = config.AZURE_CLAUDE;
  config.AZURE_CLAUDE = { ...saved, apiKey: '' };
  try {
    await assert.rejects(callClaudeDiagnosis('the case'), { code: 'ADVANCED_MODEL_UNAVAILABLE' });
    assert.equal(state.clients.length, 0);
  } finally {
    config.AZURE_CLAUDE = saved;
  }
});
