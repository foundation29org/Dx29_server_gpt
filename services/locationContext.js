// Where the patient is, to tune the differential towards locally common conditions.
// The prompt only ever gets a name built from an ISO code: the display name the
// client sends is never put in it.
//
// Settings (environment):
//   LOCATION_CONTEXT_ENABLED=false           switches the sentence off everywhere.
//   (A tenant with a fixed country is configured in the Client: branding-config.)

const REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });

// CLDR regions that are not a place where a patient lives. `ZZ` resolves to
// "Unknown Region", so the name alone cannot tell it apart from a real country.
const NOT_A_COUNTRY = new Set(['ZZ', 'EU', 'UN', 'EZ', 'XA', 'XB', 'QO']);

// Lenient on purpose: integrators send "es", " ES " or "E.S".
function normalizeCountryCode(raw) {
  if (typeof raw !== 'string') {
    return '';
  }
  const code = raw.trim().toUpperCase().replace(/[^A-Z]/g, '');
  return /^[A-Z]{2}$/.test(code) ? code : '';
}

function countryNameFromCode(countryCode) {
  if (typeof countryCode !== 'string' || !/^[A-Z]{2}$/.test(countryCode) || NOT_A_COUNTRY.has(countryCode)) {
    return '';
  }
  try {
    const name = REGION_NAMES.of(countryCode) || '';
    return name === countryCode ? '' : name;
  } catch {
    return '';
  }
}

// The country that goes into the prompt: the one the request carries, validated.
// Empty when it is not usable or the feature is off. A tenant with a fixed country
// is configured in the Client (branding-config patientCountry), which then sends it.
function resolveCountryCode(countryCode, env = process.env) {
  if (String(env.LOCATION_CONTEXT_ENABLED || '').trim().toLowerCase() === 'false') {
    return '';
  }
  const code = normalizeCountryCode(countryCode);
  return countryNameFromCode(code) ? code : '';
}

function locationContextText(countryCode, subject = 'patient') {
  const name = countryNameFromCode(countryCode);
  return name ? `The ${subject} is in ${name}.` : '';
}

// A case with no text stays empty, so the line is never mistaken for a patient
// description. `allowEmpty` is for cases whose evidence is an image: the same
// finding means different things in different places, so the line may be all the
// text there is.
function withLocationContext(text, countryCode, { allowEmpty = false } = {}) {
  const line = locationContextText(countryCode);
  if (!line || typeof text !== 'string') {
    return text;
  }
  if (!text.trim()) {
    return allowEmpty ? line : text;
  }
  return `${text}\n\n${line}`;
}

module.exports = {
  countryNameFromCode,
  locationContextText,
  normalizeCountryCode,
  resolveCountryCode,
  withLocationContext
};
