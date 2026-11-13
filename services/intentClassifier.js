'use strict';

const PROMPTS = require('../assets/prompts');

const ACTION_TO_QUERY_TYPE = Object.freeze({
  go: 'diagnostic',
  explain: 'general',
  enrich: 'other'
});

const REASONS_BY_ACTION = Object.freeze({
  go: new Set(['patient_case_ready']),
  explain: new Set([
    'medical_education',
    'known_condition_management',
    'medication_safety'
  ]),
  enrich: new Set([
    'insufficient_patient_context',
    'missing_patient_data',
    'non_medical'
  ])
});

const DEFAULT_REASON_BY_ACTION = Object.freeze({
  go: 'patient_case_ready',
  explain: 'medical_education',
  enrich: 'insufficient_patient_context'
});

const INTENT_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'reason'],
  properties: {
    action: {
      type: 'string',
      enum: Object.keys(ACTION_TO_QUERY_TYPE)
    },
    reason: {
      type: 'string',
      enum: [
        'patient_case_ready',
        'medical_education',
        'known_condition_management',
        'medication_safety',
        'insufficient_patient_context',
        'missing_patient_data',
        'non_medical'
      ]
    }
  }
};

// Con imágenes clínicas el modelo además dice si el texto da la edad y el sexo del paciente;
// la decisión final la toma applyImageRule, no el modelo.
const IMAGE_INTENT_RESPONSE_SCHEMA = {
  ...INTENT_RESPONSE_SCHEMA,
  required: [...INTENT_RESPONSE_SCHEMA.required, 'patient_age_stated', 'patient_sex_stated'],
  properties: {
    ...INTENT_RESPONSE_SCHEMA.properties,
    patient_age_stated: { type: 'boolean' },
    patient_sex_stated: { type: 'boolean' }
  }
};

function fallbackDecision(flow) {
  const action = flow === 'ask' ? 'explain' : 'go';
  return {
    action,
    reason: DEFAULT_REASON_BY_ACTION[action],
    queryType: ACTION_TO_QUERY_TYPE[action],
    usedFallback: true
  };
}

function failOpenDecision(flow, error) {
  return {
    ...fallbackDecision(flow),
    parseError: error?.message || 'classifier unavailable',
    transportFallback: true
  };
}

function extractJsonObject(rawContent) {
  if (typeof rawContent !== 'string') {
    throw new TypeError('Intent classifier response must be a string');
  }

  const cleanContent = rawContent
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');

  const firstBrace = cleanContent.indexOf('{');
  const lastBrace = cleanContent.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace < firstBrace) {
    throw new SyntaxError('Intent classifier response does not contain a JSON object');
  }

  return JSON.parse(cleanContent.slice(firstBrace, lastBrace + 1));
}

function normalizeDecision(parsedDecision) {
  const action = typeof parsedDecision?.action === 'string'
    ? parsedDecision.action.trim().toLowerCase()
    : '';
  const reason = typeof parsedDecision?.reason === 'string'
    ? parsedDecision.reason.trim().toLowerCase()
    : '';

  if (!Object.prototype.hasOwnProperty.call(ACTION_TO_QUERY_TYPE, action)) {
    throw new RangeError(`Unsupported intent action: ${action || '(empty)'}`);
  }

  const decision = {
    action,
    reason: REASONS_BY_ACTION[action].has(reason)
      ? reason
      : DEFAULT_REASON_BY_ACTION[action],
    queryType: ACTION_TO_QUERY_TYPE[action],
    usedFallback: false
  };
  if (typeof parsedDecision?.patient_age_stated === 'boolean') {
    decision.ageStated = parsedDecision.patient_age_stated;
  }
  if (typeof parsedDecision?.patient_sex_stated === 'boolean') {
    decision.sexStated = parsedDecision.patient_sex_stated;
  }
  return decision;
}

// Con imágenes clínicas adjuntas, la edad y el sexo deciden: con los dos se analizan las
// imágenes directamente; si falta alguno, se piden (el cliente muestra el aviso de imágenes,
// que también permite continuar). Sin esos datos del modelo, la decisión no cambia.
function applyImageRule(decision, imageCount) {
  if (normalizeImageCount(imageCount) === 0 || decision.usedFallback) {
    return decision;
  }
  if (typeof decision.ageStated !== 'boolean' || typeof decision.sexStated !== 'boolean') {
    return decision;
  }
  const action = decision.ageStated && decision.sexStated ? 'go' : 'enrich';
  return {
    ...decision,
    modelAction: decision.action,
    action,
    reason: action === 'go' ? 'patient_case_ready' : 'missing_patient_data',
    queryType: ACTION_TO_QUERY_TYPE[action],
    imageRule: action === 'go' ? 'age_sex_present' : 'ask_age_sex'
  };
}

function parseIntentDecision(rawContent, flow = 'diagnose') {
  try {
    return normalizeDecision(extractJsonObject(rawContent));
  } catch (error) {
    return {
      ...fallbackDecision(flow),
      parseError: error.message
    };
  }
}

function normalizeImageCount(imageCount) {
  const count = Number(imageCount);
  return Number.isInteger(count) && count > 0 ? count : 0;
}

// Con imágenes clínicas adjuntas, el enrutado las cuenta como datos del paciente y solo
// pide más datos si faltan la edad o el sexo (afectan a la interpretación de la imagen).
function buildIntentPrompt(description, imageCount = 0) {
  const count = normalizeImageCount(imageCount);
  const imageContext = count > 0
    ? PROMPTS.diagnosis.intentRoutingImages.replace('{{imageCount}}', String(count))
    : '';
  // Función de reemplazo: un «$» del texto del usuario no debe interpretarse como patrón.
  return PROMPTS.diagnosis.intentRouting
    .replace('{{imageContext}}', () => imageContext)
    .replace('{{description}}', () => description);
}

function buildIntentRequest(description, useStructuredOutput = true, { imageCount = 0 } = {}) {
  const request = {
    model: 'gpt-5.4-mini',
    messages: [{
      role: 'user',
      content: buildIntentPrompt(description, imageCount)
    }],
    reasoning_effort: 'low'
  };

  if (useStructuredOutput) {
    const withImages = normalizeImageCount(imageCount) > 0;
    request.response_format = {
      type: 'json_schema',
      json_schema: {
        name: withImages ? 'diagnose_intent_routing_images' : 'diagnose_intent_routing',
        strict: true,
        schema: withImages ? IMAGE_INTENT_RESPONSE_SCHEMA : INTENT_RESPONSE_SCHEMA
      }
    };
  }

  return request;
}

async function classifyIntent({
  description,
  flow = 'diagnose',
  timezone,
  model = 'gpt54mini',
  requestData = null,
  imageCount = 0
}) {
  // Lazy import keeps the pure parser/test path independent from runtime
  // endpoint configuration.
  const { callAiWithFailover } = require('./aiUtils');
  const startedAt = Date.now();
  let structuredOutputFallback = false;

  try {
    let response;
    try {
      response = await callAiWithFailover(
        buildIntentRequest(description, true, { imageCount }),
        timezone,
        model,
        0,
        requestData
      );
    } catch (error) {
      const status = Number(error?.response?.status);
      if (status !== 400) {
        throw error;
      }

      structuredOutputFallback = true;
      response = await callAiWithFailover(
        buildIntentRequest(description, false, { imageCount }),
        timezone,
        model,
        0,
        requestData
      );
    }

    const rawContent = response?.data?.choices?.[0]?.message?.content;
    const decision = applyImageRule(parseIntentDecision(rawContent, flow), imageCount);

    return {
      ...decision,
      response,
      usage: response?.data?.usage || null,
      duration: Date.now() - startedAt,
      structuredOutputFallback
    };
  } catch (error) {
    // Timeouts, 5xx, and exhausted failover must not block Diagnose.
    return {
      ...failOpenDecision(flow, error),
      duration: Date.now() - startedAt,
      structuredOutputFallback
    };
  }
}

function shouldSuggestDiagnosisPage(decision) {
  return decision.action === 'go' ||
    (
      decision.action === 'enrich' &&
      decision.reason !== 'non_medical'
    );
}

module.exports = {
  ACTION_TO_QUERY_TYPE,
  applyImageRule,
  buildIntentPrompt,
  buildIntentRequest,
  classifyIntent,
  failOpenDecision,
  fallbackDecision,
  normalizeDecision,
  parseIntentDecision,
  shouldSuggestDiagnosisPage
};
