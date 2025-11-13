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
  'gpt-4o-mini': {
    input: 0.0005,      // $0.50 per 1M tokens (Azure AI Studio con file search)
    output: 0.0015      // $1.50 per 1M tokens (Azure AI Studio con file search)
  },
  gpt4omini: {
    input: 0.0005,      // $0.50 per 1M tokens (Azure AI Studio con file search)
    output: 0.0015      // $1.50 per 1M tokens (Azure AI Studio con file search)
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
  gpt5: {
    input: 0.0125,    // $1.25 per 1M tokens
    output: 0.0200,    // $10.00 per 1M tokens
  }
};

function calculatePrice(usage, model = 'gpt4o') {
  // Compatibilidad con o3 y gpt-4o
  const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? (promptTokens + completionTokens);

  const pricing = PRICING[model] || PRICING.gpt4o;
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
    model: model
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

  function calculateAzureAIStudioCost(inputText, outputText) {
    const inputTokens = calculateTokens(inputText, 'gpt-4o-mini-2024-07-18');
    const outputTokens = calculateTokens(outputText, 'gpt-4o-mini-2024-07-18');
    const totalTokens = inputTokens + outputTokens;
    
    // Calcular costos usando precios de Azure AI Studio (asistente con archivos adjuntos)
    const inputCost = (inputTokens / 1000) * PRICING['gpt4omini'].input;
    const outputCost = (outputTokens / 1000) * PRICING['gpt4omini'].output;
    const totalCost = inputCost + outputCost;
    
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      inputCost: parseFloat(inputCost.toFixed(6)),
      outputCost: parseFloat(outputCost.toFixed(6)),
      totalCost: parseFloat(totalCost.toFixed(6)),
      model: 'azure_ai_studio'
    };
  }

module.exports = {
  calculatePrice,
  formatCost,
  calculateTokens,
  calculateAzureAIStudioCost
}; 