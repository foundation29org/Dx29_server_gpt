'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildIntentRequest,
  parseIntentDecision,
  shouldSuggestDiagnosisPage
} = require('../services/intentClassifier');

test('parses a valid routing decision and maps it to legacy queryType', () => {
  assert.deepEqual(
    parseIntentDecision('{"action":"enrich","reason":"insufficient_patient_context"}'),
    {
      action: 'enrich',
      reason: 'insufficient_patient_context',
      queryType: 'other',
      usedFallback: false
    }
  );
});

test('accepts fenced JSON without trusting surrounding text', () => {
  const decision = parseIntentDecision(
    '```json\n{"action":"explain","reason":"known_condition_management"}\n```'
  );

  assert.equal(decision.action, 'explain');
  assert.equal(decision.queryType, 'general');
  assert.equal(decision.usedFallback, false);
});

test('normalizes a reason that is incompatible with the selected action', () => {
  const decision = parseIntentDecision(
    '{"action":"go","reason":"known_condition_management"}'
  );

  assert.equal(decision.action, 'go');
  assert.equal(decision.reason, 'patient_case_ready');
});

test('uses flow-safe fallbacks for malformed model output', () => {
  const diagnoseDecision = parseIntentDecision('not json', 'diagnose');
  const askDecision = parseIntentDecision('not json', 'ask');

  assert.equal(diagnoseDecision.action, 'go');
  assert.equal(diagnoseDecision.queryType, 'diagnostic');
  assert.equal(diagnoseDecision.usedFallback, true);
  assert.match(diagnoseDecision.parseError, /JSON object/);

  assert.equal(askDecision.action, 'explain');
  assert.equal(askDecision.queryType, 'general');
  assert.equal(askDecision.usedFallback, true);
});

test('only sends clinical enrichment back to Diagnose from Ask', () => {
  assert.equal(
    shouldSuggestDiagnosisPage({ action: 'enrich', reason: 'missing_patient_data' }),
    true
  );
  assert.equal(
    shouldSuggestDiagnosisPage({ action: 'enrich', reason: 'non_medical' }),
    false
  );
});

test('builds a strict structured-output request', () => {
  const request = buildIntentRequest('Patient with headache');

  assert.equal(request.model, 'gpt-5.4-mini');
  assert.equal(request.response_format.type, 'json_schema');
  assert.equal(request.response_format.json_schema.strict, true);
  assert.match(request.messages[0].content, /Patient with headache/);
});
