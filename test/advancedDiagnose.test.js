'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// helpDiagnose escribe mucho en stdout y con node --test puede corromper los mensajes
console.log = () => {};

function stubModule(modulePath, exports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = { id: resolvedPath, filename: resolvedPath, loaded: true, exports };
}

// Modo avanzado: el usuario que no queda convencido pide otro diagnóstico a Claude
// Fable 5.2. Fable recibe lo mismo que Sol (texto e imágenes) y el resto del flujo es
// el de Sol; aquí se comprueba eso, que la API no lo tiene y qué se guarda.
const DESCRIPTION = 'Juan Pérez, 34 años, fiebre y artralgias desde hace tres semanas.';
const DIAGNOSES = [{
  diagnosis: 'Adult-onset Still disease',
  description: 'Systemic inflammatory disorder.',
  symptoms_in_common: ['Fever', 'Arthralgia'],
  symptoms_not_in_common: []
}];
const USAGE = { prompt_tokens: 50, completion_tokens: 50 };
const MYUUID = '9e82f00f-8d3a-4f55-9a5c-2c4a7f0e6b11';
const IMAGE = { uploadId: 'up-1', index: 0, name: 'rash.jpg', mimeType: 'image/jpeg' };

const state = {};

function reset({ claude } = {}) {
  state.order = [];
  state.anonymizeCalls = [];
  state.claudeCalls = [];
  state.solCalls = [];
  state.blobs = [];
  state.costSaves = [];
  state.events = [];
  state.errors = [];
  state.results = [];
  state.sentErrors = [];
  state.classifierCalls = 0;
  state.claude = claude || (async () => ({
    data: {
      choices: [{ message: { content: JSON.stringify(DIAGNOSES) }, finish_reason: 'end_turn' }],
      usage: { prompt_tokens: 300, completion_tokens: 1600, total_tokens: 1900 }
    }
  }));
}

stubModule('../config', {});
stubModule('../services/insights', {
  error: (info) => state.errors.push(info),
  trackEvent: (name, properties) => state.events.push({ name, properties })
});
stubModule('../services/anonymizeService', {
  anonymizeText: async (text) => {
    state.order.push('anonymize');
    state.anonymizeCalls.push(text);
    return {
      hasPersonalInfo: true,
      anonymizedText: text.replace('Juan Pérez', '**********'),
      htmlText: text.replace('Juan Pérez', '[ANON-10]'),
      usage: USAGE
    };
  }
});
stubModule('../services/claudeFoundry', {
  callClaudeDiagnosis: async (prompt, options) => {
    state.order.push('claude');
    state.claudeCalls.push({ prompt, images: options.images });
    return state.claude(prompt, options);
  }
});
stubModule('../services/blobOpenDx29', { createBlobOpenDx29: async (body, version) => { state.blobs.push(version); } });
stubModule('../services/email', { sendMailErrorGPTIP: async () => {} });
stubModule('../assets/prompts', {
  diagnosis: { withDiseases: '{{description}} {{previous_diagnoses}}', withoutDiseases: '{{description}}' }
});
stubModule('../services/costTrackingService', {
  saveDiagnoseCostBestEffort: async (data, stages, status) => {
    state.costSaves.push({ model: data.model, advancedMeta: data.advancedMeta, stages, status });
  }
});
stubModule('../services/diagnoseSessionService', { saveQuestion: async () => {} });
stubModule('../services/pubsubService', {
  sendProgress: async () => {},
  sendResult: async (userId, result) => { state.results.push(result); },
  sendError: async (userId, error, code) => { state.sentErrors.push({ code, message: error.message }); }
});
stubModule('../services/profileInferenceService', {
  inferProfileAndSpecialty: async () => ({}),
  getDefaultInferredProfile: () => ({})
});
stubModule('../services/intentClassifier', {
  classifyIntent: async () => {
    state.classifierCalls += 1;
    return { action: 'go', reason: 'patient_case_ready', queryType: 'diagnostic', duration: 1 };
  },
  shouldSuggestDiagnosisPage: () => false
});
stubModule('../services/aiUtils', {
  DEFAULT_AI_MODEL: 'gpt61sol',
  callAiWithFailover: async (requestBody, timezone, model) => {
    state.order.push('sol');
    state.solCalls.push(model);
    return {
      data: {
        usage: { prompt_tokens: 100, completion_tokens: 200 },
        choices: [{ message: { content: JSON.stringify(DIAGNOSES) } }]
      }
    };
  },
  sanitizeAiData: (data) => ({ ...data }),
  parseJsonWithFixes: async (text) => JSON.parse(text),
  resolveDiagnoseModel: () => 'gpt61sol',
  suspiciousContentErrors: () => []
});
stubModule('../services/languageDetect', {
  detectLanguageSmart: async () => ({ lang: 'en', modelUsed: 'local', azureCharsBilled: 0 })
});
stubModule('../services/llmTranslation', {
  translateToEnglish: async (texts) => ({ texts, cost: 0, durationMs: 0, model: 'gpt61terra' }),
  translateDiagnoses: async (items) => ({ items, cost: 0, durationMs: 0, model: 'gpt61terra' }),
  translateTexts: async (texts) => ({ texts, cost: 0, durationMs: 0, model: 'gpt61terra' }),
  costStages: () => [],
  showsEnglishName: () => false
});
stubModule('../services/costUtils', {
  calculatePrice: (usage, model) => ({
    totalCost: model === 'claudefable52' ? 0.07 : 0.001,
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.prompt_tokens + usage.completion_tokens
  }),
  formatCost: () => '0'
});
stubModule('../services/multimodalUploadService', {
  loadImageDataUrls: async (images) => (images || []).map((image) => ({ name: image.name, url: `data:${image.mimeType};base64,AAAA` })),
  resolveDiagnosticImages: async (body) => (body.uploadId ? [IMAGE] : []),
  validateCaseText: () => {},
  validateUploadReferenceFields: () => {},
  withImageContext: (text, images) => (images && images.length ? `${text} [images]` : text)
});
stubModule('../services/locationContext', {
  locationContextText: () => '',
  resolveCountryCode: () => null,
  withLocationContext: (text) => text
});
stubModule('../services/medicalQuestionService', { answerMedicalQuestion: async () => ({}) });
stubModule('../services/f29LiveEventService', { notifyDiagnosisFinished: async () => {} });

const advancedDiagnose = require('../services/advancedDiagnose');
const { diagnose, processAIRequestInternal } = require('../services/helpDiagnose');

function body(extra = {}) {
  return {
    description: DESCRIPTION,
    lang: 'es',
    timezone: 'Europe/Madrid',
    myuuid: MYUUID,
    advanced: true,
    advancedReason: 'missing_suspected',
    advancedSource: 'vote_down',
    ...extra
  };
}

function caseData(extra = {}) {
  return { ...body(extra), tenantId: 'dxgpt-local', flow: 'diagnose' };
}

// Llama a /diagnose como Express y espera a que termine el trabajo en segundo plano
async function callDiagnose(requestBody, headers = { 'x-tenant-id': 'dxgpt-prod', 'x-subscription-id': 'sub-web', 'x-product-id': 'brave-water-0ce6c5a03' }) {
  const response = {};
  const res = {
    status(code) { response.status = code; return this; },
    send(payload) { response.body = payload; return this; }
  };
  const req = {
    body: requestBody,
    headers,
    method: 'POST',
    url: '/diagnose',
    params: {},
    query: {},
    connection: {},
    get: () => ''
  };
  await diagnose(req, res);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return response;
}

test('the advanced fields are validated', () => {
  assert.deepEqual(advancedDiagnose.advancedFieldErrors({}), []);
  assert.deepEqual(advancedDiagnose.advancedFieldErrors({ advanced: false }), []);
  assert.deepEqual(advancedDiagnose.advancedFieldErrors(body()), []);
  assert.deepEqual(
    advancedDiagnose.advancedFieldErrors({ advanced: 'yes' }).map((error) => error.field),
    ['advanced']
  );
  assert.deepEqual(
    advancedDiagnose.advancedFieldErrors(body({ advancedReason: 'free text', advancedSource: 'email' })).map((error) => error.field),
    ['advancedReason', 'advancedSource']
  );
});

test('every web has the advanced mode, with or without images; the API does not', () => {
  const check = (extra = {}, options = {}) => advancedDiagnose.advancedRequestRejection({
    flow: 'diagnose',
    tenantId: 'dxgpt-prod',
    subscriptionId: 'sub-web',
    productId: 'brave-water-0ce6c5a03',
    nodeEnv: 'production',
    data: body(extra),
    ...options
  });
  assert.equal(check(), null);
  assert.equal(check({ uploadId: 'up-1' }), null);
  assert.equal(check({}, { tenantId: 'salud-gpt-prod', productId: 'lemon-glacier-023c47f03' }), null);
  assert.equal(check({}, { tenantId: 'dxeugpt-prod', productId: 'delightful-moss-0b31d2b03' }), null);
  // Un cliente de la API: sin tenant, o con un tenant puesto a mano pero con su producto de APIM
  assert.equal(check({}, { tenantId: undefined, productId: 'dxgpt-freemium' }), 'ADVANCED_NOT_AVAILABLE_FOR_API');
  assert.equal(check({}, { productId: 'dxgpt-freemium' }), 'ADVANCED_NOT_AVAILABLE_FOR_API');
  assert.equal(check({}, { productId: 'pro' }), 'ADVANCED_NOT_AVAILABLE_FOR_API');
  assert.equal(check({}, { productId: undefined }), 'ADVANCED_NOT_AVAILABLE_FOR_API');
  // Sin APIM: en local y en pruebas sí; en producción no
  assert.equal(check({}, { subscriptionId: undefined, productId: undefined, nodeEnv: 'local' }), null);
  assert.equal(check({}, { subscriptionId: undefined, productId: undefined, nodeEnv: 'development' }), null);
  assert.equal(check({}, { subscriptionId: undefined, productId: undefined }), 'ADVANCED_NOT_AVAILABLE_FOR_API');
  assert.equal(check({}, { flow: 'ask' }), 'ADVANCED_ONLY_DIAGNOSE');
  assert.equal(check({ response_mode: 'direct' }), 'ADVANCED_ONLY_ASYNC');
  assert.equal(check({ diseases_list: '+Lupus' }), 'ADVANCED_NO_LOAD_MORE');
});

test('Fable gets the same text as Sol, the rest of the flow is the same, and the classifier is skipped', async () => {
  reset();
  const result = await processAIRequestInternal(caseData(), { header_language: 'es' }, 'gpt61sol');

  assert.deepEqual(state.order, ['claude', 'anonymize']);
  assert.equal(state.claudeCalls[0].prompt, DESCRIPTION);
  assert.deepEqual(state.claudeCalls[0].images, []);
  assert.equal(state.solCalls.length, 0);
  assert.equal(state.classifierCalls, 0);
  assert.equal(result.advanced, true);
  assert.deepEqual(result.data.map((item) => item.diagnosis), ['Adult-onset Still disease']);
  assert.equal(result.anonymization.hasPersonalInfo, true);
  assert.deepEqual(state.blobs, ['claudefable52']);

  const [save] = state.costSaves;
  assert.equal(save.model, 'claudefable52');
  assert.deepEqual(save.advancedMeta, { reason: 'missing_suspected', source: 'vote_down' });
  const aiStage = save.stages.find((stage) => stage.name === 'ai_call');
  assert.equal(aiStage.model, 'claudefable52');
  assert.equal(aiStage.cost, 0.07);
});

test('with images, Fable gets them as Sol would', async () => {
  reset();
  await processAIRequestInternal(caseData({ imageUrls: [IMAGE] }), null, 'gpt61sol');
  assert.equal(state.claudeCalls[0].prompt, `${DESCRIPTION} [images]`);
  assert.deepEqual(state.claudeCalls[0].images, [{ name: 'rash.jpg', url: 'data:image/jpeg;base64,AAAA' }]);
});

test('a normal request still goes to Sol, with the classifier', async () => {
  reset();
  const result = await processAIRequestInternal(
    { ...caseData(), advanced: undefined, advancedReason: undefined, advancedSource: undefined },
    null,
    'gpt61sol'
  );
  assert.deepEqual(state.solCalls, ['gpt61sol']);
  assert.equal(state.claudeCalls.length, 0);
  assert.equal(state.classifierCalls, 1);
  assert.equal(result.advanced, undefined);
});

test('/diagnose answers processing and sends the advanced result by WebSocket', async () => {
  reset();
  const response = await callDiagnose(body({ uploadId: 'up-1' }));
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { result: 'processing' });
  assert.equal(state.results.length, 1);
  assert.equal(state.results[0].advanced, true);
  assert.equal(state.claudeCalls[0].images.length, 1);
  assert.ok(state.events.some((event) => event.name === 'AdvancedDiagnosisRequested' &&
    event.properties.reason === 'missing_suspected' && event.properties.source === 'vote_down'));
});

test('/diagnose does not give the advanced mode to API clients, even with a tenant header', async () => {
  reset();
  let response = await callDiagnose(body(), { 'x-subscription-id': 'sub-api', 'x-product-id': 'dxgpt-freemium' });
  assert.deepEqual(response.body, { result: 'advanced_unavailable', code: 'ADVANCED_NOT_AVAILABLE_FOR_API' });
  response = await callDiagnose(body(), { 'x-tenant-id': 'dxgpt-prod', 'x-subscription-id': 'sub-api', 'x-product-id': 'dxgpt-freemium' });
  assert.deepEqual(response.body, { result: 'advanced_unavailable', code: 'ADVANCED_NOT_AVAILABLE_FOR_API' });
  assert.equal(state.claudeCalls.length, 0);
  assert.equal(state.solCalls.length, 0);
  assert.ok(state.events.some((event) => event.name === 'AdvancedDiagnosisRejected'));
});

test('/diagnose rejects an unknown advanced reason', async () => {
  reset();
  const response = await callDiagnose(body({ advancedReason: 'anything' }));
  assert.equal(response.status, 400);
  assert.equal(state.claudeCalls.length, 0);
});

test('an unreadable Fable answer is an advanced error the user can retry, and its cost is saved', async () => {
  reset({
    claude: async () => ({
      data: {
        choices: [{ message: { content: 'not json' }, finish_reason: 'max_tokens' }],
        usage: { prompt_tokens: 300, completion_tokens: 12000, total_tokens: 12300 }
      }
    })
  });
  const response = await callDiagnose(body());
  assert.deepEqual(response.body, { result: 'processing' });
  assert.deepEqual(state.sentErrors.map((error) => error.code), ['ADVANCED_MODEL_UNAVAILABLE']);
  assert.equal(state.results.length, 0);
  const [save] = state.costSaves;
  assert.equal(save.status, 'error');
  assert.equal(save.stages.find((stage) => stage.name === 'ai_call').model, 'claudefable52');
});

test('if Fable fails, the user gets the advanced error code and keeps the previous results', async () => {
  reset({
    claude: async () => {
      const error = new Error('Advanced model call failed (429)');
      error.code = 'ADVANCED_MODEL_UNAVAILABLE';
      throw error;
    }
  });
  const response = await callDiagnose(body());
  assert.deepEqual(response.body, { result: 'processing' });
  assert.deepEqual(state.sentErrors.map((error) => error.code), ['ADVANCED_MODEL_UNAVAILABLE']);
  assert.equal(state.results.length, 0);
});
