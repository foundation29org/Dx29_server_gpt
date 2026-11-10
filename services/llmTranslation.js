'use strict';

// Traducción de vuelta (del inglés al idioma del usuario) de lo que genera la IA.
// Azure Translator traduce cada nombre y cada síntoma por separado, sin contexto,
// y en la prueba del 5-nov-2026 (respuestas de Sol en 10 idiomas, juez a ciegas)
// dejó algún error crítico en el 81 % de las respuestas: «Accommodative
// insufficiency» salía «Suficiencia acomodativa». gpt-6.1-terra, con una llamada
// por diagnóstico y todas a la vez, lo dejó en el 3 % con material difícil y
// tarda unos 2,5 s por respuesta. Si el modelo devuelve otra estructura, otro
// alfabeto o el inglés sin traducir se le pide otra vez; si sigue mal, falla o
// se acaba el plazo, esa parte se traduce con Azure como antes.
//
// La traducción de ida (lo que escribe el usuario, al inglés) va igual. En la
// prueba del 6-nov-2026 (60 casos reales de urgencias en castellano, casos en
// ruso, hindi y árabe y respuestas cortas de «mejorar»; juez a ciegas), Azure dejó
// algún error crítico en el 47 % de los casos y en el 29 % de los juegos de
// respuestas («no tto médico, ha tomado ibuprofeno» → «had not taken ibuprofen»);
// Terra, en el 1 % y el 0 %. Añade unos 2 s de mediana antes del diagnóstico.

const { callAiWithFailover, translateTextWithRetry, translateInvertWithRetry, extractProviderError } = require('./aiUtils');
const { normalizeTargetLang } = require('./translation');
const { calculatePrice, calculateTranslatorCost } = require('./costUtils');
const SUPPORTED = require('./translatorSupported.json');
const insights = require('./insights');

const MODEL = 'gpt61terra';
// Plazo para todos los intentos de un diagnóstico (Terra tarda unos 2,5 s, p90
// 3,5 s). Un texto largo tiene más (ver textBudgetMs); lo que quede, a Azure.
const TRANSLATION_TIMEOUT_MS = 15000;
const MAX_TRANSLATION_TIMEOUT_MS = 45000;
const MS_PER_CHAR_OVER_1000 = 6;
const TO_ENGLISH_TIMEOUT_MS = 10000;
const MAX_TO_ENGLISH_TIMEOUT_MS = 30000;
// Tope para las llamadas que responden en la misma petición HTTP (resumen y
// «mejorar»): el proxy de la web corta a los 45 s. En la prueba del 6-nov Terra
// tardó 5 s con 2200 caracteres y 10 s con 7500.
const SYNC_TO_ENGLISH_TIMEOUT_MS = 20000;
// Esas rutas tienen 40 s para todo: la traducción al inglés como mucho
// SYNC_TO_ENGLISH_TIMEOUT_MS y la de vuelta lo que le quede a la petición. Sin
// tiempo para el modelo, la traducción va directamente a Azure.
const SYNC_RESPONSE_MS = 40000;
const TO_ENGLISH_MS_PER_CHAR_OVER_1000 = 4;
// Otro intento solo si queda al menos esto: con menos se cortaría sin terminar.
const MIN_RETRY_BUDGET_MS = 5000;
const LLM_ATTEMPTS = 2;
const TIMEOUT_ERROR_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'AI_DEADLINE_EXCEEDED']);

// Idiomas en que se muestra el nombre original en inglés bajo el traducido. En la
// prueba, el hindi y el árabe fueron los que más errores críticos tuvieron, y en el
// sur de Asia la medicina se estudia en inglés. Las demás lenguas índicas no se
// midieron; en castellano, ruso o polaco los errores fueron casi nulos.
const ENGLISH_NAME_LANGS = new Set([
  'hi', 'bn', 'ur', 'ar', 'ne', 'mr', 'gu', 'pa', 'ta', 'te', 'kn', 'ml', 'or', 'as', 'si'
]);

// Escritura de cada idioma (código de Intl.Locale) -> propiedades Script de Unicode.
const SCRIPTS = {
  Latn: ['Latin'], Cyrl: ['Cyrillic'], Arab: ['Arabic'], Deva: ['Devanagari'], Beng: ['Bengali'],
  Hans: ['Han'], Hant: ['Han'], Jpan: ['Han', 'Hiragana', 'Katakana'], Kore: ['Hangul', 'Han'],
  Grek: ['Greek'], Hebr: ['Hebrew'], Thai: ['Thai'], Taml: ['Tamil'], Telu: ['Telugu'],
  Gujr: ['Gujarati'], Guru: ['Gurmukhi'], Knda: ['Kannada'], Mlym: ['Malayalam'], Orya: ['Oriya'],
  Sinh: ['Sinhala'], Geor: ['Georgian'], Armn: ['Armenian'], Ethi: ['Ethiopic'], Khmr: ['Khmer'],
  Laoo: ['Lao'], Mymr: ['Myanmar'], Mtei: ['Meetei_Mayek']
};

// Códigos de Azure (translatorSupported.json) que Intl nombra o escribe de otra
// forma. El nombre va al prompt y la escritura a la comprobación de alfabeto, para
// que el modelo y el respaldo de Azure den la misma variante.
const LANGUAGE_OVERRIDES = {
  ku: { name: 'Central Kurdish (Sorani)', script: 'Arab' },
  kmr: { name: 'Northern Kurdish (Kurmanji)' },
  pt: { name: 'Brazilian Portuguese' },
  tt: { name: 'Tatar (Latin script)', script: 'Latn' },
  mni: { name: 'Manipuri (Meitei Mayek script)', script: 'Mtei' }
};

const DISPLAY_NAMES = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });

const LIST_FIELDS = ['symptoms_in_common', 'symptoms_not_in_common'];

function baseLanguage(lang) {
  return String(lang || '').trim().toLowerCase().split(/[-_]/)[0];
}

// Lenguas que Azure no admite como destino (p. ej. hi-Latn) siguen recibiendo el
// inglés, como antes: no hay respaldo con el que comparar.
function needsTranslation(lang) {
  return normalizeTargetLang(lang) !== 'en';
}

// Solo si la respuesta se traduce: hi-Latn o bn-Latn se quedan en inglés y el
// nombre saldría repetido.
function showsEnglishName(lang) {
  return ENGLISH_NAME_LANGS.has(baseLanguage(lang)) && needsTranslation(lang);
}

// El nombre del idioma en inglés para el prompt, del código que usará Azure si
// hace falta el respaldo (pt_br -> pt, zh -> zh-Hans). Si Intl no lo conoce (hne,
// otq, yua), el de la tabla de Azure.
function languageName(lang) {
  const code = normalizeTargetLang(lang);
  const override = LANGUAGE_OVERRIDES[code.toLowerCase()];
  if (override?.name) return override.name;
  try {
    const name = DISPLAY_NAMES.of(code);
    if (name) return name;
  } catch {
    // Código que Intl no entiende: se usa la tabla de Azure
  }
  return SUPPORTED[code] || code;
}

// Una letra de otro alfabeto delata una traducción rota: en la prueba salieron
// síntomas en polaco convertidos en «و» y frases en árabe dentro del bengalí.
// Valen en todos los idiomas el latino (genes, siglas), letras griegas sueltas
// (α, β, γδ) y las de escritura Common o Inherited (µ, ʻ, ʼ); tres letras griegas
// seguidas ya son una palabra en griego sin traducir. Se usa Script_Extensions
// porque ー (japonés) o el tatweel árabe son Common pero propios de una escritura.
function foreignLetterPattern(lang) {
  const code = normalizeTargetLang(lang);
  let script = LANGUAGE_OVERRIDES[code.toLowerCase()]?.script;
  try {
    script = script || new Intl.Locale(code).maximize().script;
  } catch {
    return null;
  }
  const own = SCRIPTS[script];
  if (!own) return null;
  const allowed = ['Latin', 'Greek', ...own].map((name) => `\\p{scx=${name}}`).join('');
  const greekWord = own.includes('Greek') ? '' : '|\\p{Script=Greek}{3,}';
  return new RegExp(`(?=\\p{L})[^${allowed}\\p{Script=Common}\\p{Script=Inherited}]${greekWord}`, 'u');
}

function hasForeignLetters(texts, lang) {
  const pattern = foreignLetterPattern(lang);
  return Boolean(pattern) && texts.some((text) => pattern.test(text));
}

function anonTags(text) {
  return (String(text || '').match(/\[ANON-\d+\]/g) || []).sort().join(',');
}

// Las respuestas de /api/disease/info son HTML: la traducción debe conservar las
// mismas etiquetas para que se pinten igual. Solo cuenta lo que se cierra con «>»:
// un «<normal» o un «x<y» del texto no es una etiqueta.
function htmlTags(text) {
  return Array.from(String(text || '').matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^<>]*>/gi),
    ([, slash, name]) => `${slash}${name.toLowerCase()}`).sort().join(',');
}

function sameText(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

// El inglés devuelto tal cual no es una traducción. Basta con que cambie un texto:
// nombres como «CADASIL» o «MELAS» se quedan igual, pero una frase no.
function untranslated(sources, outputs) {
  const words = (text) => (String(text || '').match(/\p{L}+/gu) || []).length;
  return sources.some((source) => words(source) >= 3) && outputs.every((out, i) => sameText(out, sources[i]));
}

// Qué falla en una traducción, o null si está bien: cada texto es una cadena,
// no vacía si el original no lo era, con las etiquetas [ANON-N] del original, en
// el alfabeto del idioma y traducida. El motivo va a la telemetría del respaldo.
// Hacia el inglés no se mira si vuelve igual: el idioma detectado puede fallar y
// el texto ya venir en inglés, y un texto en otro alfabeto sin traducir ya lo
// delata la comprobación de alfabeto.
function textsProblem(sources, outputs, lang, { checkUntranslated = true } = {}) {
  if (outputs.some((out) => typeof out !== 'string')) return 'missing_text';
  if (outputs.some((out, i) => out.trim() === '' && String(sources[i] || '').trim())) return 'empty_text';
  if (outputs.some((out, i) => anonTags(out) !== anonTags(sources[i]))) return 'anon_tags';
  if (outputs.some((out, i) => htmlTags(out) !== htmlTags(sources[i]))) return 'html_tags';
  if (hasForeignLetters(outputs, lang)) return 'foreign_script';
  if (checkUntranslated && untranslated(sources, outputs)) return 'untranslated';
  return null;
}

function diagnosisPrompt(language) {
  return `Translate the JSON values from English to ${language} for clinicians. Use the standard ${language} ` +
    'medical term for every diagnosis and symptom. Keep the JSON keys and structure, and the same number of ' +
    'items in every list. Return only JSON.';
}

function textPrompt(language) {
  return `Translate the JSON values from English to ${language}. Use the standard ${language} medical terms. ` +
    'Keep the JSON keys, the line breaks, the formatting (HTML tags included) and any [ANON-N] tags exactly as ' +
    'they are. Return only JSON.';
}

// Hacia el inglés: el prompt de la prueba del 6-nov, que pide no resumir ni
// interpretar lo que escribió el usuario.
function toEnglishPrompt(language) {
  return `Translate the JSON values from ${language} into English for a physician. Translate faithfully: keep ` +
    'every finding, negative finding, value with its unit, time, duration, side, drug and dose, and any ' +
    'uncertainty. Do not add, omit, summarize or interpret anything. Write local abbreviations as the usual ' +
    'English term or abbreviation. Keep the JSON keys, the line breaks and any [ANON-N] tags exactly as they ' +
    'are. Return only JSON.';
}

// Las respuestas de «mejorar» son cortas («no, nunca», «solo el derecho»): se
// traducen juntas y cada una con su pregunta, que es lo que les da sentido.
function answersPrompt(language) {
  return `Translate the follow-up questions and the patient's answers in the JSON from ${language} into ` +
    'English for a physician. Translate each answer in the context of its question and keep its exact ' +
    'meaning: yes or no, negations, side, frequency, duration, numbers and uncertainty. Do not add or ' +
    'interpret anything. Keep the JSON keys and the same number of items. Return only JSON.';
}

// El nombre en inglés del idioma de origen. A diferencia de languageName, no pasa
// por los destinos de Azure: hi-Latn es «Hindi (Latin)», no se queda en inglés.
function sourceLanguageName(lang) {
  try {
    const name = DISPLAY_NAMES.of(new Intl.Locale(String(lang || '').trim().replace(/_/g, '-')).toString());
    if (name) return name;
  } catch {
    // Código que Intl no entiende: se usa la tabla de Azure
  }
  return SUPPORTED[baseLanguage(lang)] || 'the original language';
}

function diagnosisSource(item) {
  return {
    diagnosis: item.diagnosis,
    description: item.description,
    symptoms_in_common: item.symptoms_in_common || [],
    symptoms_not_in_common: item.symptoms_not_in_common || []
  };
}

function diagnosisTexts(item) {
  return [item.diagnosis, item.description, ...item.symptoms_in_common, ...item.symptoms_not_in_common];
}

// La traducción de un diagnóstico ({ value }) o por qué no vale ({ problem }).
// Una lista vacía puede volver sin su clave.
function checkDiagnosis(source, out, lang) {
  if (!out || typeof out !== 'object') return { problem: 'not_an_object' };
  const item = { diagnosis: out.diagnosis, description: out.description };
  for (const field of LIST_FIELDS) {
    const value = out[field] ?? (source[field].length === 0 ? [] : undefined);
    if (!Array.isArray(value) || value.length !== source[field].length) return { problem: 'list_length' };
    item[field] = value;
  }
  const problem = textsProblem(diagnosisTexts(source), diagnosisTexts(item), lang);
  return problem ? { problem } : { value: item };
}

function checkTexts(sources, out, lang, options) {
  if (!out || typeof out !== 'object') return { problem: 'not_an_object' };
  const texts = sources.map((_, i) => out[String(i + 1)]);
  const problem = textsProblem(sources, texts, lang, options);
  return problem ? { problem } : { value: texts };
}

function answerTexts(pairs) {
  return pairs.flatMap((pair) => [pair.question, pair.answer]);
}

function checkAnswers(sources, out) {
  const answers = out?.answers;
  if (!Array.isArray(answers) || answers.length !== sources.length) return { problem: 'list_length' };
  if (answers.some((pair) => !pair || typeof pair !== 'object')) return { problem: 'not_an_object' };
  const translated = answers.map((pair) => ({ question: pair.question, answer: pair.answer }));
  const problem = textsProblem(answerTexts(sources), answerTexts(translated), 'en', { checkUntranslated: false });
  return problem ? { problem } : { value: translated };
}

function readDiagnosis(source, out, lang) {
  return checkDiagnosis(source, out, lang).value || null;
}

function readTexts(sources, out, lang) {
  return checkTexts(sources, out, lang).value || null;
}

// La respuesta del modelo ya leída como JSON, o { problem: 'invalid_json' }. Los
// errores de la llamada (HTTP, plazo) se lanzan. El plazo corta la petición en
// callAiWithFailover, y quiet evita registrar como excepción un fallo que aquí
// tiene respaldo.
async function callModel(systemPrompt, payload, ctx, totals, deadline) {
  const response = await callAiWithFailover(
    {
      messages: [
        { role: 'developer', content: systemPrompt },
        { role: 'user', content: JSON.stringify(payload) }
      ],
      reasoning_effort: 'none',
      response_format: { type: 'json_object' }
    },
    ctx.timezone,
    MODEL,
    0,
    ctx.requestData,
    { deadline, quiet: true }
  );
  const usage = response?.data?.usage;
  if (usage) {
    totals.promptTokens += usage.prompt_tokens || 0;
    totals.completionTokens += usage.completion_tokens || 0;
  }
  try {
    return { data: JSON.parse(response?.data?.choices?.[0]?.message?.content || '') };
  } catch {
    return { problem: 'invalid_json' };
  }
}

function describeError(error) {
  return {
    reason: TIMEOUT_ERROR_CODES.has(error.code) ? 'timeout' : 'error',
    errorMessage: String(error.message || '').slice(0, 300),
    statusCode: String(error.response?.status || 'network'),
    ...extractProviderError(error)
  };
}

function safelyTrackEvent(name, { kind, lang, ctx }) {
  try {
    insights.trackEvent(name, {
      kind,
      lang,
      model: MODEL,
      myuuid: ctx.requestData?.myuuid || 'unknown',
      tenantId: ctx.requestData?.tenantId || 'unknown'
    });
  } catch (telemetryError) {
    console.error(`No se pudo registrar ${name}:`, telemetryError.message);
  }
}

function safelyTrackFallback(kind, lang, failure, attempts, ctx) {
  console.warn(`LLM translation fallback to Azure (${kind}, ${lang}): ${failure.reason}` +
    (failure.problem ? ` / ${failure.problem}` : '') + (failure.errorMessage ? ` / ${failure.errorMessage}` : ''));
  try {
    insights.trackEvent('LlmTranslationFallback', {
      kind,
      lang,
      ...failure,
      attempts,
      model: MODEL,
      myuuid: ctx.requestData?.myuuid || 'unknown',
      tenantId: ctx.requestData?.tenantId || 'unknown'
    });
  } catch (telemetryError) {
    console.error('No se pudo registrar LlmTranslationFallback:', telemetryError.message);
  }
}

// Se repite solo si el modelo contestó algo que no vale (otra estructura, otro
// alfabeto, inglés sin traducir, JSON roto) y queda plazo para otra llamada. Un
// error de la llamada va directo a Azure: callAiWithFailover ya probó las otras
// regiones, y repetir no arregla un 400 (filtro de contenido) ni un timeout.
async function translateWithFallback(kind, lang, ctx, totals, tryModel, useAzure, budgetMs = TRANSLATION_TIMEOUT_MS) {
  const deadline = Date.now() + budgetMs;
  const problems = [];
  // Sin tiempo para el modelo (una ruta síncrona que ya ha gastado casi todo su
  // plazo), Azure directamente
  const hasTime = budgetMs >= MIN_RETRY_BUDGET_MS;
  let failure = hasTime ? { reason: 'invalid_output' } : { reason: 'no_time' };
  let attempts = 0;
  while (hasTime && attempts < LLM_ATTEMPTS && (attempts === 0 || deadline - Date.now() >= MIN_RETRY_BUDGET_MS)) {
    attempts += 1;
    try {
      const { value, problem } = await tryModel(deadline);
      if (value) return value;
      problems.push(problem);
    } catch (error) {
      failure = describeError(error);
      break;
    }
  }
  totals.fallbacks += 1;
  safelyTrackFallback(kind, lang, problems.length ? { ...failure, problem: problems.join(',') } : failure, attempts, ctx);
  const azureStartedAt = Date.now();
  try {
    return await useAzure();
  } finally {
    totals.azureMs = Math.max(totals.azureMs, Date.now() - azureStartedAt);
  }
}

// Azure cobra lo que traduce: si la llamada falla, sus caracteres no cuentan
async function azureText(text, lang, totals) {
  if (!text) return text;
  const translated = await translateInvertWithRetry(text, lang);
  totals.azureChars += text.length;
  return translated;
}

async function azureToEnglish(text, lang, totals) {
  if (!text) return text;
  const translated = await translateTextWithRetry(text, lang);
  totals.azureChars += text.length;
  return translated;
}

async function azureDiagnosis(source, lang, totals) {
  const [diagnosis, description, inCommon, notInCommon] = await Promise.all([
    azureText(source.diagnosis, lang, totals),
    azureText(source.description, lang, totals),
    Promise.all(source.symptoms_in_common.map((s) => azureText(s, lang, totals))),
    Promise.all(source.symptoms_not_in_common.map((s) => azureText(s, lang, totals)))
  ]);
  return { diagnosis, description, symptoms_in_common: inCommon, symptoms_not_in_common: notInCommon };
}

function newTotals() {
  return { promptTokens: 0, completionTokens: 0, azureChars: 0, azureMs: 0, fallbacks: 0, startedAt: Date.now() };
}

function summarize(totals) {
  const llmCost = totals.promptTokens || totals.completionTokens
    ? calculatePrice({ prompt_tokens: totals.promptTokens, completion_tokens: totals.completionTokens }, MODEL).totalCost
    : 0;
  const azureCost = calculateTranslatorCost(totals.azureChars);
  const durationMs = Date.now() - totals.startedAt;
  return {
    model: MODEL,
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    llmCost,
    azureChars: totals.azureChars,
    azureCost,
    azureMs: Math.min(totals.azureMs, durationMs),
    cost: llmCost + azureCost,
    fallbacks: totals.fallbacks,
    durationMs
  };
}

// Etapas de coste con el formato de CostTrackingService: una para el modelo y
// otra para Azure si hubo respaldo. Se reparten el tiempo (suman la duración del
// paso), y la del modelo no cuenta como correcta si algo tuvo que ir a Azure.
function costStages(result, name) {
  const stages = [];
  if (result.promptTokens || result.completionTokens) {
    stages.push({
      name,
      cost: result.llmCost,
      tokens: {
        input: result.promptTokens,
        output: result.completionTokens,
        total: result.promptTokens + result.completionTokens
      },
      model: result.model,
      duration: result.durationMs - result.azureMs,
      success: result.fallbacks === 0
    });
  }
  if (result.azureChars > 0) {
    stages.push({
      name,
      cost: result.azureCost,
      tokens: { input: result.azureChars, output: result.azureChars, total: result.azureChars },
      model: 'translation_service',
      duration: result.azureMs,
      success: true
    });
  }
  return stages;
}

// Un texto largo (la descripción actualizada del seguimiento llega a 5000
// caracteres) necesita más tiempo de generación que un diagnóstico.
function textBudgetMs(texts) {
  const chars = texts.reduce((sum, text) => sum + String(text || '').length, 0);
  return Math.min(MAX_TRANSLATION_TIMEOUT_MS,
    TRANSLATION_TIMEOUT_MS + Math.max(0, chars - 1000) * MS_PER_CHAR_OVER_1000);
}

// El plazo de una traducción en una ruta síncrona que empezó en startedAt: lo que
// le queda de SYNC_RESPONSE_MS, y como mucho capMs
function syncBudget(startedAt, capMs = SYNC_RESPONSE_MS) {
  return { maxBudgetMs: Math.min(capMs, SYNC_RESPONSE_MS - (Date.now() - startedAt)) };
}

// Hacia el inglés la espera va antes del diagnóstico, así que el plazo es más
// corto: un caso de unos 1000 caracteres tarda 2,2 s de mediana (p90 4,9 s).
function toEnglishBudgetMs(texts) {
  const chars = texts.reduce((sum, text) => sum + String(text || '').length, 0);
  return Math.min(MAX_TO_ENGLISH_TIMEOUT_MS,
    TO_ENGLISH_TIMEOUT_MS + Math.max(0, chars - 1000) * TO_ENGLISH_MS_PER_CHAR_OVER_1000);
}

// Si la traducción acaba en error (el respaldo de Azure también falla), el coste
// ya gastado viaja en el error para que quien llama pueda registrarlo.
function withPartialResult(error, totals) {
  error.translationResult = summarize(totals);
  return error;
}

/**
 * Traduce los diagnósticos de una respuesta, cada uno en su propia llamada y
 * todos a la vez. Cada uno lleva diagnosis_en con el nombre original, salvo que
 * coincida con el traducido: el cliente lo usa para pedir más información o más
 * diagnósticos en inglés, y lo muestra si showsEnglishName(lang).
 * @param {Array<{diagnosis, description, symptoms_in_common, symptoms_not_in_common}>} diagnoses
 * @param {string} lang - idioma detectado del usuario
 * @param {{timezone?: string, requestData?: object}} ctx
 * @returns {Promise<{items: Array, cost: number, fallbacks: number, durationMs: number}>} y los
 *   tokens, caracteres y costes por separado
 */
async function translateDiagnoses(diagnoses, lang, ctx = {}) {
  const totals = newTotals();
  if (!needsTranslation(lang) || !diagnoses.length) {
    return { items: diagnoses, ...summarize(totals) };
  }
  const prompt = diagnosisPrompt(languageName(lang));
  // allSettled: si un diagnóstico falla del todo, se espera a los demás para que
  // el coste parcial incluya todas las llamadas ya pagadas
  const settled = await Promise.allSettled(diagnoses.map(async (item) => {
    const source = diagnosisSource(item);
    const translated = await translateWithFallback(
      'diagnosis', lang, ctx, totals,
      async (deadline) => {
        const { data, problem } = await callModel(prompt, source, ctx, totals, deadline);
        return problem ? { problem } : checkDiagnosis(source, data, lang);
      },
      () => azureDiagnosis(source, lang, totals)
    );
    return sameText(translated.diagnosis, source.diagnosis)
      ? translated
      : { ...translated, diagnosis_en: source.diagnosis };
  }));
  const failed = settled.find((outcome) => outcome.status === 'rejected');
  if (failed) {
    throw withPartialResult(failed.reason, totals);
  }
  return { items: settled.map((outcome) => outcome.value), ...summarize(totals) };
}

/**
 * Traduce una lista de textos (preguntas, una descripción, un resumen) en una
 * sola llamada, para que compartan contexto.
 * @param {string[]} texts
 * @param {string} lang
 * @param {{timezone?: string, requestData?: object}} ctx
 * @returns {Promise<{texts: string[], cost: number, fallbacks: number, durationMs: number}>}
 */
async function translateTexts(texts, lang, ctx = {}, { maxBudgetMs = MAX_TRANSLATION_TIMEOUT_MS } = {}) {
  const totals = newTotals();
  if (!needsTranslation(lang) || !texts.length) {
    return { texts, ...summarize(totals) };
  }
  const payload = Object.fromEntries(texts.map((text, i) => [String(i + 1), text]));
  const prompt = textPrompt(languageName(lang));
  try {
    const translated = await translateWithFallback(
      'text', lang, ctx, totals,
      async (deadline) => {
        const { data, problem } = await callModel(prompt, payload, ctx, totals, deadline);
        return problem ? { problem } : checkTexts(texts, data, lang);
      },
      () => Promise.all(texts.map((text) => azureText(text, lang, totals))),
      Math.min(maxBudgetMs, textBudgetMs(texts))
    );
    return { texts: translated, ...summarize(totals) };
  } catch (error) {
    throw withPartialResult(error, totals);
  }
}

/**
 * Traduce al inglés lo que escribió el usuario (la descripción, la lista de
 * diagnósticos previos) en una sola llamada, con Azure de respaldo. Si fallan los
 * dos, lanza el error de Azure, con lo ya gastado en error.translationResult.
 * @param {string[]} texts
 * @param {string} lang - idioma detectado del texto
 * @param {{timezone?: string, requestData?: object}} ctx
 * @param {{maxBudgetMs?: number}} options - tope del plazo antes de pasar a Azure
 * @returns {Promise<{texts: string[], cost: number, fallbacks: number, durationMs: number}>}
 */
async function translateToEnglish(texts, lang, ctx = {}, { maxBudgetMs = MAX_TO_ENGLISH_TIMEOUT_MS } = {}) {
  const totals = newTotals();
  if (baseLanguage(lang) === 'en' || !texts.length) {
    return { texts, ...summarize(totals) };
  }
  const payload = Object.fromEntries(texts.map((text, i) => [String(i + 1), text]));
  const prompt = toEnglishPrompt(sourceLanguageName(lang));
  try {
    const translated = await translateWithFallback(
      'to_english', lang, ctx, totals,
      async (deadline) => {
        const { data, problem } = await callModel(prompt, payload, ctx, totals, deadline);
        return problem ? { problem } : checkTexts(texts, data, 'en', { checkUntranslated: false });
      },
      () => Promise.all(texts.map((text) => azureToEnglish(text, lang, totals))),
      Math.min(maxBudgetMs, toEnglishBudgetMs(texts))
    );
    // Se acepta (el texto pudo venir ya en inglés), pero se cuenta: si pasara a
    // menudo, al diagnóstico le estaría llegando el idioma original
    if (untranslated(texts, translated)) {
      safelyTrackEvent('LlmTranslationUnchanged', { kind: 'to_english', lang, ctx });
    }
    return { texts: translated, ...summarize(totals) };
  } catch (error) {
    throw withPartialResult(error, totals);
  }
}

/**
 * Traduce al inglés las preguntas de «mejorar» con las respuestas del paciente,
 * todas en una llamada. Cada elemento conserva sus otros campos.
 * @param {Array<{question: string, answer: string}>} answers
 * @param {string} lang
 * @param {{timezone?: string, requestData?: object}} ctx
 * @returns {Promise<{answers: Array, cost: number, fallbacks: number, durationMs: number}>}
 */
async function translateAnswersToEnglish(answers, lang, ctx = {}, { maxBudgetMs = MAX_TO_ENGLISH_TIMEOUT_MS } = {}) {
  const totals = newTotals();
  if (baseLanguage(lang) === 'en' || !answers.length) {
    return { answers, ...summarize(totals) };
  }
  const source = answers.map((item) => ({ question: String(item.question ?? ''), answer: String(item.answer ?? '') }));
  const prompt = answersPrompt(sourceLanguageName(lang));
  try {
    const translated = await translateWithFallback(
      'answers', lang, ctx, totals,
      async (deadline) => {
        const { data, problem } = await callModel(prompt, { answers: source }, ctx, totals, deadline);
        return problem ? { problem } : checkAnswers(source, data);
      },
      // Como antes: cada pregunta y cada respuesta por separado
      () => Promise.all(source.map(async (pair) => ({
        question: await azureToEnglish(pair.question, lang, totals),
        answer: await azureToEnglish(pair.answer, lang, totals)
      }))),
      Math.min(maxBudgetMs, toEnglishBudgetMs(answerTexts(source)))
    );
    if (untranslated(answerTexts(source), answerTexts(translated))) {
      safelyTrackEvent('LlmTranslationUnchanged', { kind: 'answers', lang, ctx });
    }
    return { answers: answers.map((item, i) => ({ ...item, ...translated[i] })), ...summarize(totals) };
  } catch (error) {
    throw withPartialResult(error, totals);
  }
}

module.exports = {
  translateDiagnoses,
  translateTexts,
  translateToEnglish,
  translateAnswersToEnglish,
  SYNC_TO_ENGLISH_TIMEOUT_MS,
  syncBudget,
  costStages,
  showsEnglishName,
  needsTranslation,
  hasForeignLetters,
  readDiagnosis,
  readTexts,
  languageName
};
