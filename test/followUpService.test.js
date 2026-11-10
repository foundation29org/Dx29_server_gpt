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

const state = { prompts: [], detectCalls: 0, translateCalls: [], answerCalls: [], reverseCalls: [], aiContent: '[]' };

stubModule('../services/aiUtils', {
  detectLanguageWithRetry: async () => {
    state.detectCalls += 1;
    return 'es';
  },
  sanitizeInput: (input) => input.trim(),
  suspiciousContentErrors: () => [],
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
// Las traducciones (gpt-6.1-terra con Azure de respaldo) tienen sus propias
// pruebas en llmTranslation.test.js; aquí solo se comprueba qué se manda.
stubModule('../services/llmTranslation', {
  SYNC_TO_ENGLISH_TIMEOUT_MS: 20000,
  // Como el real: lo que le queda a la petición de sus 40 s, y como mucho cap
  syncBudget: (startedAt, cap = 40000) => ({ maxBudgetMs: Math.min(cap, 40000 - (Date.now() - startedAt)) }),
  translateToEnglish: async (texts, lang, ctx, options) => {
    state.translateCalls.push(texts);
    state.translateOptions.push(options);
    if (state.translateFails) {
      // Fallan gpt-6.1-terra y Azure: el error lleva lo ya gastado
      const error = new Error('Azure Translator down');
      error.translationResult = { cost: 0.003, model: 'gpt61terra' };
      throw error;
    }
    return { texts: texts.map((text) => `[en] ${text}`), promptTokens: 5, completionTokens: 5 };
  },
  translateAnswersToEnglish: async (answers, lang, ctx, options) => {
    state.answerCalls.push(answers);
    state.translateOptions.push(options);
    return {
      answers: answers.map((item) => ({ ...item, question: `[en] ${item.question}`, answer: `[en] ${item.answer}` })),
      promptTokens: 5,
      completionTokens: 5,
      durationMs: 0,
      cost: 0.001
    };
  },
  translateTexts: async (texts, lang, ctx, options) => {
    state.reverseCalls.push({ texts, lang });
    state.reverseOptions.push(options);
    return { texts: texts.map((text) => `[${lang}] ${text}`), promptTokens: 10, completionTokens: 20 };
  },
  costStages: (result, name) => [{ name, cost: result.cost || 0, tokens: { input: 10, output: 20, total: 30 }, model: 'gpt61terra', duration: 0, success: true }]
});
stubModule('../services/costUtils', {
  calculatePrice: () => ({ totalCost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
  formatCost: () => '0'
});
stubModule('../services/costTrackingService', {
  saveCostRecordBestEffort: async (record) => { state.costRecords.push(record); }
});
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
  state.translateCalls = [];
  state.translateOptions = [];
  state.reverseOptions = [];
  state.translateFails = false;
  state.costRecords = [];
  state.answerCalls = [];
  state.reverseCalls = [];
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
  assert.deepEqual(res.body.data.questions, ['[es] ¿Fuma?'], 'the questions are translated back to Spanish');
  assert.deepEqual(state.reverseCalls, [{ texts: ['¿Fuma?'], lang: 'es' }]);
  // La vuelta solo tiene lo que le queda a la petición de sus 40 s
  const [reverseBudget] = state.reverseOptions;
  assert.ok(reverseBudget.maxBudgetMs > 30000 && reverseBudget.maxBudgetMs <= 40000, JSON.stringify(reverseBudget));
  assert.equal(res.body.detectedLang, 'es');
  assert.equal(state.detectCalls, 0);
  assert.deepEqual(state.translateCalls, [['Enfisema bulloso gigante']], 'only the disease list is translated');
  // Responde en la misma petición HTTP: plazo más corto antes de pasar a Azure
  assert.deepEqual(state.translateOptions, [{ maxBudgetMs: 20000 }]);
  assert.match(state.prompts[0], /\[en\] Enfisema bulloso gigante/);
  assert.match(state.prompts[0], /submitted as medical images/);
});

test('a disease sent in English (diseases_en) is not translated again', async () => {
  state.aiContent = '["¿Fuma?"]';
  const res = await call(generateFollowUpQuestions, {
    ...baseBody,
    description: '',
    diseases: 'Giant bullous emphysema',
    diseases_en: true,
    mode: 'hypothesis',
    uploadId: UPLOAD_ID
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(state.translateCalls, []);
  assert.match(state.prompts[0], /Giant bullous emphysema/);
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
  assert.deepEqual(res.body.data.questions, ['[es] ¿Qué edad tiene?'], 'the questions are translated back to Spanish');
  assert.equal(state.detectCalls, 0);
  assert.deepEqual(state.translateCalls, []);
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
  // Las respuestas van juntas, cada una con su pregunta, y sin descripción no hay más
  assert.deepEqual(state.answerCalls, [[{ question: '¿Fuma?', answer: 'Sí, 40 paquetes-año' }]]);
  assert.deepEqual(state.translateOptions, [{ maxBudgetMs: 20000 }]);
  assert.deepEqual(state.translateCalls, []);
  assert.match(state.prompts[0], /\[en\] Sí, 40 paquetes-año/);
});

test('missing or empty timezone falls back to UTC instead of rejecting', async () => {
  state.aiContent = '["¿Desde cuándo?"]';
  const res = await call(generateFollowUpQuestions, {
    myuuid: baseBody.myuuid,
    lang: 'es',
    timezone: '',
    description: 'Cefalea pulsátil desde hace tres semanas.',
    diseases: 'Migraña',
    mode: 'general'
  });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.result, 'success');
});

test('if the translation to English and Azure fail, the request fails but what it cost is saved', async () => {
  state.translateFails = true;
  const answers = [{ question: '¿Fuma?', answer: 'Sí, 40 paquetes-año' }];
  const res = await call(processFollowUpAnswers, {
    ...baseBody,
    description: 'Varón de 60 años con tos desde hace un mes y pérdida de peso.',
    answers,
    mode: 'hypothesis',
    detectedLanguage: 'es'
  });

  assert.equal(res.statusCode, 500);
  assert.equal(state.prompts.length, 0);
  const [record] = state.costRecords;
  assert.equal(record.operation, 'process-follow-up');
  assert.equal(record.status, 'error');
  assert.equal(record.error.stage, 'translation');
  // La descripción falló y las respuestas, que iban a la vez, sí se tradujeron: cuentan las dos
  assert.deepEqual(record.stages.map((stage) => [stage.name, stage.cost]), [['translation', 0.003], ['translation', 0.001]]);
  assert.equal(record.totalCost, 0.004);

  state.costRecords = [];
  const questions = await call(generateFollowUpQuestions, {
    ...baseBody,
    description: 'Varón de 60 años con tos desde hace un mes y pérdida de peso.',
    diseases: 'Cáncer de pulmón',
    mode: 'hypothesis',
    detectedLanguage: 'es'
  });
  assert.equal(questions.statusCode, 500);
  assert.deepEqual(state.costRecords.map((r) => [r.operation, r.status, r.totalCost]), [['follow_up_questions', 'error', 0.003]]);
});
