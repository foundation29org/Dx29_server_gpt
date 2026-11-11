'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// callInfoDisease escribe mucho en stdout, y con node --test ese texto a veces corrompe
// los mensajes del runner («Unable to deserialize cloned data»). Los errores siguen
// saliendo por stderr.
console.log = () => {};

function stubModule(modulePath, exports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports
  };
}

const state = { aiContent: '', translations: [], translateFails: false, costRecords: [], errors: [] };

stubModule('../services/aiUtils', {
  sanitizeInput: (input) => input.trim(),
  suspiciousContentErrors: () => [],
  callAiWithFailover: async (requestBody) => {
    state.prompts.push(requestBody.messages[0].content);
    return {
    data: {
      usage: { prompt_tokens: 100, completion_tokens: 200 },
      choices: [{ message: { content: state.aiContent } }]
    }
    };
  },
  extractProviderError: () => ({}),
  DEFAULT_AI_MODEL: 'gpt56terra'
});
// La traducción tiene sus propias pruebas en llmTranslation.test.js; aquí solo se
// comprueba qué se le pide traducir y qué se hace con el resultado.
const TRANSLATION_STAGE = { name: 'reverse_translation', cost: 0.001, tokens: { input: 10, output: 20, total: 30 }, model: 'gpt61terra', duration: 5, success: true };
stubModule('../services/llmTranslation', {
  translateTexts: async (texts, lang, ctx, options) => {
    state.translations.push({ texts, lang });
    state.translationOptions.push(options);
    state.order.push('translate:start');
    // Un respiro: si las llamadas fueran una tras otra, cada una acabaría antes de empezar la siguiente
    await new Promise((resolve) => setImmediate(resolve));
    state.order.push('translate:end');
    if (state.translateFails) {
      const error = new Error('Azure Translator down');
      error.translationResult = { promptTokens: 10, completionTokens: 20 };
      throw error;
    }
    return { texts: texts.map((text) => `[${lang}] ${text}`) };
  },
  costStages: () => [{ ...TRANSLATION_STAGE }],
  // Como el real: lo que le queda a la petición de sus 40 s
  syncBudget: (startedAt, cap = 40000) => ({ maxBudgetMs: Math.min(cap, 40000 - (Date.now() - startedAt)) })
});
stubModule('../services/costUtils', {
  calculatePrice: () => ({ totalCost: 0.002, inputTokens: 100, outputTokens: 200, totalTokens: 300 }),
  formatCost: () => '0'
});
stubModule('../services/costTrackingService', {
  saveCostRecordBestEffort: async (record) => { state.costRecords.push(record); },
  saveSimpleOperationCostBestEffort: async () => {}
});
stubModule('../services/email', { sendMailErrorGPTIP: async () => {} });
stubModule('../services/insights', { error: (error) => state.errors.push(error) });
stubModule('../services/multimodalUploadService', {
  loadImageDataUrls: async () => [],
  resolveDiagnosticImages: async () => [],
  validateCaseText: () => {},
  validateUploadReferenceFields: () => {}
});

const { callInfoDisease } = require('../services/callInfoDiseaseService');

const baseBody = {
  myuuid: '9e82f00f-8d3a-4f55-9a5c-2c4a7f0e6b11',
  timezone: 'Europe/Madrid',
  detectedLang: 'es',
  disease: 'Accommodative insufficiency'
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

async function call(body) {
  const res = fakeResponse();
  await callInfoDisease({
    body,
    headers: { 'x-tenant-id': 'test-tenant' },
    connection: { remoteAddress: '127.0.0.1' },
    get: () => undefined
  }, res);
  return res;
}

test.beforeEach(() => {
  state.prompts = [];
  state.translations = [];
  state.translationOptions = [];
  state.order = [];
  state.translateFails = false;
  state.costRecords = [];
  state.errors = [];
});

test('the differential list is translated name by name, without empty lines', async () => {
  state.aiContent = 'Possible symptoms\n1. Blurred near vision.\n2. Eye strain';
  const res = await call({ ...baseBody, questionType: 3, medicalDescription: 'Headache when reading for a long time.' });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(state.translations, [{ texts: ['Blurred near vision', 'Eye strain'], lang: 'es' }]);
  assert.deepEqual(res.body.data.symptoms, [
    { name: '[es] Blurred near vision', checked: false },
    { name: '[es] Eye strain', checked: false }
  ]);
});

test('when the answer will be translated, the model is asked to answer in English', async () => {
  state.aiContent = '1. Visión borrosa de cerca';
  for (const questionType of [0, 1, 2, 3, 4, 5, 6]) {
    state.prompts = [];
    await call({ ...baseBody, questionType, medicalDescription: 'Dolor de cabeza al leer mucho rato.' });
    assert.match(state.prompts[0], /Write the whole answer in English/, `questionType ${questionType}`);
  }
});

test('an English answer keeps the prompt as before', async () => {
  state.aiContent = '1. Blurred near vision';
  for (const detectedLang of ['en', 'en-GB', undefined]) {
    state.prompts = [];
    await call({ ...baseBody, detectedLang, questionType: 3, medicalDescription: 'Headache when reading.' });
    assert.doesNotMatch(state.prompts[0], /in English/, String(detectedLang));
  }
});

test('a long answer is translated in chunks at the same time and joined in order', async () => {
  // Seis bloques de unos 620 caracteres: dos por trozo, tres trozos
  const SEP = '\n\n';
  const blocks = Array.from({ length: 6 }, (_, i) => `<p>Block ${i + 1} ${'x'.repeat(600)}</p>`);
  state.aiContent = blocks.join(SEP);
  const res = await call({ ...baseBody, questionType: 1 });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const chunks = [0, 2, 4].map((i) => blocks.slice(i, i + 2).join(SEP));
  assert.deepEqual(state.translations.map(({ texts }) => texts), chunks.map((chunk) => [chunk]));
  assert.equal(res.body.data.content, chunks.map((chunk) => `[es] ${chunk}`).join(SEP));
  // A la vez: las tres empiezan antes de que acabe ninguna
  assert.deepEqual(state.order.slice(0, 3), ['translate:start', 'translate:start', 'translate:start']);
  // Con el plazo que le queda a la petición, y la espera real en el coste, no la suma
  assert.ok(state.translationOptions.every((o) => o.maxBudgetMs > 30000 && o.maxBudgetMs <= 40000));
  const [record] = state.costRecords;
  const waits = record.stages.filter((stage) => stage.name === 'reverse_translation').map((stage) => stage.duration);
  assert.equal(waits.length, 3);
  assert.ok(waits.reduce((a, b) => a + b, 0) < 15, `the 3 chunks ran together: ${waits}`);
});

test('an HTML answer is translated whole and its cost record keeps the question and the disease', async () => {
  state.aiContent = '<p><strong>Treatment</strong></p>';
  const res = await call({ ...baseBody, questionType: 1 });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.content, '[es] <p><strong>Treatment</strong></p>');
  assert.equal(state.costRecords.length, 1);
  const [record] = state.costRecords;
  assert.deepEqual(record.stages.map((stage) => stage.name), ['ai_call', 'reverse_translation']);
  assert.deepEqual(record.operationData, { questionType: 1, disease: baseBody.disease, detectedLanguage: 'es' });
  assert.ok(record.descriptionLength > 0);
  assert.equal(record.totalTokens.total, 330);
});

test('if the translation fails the English answer is returned, with the error and what it cost', async () => {
  state.aiContent = '<p>Rest</p>';
  state.translateFails = true;
  const res = await call({ ...baseBody, questionType: 1 });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.content, '<p>Rest</p>');
  assert.match(state.errors[0].message, /translation failed/);
  const [record] = state.costRecords;
  assert.equal(record.stages[1].name, 'reverse_translation');
  assert.equal(record.stages[1].success, false);
});

test('an empty answer is not sent to be translated', async () => {
  state.aiContent = '```html\n\n```';
  const res = await call({ ...baseBody, questionType: 1 });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(state.translations, []);
});
