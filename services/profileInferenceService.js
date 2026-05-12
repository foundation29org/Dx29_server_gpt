const insights = require('./insights');
const { callAiWithFailover, parseJsonWithFixes, sanitizeInput } = require('./aiUtils');

const profileInferenceModel = 'gpt54mini';

const USER_TYPES = {
  PROFESSIONAL: 'professional',
  PATIENT: 'patient',
  CAREGIVER: 'caregiver',
  NONE: 'none'
};

const OTHER_SPECIALTY = 'Other';
const PREFER_NOT_TO_SAY_SPECIALTY = 'Prefer not to say';

const specialtyCatalog = [
  'Family Medicine',
  'Internal Medicine',
  'Pediatrics',
  'Neurology',
  'Cardiology',
  'Pulmonology',
  'Gastroenterology',
  'Endocrinology',
  'Nephrology',
  'Rheumatology',
  'Hematology',
  'Medical Oncology',
  'Infectious Diseases',
  'Dermatology',
  'Psychiatry',
  'General Surgery',
  'Orthopedic Surgery and Traumatology',
  'Neurosurgery',
  'Urology',
  'Gynecology and Obstetrics',
  'Ophthalmology',
  'Otolaryngology',
  'Radiology',
  'Emergency Medicine',
  'Intensive Care Medicine',
  'Clinical Genetics',
  OTHER_SPECIALTY,
  PREFER_NOT_TO_SAY_SPECIALTY
];

function normalizeUserType(value) {
  const normalized = normalizeText(value);
  const allowed = [
    USER_TYPES.PROFESSIONAL,
    USER_TYPES.PATIENT,
    USER_TYPES.CAREGIVER,
    USER_TYPES.NONE
  ];
  return allowed.includes(normalized) ? normalized : USER_TYPES.NONE;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function mapToCatalogSpecialty(value) {
  const normalizedInput = normalizeText(value);
  const found = specialtyCatalog.find((item) => normalizeText(item) === normalizedInput);
  return found || null;
}

function clampConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric < 0) return 0;
  if (numeric > 1) return 1;
  return numeric;
}

function getDefaultInferredProfile(confidenceThreshold = 0.7) {
  return {
    userType: USER_TYPES.NONE,
    topSpecialties: [OTHER_SPECIALTY],
    confidence: 0,
    confidenceThreshold,
    feedbackAutofillRecommended: false
  };
}

function normalizeInferenceOutput(parsed, confidenceThreshold = 0.7) {
  const fallback = getDefaultInferredProfile(confidenceThreshold);
  if (!parsed || typeof parsed !== 'object') return fallback;

  const userType = normalizeUserType(parsed.userType);
  const confidence = clampConfidence(parsed.confidence);

  if (userType !== USER_TYPES.PROFESSIONAL) {
    return {
      userType,
      topSpecialties: [PREFER_NOT_TO_SAY_SPECIALTY],
      confidence,
      confidenceThreshold,
      feedbackAutofillRecommended: false
    };
  }

  const candidateList = Array.isArray(parsed.topSpecialties) ? parsed.topSpecialties : [];
  const mappedList = [];
  for (const value of candidateList) {
    const mapped = mapToCatalogSpecialty(value);
    if (mapped && !mappedList.includes(mapped)) {
      mappedList.push(mapped);
    }
    if (mappedList.length >= 3) break;
  }

  const topSpecialties = mappedList.length > 0 ? mappedList : [OTHER_SPECIALTY];
  const hasFallbackTop = topSpecialties[0] === OTHER_SPECIALTY || topSpecialties[0] === PREFER_NOT_TO_SAY_SPECIALTY;
  const feedbackAutofillRecommended = !hasFallbackTop && confidence >= confidenceThreshold;

  return {
    userType,
    topSpecialties,
    confidence,
    confidenceThreshold,
    feedbackAutofillRecommended
  };
}

function buildProfileInferencePrompt(description, diseasesList) {
  const catalogText = specialtyCatalog.map((item, index) => `${index + 1}. ${item}`).join('\n');
  return `Task: infer user profile and medical specialty from the available signals.

Available data:
- Description: ${description || 'N/A'}
- Related diseases: ${diseasesList || 'N/A'}

Allowed user types (must choose exactly one):
- professional
- patient
- caregiver
- none

Allowed specialties (must choose only from this list):
${catalogText}

Rules:
1) If userType is not "professional", topSpecialties must be ["Prefer not to say"].
2) If confidence is low or evidence is insufficient, use topSpecialties ["Other"].
3) Return up to 3 specialties ordered by likelihood.
4) Never invent specialties outside the allowed list.
5) Return only valid JSON with this exact schema:
{
  "userType": "professional|patient|caregiver|none",
  "topSpecialties": ["..."],
  "confidence": 0.0
}`;
}

async function inferProfileAndSpecialty({
  description = '',
  diseasesList = '',
  timezone = '',
  tenantId = null,
  subscriptionId = null,
  myuuid = null,
  dataRequest = null,
  confidenceThreshold = 0.7
}) {
  const fallback = getDefaultInferredProfile(confidenceThreshold);
  const safeDescription = sanitizeInput(String(description || '')).slice(0, 5000);
  const safeDiseases = sanitizeInput(String(diseasesList || '')).slice(0, 2000);

  if (!safeDescription && !safeDiseases) {
    return {
      ...fallback,
      usage: null,
      model: profileInferenceModel,
      durationMs: 0
    };
  }

  const prompt = buildProfileInferencePrompt(safeDescription, safeDiseases);
  const requestBody = {
    model: 'gpt-5.4-mini',
    messages: [{ role: 'user', content: prompt }],
    reasoning_effort: 'low'
  };

  const startedAt = Date.now();
  try {
    const response = await callAiWithFailover(requestBody, timezone, profileInferenceModel, 0, dataRequest);
    const durationMs = Date.now() - startedAt;
    const aiText = response?.data?.choices?.[0]?.message?.content?.trim() || '';
    const parsed = await parseJsonWithFixes(aiText, 'object');
    const normalized = normalizeInferenceOutput(parsed, confidenceThreshold);

    return {
      ...normalized,
      usage: response?.data?.usage || null,
      model: profileInferenceModel,
      durationMs
    };
  } catch (error) {
    insights.error({
      message: 'Profile inference failed',
      error: error?.message || String(error),
      tenantId,
      subscriptionId,
      myuuid
    });
    return {
      ...fallback,
      usage: null,
      model: profileInferenceModel,
      durationMs: Date.now() - startedAt
    };
  }
}

module.exports = {
  inferProfileAndSpecialty,
  getDefaultInferredProfile,
  getSpecialtyCatalog: () => [...specialtyCatalog]
};
