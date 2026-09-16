const axios = require('axios');
const config = require('../config');

const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_THINKING_LEVEL = 'low';
const DEFAULT_TIMEOUT_MS = 180000;

function buildGeminiRequest(prompt, modelName) {
  const requestBody = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: 0
    }
  };

  // Gemini 3 uses thinkingLevel. Gemini 2.5 uses thinkingBudget, so the
  // fallback keeps its provider default instead of sending an incompatible field.
  if (modelName.startsWith('gemini-3')) {
    requestBody.generationConfig.thinkingConfig = {
      thinkingLevel: GEMINI_THINKING_LEVEL
    };
  }

  return requestBody;
}

async function callGeminiModel(prompt, modelName) {
  const apiKey = config.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  const url = `${GEMINI_API_BASE_URL}/${modelName}:generateContent`;
  const response = await axios.post(
    url,
    buildGeminiRequest(prompt, modelName),
    {
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      timeout: config.GEMINI_HTTP_TIMEOUT_MS ||
        config.AZURE_OPENAI_TIMEOUT_MS ||
        DEFAULT_TIMEOUT_MS
    }
  );

  const candidate = response?.data?.candidates?.[0];
  if (!candidate) {
    throw new Error(`Gemini ${modelName} returned no candidates`);
  }

  const finishReason = candidate?.finishReason;
  if (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
    throw new Error(`Gemini ${modelName} finished with reason: ${finishReason}`);
  }

  const text = candidate?.content?.parts
    ?.map((part) => part?.text || '')
    .join('')
    ?.trim();
  if (!text) {
    throw new Error(`Gemini ${modelName} returned empty content`);
  }

  const usageMetadata = response?.data?.usageMetadata || {};
  const promptTokens =
    usageMetadata.promptTokenCount ?? usageMetadata.inputTokenCount ?? 0;
  const candidateTokens =
    usageMetadata.candidatesTokenCount ?? usageMetadata.outputTokenCount ?? 0;
  const reasoningTokens = usageMetadata.thoughtsTokenCount ?? 0;
  const billedOutputTokens = candidateTokens + reasoningTokens;

  return {
    data: {
      choices: [{ message: { content: text } }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: billedOutputTokens,
        reasoning_tokens: reasoningTokens,
        total_tokens: usageMetadata.totalTokenCount ??
          (promptTokens + billedOutputTokens)
      }
    }
  };
}

module.exports = {
  buildGeminiRequest,
  callGeminiModel
};
