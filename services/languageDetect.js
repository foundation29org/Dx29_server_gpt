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

module.exports = { detectLanguageSmart };


