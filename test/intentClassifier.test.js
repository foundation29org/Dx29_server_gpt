'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// classifyIntent carga aiUtils al llamarse: aquí se sustituye por una respuesta fija.
const aiCalls = [];
let aiContent = '{}';
const aiUtilsPath = require.resolve('../services/aiUtils');
require.cache[aiUtilsPath] = {
  id: aiUtilsPath,
  filename: aiUtilsPath,
  loaded: true,
  exports: {
    callAiWithFailover: async (requestBody) => {
      aiCalls.push(requestBody);
      return { data: { choices: [{ message: { content: aiContent } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } };
    }
  }
};

const {
  applyAskOnce,
  applyImageRule,
  classifyIntent,
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

test('with clinical images the routing prompt asks for age, sex and symptoms', () => {
  const prompt = buildIntentPrompt('Analyze this x-ray', 2);

  assert.match(prompt, /ATTACHED IMAGES/);
  assert.match(prompt, /attached 2 medical image\(s\)/);
  assert.match(prompt, /patient_age_stated/);
  assert.match(prompt, /patient_sex_stated/);
  assert.match(prompt, /patient_symptoms_stated/);
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

test('with images the structured output also asks whether age, sex and symptoms are stated', () => {
  const plain = buildIntentRequest('Rash', true);
  const withImages = buildIntentRequest('Rash', true, { imageCount: 1 });

  assert.deepEqual(plain.response_format.json_schema.schema.required, ['action', 'reason']);
  assert.deepEqual(
    withImages.response_format.json_schema.schema.required,
    ['action', 'reason', 'patient_age_stated', 'patient_sex_stated', 'patient_symptoms_stated']
  );
  assert.equal(withImages.response_format.json_schema.strict, true);
});

test('with images, age, sex and symptoms decide between analyzing directly and asking for them', () => {
  const parse = (age, sex, symptoms, action = 'explain', reason = 'medical_education') => parseIntentDecision(
    JSON.stringify({ action, reason, patient_age_stated: age, patient_sex_stated: sex, patient_symptoms_stated: symptoms })
  );

  const go = applyImageRule(parse(true, true, true), 1);
  assert.equal(go.action, 'go');
  assert.equal(go.reason, 'patient_case_ready');
  assert.equal(go.queryType, 'diagnostic');
  assert.equal(go.modelAction, 'explain');
  assert.equal(go.imageRule, 'patient_data_present');

  for (const flags of [[true, true, false], [true, false, true], [false, true, true], [false, false, false]]) {
    const ask = applyImageRule(parse(...flags, 'go', 'patient_case_ready'), 2);
    assert.equal(ask.action, 'enrich', String(flags));
    assert.equal(ask.reason, 'missing_patient_data');
    assert.equal(ask.imageRule, 'ask_patient_data');
  }
});

test('the image rule leaves the decision alone without images or without the booleans', () => {
  const withFlags = parseIntentDecision('{"action":"enrich","reason":"non_medical","patient_age_stated":true,"patient_sex_stated":true,"patient_symptoms_stated":true}');
  assert.deepEqual(applyImageRule(withFlags, 0), withFlags);

  const noFlags = parseIntentDecision('{"action":"enrich","reason":"missing_patient_data"}');
  assert.deepEqual(applyImageRule(noFlags, 1), noFlags);

  const partialFlags = parseIntentDecision('{"action":"go","reason":"patient_case_ready","patient_age_stated":true,"patient_sex_stated":true}');
  assert.deepEqual(applyImageRule(partialFlags, 1), partialFlags);

  const fallback = parseIntentDecision('not json', 'diagnose');
  assert.deepEqual(applyImageRule(fallback, 1), fallback);
});

test('ask once: a second image prompt in the same case analyzes the images instead', () => {
  const ask = applyImageRule(parseIntentDecision(
    '{"action":"go","reason":"patient_case_ready","patient_age_stated":false,"patient_sex_stated":true,"patient_symptoms_stated":true}'
  ), 1);
  const once = applyAskOnce(ask);
  assert.equal(once.action, 'go');
  assert.equal(once.reason, 'patient_case_ready');
  assert.equal(once.queryType, 'diagnostic');
  assert.equal(once.imageRule, 'already_asked');
  assert.equal(once.modelAction, 'go');
  assert.equal(once.ageStated, false);

  const present = applyImageRule(parseIntentDecision(
    '{"action":"go","reason":"patient_case_ready","patient_age_stated":true,"patient_sex_stated":true,"patient_symptoms_stated":true}'
  ), 1);
  assert.deepEqual(applyAskOnce(present), present);
  const noImages = parseIntentDecision('{"action":"enrich","reason":"missing_patient_data"}');
  assert.deepEqual(applyAskOnce(noImages), noImages);
});

test('classifyIntent checks for an earlier image prompt only when it would ask', async () => {
  const flags = (age, sex, symptoms) => JSON.stringify({
    action: 'go', reason: 'patient_case_ready',
    patient_age_stated: age, patient_sex_stated: sex, patient_symptoms_stated: symptoms
  });
  let lookups = 0;
  const askedBefore = (answer) => async () => { lookups += 1; if (answer instanceof Error) throw answer; return answer; };

  aiContent = flags(false, true, true);
  const first = await classifyIntent({ description: 'Is this HSV?', imageCount: 1, wasAskedForImageData: askedBefore(false) });
  assert.equal(first.action, 'enrich');
  assert.equal(first.imageRule, 'ask_patient_data');
  assert.equal(lookups, 1);

  const second = await classifyIntent({ description: 'Is this HSV?', imageCount: 1, wasAskedForImageData: askedBefore(true) });
  assert.equal(second.action, 'go');
  assert.equal(second.reason, 'patient_case_ready');
  assert.equal(second.imageRule, 'already_asked');
  assert.equal(second.modelAction, 'go');
  assert.equal(lookups, 2);

  const lookupFails = await classifyIntent({ description: 'Is this HSV?', imageCount: 1, wasAskedForImageData: askedBefore(new Error('mongo down')) });
  assert.equal(lookupFails.action, 'enrich');
  assert.equal(lookupFails.imageRule, 'ask_patient_data');
  assert.equal(lookupFails.askOnceError, 'mongo down');
  assert.equal(lookups, 3);

  aiContent = flags(true, true, true);
  const complete = await classifyIntent({ description: '63F, lump for 2 weeks', imageCount: 1, wasAskedForImageData: askedBefore(true) });
  assert.equal(complete.imageRule, 'patient_data_present');
  assert.equal(lookups, 3);

  aiContent = '{"action":"enrich","reason":"missing_patient_data"}';
  const textOnly = await classifyIntent({ description: 'Analyze this patient', imageCount: 0, wasAskedForImageData: askedBefore(true) });
  assert.equal(textOnly.action, 'enrich');
  assert.equal(textOnly.imageRule, undefined);
  assert.equal(lookups, 3);

  aiContent = flags(false, false, false);
  const noLookup = await classifyIntent({ description: 'What is this?', imageCount: 2 });
  assert.equal(noLookup.imageRule, 'ask_patient_data');
  assert.ok(aiCalls.length >= 6);
});
