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

// Las traducciones de helpDiagnose: la descripción va al inglés antes del
// diagnóstico; la respuesta vuelve al idioma del usuario a la vez que se anonimiza,
// y en otro idioma se anonimiza también el texto original. Aquí se comprueba ese
// orden, qué se usa y qué coste se guarda; las traducciones en sí tienen sus
// pruebas en llmTranslation.test.js.
const DESCRIPTION = 'Visión borrosa de cerca al leer.';
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
const USAGE = { prompt_tokens: 50, completion_tokens: 50 };
const NO_PII = { hasPersonalInfo: false, anonymizedText: '', htmlText: '', usage: USAGE };

const state = {};

function reset({ lang = 'es', translate, anonymize, forwardFails = false } = {}) {
  state.lang = lang;
  state.order = [];
  state.forwardCalls = [];
  state.translateCalls = [];
  state.textCalls = [];
  state.anonymizeCalls = [];
  state.prompts = [];
  state.aiCalls = [];
  state.blobs = [];
  state.costSaves = [];
  state.errors = [];
  state.events = [];
  state.forwardFails = forwardFails;
  state.translate = translate || (async () => ({ items: TRANSLATED, cost: 0.004, durationMs: 1000, model: 'gpt61terra' }));
  state.anonymize = anonymize || (async () => NO_PII);
}

// El texto del usuario «traducido» lleva delante [en]
const english = (text) => `[en] ${text}`;

stubModule('../config', {});
stubModule('../services/insights', {
  error: (info) => state.errors.push(info),
  trackEvent: (name, properties) => state.events.push({ name, properties })
});
stubModule('../services/anonymizeService', {
  anonymizeText: async (text, ...args) => {
    state.anonymizeCalls.push(text);
    state.order.push('anonymize:start');
    const result = await state.anonymize(text, ...args);
    state.order.push('anonymize:end');
    return result;
  }
});
stubModule('../services/blobOpenDx29', {
  createBlobOpenDx29: async (body, version) => { state.blobs.push(version); }
});
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
  DEFAULT_AI_MODEL: 'gpt61sol',
  callAiWithFailover: async (requestBody, timezone, model) => {
    state.order.push('diagnose');
    state.aiCalls.push({ model, requestBody });
    // Con el modelo por defecto la petición es la de visión: el texto va en una parte
    const content = requestBody.messages[0].content;
    state.prompts.push(typeof content === 'string' ? content : content.map((part) => part.text || '').join(''));
    return {
      data: {
        usage: { prompt_tokens: 100, completion_tokens: 200 },
        choices: [{ message: { content: JSON.stringify(DIAGNOSES) } }]
      }
    };
  },
  sanitizeAiData: (data) => data,
  parseJsonWithFixes: async (text) => JSON.parse(text),
  resolveDiagnoseModel: (model) => model,
  suspiciousContentErrors: () => []
});
stubModule('../services/languageDetect', {
  detectLanguageSmart: async () => ({ lang: state.lang, modelUsed: 'local', azureCharsBilled: 0 })
});
stubModule('../services/llmTranslation', {
  translateToEnglish: async (texts, lang) => {
    state.order.push('to_english');
    state.forwardCalls.push({ texts, lang });
    if (state.forwardFails) {
      const error = new Error('Azure Translator down');
      error.translationResult = { cost: 0.001, durationMs: 300 };
      throw error;
    }
    return { texts: texts.map(english), cost: 0.002, durationMs: 2000, model: 'gpt61terra' };
  },
  translateDiagnoses: (items, lang) => {
    state.order.push('translate:start');
    state.translateCalls.push({ items, lang });
    return state.translate(items, lang);
  },
  translateTexts: async (texts, lang) => {
    state.textCalls.push({ texts, lang });
    return { texts: texts.map((text) => `[${lang}] ${text}`), cost: 0.001, durationMs: 500, model: 'gpt61terra' };
  },
  costStages: (result, name) => [{
    name,
    cost: result.cost,
    tokens: { input: 10, output: 20, total: 30 },
    model: result.model,
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

function request(extra = {}) {
  return {
    description: DESCRIPTION,
    lang: state.lang,
    timezone: 'Europe/Madrid',
    myuuid: '9e82f00f-8d3a-4f55-9a5c-2c4a7f0e6b11',
    tenantId: 'test-tenant',
    flow: 'diagnose',
    forceDiagnosis: true,
    ...extra
  };
}

function stagesNamed(save, name) {
  return save.stages.filter((stage) => stage.name === name);
}

test('Sol diagnoses with its own deployment, reasoning low, and the case is saved to the blob', async () => {
  reset();
  await processAIRequestInternal(request(), { header_language: 'es' }, 'gpt61sol');

  assert.equal(state.aiCalls.length, 1);
  assert.equal(state.aiCalls[0].model, 'gpt61sol');
  assert.equal(state.aiCalls[0].requestBody.model, 'gpt-6.1-sol');
  assert.equal(state.aiCalls[0].requestBody.reasoning_effort, 'low');
  assert.deepEqual(state.blobs, ['gpt61sol']);
  const [stage] = stagesNamed(state.costSaves[0], 'ai_call');
  assert.equal(stage.model, 'gpt61sol');
});

test('Terra can still be asked for locally, with its own deployment', async () => {
  reset();
  await processAIRequestInternal(request(), { header_language: 'es' }, 'gpt56terra');

  assert.equal(state.aiCalls[0].requestBody.model, 'gpt-5.6-terra');
  assert.deepEqual(state.blobs, ['gpt56terra']);
});

test('the description goes to English before the diagnosis, with its cost', async () => {
  reset();
  await processAIRequestInternal(request({ diseases_list: 'Miopía', diseases_list_en: false }), null, 'gpt56terra');

  // Descripción y diagnósticos previos en una sola llamada
  assert.deepEqual(state.forwardCalls, [{ texts: [DESCRIPTION, 'Miopía'], lang: 'es' }]);
  assert.equal(state.order[0], 'to_english');
  assert.equal(state.prompts[0], `${english(DESCRIPTION)} ${english('Miopía')}`);
  const [stage] = stagesNamed(state.costSaves[0], 'translation');
  assert.equal(stage.model, 'gpt61terra');
  assert.equal(stage.cost, 0.002);
});

test('previous diagnoses sent in English are not translated again', async () => {
  reset();
  await processAIRequestInternal(request({ diseases_list: 'Myopia', diseases_list_en: true }), null, 'gpt56terra');
  assert.deepEqual(state.forwardCalls, [{ texts: [DESCRIPTION], lang: 'es' }]);
  assert.equal(state.prompts[0], `${english(DESCRIPTION)} Myopia`);
});

test('if the translation to English fails, the request fails with what it cost', async () => {
  reset({ forwardFails: true });
  await assert.rejects(processAIRequestInternal(request(), null, 'gpt56terra'), (error) => {
    assert.equal(error.result, 'translation error');
    return true;
  });
  assert.equal(state.prompts.length, 0);
  const [save] = state.costSaves;
  assert.equal(save.status, 'error');
  const [stage] = stagesNamed(save, 'translation');
  assert.equal(stage.cost, 0.001);
  assert.equal(stage.success, false);
});

test('the answer translation runs alongside the anonymization, and its result is returned', { timeout: 5000 }, async () => {
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
      return NO_PII;
    }
  });
  const result = await processAIRequestInternal(request(), null, 'gpt56terra');

  assert.deepEqual(state.order, ['to_english', 'diagnose', 'translate:start', 'anonymize:start', 'translate:end', 'anonymize:end']);
  assert.deepEqual(state.translateCalls, [{ items: DIAGNOSES, lang: 'es' }]);
  // Solo se anonimiza el inglés
  assert.deepEqual(state.anonymizeCalls, [english(DESCRIPTION)]);
  assert.deepEqual(result.data, TRANSLATED);
  assert.equal(result.showEnglishName, false);
});

test('the saved answer translation stage counts only the wait it added to the response', async () => {
  // La traducción ya ha terminado cuando acaba la anonimización: no añade espera
  reset();
  await processAIRequestInternal(request(), null, 'gpt56terra');

  const [save] = state.costSaves;
  assert.equal(save.status, 'success');
  const [stage] = stagesNamed(save, 'reverse_diseases');
  assert.equal(stage.model, 'gpt61terra');
  assert.equal(stage.cost, 0.004);
  assert.ok(stage.duration < 100, `duration ${stage.duration} should be the exposed wait, not the 1000 ms of the calls`);
  // La anonimización, con el modelo de anonimización
  assert.deepEqual(stagesNamed(save, 'anonymization').map((s) => s.model), ['gpt54mini']);
});

test('an English case is neither translated nor anonymized twice', async () => {
  reset({ lang: 'en' });
  const result = await processAIRequestInternal(request(), null, 'gpt56terra');

  assert.deepEqual(state.forwardCalls, []);
  assert.deepEqual(state.translateCalls, []);
  assert.deepEqual(state.anonymizeCalls, [DESCRIPTION]);
  assert.deepEqual(result.data, DIAGNOSES);
  assert.deepEqual(stagesNamed(state.costSaves[0], 'reverse_diseases'), []);
});

// El anonimizador: tapa cada trozo con [ANON-N] (N caracteres) y en anonymizedText
// los cambia por asteriscos. El resto del texto queda igual, como en el real.
function masked(text, spans) {
  let tagged = text;
  for (const span of spans) tagged = tagged.replace(span, `[ANON-${span.length}]`);
  return {
    hasPersonalInfo: tagged !== text,
    htmlText: tagged,
    anonymizedText: tagged.replace(/\[ANON-(\d+)\]/g, (m, n) => '*'.repeat(Number(n))),
    usage: USAGE
  };
}

const PII_DESCRIPTION = 'Paciente Juan Pérez, teléfono 612 345 678, visión borrosa.';
const NAME_AND_PHONE = ['Juan Pérez', '612 345 678'];

test('with personal data in another language, the user sees the anonymized English translated with Terra', async () => {
  // No se anonimiza el texto original: en nov-2026 se probó y no se podía comprobar
  // con garantías que tapara lo mismo que el inglés
  reset({ anonymize: async (text) => masked(text, NAME_AND_PHONE) });
  const result = await processAIRequestInternal(request({ description: PII_DESCRIPTION }), null, 'gpt56terra');

  assert.deepEqual(state.anonymizeCalls, [english(PII_DESCRIPTION)]);
  assert.deepEqual(state.textCalls, [{ texts: ['[en] Paciente [ANON-10], teléfono [ANON-11], visión borrosa.'], lang: 'es' }]);
  assert.equal(result.anonymization.hasPersonalInfo, true);
  assert.equal(result.anonymization.anonymizedText, '[es] [en] Paciente **********, teléfono ***********, visión borrosa.');
  assert.doesNotMatch(result.anonymization.anonymizedText, /Juan|612/);
  const [stage] = stagesNamed(state.costSaves[0], 'reverse_anonymization');
  assert.equal(stage.cost, 0.001);
  assert.equal(stage.model, 'gpt61terra');
});

test('with personal data in English, the anonymized text is shown as is', async () => {
  reset({ lang: 'en', anonymize: async (text) => masked(text, NAME_AND_PHONE) });
  const result = await processAIRequestInternal(request({ description: 'Patient Juan Pérez, phone 612 345 678, blurred vision.' }), null, 'gpt56terra');

  assert.deepEqual(state.textCalls, []);
  assert.equal(result.anonymization.anonymizedText, 'Patient **********, phone ***********, blurred vision.');
});

test('if anonymization fails, the answer translation already under way is still saved as a failed stage', async () => {
  reset({ anonymize: async () => { throw new Error('anonymizer down'); } });
  await assert.rejects(processAIRequestInternal(request(), null, 'gpt56terra'), /anonymizer down/);

  const [save] = state.costSaves;
  assert.equal(save.status, 'error');
  const [stage] = stagesNamed(save, 'reverse_diseases');
  assert.equal(stage.cost, 0.004);
  assert.equal(stage.success, false);
});

test('if the answer translation and Azure fail, the request fails with the error logged and what the model cost', async () => {
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
  const [stage] = stagesNamed(save, 'reverse_diseases');
  assert.equal(stage.cost, 0.002);
  assert.equal(stage.success, false);
});
