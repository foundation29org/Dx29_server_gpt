'use strict';

// Traducción de vuelta (del inglés al idioma del usuario) de lo que genera la IA.
// Azure Translator traduce cada nombre y cada síntoma por separado, sin contexto,
// y en la prueba del 5-nov-2026 (respuestas de Sol en 10 idiomas, juez a ciegas)
// dejó algún error crítico en el 81 % de las respuestas: «Accommodative
// insufficiency» salía «Suficiencia acomodativa». gpt-6.1-terra, con una llamada
// por diagnóstico y todas a la vez, lo dejó en el 3 % con material difícil y
// tarda unos 2,5 s por respuesta. Si el modelo devuelve otra estructura u otro
// alfabeto se le pide otra vez; si sigue mal, falla o tarda demasiado, esa parte
// se traduce con Azure como antes.

const { callAiWithFailover, translateInvertWithRetry } = require('./aiUtils');
const { normalizeTargetLang } = require('./translation');
const { calculatePrice } = require('./costUtils');
const insights = require('./insights');

const MODEL = 'gpt61terra';
// Plazo para todos los intentos de un diagnóstico o de una lista de textos; lo
// que quede, a Azure. Terra tarda unos 2,5 s (p90 3,5 s).
const TRANSLATION_TIMEOUT_MS = 15000;
const LLM_ATTEMPTS = 2;
const AZURE_USD_PER_CHAR = 10 / 1000000;

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
  Laoo: ['Lao'], Mymr: ['Myanmar']
};

// Códigos de Azure que Intl interpreta de otra forma: el 'ku' de Azure es kurdo
// central (sorani), en alfabeto árabe, e Intl lo toma por kurmanji, en latino.
const LANGUAGE_OVERRIDES = {
  ku: { name: 'Central Kurdish (Sorani)', script: 'Arab' }
};

const LIST_FIELDS = ['symptoms_in_common', 'symptoms_not_in_common'];

function baseLanguage(lang) {
  return String(lang || '').trim().toLowerCase().split('-')[0];
}

// Solo si la respuesta se traduce: hi-Latn o bn-Latn se quedan en inglés y el
// nombre saldría repetido.
function showsEnglishName(lang) {
  return ENGLISH_NAME_LANGS.has(baseLanguage(lang)) && needsTranslation(lang);
}

function languageName(lang) {
  const override = LANGUAGE_OVERRIDES[String(lang || '').toLowerCase()];
  if (override) return override.name;
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(lang) || lang;
  } catch {
    return lang;
  }
}

// Una letra de otro alfabeto delata una traducción rota: en la prueba salieron
// síntomas en polaco convertidos en «و» y frases en árabe dentro del bengalí.
// El latino (genes, siglas) y el griego (α, β) valen en todos los idiomas.
function foreignLetterPattern(lang) {
  let script = LANGUAGE_OVERRIDES[String(lang || '').toLowerCase()]?.script;
  try {
    script = script || new Intl.Locale(lang).maximize().script;
  } catch {
    return null;
  }
  const own = SCRIPTS[script];
  if (!own) return null;
  const allowed = ['Latin', 'Greek', ...own].map((name) => `\\p{Script=${name}}`).join('');
  return new RegExp(`(?=\\p{L})[^${allowed}]`, 'u');
}

function hasForeignLetters(texts, lang) {
  const pattern = foreignLetterPattern(lang);
  return Boolean(pattern) && texts.some((text) => pattern.test(text));
}

function anonTags(text) {
  return (String(text || '').match(/\[ANON-\d+\]/g) || []).sort().join(',');
}

// Qué falla en una traducción, o null si está bien: cada texto es una cadena,
// no vacía si el original no lo era, con las etiquetas [ANON-N] del original y
// en el alfabeto del idioma. El motivo va a la telemetría del respaldo.
function textsProblem(sources, outputs, lang) {
  if (outputs.length !== sources.length || outputs.some((out) => typeof out !== 'string')) return 'missing_text';
  if (outputs.some((out, i) => out.trim() === '' && String(sources[i] || '').trim())) return 'empty_text';
  if (outputs.some((out, i) => anonTags(out) !== anonTags(sources[i]))) return 'anon_tags';
  if (hasForeignLetters(outputs, lang)) return 'foreign_script';
  return null;
}

function diagnosisPrompt(language) {
  return `Translate the JSON values from English to ${language} for clinicians. Use the standard ${language} ` +
    'medical term for every diagnosis and symptom. Keep the JSON keys and structure, and the same number of ' +
    'items in every list. Return only JSON.';
}

function textPrompt(language) {
  return `Translate the JSON values from English to ${language}. Use the standard ${language} medical terms. ` +
    'Keep the JSON keys, the line breaks, the formatting and any [ANON-N] tags exactly as they are. Return only JSON.';
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

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`LLM translation timed out after ${ms} ms`);
      error.code = 'LLM_TRANSLATION_TIMEOUT';
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// La respuesta del modelo ya leída como JSON, o { problem: 'invalid_json' }. Los
// errores de la llamada (HTTP, timeout) se lanzan.
async function callModel(systemPrompt, payload, ctx, totals, timeoutMs) {
  const response = await withTimeout(callAiWithFailover(
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
    ctx.requestData
  ), timeoutMs);
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
    reason: error.code === 'LLM_TRANSLATION_TIMEOUT' ? 'timeout' : 'error',
    errorMessage: String(error.message || '').slice(0, 300),
    statusCode: String(error.response?.status || 'none'),
    providerErrorCode: String(error.response?.data?.error?.code || 'none')
  };
}

function safelyTrackFallback(kind, lang, failure, attempts, ctx) {
  console.warn(`LLM translation fallback to Azure (${kind}, ${lang}): ${failure.reason}` +
    (failure.problem ? ` / ${failure.problem}` : '') + (failure.errorMessage ? ` / ${failure.errorMessage}` : ''));
  try {
    insights.trackEvent('LlmTranslationFallback', {
      kind,
      lang: String(lang),
      reason: failure.reason,
      problem: String(failure.problem || 'none'),
      errorMessage: String(failure.errorMessage || 'none'),
      statusCode: String(failure.statusCode || 'none'),
      providerErrorCode: String(failure.providerErrorCode || 'none'),
      attempts: String(attempts),
      model: MODEL,
      myuuid: String(ctx.requestData?.myuuid || 'unknown'),
      tenantId: String(ctx.requestData?.tenantId || 'unknown')
    });
  } catch (telemetryError) {
    console.error('No se pudo registrar LlmTranslationFallback:', telemetryError.message);
  }
}

// Se repite solo si el modelo contestó algo que no vale (otra estructura, otro
// alfabeto, JSON roto). Un error de la llamada va directo a Azure:
// callAiWithFailover ya probó las otras regiones, y repetir no arregla un 400
// (filtro de contenido) ni un timeout. Todos los intentos comparten un plazo.
async function translateWithFallback(kind, lang, ctx, totals, tryModel, useAzure) {
  const deadline = Date.now() + TRANSLATION_TIMEOUT_MS;
  let failure = { reason: 'timeout' };
  let attempts = 0;
  while (attempts < LLM_ATTEMPTS && deadline - Date.now() > 0) {
    attempts += 1;
    try {
      const { value, problem } = await tryModel(deadline - Date.now());
      if (value) return value;
      failure = { reason: 'invalid_output', problem };
    } catch (error) {
      failure = describeError(error);
      break;
    }
  }
  totals.fallbacks += 1;
  safelyTrackFallback(kind, lang, failure, attempts, ctx);
  return useAzure();
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
  return { promptTokens: 0, completionTokens: 0, azureChars: 0, fallbacks: 0, startedAt: Date.now() };
}

function summarize(totals) {
  const llmCost = totals.promptTokens || totals.completionTokens
    ? calculatePrice({ prompt_tokens: totals.promptTokens, completion_tokens: totals.completionTokens }, MODEL).totalCost
    : 0;
  const azureCost = totals.azureChars * AZURE_USD_PER_CHAR;
  return {
    model: MODEL,
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    llmCost,
    azureChars: totals.azureChars,
    azureCost,
    cost: llmCost + azureCost,
    fallbacks: totals.fallbacks,
    durationMs: Date.now() - totals.startedAt
  };
}

// Etapas de coste con el formato de CostTrackingService: una para el modelo y
// otra para Azure si hubo respaldo.
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
      duration: result.durationMs,
      success: true
    });
  }
  if (result.azureChars > 0) {
    stages.push({
      name,
      cost: result.azureCost,
      tokens: { input: result.azureChars, output: result.azureChars, total: result.azureChars },
      model: 'translation_service',
      duration: result.durationMs,
      success: true
    });
  }
  return stages;
}

// Lenguas que Azure no admite como destino (p. ej. hi-Latn) siguen recibiendo el
// inglés, como antes: no hay respaldo con el que comparar.
function needsTranslation(lang) {
  return Boolean(lang) && baseLanguage(lang) !== 'en' && normalizeTargetLang(lang) !== 'en';
}

/**
 * Traduce los diagnósticos de una respuesta, cada uno en su propia llamada y
 * todos a la vez.
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
  const items = await Promise.all(diagnoses.map((item) => {
    const source = diagnosisSource(item);
    return translateWithFallback(
      'diagnosis', lang, ctx, totals,
      async (timeoutMs) => {
        const { data, problem } = await callModel(prompt, source, ctx, totals, timeoutMs);
        return problem ? { problem } : checkDiagnosis(source, data, lang);
      },
      () => azureDiagnosis(source, lang, totals)
    );
  }));
  return { items, ...summarize(totals) };
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
  const translated = await translateWithFallback(
    'text', lang, ctx, totals,
    async (timeoutMs) => {
      const { data, problem } = await callModel(textPrompt(languageName(lang)), payload, ctx, totals, timeoutMs);
      return problem ? { problem } : checkTexts(texts, data, lang);
    },
    () => Promise.all(texts.map((text) => azureText(text, lang, totals)))
  );
  return { texts: translated, ...summarize(totals) };
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
  languageName,
  MODEL
};
