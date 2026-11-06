'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// helpDiagnose escribe mucho en stdout, y con node --test ese texto a veces corrompe
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

// La traducción de la respuesta (llmTranslation) se lanza tras el parseo y se espera
// después de la anonimización. Aquí se comprueba ese orden y qué coste se guarda;
// la traducción en sí tiene sus pruebas en llmTranslation.test.js.
const DIAGNOSES = [{
  diagnosis: 'Accommodative insufficiency',
  description: 'Reduced ability to focus at near.',
  symptoms_in_common: ['Blurred near vision'],
  symptoms_not_in_common: []
}];
const TRANSLATED = [{
  ...DIAGNOSES[0],
  diagnosis: 'Insuficiencia acomodativa',
  diagnosis_en: 'Accommodative insufficiency'
}];

const state = {};

function reset({ lang = 'es', translate, anonymize } = {}) {
  state.lang = lang;
  state.order = [];
  state.translateCalls = [];
  state.costSaves = [];
  state.errors = [];
  state.translate = translate || (async () => ({ items: TRANSLATED, cost: 0.004, durationMs: 1000 }));
  state.anonymize = anonymize || (async () => ({ hasPersonalInfo: false, anonymizedText: '', htmlText: '' }));
}

stubModule('../config', {});
stubModule('../services/insights', {
  error: (info) => state.errors.push(info),
  trackEvent: () => {}
});
stubModule('../services/anonymizeService', {
  anonymizeText: async (...args) => {
    state.order.push('anonymize:start');
    const result = await state.anonymize(...args);
    state.order.push('anonymize:end');
    return result;
  }
});
stubModule('../services/blobOpenDx29', { createBlobOpenDx29: async () => {} });
stubModule('../services/email', { sendMailErrorGPTIP: async () => {} });
stubModule('../assets/prompts', {
  diagnosis: { withDiseases: '{{description}} {{previous_diagnoses}}', withoutDiseases: '{{description}}' }
});
stubModule('../services/costTrackingService', {
  saveDiagnoseCostBestEffort: async (data, stages, status) => {
    state.costSaves.push({ stages, status });
  }
});
stubModule('../services/diagnoseSessionService', { saveQuestion: async () => {} });
stubModule('../services/pubsubService', { sendProgress: async () => {} });
stubModule('../services/profileInferenceService', {
  inferProfileAndSpecialty: async () => ({}),
  getDefaultInferredProfile: () => ({})
});
stubModule('../services/intentClassifier', {
  classifyIntent: async () => { throw new Error('forceDiagnosis skips the classifier'); },
  shouldSuggestDiagnosisPage: () => false
});
stubModule('../services/aiUtils', {
  DEFAULT_AI_MODEL: 'gpt56terra',
  callAiWithFailover: async () => {
    state.order.push('diagnose');
    return {
      data: {
        usage: { prompt_tokens: 100, completion_tokens: 200 },
        choices: [{ message: { content: JSON.stringify(DIAGNOSES) } }]
      }
    };
  },
  translateTextWithRetry: async (text) => `[en] ${text}`,
  translateInvertWithRetry: async (text) => text,
  sanitizeAiData: (data) => data,
  parseJsonWithFixes: async (text) => JSON.parse(text),
  resolveDiagnoseModel: (model) => model,
  suspiciousContentErrors: () => []
});
stubModule('../services/languageDetect', {
  detectLanguageSmart: async () => ({ lang: state.lang, modelUsed: 'local', azureCharsBilled: 0 })
});
stubModule('../services/llmTranslation', {
  translateDiagnoses: (items, lang) => {
    state.order.push('translate:start');
    state.translateCalls.push({ items, lang });
    return state.translate(items, lang);
  },
  costStages: (result, name) => [{
    name,
    cost: result.cost,
    tokens: { input: 10, output: 20, total: 30 },
    model: 'gpt61terra',
    duration: result.durationMs,
    success: true
  }],
  showsEnglishName: (lang) => lang === 'hi'
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
stubModule('../services/medicalQuestionService', { answerMedicalQuestion: async () => ({}) });
stubModule('../services/f29LiveEventService', { notifyDiagnosisFinished: async () => {} });

const { processAIRequestInternal } = require('../services/helpDiagnose');

function request() {
  return {
    description: 'Visión borrosa de cerca al leer.',
    lang: state.lang,
    timezone: 'Europe/Madrid',
    myuuid: '9e82f00f-8d3a-4f55-9a5c-2c4a7f0e6b11',
    tenantId: 'test-tenant',
    flow: 'diagnose',
    forceDiagnosis: true
  };
}

function reverseStages(save) {
  return save.stages.filter((stage) => stage.name === 'reverse_diseases');
}

test('the translation runs alongside anonymization, from the English answer, and its result is returned', { timeout: 5000 }, async () => {
  // La traducción solo termina cuando ya ha empezado la anonimización: si el código
  // esperase la traducción antes de anonimizar, la prueba se quedaría colgada
  let anonymizationStarted;
  const started = new Promise((resolve) => { anonymizationStarted = resolve; });
  reset({
    translate: async () => {
      await started;
      state.order.push('translate:end');
      return { items: TRANSLATED, cost: 0.004, durationMs: 1000 };
    },
    anonymize: async () => {
      anonymizationStarted();
      await new Promise((resolve) => setImmediate(resolve));
      return { hasPersonalInfo: false, anonymizedText: '', htmlText: '' };
    }
  });
  const result = await processAIRequestInternal(request(), null, 'gpt56terra');

  assert.deepEqual(state.order, ['diagnose', 'translate:start', 'anonymize:start', 'translate:end', 'anonymize:end']);
  assert.deepEqual(state.translateCalls, [{ items: DIAGNOSES, lang: 'es' }]);
  assert.deepEqual(result.data, TRANSLATED);
  assert.equal(result.showEnglishName, false);
});

test('the saved translation stage counts only the wait it added to the answer', async () => {
  // La traducción ya ha terminado cuando acaba la anonimización: no añade espera
  reset();
  await processAIRequestInternal(request(), null, 'gpt56terra');

  const [save] = state.costSaves;
  assert.equal(save.status, 'success');
  const [stage] = reverseStages(save);
  assert.equal(stage.model, 'gpt61terra');
  assert.equal(stage.cost, 0.004);
  assert.ok(stage.duration < 100, `duration ${stage.duration} should be the exposed wait, not the 1000 ms of the calls`);
});

test('an English answer is not translated', async () => {
  reset({ lang: 'en' });
  const result = await processAIRequestInternal(request(), null, 'gpt56terra');

  assert.deepEqual(state.translateCalls, []);
  assert.deepEqual(result.data, DIAGNOSES);
  assert.deepEqual(reverseStages(state.costSaves[0]), []);
});

test('if anonymization fails, the translation already under way is still saved as a failed stage', async () => {
  reset({ anonymize: async () => { throw new Error('anonymizer down'); } });
  await assert.rejects(processAIRequestInternal(request(), null, 'gpt56terra'), /anonymizer down/);

  const [save] = state.costSaves;
  assert.equal(save.status, 'error');
  const [stage] = reverseStages(save);
  assert.equal(stage.cost, 0.004);
  assert.equal(stage.success, false);
});

test('if the translation and Azure fail, the request fails with the error logged and what the model cost', async () => {
  reset({
    translate: async () => {
      const error = new Error('Azure Translator down');
      error.translationResult = { cost: 0.002, durationMs: 500 };
      throw error;
    }
  });
  await assert.rejects(processAIRequestInternal(request(), null, 'gpt56terra'), /Azure Translator down/);

  assert.ok(state.errors.some((error) => /Answer translation failed/.test(error.message)));
  const [save] = state.costSaves;
  assert.equal(save.status, 'error');
  const [stage] = reverseStages(save);
  assert.equal(stage.cost, 0.002);
  assert.equal(stage.success, false);
});
