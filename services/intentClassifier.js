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

function fallbackDecision(flow) {
  const action = flow === 'ask' ? 'explain' : 'go';
  return {
    action,
    reason: DEFAULT_REASON_BY_ACTION[action],
    queryType: ACTION_TO_QUERY_TYPE[action],
    usedFallback: true
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

  return {
    action,
    reason: REASONS_BY_ACTION[action].has(reason)
      ? reason
      : DEFAULT_REASON_BY_ACTION[action],
    queryType: ACTION_TO_QUERY_TYPE[action],
    usedFallback: false
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

function buildIntentRequest(description, useStructuredOutput = true) {
  const request = {
    model: 'gpt-5.4-mini',
    messages: [{
      role: 'user',
      content: PROMPTS.diagnosis.intentRouting.replace('{{description}}', description)
    }],
    reasoning_effort: 'low'
  };

  if (useStructuredOutput) {
    request.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'diagnose_intent_routing',
        strict: true,
        schema: INTENT_RESPONSE_SCHEMA
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
  requestData = null
}) {
  // Lazy import keeps the pure parser/test path independent from runtime
  // endpoint configuration.
  const { callAiWithFailover } = require('./aiUtils');
  const startedAt = Date.now();
  let response;
  let structuredOutputFallback = false;

  try {
    response = await callAiWithFailover(
      buildIntentRequest(description, true),
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
      buildIntentRequest(description, false),
      timezone,
      model,
      0,
      requestData
    );
  }

  const rawContent = response?.data?.choices?.[0]?.message?.content;
  const decision = parseIntentDecision(rawContent, flow);

  return {
    ...decision,
    response,
    usage: response?.data?.usage || null,
    duration: Date.now() - startedAt,
    structuredOutputFallback
  };
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
  buildIntentRequest,
  classifyIntent,
  fallbackDecision,
  normalizeDecision,
  parseIntentDecision,
  shouldSuggestDiagnosisPage
};
