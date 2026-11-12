'use strict';

// Llamadas a Claude (claude-fable-5-2) desplegado en Microsoft Foundry, con el SDK
// oficial de Anthropic para Foundry. Solo lo usa el modo avanzado del diagnóstico.
//
// Recibe el mismo prompt y las mismas imágenes que Sol, y devuelve la respuesta con la
// forma de Azure OpenAI ({ data: { choices, usage } }) para que helpDiagnose la trate
// igual: parseo, anonimización, traducción, coste y guardado.
//
// El despliegue claude-fable-5-2 de dxgptbot es Global Standard, versión 1 («Hosted on
// Anthropic infrastructure» según Microsoft): a diferencia de Sol (Data Zone Standard,
// UE), los datos pueden procesarse fuera de la zona de la UE.

const config = require('../config');
const insights = require('./insights');

let cachedClient = null;

function claudeConfig() {
  return config.AZURE_CLAUDE || {};
}

function getClient() {
  if (cachedClient) return cachedClient;
  const { resource, apiKey } = claudeConfig();
  if (!resource || !apiKey) {
    const error = new Error('Claude on Foundry is not configured (AZURE_CLAUDE_RESOURCE / AZURE_CLAUDE_KEY)');
    error.code = 'ADVANCED_MODEL_UNAVAILABLE';
    throw error;
  }
  // Se carga aquí y no arriba: las pruebas y los arranques sin modo avanzado no lo necesitan
  const { AnthropicFoundry } = require('@anthropic-ai/foundry-sdk');
  cachedClient = new AnthropicFoundry({
    resource,
    apiKey,
    // Un reintento del SDK (429, 5xx, red). El diagnóstico va por la ruta asíncrona,
    // así que no le afecta el corte de 45 s de SWA.
    maxRetries: 1,
    timeout: config.AZURE_OPENAI_TIMEOUT_MS || 180000
  });
  return cachedClient;
}

// Claude rechaza (400) cada imagen cuyo base64 pase de 5 MB; DxGPT acepta imágenes de
// hasta 20 MB para Sol. Se comprueba antes de llamar, sin gastar nada.
const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;

// Las imágenes llegan como data URL (loadImageDataUrls). Claude las quiere en base64 con
// su tipo; el texto va primero, como en la petición de Sol.
function userContent(prompt, images) {
  const blocks = [{ type: 'text', text: prompt }];
  for (const image of images || []) {
    const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/s.exec(image?.url || '');
    if (!match) continue;
    if (match[2].length > MAX_IMAGE_BASE64_BYTES) {
      const tooLarge = new Error(`Image larger than the advanced model accepts (${match[2].length} base64 bytes)`);
      tooLarge.code = 'ADVANCED_IMAGE_TOO_LARGE';
      tooLarge.phase = 'ai_call';
      tooLarge.base64Bytes = match[2].length;
      throw tooLarge;
    }
    blocks.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
  }
  return blocks.length === 1 ? prompt : blocks;
}

// Si vale la pena que el usuario lo vuelva a intentar: cuota (429), errores del servicio
// (5xx), tiempo agotado o red. Un 400 (petición que nunca va a pasar) o un 401/403/404
// (configuración) no se arreglan reintentando.
function isRetryableStatus(status) {
  return !status || status === 408 || status === 409 || status === 429 || status >= 500;
}

function textOf(message) {
  return (message?.content || [])
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

// prompt e images: lo mismo que recibe Sol. Devuelve { data: { choices, usage } }.
async function callClaudeDiagnosis(prompt, { images = [], dataRequest = {} } = {}) {
  const { deployment, maxTokens, effort } = claudeConfig();
  let content;
  try {
    content = userContent(prompt, images);
  } catch (error) {
    // Imagen demasiado grande: no se llama a Fable, pero queda en App Insights (y en el
    // informe diario como call_image_too_large)
    insights.trackEvent('AdvancedDiagnosisCall', {
      model: String(deployment),
      ok: 'false',
      status: 'image_too_large',
      imageCount: String((images || []).length),
      imageBase64Bytes: String(error.base64Bytes || ''),
      tenantId: String(dataRequest.tenantId || ''),
      myuuid: String(dataRequest.myuuid || '')
    });
    throw error;
  }
  const client = getClient();
  const startedAt = Date.now();
  let message;
  let stream = null;
  try {
    // Con streaming: la respuesta puede tardar y así la conexión no queda inactiva
    stream = client.messages.stream({
      model: deployment,
      max_tokens: maxTokens,
      thinking: { type: 'adaptive' },
      output_config: { effort },
      messages: [{ role: 'user', content }]
    });
    message = await stream.finalMessage();
  } catch (error) {
    const status = error?.status;
    insights.trackEvent('AdvancedDiagnosisCall', {
      model: String(deployment),
      ok: 'false',
      status: String(status || ''),
      errorType: String(error?.error?.error?.type || error?.name || ''),
      requestId: String(error?.requestID || stream?.request_id || ''),
      durationMs: String(Date.now() - startedAt),
      imageCount: String((images || []).length),
      tenantId: String(dataRequest.tenantId || ''),
      myuuid: String(dataRequest.myuuid || '')
    });
    const wrapped = new Error(`Advanced model call failed${status ? ` (${status})` : ''}: ${error?.message || error}`);
    wrapped.code = isRetryableStatus(status) ? 'ADVANCED_MODEL_UNAVAILABLE' : 'ADVANCED_MODEL_REJECTED';
    wrapped.phase = 'ai_call';
    wrapped.statusCode = status;
    throw wrapped;
  }

  const usage = message.usage || {};
  const inputTokens = (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0);
  const outputTokens = usage.output_tokens || 0;
  // Solo forma, nunca contenido
  insights.trackEvent('AdvancedDiagnosisCall', {
    model: String(deployment),
    ok: 'true',
    stopReason: String(message.stop_reason || ''),
    inputTokens: String(inputTokens),
    outputTokens: String(outputTokens),
    requestId: String(stream?.request_id || message._request_id || ''),
    durationMs: String(Date.now() - startedAt),
    imageCount: String((images || []).length),
    tenantId: String(dataRequest.tenantId || ''),
    myuuid: String(dataRequest.myuuid || '')
  });

  // Los filtros de Fable pueden negarse a responder (200 con stop_reason «refusal»)
  if (message.stop_reason === 'refusal') {
    const refusal = new Error('The advanced model declined to answer this case');
    refusal.code = 'ADVANCED_MODEL_REFUSED';
    refusal.phase = 'ai_call';
    throw refusal;
  }

  return {
    data: {
      choices: [{
        message: { content: textOf(message) },
        finish_reason: message.stop_reason || ''
      }],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens
      }
    }
  };
}

// Para las pruebas
function resetClaudeClientForTests() {
  cachedClient = null;
}

module.exports = { callClaudeDiagnosis, resetClaudeClientForTests };
