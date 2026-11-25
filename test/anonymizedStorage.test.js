'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// helpDiagnose escribe mucho en stdout y con node --test puede corromper los mensajes
// del runner (ver diagnoseTranslation.test.js).
console.log = () => {};

function stubModule(modulePath, exports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = { id: resolvedPath, filename: resolvedPath, loaded: true, exports };
}

// Qué texto llega a las sesiones y al blob según lo que devuelva el anonimizador.
// Solo se guarda lo que ha pasado por él: si falla o no devuelve nada, sin texto.
const DESCRIPTION = 'Paciente Juan Pérez, teléfono 612 345 678, fiebre y tos.';
const DIAGNOSES = [{ diagnosis: 'Influenza', description: 'Viral infection.', symptoms_in_common: ['Fever'], symptoms_not_in_common: [] }];
const USAGE = { prompt_tokens: 50, completion_tokens: 50 };
const english = (text) => `[en] ${text}`;

// Respuestas posibles del anonimizador real
const anonymizer = {
  noPersonalInfo: async (text) => ({ hasPersonalInfo: false, anonymizationFailed: false, anonymizedText: text, markdownText: text, htmlText: text, usage: USAGE }),
  personalInfo: async (text) => {
    const tagged = text.replace('Juan Pérez', '[ANON-10]').replace('612 345 678', '[ANON-11]');
    const masked = tagged.replace(/\[ANON-(\d+)\]/g, (m, n) => '*'.repeat(Number(n)));
    return { hasPersonalInfo: true, anonymizationFailed: false, anonymizedText: masked, markdownText: masked, htmlText: tagged, usage: USAGE };
  },
  empty: async () => ({ hasPersonalInfo: false, anonymizationFailed: true, anonymizedText: '', markdownText: '', htmlText: '', usage: USAGE }),
  throws: async () => { throw new Error('anonymizer down'); }
};

const state = {};

function reset({ anonymize, intent }) {
  state.anonymize = anonymize;
  state.intent = intent;
  state.anonymizeCalls = [];
  state.blobs = [];
  state.sessions = [];
  state.errors = [];
  state.sessionSaved = new Promise((resolve) => { state.resolveSession = resolve; });
}

stubModule('../config', {});
stubModule('../services/insights', {
  error: (info) => state.errors.push(info),
  trackEvent: () => {}
});
stubModule('../services/anonymizeService', {
  anonymizeText: async (text, ...args) => {
    state.anonymizeCalls.push(text);
    return state.anonymize(text, ...args);
  }
});
stubModule('../services/blobOpenDx29', {
  createBlobOpenDx29: async (body) => { state.blobs.push(body); }
});
stubModule('../services/email', { sendMailErrorGPTIP: async () => {} });
stubModule('../assets/prompts', {
  diagnosis: { withDiseases: '{{description}} {{previous_diagnoses}}', withoutDiseases: '{{description}}' }
});
stubModule('../services/costTrackingService', { saveDiagnoseCostBestEffort: async () => {} });
stubModule('../services/diagnoseSessionService', {
  saveQuestion: async (questionData) => {
    state.sessions.push(questionData);
    state.resolveSession();
  },
  hasRecentImageAsk: async () => false
});
stubModule('../services/pubsubService', { sendProgress: async () => {}, sendResult: async () => {} });
stubModule('../services/profileInferenceService', {
  inferProfileAndSpecialty: async () => ({}),
  getDefaultInferredProfile: () => ({})
});
stubModule('../services/intentClassifier', {
  classifyIntent: async () => state.intent,
  shouldSuggestDiagnosisPage: () => false
});
stubModule('../services/aiUtils', {
  DEFAULT_AI_MODEL: 'gpt61sol',
  callAiWithFailover: async () => ({
    data: { usage: { prompt_tokens: 100, completion_tokens: 200 }, choices: [{ message: { content: JSON.stringify(DIAGNOSES) } }] }
  }),
  sanitizeAiData: (data) => data,
  parseJsonWithFixes: async (text) => JSON.parse(text),
  resolveDiagnoseModel: (model) => model,
  suspiciousContentErrors: () => []
});
stubModule('../services/languageDetect', {
  detectLanguageSmart: async () => ({ lang: 'es', modelUsed: 'local', azureCharsBilled: 0 })
});
stubModule('../services/llmTranslation', {
  translateToEnglish: async (texts) => ({ texts: texts.map(english), cost: 0.002, durationMs: 10, model: 'gpt61terra' }),
  translateDiagnoses: async (items) => ({ items, cost: 0.004, durationMs: 10, model: 'gpt61terra' }),
  translateTexts: async (texts, lang) => ({ texts: texts.map((text) => `[${lang}] ${text}`), cost: 0.001, durationMs: 10, model: 'gpt61terra' }),
  costStages: (result, name) => [{ name, cost: result.cost, tokens: { input: 1, output: 1, total: 2 }, model: result.model, duration: result.durationMs, success: true }],
  showsEnglishName: () => false
});
stubModule('../services/costUtils', {
  calculatePrice: () => ({ totalCost: 0.01, inputTokens: 100, outputTokens: 200, totalTokens: 300 }),
  formatCost: () => '0'
});
stubModule('../services/multimodalUploadService', {
  loadImageDataUrls: async () => [],
  resolveDiagnosticImages: async () => [],
  validateCaseText: () => {},
  validateUploadReferenceFields: () => {},
  withImageContext: (text) => text
});
stubModule('../services/locationContext', {
  locationContextText: () => '',
  resolveCountryCode: () => null,
  withLocationContext: (text) => text
});
stubModule('../services/medicalQuestionService', {
  answerMedicalQuestion: async () => ({ medicalAnswer: 'Respuesta educativa.', sonarData: null, model: 'gpt61sol', usage: null })
});
stubModule('../services/f29LiveEventService', { notifyDiagnosisFinished: async () => {} });

const { processAIRequestInternal } = require('../services/helpDiagnose');

const DIAGNOSE = { action: 'go', reason: 'patient_case_ready', queryType: 'diagnostic', usedFallback: false, duration: 0 };
const EXPLAIN = { action: 'explain', reason: 'general_question', queryType: 'general', usedFallback: false, duration: 0 };

function request(extra = {}) {
  return {
    description: DESCRIPTION,
    lang: 'es',
    timezone: 'Europe/Madrid',
    myuuid: '9e82f00f-8d3a-4f55-9a5c-2c4a7f0e6b11',
    tenantId: 'test-tenant',
    flow: 'diagnose',
    ...extra
  };
}

// La sesión no diagnóstica se guarda después de responder
async function savedSession() {
  await Promise.race([
    state.sessionSaved,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('session not saved')), 2000))
  ]);
  return state.sessions[0];
}

function assertNoPersonalData(value) {
  assert.doesNotMatch(JSON.stringify(value), /Juan|Pérez|612 345 678/);
}

test('diagnóstico: si el anonimizador no devuelve nada, el blob y la sesión van sin texto', async () => {
  reset({ anonymize: anonymizer.empty, intent: DIAGNOSE });
  const result = await processAIRequestInternal(request(), { header_language: 'es' }, 'gpt61sol');

  assert.equal(result.anonymization.hasPersonalInfo, false);
  assert.equal(state.blobs.length, 1);
  assert.equal(state.blobs[0].value, '');
  assert.equal(state.blobs[0].valueEnglish, '');
  assert.equal(state.sessions[0].question.originalText, '');
  assert.equal(state.sessions[0].question.translatedText, '');
  assertNoPersonalData(state.blobs[0]);
  assertNoPersonalData(state.sessions[0]);
});

test('diagnóstico: con datos personales se guarda la versión tapada', async () => {
  reset({ anonymize: anonymizer.personalInfo, intent: DIAGNOSE });
  await processAIRequestInternal(request(), { header_language: 'es' }, 'gpt61sol');

  assert.match(state.blobs[0].value, /\*{10}/);
  assert.match(state.blobs[0].valueEnglish, /^\[en\] Paciente \*{10}/);
  assertNoPersonalData(state.blobs[0]);
  assertNoPersonalData(state.sessions[0]);
});

test('diagnóstico: sin datos personales se guarda el texto que devolvió el anonimizador', async () => {
  reset({ anonymize: anonymizer.noPersonalInfo, intent: DIAGNOSE });
  await processAIRequestInternal(request({ description: 'Fiebre y tos desde hace tres días.' }), { header_language: 'es' }, 'gpt61sol');

  assert.equal(state.blobs[0].value, english('Fiebre y tos desde hace tres días.'));
  assert.equal(state.blobs[0].valueEnglish, english('Fiebre y tos desde hace tres días.'));
});

test('no diagnóstica: si el anonimizador falla, la sesión se guarda sin texto', async () => {
  reset({ anonymize: anonymizer.throws, intent: EXPLAIN });
  await processAIRequestInternal(request(), null, 'gpt61sol');
  const session = await savedSession();

  assert.equal(session.question.originalText, '');
  assert.equal(session.question.anonymizedText, undefined);
  assertNoPersonalData(session);
  assert.ok(state.errors.some((error) => /anonymization/.test(error.message)));
});

test('no diagnóstica: si el anonimizador no devuelve nada, la sesión se guarda sin texto', async () => {
  reset({ anonymize: anonymizer.empty, intent: EXPLAIN });
  await processAIRequestInternal(request(), null, 'gpt61sol');
  const session = await savedSession();

  assert.equal(session.question.originalText, '');
  assertNoPersonalData(session);
});

test('no diagnóstica sin X-Tenant-Id (API): no se anonimiza, y la sesión va sin texto', async () => {
  // Anonimizar aquí se le facturaría al cliente de la API sin devolverle nada
  reset({ anonymize: anonymizer.personalInfo, intent: EXPLAIN });
  await processAIRequestInternal(request({ tenantId: undefined }), null, 'gpt61sol');
  const session = await savedSession();

  assert.deepEqual(state.anonymizeCalls, []);
  assert.equal(session.question.originalText, '');
  assertNoPersonalData(session);
});

test('no diagnóstica con la web: con datos personales se guarda la versión tapada', async () => {
  reset({ anonymize: anonymizer.personalInfo, intent: EXPLAIN });
  await processAIRequestInternal(request(), null, 'gpt61sol');
  const session = await savedSession();

  assert.deepEqual(state.anonymizeCalls, [DESCRIPTION]);
  assert.equal(session.question.originalText, 'Paciente **********, teléfono ***********, fiebre y tos.');
  assertNoPersonalData(session);
});

test('no diagnóstica sin descripción (solo imágenes): no se llama al anonimizador', async () => {
  reset({ anonymize: anonymizer.empty, intent: EXPLAIN });
  await processAIRequestInternal(request({ description: '' }), null, 'gpt61sol');
  const session = await savedSession();

  assert.deepEqual(state.anonymizeCalls, []);
  assert.equal(session.question.originalText, '');
});

test('no diagnóstica: sin datos personales se guarda el texto', async () => {
  reset({ anonymize: anonymizer.noPersonalInfo, intent: EXPLAIN });
  await processAIRequestInternal(request({ description: 'Qué es la gripe' }), null, 'gpt61sol');
  const session = await savedSession();

  assert.equal(session.question.originalText, 'Qué es la gripe');
});

test('pregunta médica: si el anonimizador no devuelve nada, se contesta pero la sesión va sin texto', async () => {
  reset({ anonymize: anonymizer.empty, intent: EXPLAIN });
  const result = await processAIRequestInternal(request({ flow: 'ask' }), null, 'gpt61sol');

  assert.equal(result.medicalAnswer, 'Respuesta educativa.');
  assert.equal(state.sessions[0].question.originalText, '');
  assert.equal(state.sessions[0].question.translatedText, '');
  assertNoPersonalData(state.sessions[0]);
});

test('pregunta médica: con datos personales la sesión guarda la versión tapada', async () => {
  reset({ anonymize: anonymizer.personalInfo, intent: EXPLAIN });
  await processAIRequestInternal(request({ flow: 'ask' }), null, 'gpt61sol');

  assert.equal(state.sessions[0].question.originalText, 'Paciente **********, teléfono ***********, fiebre y tos.');
  assertNoPersonalData(state.sessions[0]);
});
