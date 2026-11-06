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

// Respuestas que dará el modelo, en orden; cuando se acaban, repite la última
const state = { replies: [], calls: 0, azureCalls: 0, events: [] };

stubModule('../services/aiUtils', {
  callAiWithFailover: async (requestBody) => {
    state.calls += 1;
    state.lastRequest = requestBody;
    const reply = state.replies.length > 1 ? state.replies.shift() : state.replies[0];
    if (reply instanceof Error) throw reply;
    return {
      data: {
        usage: { prompt_tokens: 100, completion_tokens: 200 },
        choices: [{ message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }]
      }
    };
  },
  translateInvertWithRetry: async (text, lang) => {
    state.azureCalls += 1;
    return `[azure:${lang}] ${text}`;
  }
});
stubModule('../services/insights', {
  trackEvent: (name, properties) => state.events.push({ name, properties }),
  error: () => {}
});

const {
  translateDiagnoses,
  translateTexts,
  costStages,
  showsEnglishName,
  needsTranslation,
  hasForeignLetters,
  readDiagnosis,
  readTexts,
  languageName
} = require('../services/llmTranslation');

const SOURCE = {
  diagnosis: 'Accommodative insufficiency',
  description: 'Reduced ability to focus at near.',
  symptoms_in_common: ['Blurred near vision', 'Eye strain'],
  symptoms_not_in_common: []
};
const SPANISH = {
  diagnosis: 'Insuficiencia acomodativa',
  description: 'Menor capacidad de enfocar de cerca.',
  symptoms_in_common: ['Visión borrosa de cerca', 'Fatiga ocular'],
  symptoms_not_in_common: []
};

function reset(replies) {
  state.replies = replies;
  state.calls = 0;
  state.azureCalls = 0;
  state.events = [];
}

test('a translation with the same shape is accepted, and an empty list may come back without its key', () => {
  assert.deepEqual(readDiagnosis(SOURCE, SPANISH, 'es'), SPANISH);
  const { symptoms_not_in_common: _dropped, ...withoutEmptyList } = SPANISH;
  assert.deepEqual(readDiagnosis(SOURCE, withoutEmptyList, 'es'), SPANISH);
});

test('a translation with other symptoms, an empty text or another script is rejected', () => {
  assert.equal(readDiagnosis(SOURCE, { ...SPANISH, symptoms_in_common: ['Visión borrosa de cerca'] }, 'es'), null);
  assert.equal(readDiagnosis(SOURCE, { ...SPANISH, diagnosis: ' ' }, 'es'), null);
  // Lo que pasó en la prueba: síntomas en polaco convertidos en «و»
  assert.equal(readDiagnosis(SOURCE, { ...SPANISH, symptoms_in_common: ['و', 'و'] }, 'pl'), null);
  assert.equal(readDiagnosis(SOURCE, null, 'es'), null);
});

test('the script check lets gene symbols and Greek letters through in every language', () => {
  assert.equal(hasForeignLetters(['RPGRIP1 से संबंधित लेबर जन्मजात अंधता', 'β-थैलेसीमिया'], 'hi'), false);
  assert.equal(hasForeignLetters(['ضمور المخيخ'], 'bn'), true);
  assert.equal(hasForeignLetters(['Атрофия мозжечка'], 'ru'), false);
  assert.equal(hasForeignLetters(['Атрофия mózgu'], 'pl'), true);
  // Un idioma sin escritura conocida no se comprueba
  assert.equal(hasForeignLetters(['texto'], 'xx-unknown'), false);
});

test('texts keep their [ANON-N] tags', () => {
  const sources = ['Patient [ANON-1] reports pain.', 'No fever.'];
  assert.deepEqual(readTexts(sources, { 1: 'El paciente [ANON-1] refiere dolor.', 2: 'Sin fiebre.' }, 'es'),
    ['El paciente [ANON-1] refiere dolor.', 'Sin fiebre.']);
  assert.equal(readTexts(sources, { 1: 'El paciente refiere dolor.', 2: 'Sin fiebre.' }, 'es'), null);
  assert.equal(readTexts(sources, { 1: 'El paciente [ANON-1] refiere dolor.' }, 'es'), null);
});

test('diagnoses are translated one call each, and the cost comes from the tokens', async () => {
  reset([SPANISH]);
  const result = await translateDiagnoses([SOURCE, SOURCE], 'es', { timezone: 'Europe/Madrid' });
  assert.equal(state.calls, 2);
  assert.equal(state.azureCalls, 0);
  assert.deepEqual(result.items, [SPANISH, SPANISH]);
  assert.equal(result.fallbacks, 0);
  assert.equal(result.promptTokens, 200);
  assert.equal(result.completionTokens, 400);
  assert.ok(result.llmCost > 0);
  assert.equal(state.lastRequest.reasoning_effort, 'none');
  assert.deepEqual(state.lastRequest.response_format, { type: 'json_object' });
  assert.match(state.lastRequest.messages[0].content, /from English to Spanish/);
  assert.deepEqual(costStages(result, 'reverse_diseases').map((stage) => stage.model), ['gpt61terra']);
});

test('a wrong answer is retried once and then that diagnosis goes to Azure', async () => {
  reset([{ ...SPANISH, symptoms_in_common: ['solo uno'] }]);
  const result = await translateDiagnoses([SOURCE], 'es');
  assert.equal(state.calls, 2);
  assert.equal(result.fallbacks, 1);
  assert.equal(result.items[0].diagnosis, '[azure:es] Accommodative insufficiency');
  assert.deepEqual(result.items[0].symptoms_not_in_common, []);
  assert.ok(result.azureChars > 0);
  assert.deepEqual(costStages(result, 'reverse_diseases').map((stage) => stage.model), ['gpt61terra', 'translation_service']);
  assert.equal(state.events[0].name, 'LlmTranslationFallback');
  assert.equal(state.events[0].properties.reason, 'invalid_output');
  assert.equal(state.events[0].properties.problem, 'list_length');
  assert.equal(state.events[0].properties.attempts, '2');
});

test('a failed call goes straight to Azure, with the cause in the event', async () => {
  // callAiWithFailover ya probó las otras regiones; repetir no arregla un 400
  const contentFilter = Object.assign(new Error('Request failed with status code 400'), {
    response: { status: 400, data: { error: { code: 'content_filter' } } }
  });
  reset([contentFilter]);
  const failed = await translateTexts(['No fever.'], 'es');
  assert.deepEqual(failed.texts, ['[azure:es] No fever.']);
  assert.equal(state.calls, 1);
  const event = state.events[0].properties;
  assert.equal(event.reason, 'error');
  assert.equal(event.statusCode, '400');
  assert.equal(event.providerErrorCode, 'content_filter');
  assert.match(event.errorMessage, /status code 400/);
});

test('broken JSON is asked again before going to Azure', async () => {
  reset(['{"1": "Sin fie']);
  const broken = await translateTexts(['No fever.'], 'es');
  assert.deepEqual(broken.texts, ['[azure:es] No fever.']);
  assert.equal(state.calls, 2);
  assert.equal(state.events[0].properties.reason, 'invalid_output');
  assert.equal(state.events[0].properties.problem, 'invalid_json');

  reset(['{"1": "Sin fie', { 1: 'Sin fiebre.' }]);
  const second = await translateTexts(['No fever.'], 'es');
  assert.deepEqual(second.texts, ['Sin fiebre.']);
  assert.equal(state.events.length, 0);
});

test('languages Azure cannot target and English are left as they are', async () => {
  reset([SPANISH]);
  assert.equal(needsTranslation('hi-Latn'), false);
  assert.equal(needsTranslation('en'), false);
  assert.equal(needsTranslation('hi'), true);
  const result = await translateDiagnoses([SOURCE], 'hi-Latn');
  assert.deepEqual(result.items, [SOURCE]);
  assert.equal(state.calls, 0);
  assert.equal(state.azureCalls, 0);
});

test('the English name is shown for Hindi, Bengali, Arabic and other South Asian languages, not Spanish', () => {
  for (const lang of ['hi', 'bn', 'ar', 'ur', 'ta', 'BN']) assert.equal(showsEnglishName(lang), true, lang);
  for (const lang of ['es', 'ru', 'pl', 'fr', 'en', '', undefined]) assert.equal(showsEnglishName(lang), false, lang);
  // Romanized Hindi and Bengali stay in English: the name would be repeated
  for (const lang of ['hi-Latn', 'bn-Latn']) assert.equal(showsEnglishName(lang), false, lang);
});

test('codes with a capitalized script, such as zh-Hans, are translated', () => {
  const { normalizeTargetLang } = require('../services/translation');
  assert.equal(normalizeTargetLang('zh-Hans'), 'zh-Hans');
  assert.equal(normalizeTargetLang('zh-hans'), 'zh-Hans');
  assert.equal(normalizeTargetLang('sr-latn'), 'sr-Latn');
  assert.equal(normalizeTargetLang('zh-cn'), 'zh-Hans');
  assert.equal(normalizeTargetLang('xx'), 'en');
  assert.equal(needsTranslation('zh-Hans'), true);
  assert.equal(hasForeignLetters(['急性阑尾炎'], 'zh-Hans'), false);
});

test("Azure's Kurdish (ku) is Central Kurdish, in Arabic script", () => {
  assert.equal(languageName('ku'), 'Central Kurdish (Sorani)');
  assert.equal(hasForeignLetters(['هەوکردنی ئاپێندیکس'], 'ku'), false);
});

test('the cost record accepts gpt61terra as the model of a stage', () => {
  stubModule('../db_connect', require('mongoose'));
  const CostTracking = require('../models/costTracking');
  const record = new CostTracking({
    myuuid: 'test', operation: 'diagnose', model: 'gpt56terra', lang: 'es', timezone: 'Europe/Madrid',
    stages: [
      { name: 'reverse_diseases', model: 'gpt61terra', cost: 0.001 },
      { name: 'reverse_diseases', model: 'translation_service', cost: 0.0001 }
    ],
    totalCost: 0.0011, status: 'success'
  });
  const error = record.validateSync();
  assert.equal(error?.errors?.['stages.0.model'], undefined);
  assert.equal(error?.errors?.['stages.1.model'], undefined);
});

test('the prompt names the language in English', () => {
  assert.equal(languageName('es'), 'Spanish');
  assert.equal(languageName('zh-Hans'), 'Simplified Chinese');
  assert.equal(languageName('not a code'), 'not a code');
});
