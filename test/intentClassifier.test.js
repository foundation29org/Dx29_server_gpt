'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyImageRule,
  buildIntentPrompt,
  buildIntentRequest,
  failOpenDecision,
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

test('transport failure fail-opens diagnose to DDx and ask to explain', () => {
  const diagnoseDecision = failOpenDecision('diagnose', new Error('ETIMEDOUT'));
  const askDecision = failOpenDecision('ask', Object.assign(new Error('Azure 500'), { response: { status: 500 } }));

  assert.equal(diagnoseDecision.action, 'go');
  assert.equal(diagnoseDecision.queryType, 'diagnostic');
  assert.equal(diagnoseDecision.usedFallback, true);
  assert.equal(diagnoseDecision.transportFallback, true);

  assert.equal(askDecision.action, 'explain');
  assert.equal(askDecision.queryType, 'general');
  assert.equal(askDecision.transportFallback, true);
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

test('without images the routing prompt has no image section and no placeholders', () => {
  const prompt = buildIntentPrompt('Analyze this x-ray');

  assert.doesNotMatch(prompt, /ATTACHED IMAGES/);
  assert.doesNotMatch(prompt, /\{\{\w+\}\}/);
  assert.match(prompt, /INPUT:\nAnalyze this x-ray$/);
});

test('with clinical images the routing prompt asks for age and sex', () => {
  const prompt = buildIntentPrompt('Analyze this x-ray', 2);

  assert.match(prompt, /ATTACHED IMAGES/);
  assert.match(prompt, /attached 2 medical image\(s\)/);
  assert.match(prompt, /patient_age_stated/);
  assert.match(prompt, /patient_sex_stated/);
  assert.doesNotMatch(prompt, /\{\{\w+\}\}/);
  assert.ok(prompt.indexOf('ATTACHED IMAGES') < prompt.indexOf('INPUT:'));
});

test('ignores invalid image counts', () => {
  for (const count of [0, -1, 1.5, '2', null, undefined, NaN]) {
    const expectImages = count === '2';
    assert.equal(/ATTACHED IMAGES/.test(buildIntentPrompt('Rash', count)), expectImages, String(count));
  }
});

test('inserts the user text literally, even with replacement patterns', () => {
  const prompt = buildIntentPrompt('Costs $& and $1 {{imageContext}}', 1);

  assert.match(prompt, /INPUT:\nCosts \$& and \$1 \{\{imageContext\}\}$/);
  assert.equal(prompt.match(/ATTACHED IMAGES/g).length, 1);
});

test('the request carries the image section in both structured and plain modes', () => {
  for (const structured of [true, false]) {
    const request = buildIntentRequest('What is this?', structured, { imageCount: 1 });
    assert.match(request.messages[0].content, /ATTACHED IMAGES/);
  }
});

test('with images the structured output also asks whether age and sex are stated', () => {
  const plain = buildIntentRequest('Rash', true);
  const withImages = buildIntentRequest('Rash', true, { imageCount: 1 });

  assert.deepEqual(plain.response_format.json_schema.schema.required, ['action', 'reason']);
  assert.deepEqual(
    withImages.response_format.json_schema.schema.required,
    ['action', 'reason', 'patient_age_stated', 'patient_sex_stated']
  );
  assert.equal(withImages.response_format.json_schema.strict, true);
});

test('with images, age and sex decide between analyzing directly and asking for them', () => {
  const parse = (age, sex, action = 'explain', reason = 'medical_education') => parseIntentDecision(
    JSON.stringify({ action, reason, patient_age_stated: age, patient_sex_stated: sex })
  );

  const go = applyImageRule(parse(true, true), 1);
  assert.equal(go.action, 'go');
  assert.equal(go.reason, 'patient_case_ready');
  assert.equal(go.queryType, 'diagnostic');
  assert.equal(go.modelAction, 'explain');
  assert.equal(go.imageRule, 'age_sex_present');

  for (const [age, sex] of [[true, false], [false, true], [false, false]]) {
    const ask = applyImageRule(parse(age, sex, 'go', 'patient_case_ready'), 2);
    assert.equal(ask.action, 'enrich');
    assert.equal(ask.reason, 'missing_patient_data');
    assert.equal(ask.imageRule, 'ask_age_sex');
  }
});

test('the image rule leaves the decision alone without images or without the booleans', () => {
  const withFlags = parseIntentDecision('{"action":"enrich","reason":"non_medical","patient_age_stated":true,"patient_sex_stated":true}');
  assert.deepEqual(applyImageRule(withFlags, 0), withFlags);

  const noFlags = parseIntentDecision('{"action":"enrich","reason":"missing_patient_data"}');
  assert.deepEqual(applyImageRule(noFlags, 1), noFlags);

  const fallback = parseIntentDecision('not json', 'diagnose');
  assert.deepEqual(applyImageRule(fallback, 1), fallback);
});
