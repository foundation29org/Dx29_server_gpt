'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function stubModule(modulePath, exports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports
  };
}

stubModule('../services/aiUtils', {
  callAiWithFailover: async () => {
    throw new Error('Use an injected test call');
  }
});

delete require.cache[
  require.resolve('../services/multimodalImageClassifierService')
];

const {
  CLASSIFICATIONS,
  classifyImage,
  isNotMedicalImage,
  normalizeClassification,
  shouldExtractDocumentText,
  shouldExtractMixedDocumentText
} = require('../services/multimodalImageClassifierService');

test('discards a high-confidence non-medical image', () => {
  const result = normalizeClassification({
    classification: CLASSIFICATIONS.NOT_MEDICAL,
    confidence: 0.97,
    has_document_text: false,
    has_medical_visual: false,
    evidence: ['company logo']
  });

  assert.equal(isNotMedicalImage(result), true);
  assert.equal(shouldExtractDocumentText(result), false);
});

test('keeps a low-confidence non-medical image for vision', () => {
  const result = normalizeClassification({
    classification: CLASSIFICATIONS.NOT_MEDICAL,
    confidence: 0.89,
    has_document_text: false,
    has_medical_visual: false,
    evidence: []
  });

  assert.equal(isNotMedicalImage(result), false);
});

test('downgrades a non-medical label that also reports medical content to unknown', () => {
  for (const flags of [
    { has_document_text: false, has_medical_visual: true },
    { has_document_text: true, has_medical_visual: false }
  ]) {
    const result = normalizeClassification({
      classification: CLASSIFICATIONS.NOT_MEDICAL,
      confidence: 0.99,
      ...flags,
      evidence: []
    });

    assert.equal(result.classification, CLASSIFICATIONS.UNKNOWN);
    assert.equal(isNotMedicalImage(result), false);
  }
});

test('never discards an unknown image', () => {
  const result = normalizeClassification({
    classification: CLASSIFICATIONS.UNKNOWN,
    confidence: 0.99,
    has_document_text: false,
    has_medical_visual: false,
    evidence: []
  });

  assert.equal(isNotMedicalImage(result), false);
});

function responseWith(value) {
  return {
    data: {
      choices: [{
        message: {
          content: JSON.stringify(value)
        }
      }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120
      }
    }
  };
}

test('routes only a consistent high-confidence document image to OCR', async () => {
  let capturedRequest;
  const result = await classifyImage({
    url: 'https://storage.test/report.png?sig=secret'
  }, {
    timezone: 'Europe/Madrid'
  }, {
    callAi: async (request) => {
      capturedRequest = request;
      return responseWith({
        classification: CLASSIFICATIONS.DOCUMENT_ONLY,
        confidence: 0.97,
        has_document_text: true,
        has_medical_visual: false,
        evidence: ['report table']
      });
    }
  });

  assert.equal(shouldExtractDocumentText(result), true);
  assert.equal(result.hasDocumentText, true);
  assert.equal(result.hasMedicalVisual, false);
  assert.equal(
    capturedRequest.messages[1].content[1].image_url.detail,
    'low'
  );
  assert.equal(
    capturedRequest.response_format.json_schema.strict,
    true
  );
  // Un tope de tokens se lo come el razonamiento y deja el contenido vacío.
  assert.equal(
    Object.hasOwn(capturedRequest, 'max_completion_tokens'),
    false
  );
});

test('adds OCR text to a high-confidence mixed image without replacing vision', () => {
  const result = normalizeClassification({
    classification: CLASSIFICATIONS.CONTAINS_MEDICAL_VISUAL,
    confidence: 0.99,
    has_document_text: true,
    has_medical_visual: true,
    evidence: ['radiograph with report text']
  });

  assert.equal(shouldExtractDocumentText(result), false);
  assert.equal(shouldExtractMixedDocumentText(result), true);
  assert.equal(result.classification, CLASSIFICATIONS.CONTAINS_MEDICAL_VISUAL);
});

test('does not OCR a pure medical image', () => {
  const result = normalizeClassification({
    classification: CLASSIFICATIONS.CONTAINS_MEDICAL_VISUAL,
    confidence: 0.99,
    has_document_text: false,
    has_medical_visual: true,
    evidence: ['radiograph']
  });

  assert.equal(shouldExtractDocumentText(result), false);
  assert.equal(shouldExtractMixedDocumentText(result), false);
});

test('keeps low-confidence document classifications on direct vision', () => {
  const result = normalizeClassification({
    classification: CLASSIFICATIONS.DOCUMENT_ONLY,
    confidence: 0.89,
    has_document_text: true,
    has_medical_visual: false,
    evidence: ['report text']
  });

  assert.equal(shouldExtractDocumentText(result), false);
});

test('downgrades inconsistent document classifications to unknown', () => {
  const result = normalizeClassification({
    classification: CLASSIFICATIONS.DOCUMENT_ONLY,
    confidence: 0.99,
    has_document_text: true,
    has_medical_visual: true,
    evidence: []
  });

  assert.equal(result.classification, CLASSIFICATIONS.UNKNOWN);
  assert.equal(shouldExtractDocumentText(result), false);
});

test('rejects malformed classifier JSON so callers can fail open to vision', async () => {
  await assert.rejects(
    classifyImage({
      url: 'https://storage.test/report.png?sig=secret'
    }, {}, {
      callAi: async () => ({
        data: {
          choices: [{ message: { content: 'not-json' } }]
        }
      })
    }),
    /invalid JSON/
  );
});
