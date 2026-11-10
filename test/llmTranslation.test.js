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

// Respuestas que dará el modelo, en orden; cuando se acaban, repite la última.
// Una respuesta 'echo' devuelve tal cual lo que se le pidió traducir.
const state = { replies: [], calls: 0, azureCalls: 0, events: [], azureFails: false };

stubModule('../services/aiUtils', {
  callAiWithFailover: async (requestBody, timezone, model, retryCount, requestData, options) => {
    state.calls += 1;
    state.lastRequest = requestBody;
    state.lastOptions = options;
    const reply = state.replies.length > 1 ? state.replies.shift() : state.replies[0];
    if (reply instanceof Error) throw reply;
    const content = reply === 'echo'
      ? requestBody.messages[1].content
      : (typeof reply === 'string' ? reply : JSON.stringify(reply));
    return {
      data: {
        usage: { prompt_tokens: 100, completion_tokens: 200 },
        choices: [{ message: { content } }]
      }
    };
  },
  translateInvertWithRetry: async (text, lang) => {
    state.azureCalls += 1;
    if (state.azureFails) throw new Error('Azure Translator down');
    return `[azure:${lang}] ${text}`;
  },
  translateTextWithRetry: async (text, lang) => {
    state.azureCalls += 1;
    if (state.azureFails) throw new Error('Azure Translator down');
    return `[azure-en:${lang}] ${text}`;
  },
  extractProviderError: (error) => (error.response?.data?.error
    ? { providerErrorCode: String(error.response.data.error.code) }
    : {})
});
stubModule('../services/insights', {
  trackEvent: (name, properties) => state.events.push({ name, properties }),
  error: () => {}
});

const {
  translateDiagnoses,
  translateTexts,
  translateToEnglish,
  translateAnswersToEnglish,
  syncBudget,
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
const HINDI = {
  diagnosis: 'समंजन अपर्याप्तता',
  description: 'पास की चीज़ों पर ध्यान केंद्रित करने की क्षमता में कमी।',
  symptoms_in_common: ['पास की धुंधली दृष्टि', 'आँखों में थकान'],
  symptoms_not_in_common: []
};

function reset(replies) {
  state.replies = replies;
  state.calls = 0;
  state.azureCalls = 0;
  state.events = [];
  state.azureFails = false;
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

test('the English answer returned untranslated is rejected, but a name that stays the same is fine', () => {
  assert.equal(readDiagnosis(SOURCE, SOURCE, 'es'), null);
  assert.equal(readDiagnosis(SOURCE, SOURCE, 'hi'), null);
  const cadasil = { ...SOURCE, diagnosis: 'CADASIL' };
  assert.ok(readDiagnosis(cadasil, { ...SPANISH, diagnosis: 'CADASIL' }, 'es'));
  assert.equal(readTexts(['Do you smoke every day?'], { 1: 'Do you smoke every day?' }, 'es'), null);
});

test('the script check lets gene symbols, Greek letters and shared signs through in every language', () => {
  assert.equal(hasForeignLetters(['RPGRIP1 से संबंधित लेबर जन्मजात अंधता', 'β-थैलेसीमिया'], 'hi'), false);
  assert.equal(hasForeignLetters(['ضمور المخيخ'], 'bn'), true);
  assert.equal(hasForeignLetters(['Атрофия мозжечка'], 'ru'), false);
  assert.equal(hasForeignLetters(['Атрофия mózgu'], 'pl'), true);
  // ー (japonés), µ (micro), ʻ (uzbeko) y el tatweel árabe son letras de escritura Common
  assert.equal(hasForeignLetters(['アレルギー性鼻炎', 'パーキンソン病'], 'ja'), false);
  assert.equal(hasForeignLetters(['Creatinina 120 µmol/L'], 'es'), false);
  assert.equal(hasForeignLetters(['Oʻzbekiston'], 'uz'), false);
  assert.equal(hasForeignLetters(['مـرض'], 'ar'), false);
  // Un idioma sin escritura conocida no se comprueba
  assert.equal(hasForeignLetters(['texto'], 'xx-unknown'), false);
});

test('HTML answers keep their tags', () => {
  const source = ['<p><strong>Treatment</strong></p><ul><li>Rest</li></ul>'];
  assert.deepEqual(readTexts(source, { 1: '<p><strong>Tratamiento</strong></p><ul><li>Reposo</li></ul>' }, 'es'),
    ['<p><strong>Tratamiento</strong></p><ul><li>Reposo</li></ul>']);
  assert.equal(readTexts(source, { 1: '<p>Tratamiento</p><ul><li>Reposo</li></ul>' }, 'es'), null);
  // Un «<» del texto que no abre una etiqueta puede cambiar al traducirse
  assert.deepEqual(readTexts(['<p>Ferritin <normal range</p>'], { 1: '<p>Ferritina < rango normal</p>' }, 'es'),
    ['<p>Ferritina < rango normal</p>']);
});

test('texts keep their [ANON-N] tags', () => {
  const sources = ['Patient [ANON-1] reports pain.', 'No fever.'];
  assert.deepEqual(readTexts(sources, { 1: 'El paciente [ANON-1] refiere dolor.', 2: 'Sin fiebre.' }, 'es'),
    ['El paciente [ANON-1] refiere dolor.', 'Sin fiebre.']);
  assert.equal(readTexts(sources, { 1: 'El paciente refiere dolor.', 2: 'Sin fiebre.' }, 'es'), null);
  assert.equal(readTexts(sources, { 1: 'El paciente [ANON-1] refiere dolor.' }, 'es'), null);
});

test('diagnoses are translated one call each, with a deadline, quietly, and the cost comes from the tokens', async () => {
  reset([SPANISH]);
  const before = Date.now();
  const result = await translateDiagnoses([SOURCE, SOURCE], 'es', { timezone: 'Europe/Madrid' });
  assert.equal(state.calls, 2);
  assert.equal(state.azureCalls, 0);
  const withName = { ...SPANISH, diagnosis_en: 'Accommodative insufficiency' };
  assert.deepEqual(result.items, [withName, withName]);
  assert.equal(result.fallbacks, 0);
  assert.equal(result.promptTokens, 200);
  assert.equal(result.completionTokens, 400);
  assert.ok(result.llmCost > 0);
  assert.equal(state.lastRequest.reasoning_effort, 'none');
  assert.deepEqual(state.lastRequest.response_format, { type: 'json_object' });
  assert.match(state.lastRequest.messages[0].content, /from English to Spanish/);
  // El plazo llega a callAiWithFailover, que corta la petición; quiet evita excepciones en Insights
  assert.equal(state.lastOptions.quiet, true);
  assert.ok(state.lastOptions.deadline > before && state.lastOptions.deadline <= Date.now() + 15000);
  const stages = costStages(result, 'reverse_diseases');
  assert.deepEqual(stages.map((stage) => stage.model), ['gpt61terra']);
  assert.equal(stages[0].success, true);
});

test('every translated diagnosis carries its English name, except when it is the same', async () => {
  reset([HINDI]);
  const translated = await translateDiagnoses([SOURCE], 'hi');
  assert.equal(translated.items[0].diagnosis_en, 'Accommodative insufficiency');

  reset([{ ...HINDI, diagnosis: 'CADASIL' }]);
  const same = await translateDiagnoses([{ ...SOURCE, diagnosis: 'CADASIL' }], 'hi');
  assert.equal(same.items[0].diagnosis_en, undefined);

  // También en castellano: el cliente lo usa para pedir más información en inglés
  // (solo lo muestra si showsEnglishName)
  reset([SPANISH]);
  const spanish = await translateDiagnoses([SOURCE], 'es');
  assert.equal(spanish.items[0].diagnosis_en, 'Accommodative insufficiency');
  assert.equal(showsEnglishName('es'), false);
});

test('a wrong answer is retried once and then that diagnosis goes to Azure', async () => {
  reset([{ ...SPANISH, symptoms_in_common: ['solo uno'] }]);
  const result = await translateDiagnoses([SOURCE], 'es');
  assert.equal(state.calls, 2);
  assert.equal(result.fallbacks, 1);
  assert.equal(result.items[0].diagnosis, '[azure:es] Accommodative insufficiency');
  assert.deepEqual(result.items[0].symptoms_not_in_common, []);
  assert.ok(result.azureChars > 0);
  const stages = costStages(result, 'reverse_diseases');
  assert.deepEqual(stages.map((stage) => stage.model), ['gpt61terra', 'translation_service']);
  // El tiempo se reparte entre las dos etapas, sin contarlo dos veces
  assert.equal(stages[0].duration + stages[1].duration, result.durationMs);
  assert.equal(stages[0].success, false);
  const event = state.events[0];
  assert.equal(event.name, 'LlmTranslationFallback');
  assert.equal(event.properties.reason, 'invalid_output');
  assert.equal(event.properties.problem, 'list_length,list_length');
  assert.equal(event.properties.attempts, 2);
});

test('an untranslated echo goes to Azure too', async () => {
  reset(['echo']);
  const result = await translateDiagnoses([SOURCE], 'hi');
  assert.equal(result.fallbacks, 1);
  assert.equal(state.events[0].properties.problem, 'untranslated,untranslated');
  assert.equal(result.items[0].diagnosis, '[azure:hi] Accommodative insufficiency');
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

  // El plazo cortado por axios o por callAiWithFailover cuenta como timeout
  reset([Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' })]);
  await translateTexts(['No fever.'], 'es');
  assert.equal(state.events[0].properties.reason, 'timeout');
  assert.equal(state.events[0].properties.statusCode, 'network');
});

test('broken JSON is asked again before going to Azure', async () => {
  reset(['{"1": "Sin fie']);
  const broken = await translateTexts(['No fever.'], 'es');
  assert.deepEqual(broken.texts, ['[azure:es] No fever.']);
  assert.equal(state.calls, 2);
  assert.equal(state.events[0].properties.reason, 'invalid_output');
  assert.equal(state.events[0].properties.problem, 'invalid_json,invalid_json');

  reset(['{"1": "Sin fie', { 1: 'Sin fiebre.' }]);
  const second = await translateTexts(['No fever.'], 'es');
  assert.deepEqual(second.texts, ['Sin fiebre.']);
  assert.equal(state.events.length, 0);
});

test('a long text gets a longer deadline than a diagnosis', async () => {
  reset([{ 1: 'Texto largo traducido.' }]);
  const before = Date.now();
  await translateTexts(['word '.repeat(1000)], 'es');
  assert.ok(state.lastOptions.deadline - before > 20000);
  assert.ok(state.lastOptions.deadline - before <= 45000);
});

test('if Azure also fails, the error carries what the model already cost', async () => {
  reset([{ ...SPANISH, symptoms_in_common: ['solo uno'] }]);
  state.azureFails = true;
  // Dos diagnósticos, dos intentos cada uno: las 4 llamadas cuentan, también las del
  // diagnóstico que seguía en marcha cuando el otro falló
  await assert.rejects(translateDiagnoses([SOURCE, SOURCE], 'es'), (error) => {
    assert.equal(error.message, 'Azure Translator down');
    assert.equal(state.calls, 4);
    assert.equal(error.translationResult.promptTokens, 400);
    assert.ok(error.translationResult.llmCost > 0);
    return true;
  });
});

test('languages Azure cannot target and English are left as they are', async () => {
  reset([SPANISH]);
  assert.equal(needsTranslation('hi-Latn'), false);
  assert.equal(needsTranslation('en'), false);
  assert.equal(needsTranslation('en-US'), false);
  assert.equal(needsTranslation(undefined), false);
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

test('the prompt names the language as Azure would translate it', () => {
  assert.equal(languageName('es'), 'Spanish');
  assert.equal(languageName('zh-Hans'), 'Simplified Chinese');
  assert.equal(languageName('zh'), 'Simplified Chinese');
  assert.equal(languageName('pt_br'), 'Brazilian Portuguese');
  // Intl no conoce estos códigos de Azure: se usa el nombre de su tabla
  assert.equal(languageName('yua'), 'Yucatec Maya');
  assert.equal(languageName('hne'), 'Chhattisgarhi');
  // Azure escribe el tártaro en latino y el kurdo central (ku) en árabe
  assert.equal(languageName('tt'), 'Tatar (Latin script)');
  assert.equal(hasForeignLetters(['Yuqarı sulış yulları infektsiyäse'], 'tt'), false);
  assert.equal(languageName('ku'), 'Central Kurdish (Sorani)');
  assert.equal(hasForeignLetters(['هەوکردنی ئاپێندیکس'], 'ku'), false);
  assert.equal(languageName('kmr'), 'Northern Kurdish (Kurmanji)');
});

test('what the user wrote goes to English in one call, quietly, and an echo is accepted', async () => {
  reset([{ 1: 'No fever. Has taken ibuprofen.', 2: 'Migraine, Tension headache' }]);
  const result = await translateToEnglish(['Sin fiebre. Ha tomado ibuprofeno.', 'Migraña, Cefalea tensional'], 'es');
  assert.deepEqual(result.texts, ['No fever. Has taken ibuprofen.', 'Migraine, Tension headache']);
  assert.equal(state.calls, 1);
  assert.equal(state.lastOptions.quiet, true);
  assert.match(state.lastRequest.messages[0].content, /from Spanish into English/);
  assert.deepEqual(costStages(result, 'translation').map((stage) => stage.model), ['gpt61terra']);

  // Detectado como castellano pero ya venía en inglés: se queda igual, sin respaldo,
  // y se cuenta por si fuera el idioma original sin traducir
  reset(['echo']);
  const echo = await translateToEnglish(['Headache for three weeks, no fever.'], 'es');
  assert.deepEqual(echo.texts, ['Headache for three weeks, no fever.']);
  assert.equal(echo.fallbacks, 0);
  assert.deepEqual(state.events.map((event) => [event.name, event.properties.kind]), [['LlmTranslationUnchanged', 'to_english']]);
});

test('the translation to English has a shorter deadline, because it comes before the diagnosis', async () => {
  // El plazo se fija al empezar la llamada, entre «antes» y «después»: comparar con
  // el momento correcto evita fallos de un milisegundo con el equipo cargado
  async function budget(texts, options) {
    const before = Date.now();
    await translateToEnglish(texts, 'es', {}, options);
    const after = Date.now();
    return { atLeast: state.lastOptions.deadline - after, atMost: state.lastOptions.deadline - before };
  }
  reset([{ 1: 'Short case.' }]);
  assert.ok((await budget(['Caso corto.'])).atLeast <= 10000);
  const long = await budget(['palabra '.repeat(1500)]);
  assert.ok(long.atMost > 20000);
  assert.ok(long.atLeast <= 30000);
  // El resumen y «mejorar», que responden en la misma llamada HTTP, lo acortan
  assert.ok((await budget(['palabra '.repeat(1500)], { maxBudgetMs: 20000 })).atLeast <= 20000);
});

test('an English translation left in another script goes to Azure', async () => {
  reset([{ 1: 'Головная боль три недели.' }]);
  const result = await translateToEnglish(['Головная боль три недели.'], 'ru');
  assert.deepEqual(result.texts, ['[azure-en:ru] Головная боль три недели.']);
  assert.equal(state.events[0].properties.kind, 'to_english');
  assert.equal(state.events[0].properties.problem, 'foreign_script,foreign_script');
});

test('Greek left untranslated is another script too, but loose Greek letters are not', async () => {
  // Antes valía cualquier letra griega (por α, β), también un texto entero en griego
  reset([{ 1: 'Ο ασθενής έχει πονοκέφαλο.' }]);
  const result = await translateToEnglish(['Ο ασθενής έχει πονοκέφαλο.'], 'el');
  assert.deepEqual(result.texts, ['[azure-en:el] Ο ασθενής έχει πονοκέφαλο.']);
  assert.equal(state.events[0].properties.problem, 'foreign_script,foreign_script');

  assert.equal(hasForeignLetters(['Linfocitos T γδ y receptores β'], 'es'), false);
  assert.equal(hasForeignLetters(['Ο ασθενής'], 'el'), false);
});

test('a synchronous route without time left for the model goes straight to Azure', async () => {
  reset([{ 1: 'Pregunta.' }]);
  const result = await translateTexts(['Question.'], 'es', {}, { maxBudgetMs: 2000 });
  assert.deepEqual(result.texts, ['[azure:es] Question.']);
  assert.equal(state.calls, 0);
  assert.equal(state.events[0].properties.reason, 'no_time');

  // syncBudget: lo que le queda a la petición de sus 40 s, y como mucho el tope
  assert.equal(syncBudget(Date.now(), 20000).maxBudgetMs, 20000);
  const late = syncBudget(Date.now() - 38000).maxBudgetMs;
  assert.ok(late <= 2000 && late > 1000, String(late));
});

test('English is not sent to translate, and a source Azure cannot target is still named', async () => {
  reset([{ 1: 'Fever for two days.' }]);
  const english = await translateToEnglish(['Fever for two days.'], 'en-US');
  assert.equal(state.calls, 0);
  assert.deepEqual(english.texts, ['Fever for two days.']);

  await translateToEnglish(['Do din se bukhar hai.'], 'hi-Latn');
  assert.match(state.lastRequest.messages[0].content, /from Hindi \(Latin\) into English/);
  // Un código con guion bajo, como los del cliente
  await translateToEnglish(['Febre há dois dias.'], 'pt_br');
  assert.match(state.lastRequest.messages[0].content, /from Brazilian Portuguese into English/);
});

test('follow-up answers go to English together, each with its question, and keep their other fields', async () => {
  const answers = [
    { question: '¿Le duele?', answer: 'Solo el izquierdo', id: 1 },
    { question: '¿Ha tenido fiebre?', answer: 'No, nunca', id: 2 }
  ];
  reset([{ answers: [
    { question: 'Does it hurt?', answer: 'Only the left one' },
    { question: 'Have you had a fever?', answer: 'No, never' }
  ] }]);
  const result = await translateAnswersToEnglish(answers, 'es');
  assert.deepEqual(result.answers, [
    { question: 'Does it hurt?', answer: 'Only the left one', id: 1 },
    { question: 'Have you had a fever?', answer: 'No, never', id: 2 }
  ]);
  assert.equal(state.calls, 1);
  assert.match(state.lastRequest.messages[0].content, /in the context of its question/);

  // Una respuesta perdida: a Azure, campo a campo como antes
  reset([{ answers: [{ question: 'Does it hurt?', answer: 'Only the left one' }] }]);
  const short = await translateAnswersToEnglish(answers, 'es');
  assert.equal(short.answers[1].answer, '[azure-en:es] No, nunca');
  assert.equal(short.answers[1].id, 2);
  assert.equal(state.azureCalls, 4);
  assert.equal(state.events[0].properties.kind, 'answers');
  assert.equal(state.events[0].properties.problem, 'list_length,list_length');

  // Devueltas tal cual: se aceptan, como hacia el inglés, pero se cuentan
  reset([{ answers: answers.map(({ question, answer }) => ({ question, answer })) }]);
  const echo = await translateAnswersToEnglish(answers, 'es');
  assert.equal(echo.answers[1].answer, 'No, nunca');
  assert.deepEqual(state.events.map((event) => [event.name, event.properties.kind]), [['LlmTranslationUnchanged', 'answers']]);
});

test('if Azure also fails going to English, the error carries what the model already cost', async () => {
  reset([{ 1: 'Головная боль.' }]);
  state.azureFails = true;
  await assert.rejects(translateToEnglish(['Головная боль.'], 'ru'), (error) => {
    assert.equal(error.message, 'Azure Translator down');
    assert.equal(error.translationResult.promptTokens, 200);
    // Azure no cobra una traducción que falla: no aparece como etapa
    assert.equal(error.translationResult.azureChars, 0);
    return true;
  });
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
