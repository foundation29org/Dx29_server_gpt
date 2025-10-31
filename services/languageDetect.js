'use strict'

const { callAiWithFailover, detectLanguageWithRetry } = require('./aiUtils');

/**
 * Smart language detection with tiered strategy:
 * - <30 chars: Azure detect (cheap and fast)
 * - 30–200 chars: gpt-5-mini (LLM)
 * - >200 chars: gpt-5-nano (LLM)
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
  const content = typeof text === 'string' ? text : '';
  const length = content.length;
  const dataRequest = { tenantId, subscriptionId, myuuid };
  // Short: Azure detect
  if (length < 30) {
    try {
      const lang = await detectLanguageWithRetry(content, langHint);
      return { lang, modelUsed: 'azure_detect', usage: null, durationMs: 0, azureCharsBilled: length };
    } catch (_) {
      return { lang: langHint || 'en', modelUsed: 'fallback_hint', usage: null, durationMs: 0, azureCharsBilled: 0 };
    }
  }

  // Medium / Long: LLM detect
  const model = length <= 200 ? 'gpt5mini' : 'gpt5nano';
  const body = model === 'gpt5mini'
    ? {
        model: 'gpt-5-mini',
        messages: [
          { role: 'user', content: `Detect the language of the following text. Return ONLY the ISO 639-1 or 2-letter code (e.g., en, es). Text:` },
          { role: 'user', content: content }
        ],
        reasoning_effort: 'low'
      }
    : {
        model: 'gpt-5-nano',
        messages: [
          { role: 'user', content: `Detect the language of the following text. Return ONLY the ISO 639-1 or 2-letter code (e.g., en, es). Text:` },
          { role: 'user', content: content }
        ],
        reasoning_effort: 'low'
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
      const lang = await detectLanguageWithRetry(content, langHint);
      return { lang, modelUsed: 'azure_detect', usage: null, durationMs: 0, azureCharsBilled: length };
    } catch (__ ) {
      return { lang: langHint || 'en', modelUsed: 'fallback_hint', usage: null, durationMs: 0, azureCharsBilled: 0 };
    }
  }
}

module.exports = { detectLanguageSmart };


