const { encodingForModel } = require("js-tiktoken");
// Utilidades para cálculo y formato de costes de IA

// Precios por 1K tokens (en USD) - actualizados según OpenAI pricing
const PRICING = {
  gpt4o: {
    input: 0.0025,    // $2.50 per 1M tokens
    output: 0.01      // $10.00 per 1M tokens
  },
  o3: {
    input: 0.002,     // $2 per 1M tokens  
    output: 0.008      // $8 per 1M tokens
  },
  sonar: {
    input: 0.001,     // $1 per 1M tokens
    output: 0.001,    // $1 per 1M tokens
    request: 0.005    // $0.005 per request (Low context: $5 per 1K requests)
  },
  'sonar-reasoning-pro': {
    input: 0.002,     // $2 per 1M tokens
    output: 0.008,    // $8 per 1M tokens
    request: 0.01    // $0.01 per request (medium context: $10 per 1K requests)
  },
  'sonar-pro': {
    input: 0.003,     // $3 per 1M tokens
    output: 0.015,    // $15 per 1M tokens
    request: 0.01    // $0.01 per request (medium context: $10 per 1K requests)
  },
  gpt5nano: {
    input: 0.00005,    // $0.05 per 1M tokens
    output: 0.0004,    // $0.40 per 1M tokens
  },
  gpt5mini: {
    input: 0.00025,    // $0.25 per 1M tokens
    output: 0.0020,    // $2.00 per 1M tokens
  },
  gpt54mini: {
    input: 0.00075,    // $0.75 per 1M tokens
    output: 0.0045,    // $4.50 per 1M tokens
  },
  gpt5: {
    input: 0.0125,    // $1.25 per 1M tokens
    output: 0.0200,    // $10.00 per 1M tokens
  },
  'gemini-3-pro-preview': {
    input: 0.002,      // Temporal: ajustar cuando se confirme tarifa final
    output: 0.008      // Temporal: ajustar cuando se confirme tarifa final
  },
  'gemini-2.5-pro': {
    input: 0.002,      // Temporal: ajustar cuando se confirme tarifa final
    output: 0.008      // Temporal: ajustar cuando se confirme tarifa final
  }
};

const PRICING_ALIASES = {
  'gpt-5-mini': 'gpt5mini',
  'gpt-5.4-mini': 'gpt54mini',
  'gpt-5-nano': 'gpt5nano',
  'gpt-5': 'gpt5'
};

function calculatePrice(usage, model = 'gpt54mini') {
  // Compatibilidad con o3 y gpt-4o
  const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? (promptTokens + completionTokens);

  const normalizedModel = PRICING_ALIASES[model] || model;
  const pricing = PRICING[normalizedModel] || PRICING.gpt54mini;
  const inputCost = (promptTokens / 1000) * pricing.input;
  const outputCost = (completionTokens / 1000) * pricing.output;
  
  // Agregar request fee para Sonar
  const requestFee = pricing.request || 0;
  const totalCost = inputCost + outputCost + requestFee;

  return {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    totalTokens: totalTokens,
    inputCost: parseFloat(inputCost.toFixed(6)),
    outputCost: parseFloat(outputCost.toFixed(6)),
    requestFee: parseFloat(requestFee.toFixed(6)),
    totalCost: parseFloat(totalCost.toFixed(6)),
    model: normalizedModel
  };
}

function formatCost(cost) {
  return `$${cost.toFixed(6)}`; // Siempre en dólares con 6 decimales
}

function calculateTokens(text, model = 'gpt4o') {
    // Usar directamente el modelo para obtener el encoding correcto
    const enc = encodingForModel(model);
    return enc.encode(text).length;
  }

module.exports = {
  calculatePrice,
  formatCost,
  calculateTokens
}; 