'use strict'

const { callAiWithFailover, detectLanguageWithRetry } = require('./aiUtils');
const { MIN_TEXT_CHARS_WITHOUT_IMAGES: MIN_DETECTABLE_CHARS } = require('./multimodalInputValidation');
const { detectLanguageLocal } = require('./localLanguageDetect');
const insights = require('./insights');

/**
 * Smart language detection with tiered strategy:
 * - Local detectors (tinyld + eld) when both agree and the language is supported (free, ~1 ms)
 * - Otherwise <1000 chars: Azure detect; >=1000 chars: gpt-5-nano on the first 1000 chars
 * Fallbacks: On LLM error → Azure detect; On Azure error → return langHint || 'en'
 *
 * @param {string} text
 * @param {string} langHint
 * @param {string} timezone
 * @param {string} tenantId
 * @param {string} subscriptionId
 * @param {string} myuuid
 * @returns {Promise<{ lang: string, modelUsed: string, usage?: any, durationMs?: number, azureCharsBilled: number }>}
 */
async function detectLanguageSmart(text, langHint, timezone, tenantId, subscriptionId, myuuid) {
  const result = await detectLanguageSmartUntracked(text, langHint, timezone, tenantId, subscriptionId, myuuid);
  trackDetectionMethod(result.modelUsed, text);
  return result;
}

// Permite ver en Insights qué parte de las detecciones se resuelve en local
// (LanguageDetectionMethod por method y lengthBucket). Nunca debe romper la petición.
function trackDetectionMethod(method, text) {
  try {
    const length = typeof text === 'string' ? text.length : 0;
    const lengthBucket = length < 100 ? '<100' : length < 1000 ? '100-999' : '1000+';
    insights.trackEvent('LanguageDetectionMethod', { method: String(method || 'unknown'), lengthBucket });
  } catch (_) {
    // La telemetría es opcional
  }
}

async function detectLanguageSmartUntracked(text, langHint, timezone, tenantId, subscriptionId, myuuid) {
  const content = typeof text === 'string' ? text : '';
  const length = content.length;
  const dataRequest = { tenantId, subscriptionId, myuuid };
  // Solo llega texto tan corto cuando acompaña a imágenes ("fiebre" o nada).
  // Con una palabra el detector acierta por casualidad y Azure rechaza el
  // texto vacío tras 6 reintentos; el idioma de la página es más fiable.
  if (content.trim().length < MIN_DETECTABLE_CHARS) {
    return { lang: langHint || 'en', modelUsed: 'fallback_hint', usage: null, durationMs: 0, azureCharsBilled: 0 };
  }
  // Primero el detector local gratuito; si no hay acuerdo claro, sigue la ruta de siempre.
  const localStart = Date.now();
  const localLang = await detectLanguageLocal(content);
  if (localLang) {
    return { lang: localLang, modelUsed: 'local_detect', usage: null, durationMs: Date.now() - localStart, azureCharsBilled: 0 };
  }

  // Short: Azure detect
  if (length < 1000) {
    try {
      const start = Date.now();
      const lang = await detectLanguageWithRetry(content, langHint);
      const durationMs = Date.now() - start;
      return { lang, modelUsed: 'azure_detect', usage: null, durationMs, azureCharsBilled: length };
    } catch (_) {
      return { lang: langHint || 'en', modelUsed: 'fallback_hint', usage: null, durationMs: 0, azureCharsBilled: 0 };
    }
  }

  // Medium / Long: LLM detect (cap input to 1000 chars to reduce cost)
  //const model = length <= 1000 ? 'gpt5mini' : 'gpt5nano';
  const model = 'gpt5nano';
  const llmText = length > 1000 ? content.slice(0, 1000) : content;

  const body = {
    model: "gpt-5-nano",
    messages: [
      { role: 'developer', content: `Detect the language of the following text. Return ONLY the ISO 639-1 or 2-letter code (e.g., en, es). Text:` },
      { role: 'user', content: llmText }
    ],
    reasoning_effort: "low" //minimal, low, medium, high
  };
  try {
    const start = Date.now();
    const resp = await callAiWithFailover(body, timezone, model, 0, dataRequest);
    const durationMs = Date.now() - start;
    const out = resp?.data?.choices?.[0]?.message?.content?.trim() || '';
    const code = out.toLowerCase().match(/^[a-z]{2,8}$/) ? out.toLowerCase() : (langHint || 'en');
    return { lang: code, modelUsed: model, usage: resp?.data?.usage, durationMs, azureCharsBilled: 0 };
  } catch (_) {
    // Fallback Azure
    try {
      const sample = length > 1000 ? content.slice(0, 1000) : content;
      const billed = sample.length;
      const start = Date.now();
      const lang = await detectLanguageWithRetry(sample, langHint);
      const durationMs = Date.now() - start;
      return { lang, modelUsed: 'azure_detect', usage: null, durationMs, azureCharsBilled: billed };
    } catch (__ ) {
      return { lang: langHint || 'en', modelUsed: 'fallback_hint', usage: null, durationMs: 0, azureCharsBilled: 0 };
    }
  }
}

/**
 * Detección para los flujos que solo usan Azure (follow-up): local primero y
 * Azure si no hay acuerdo. Devuelve también los caracteres facturados por Azure.
 * @returns {Promise<{ lang: string, azureCharsBilled: number }>}
 */
async function detectLanguageLocalOrAzure(text, langHint) {
  const content = typeof text === 'string' ? text : '';
  const localLang = await detectLanguageLocal(content);
  if (localLang) {
    trackDetectionMethod('local_detect', content);
    return { lang: localLang, azureCharsBilled: 0 };
  }
  const lang = await detectLanguageWithRetry(content, langHint);
  trackDetectionMethod('azure_detect', content);
  return { lang, azureCharsBilled: content.length };
}

module.exports = { detectLanguageSmart, detectLanguageLocalOrAzure };


