'use strict';

const { callAiWithFailover } = require('./aiUtils');
const {
  getImageClassifierConfidence,
  getImageClassifierModel
} = require('./multimodalImageRoutingConfig');

const CLASSIFICATIONS = Object.freeze({
  DOCUMENT_ONLY: 'document_only',
  CONTAINS_MEDICAL_VISUAL: 'contains_medical_visual',
  UNKNOWN: 'unknown'
});

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    classification: {
      type: 'string',
      enum: Object.values(CLASSIFICATIONS)
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1
    },
    has_document_text: { type: 'boolean' },
    has_medical_visual: { type: 'boolean' },
    evidence: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 4
    }
  },
  required: [
    'classification',
    'confidence',
    'has_document_text',
    'has_medical_visual',
    'evidence'
  ],
  additionalProperties: false
};

const SYSTEM_PROMPT = `You route uploads for a medical diagnostic product. Do not diagnose.

Determine whether the image is exclusively a text document or contains any
meaningful medical visual evidence.

Return document_only only when:
- the useful content is exclusively prose, forms, tables, or laboratory values;
- there is no radiograph, CT, MRI, ultrasound, pathology, dermatology,
  fundoscopy, endoscopy, ECG, clinical photograph, medical chart, plot, or
  other visual evidence that Terra should inspect.

Return contains_medical_visual when any medically meaningful visual is present,
even if the same canvas also contains substantial report text. Small labels,
arrows, measurements, and image annotations belong to the medical visual and
must not cause it to be treated as a text-only document.

Set has_document_text=true only for substantial standalone clinical prose,
forms, tables, or laboratory values worth extracting with OCR. Keep it false
for labels, arrows, measurements, legends, and annotations alone.

Return unknown whenever the distinction is uncertain. Prefer unknown over
document_only.`;

function stripJsonFence(value) {
  return String(value || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function normalizeClassification(raw) {
  const classification = String(raw?.classification || '');
  const confidence = Number(raw?.confidence);
  const hasDocumentText = raw?.has_document_text === true;
  const hasMedicalVisual = raw?.has_medical_visual === true;
  const evidence = Array.isArray(raw?.evidence)
    ? raw.evidence.slice(0, 4).map((item) => String(item))
    : [];

  const validConfidence = Number.isFinite(confidence) &&
    confidence >= 0 &&
    confidence <= 1;
  const consistentDocument = classification === CLASSIFICATIONS.DOCUMENT_ONLY &&
    hasDocumentText &&
    !hasMedicalVisual;
  const consistentMedical = classification === CLASSIFICATIONS.CONTAINS_MEDICAL_VISUAL &&
    hasMedicalVisual;
  const consistentUnknown = classification === CLASSIFICATIONS.UNKNOWN;

  if (
    !validConfidence ||
    (!consistentDocument && !consistentMedical && !consistentUnknown)
  ) {
    return {
      classification: CLASSIFICATIONS.UNKNOWN,
      confidence: 0,
      hasDocumentText,
      hasMedicalVisual,
      evidence: ['Classifier returned an inconsistent result']
    };
  }

  return {
    classification,
    confidence,
    hasDocumentText,
    hasMedicalVisual,
    evidence
  };
}

function fallbackClassification(error) {
  return {
    classification: CLASSIFICATIONS.UNKNOWN,
    confidence: 0,
    hasDocumentText: false,
    hasMedicalVisual: false,
    evidence: [],
    error: error?.message || 'Image classification failed'
  };
}

function shouldExtractDocumentText(
  classification,
  threshold = getImageClassifierConfidence()
) {
  return classification?.classification === CLASSIFICATIONS.DOCUMENT_ONLY &&
    classification.hasDocumentText === true &&
    classification.hasMedicalVisual === false &&
    Number(classification.confidence) >= threshold;
}

function shouldExtractMixedDocumentText(
  classification,
  threshold = getImageClassifierConfidence()
) {
  return classification?.classification ===
      CLASSIFICATIONS.CONTAINS_MEDICAL_VISUAL &&
    classification.hasDocumentText === true &&
    classification.hasMedicalVisual === true &&
    Number(classification.confidence) >= threshold;
}

async function classifyImage(image, context = {}, options = {}) {
  if (!image?.url) {
    throw new Error('Image URL is required for classification');
  }

  const model = options.model || getImageClassifierModel();
  const callAi = options.callAi || callAiWithFailover;
  const startedAt = Date.now();
  const requestBody = {
    messages: [
      {
        role: 'system',
        content: SYSTEM_PROMPT
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Classify this upload for safe routing.'
          },
          {
            type: 'image_url',
            image_url: {
              url: image.url,
              detail: 'low'
            }
          }
        ]
      }
    ],
    // Sin tope de tokens: con un presupuesto bajo el razonamiento se lo come
    // entero y el clasificador devuelve contenido vacío.
    reasoning_effort: 'low',
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'multimodal_image_routing',
        strict: true,
        schema: OUTPUT_SCHEMA
      }
    }
  };

  const response = await callAi(
    requestBody,
    context.timezone || 'UTC',
    model,
    0,
    null
  );
  const content = response?.data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Image classifier returned an empty response');
  }

  let parsed;
  try {
    parsed = JSON.parse(stripJsonFence(content));
  } catch {
    throw new Error('Image classifier returned invalid JSON');
  }

  return {
    ...normalizeClassification(parsed),
    usage: response?.data?.usage || {},
    model,
    durationMs: Date.now() - startedAt
  };
}

module.exports = {
  CLASSIFICATIONS,
  classifyImage,
  fallbackClassification,
  normalizeClassification,
  shouldExtractDocumentText,
  shouldExtractMixedDocumentText
};
