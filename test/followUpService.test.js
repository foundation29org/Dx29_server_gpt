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

const state = { prompts: [], detectCalls: 0, translateCalls: 0, aiContent: '[]' };

stubModule('../services/aiUtils', {
  detectLanguageWithRetry: async () => {
    state.detectCalls += 1;
    return 'es';
  },
  translateTextWithRetry: async (text) => {
    state.translateCalls += 1;
    return text;
  },
  translateInvertWithRetry: async (text) => text,
  sanitizeInput: (input) => input.trim(),
  callAiWithFailover: async (requestBody) => {
    state.prompts.push(requestBody.messages[0].content);
    return {
      data: {
        usage: {},
        choices: [{ message: { content: state.aiContent } }]
      }
    };
  },
  parseJsonWithFixes: async (content) => JSON.parse(content)
});
stubModule('../services/costUtils', {
  calculatePrice: () => ({ totalCost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
  formatCost: () => '0'
});
stubModule('../services/costTrackingService', { saveCostRecordBestEffort: async () => {} });
stubModule('../services/email', { sendMailErrorGPTIP: async () => {} });
stubModule('../services/insights', { error: () => {} });
stubModule('../services/multimodalUploadService', {
  isValidUploadId: (value) => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)
});

const {
  generateFollowUpQuestions,
  processFollowUpAnswers,
  generateERQuestions
} = require('../services/followUpService');

const UPLOAD_ID = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const baseBody = {
  myuuid: '9e82f00f-8d3a-4f55-9a5c-2c4a7f0e6b11',
  lang: 'es',
  timezone: 'Europe/Madrid'
};

function fakeResponse() {
  const res = { statusCode: null, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.send = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

async function call(handler, body) {
  const res = fakeResponse();
  await handler({ body, headers: { 'x-tenant-id': 'test-tenant' }, method: 'POST', url: '/', connection: { remoteAddress: '127.0.0.1' }, get: () => undefined }, res);
  return res;
}

test.beforeEach(() => {
  state.prompts = [];
  state.detectCalls = 0;
  state.translateCalls = 0;
});

test('image-only hypothesis follow-up works without a description', async () => {
  state.aiContent = '["¿Fuma?"]';
  const res = await call(generateFollowUpQuestions, {
    ...baseBody,
    description: '',
    diseases: 'Enfisema bulloso gigante',
    mode: 'hypothesis',
    uploadId: UPLOAD_ID
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result, 'success');
  assert.deepEqual(res.body.data.questions, ['¿Fuma?']);
  assert.equal(res.body.detectedLang, 'es');
  assert.equal(state.detectCalls, 0);
  assert.equal(state.translateCalls, 1, 'only the disease list is translated');
  assert.match(state.prompts[0], /submitted as medical images/);
});

test('follow-up still requires a description without an upload', async () => {
  const res = await call(generateFollowUpQuestions, {
    ...baseBody,
    description: '',
    diseases: 'Enfisema bulloso gigante',
    mode: 'hypothesis'
  });

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body.details, [{ field: 'description', reason: 'Field is required' }]);
});

test('an upload allows a short description but keeps the length limit', async () => {
  state.aiContent = '["¿Desde cuándo?"]';
  const shortRes = await call(generateFollowUpQuestions, {
    ...baseBody,
    description: 'tos',
    diseases: 'Neumonía',
    mode: 'general',
    uploadId: UPLOAD_ID
  });
  assert.equal(shortRes.statusCode, 200);
  assert.doesNotMatch(state.prompts[0], /submitted as medical images/);

  const longRes = await call(generateFollowUpQuestions, {
    ...baseBody,
    description: 'x'.repeat(8001),
    diseases: 'Neumonía',
    mode: 'general',
    uploadId: UPLOAD_ID
  });
  assert.equal(longRes.statusCode, 400);
  assert.deepEqual(longRes.body.details, [{ field: 'description', reason: 'Must not exceed 8000 characters' }]);
});

test('image-only guided questions before diagnosis work without a description', async () => {
  state.aiContent = '["¿Qué edad tiene?"]';
  const res = await call(generateERQuestions, {
    ...baseBody,
    description: '',
    uploadId: UPLOAD_ID
  });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.result, 'success');
  assert.deepEqual(res.body.data.questions, ['¿Qué edad tiene?']);
  assert.equal(state.detectCalls, 0);
  assert.equal(state.translateCalls, 0);
  assert.match(state.prompts[0], /submitted as medical images/);
});

test('guided questions before diagnosis still require a description without an upload', async () => {
  const res = await call(generateERQuestions, { ...baseBody, description: '' });

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body.details, [{ field: 'description', reason: 'Field is required' }]);
});

test('image-only answers are processed without a description', async () => {
  state.aiContent = 'Fumador de 40 paquetes-año.';
  const res = await call(processFollowUpAnswers, {
    ...baseBody,
    description: '',
    answers: [{ question: '¿Fuma?', answer: 'Sí, 40 paquetes-año' }],
    mode: 'hypothesis',
    detectedLanguage: 'es',
    uploadId: UPLOAD_ID
  });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.result, 'success');
  assert.ok(res.body.data.updatedDescription);
  assert.equal(state.detectCalls, 0);
  assert.match(state.prompts[0], /submitted as medical images/);
});
