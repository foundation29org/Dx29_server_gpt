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

const { callAiWithFailover, translateInvertWithRetry, extractProviderError } = require('./aiUtils');
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
  return String(lang || '').trim().toLowerCase().split('-')[0];
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
// Valen en todos los idiomas el latino (genes, siglas), el griego (α, β) y las
// letras de escritura Common o Inherited (µ, ʻ, ʼ). Se usa Script_Extensions
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
  return new RegExp(`(?=\\p{L})[^${allowed}\\p{Script=Common}\\p{Script=Inherited}]`, 'u');
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
function textsProblem(sources, outputs, lang) {
  if (outputs.some((out) => typeof out !== 'string')) return 'missing_text';
  if (outputs.some((out, i) => out.trim() === '' && String(sources[i] || '').trim())) return 'empty_text';
  if (outputs.some((out, i) => anonTags(out) !== anonTags(sources[i]))) return 'anon_tags';
  if (outputs.some((out, i) => htmlTags(out) !== htmlTags(sources[i]))) return 'html_tags';
  if (hasForeignLetters(outputs, lang)) return 'foreign_script';
  if (untranslated(sources, outputs)) return 'untranslated';
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

function checkTexts(sources, out, lang) {
  if (!out || typeof out !== 'object') return { problem: 'not_an_object' };
  const texts = sources.map((_, i) => out[String(i + 1)]);
  const problem = textsProblem(sources, texts, lang);
  return problem ? { problem } : { value: texts };
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
  let failure = { reason: 'invalid_output' };
  let attempts = 0;
  while (attempts < LLM_ATTEMPTS && (attempts === 0 || deadline - Date.now() >= MIN_RETRY_BUDGET_MS)) {
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

async function azureText(text, lang, totals) {
  if (!text) return text;
  totals.azureChars += text.length;
  return translateInvertWithRetry(text, lang);
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
async function translateTexts(texts, lang, ctx = {}) {
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
      textBudgetMs(texts)
    );
    return { texts: translated, ...summarize(totals) };
  } catch (error) {
    throw withPartialResult(error, totals);
  }
}

module.exports = {
  translateDiagnoses,
  translateTexts,
  costStages,
  showsEnglishName,
  needsTranslation,
  hasForeignLetters,
  readDiagnosis,
  readTexts,
  languageName
};
