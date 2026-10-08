const test = require('node:test');
const assert = require('node:assert/strict');

const {
  countryNameFromCode,
  locationContextText,
  normalizeCountryCode,
  resolveCountryCode,
  withLocationContext
} = require('../services/locationContext');

test('normalizeCountryCode accepts lenient input and rejects the rest', () => {
  assert.equal(normalizeCountryCode(' es '), 'ES');
  assert.equal(normalizeCountryCode('E.S'), 'ES');
  for (const value of ['', 'ESP', 'E', '12', undefined, null, 5, {}, ['ES']]) {
    assert.equal(normalizeCountryCode(value), '', `expected empty for ${JSON.stringify(value)}`);
  }
});

test('resolveCountryCode keeps a valid country and drops anything else', () => {
  assert.equal(resolveCountryCode('in', {}), 'IN');
  assert.equal(resolveCountryCode('ZZ', {}), '');
  assert.equal(resolveCountryCode('', {}), '');
  assert.equal(resolveCountryCode(undefined, {}), '');
});

test('resolveCountryCode returns nothing when LOCATION_CONTEXT_ENABLED is false', () => {
  assert.equal(resolveCountryCode('IN', { LOCATION_CONTEXT_ENABLED: 'false' }), '');
  assert.equal(resolveCountryCode('IN', { LOCATION_CONTEXT_ENABLED: ' False ' }), '');
  assert.equal(resolveCountryCode('IN', { LOCATION_CONTEXT_ENABLED: 'true' }), 'IN');
});

test('countryNameFromCode returns the English name for a valid ISO code', () => {
  assert.equal(countryNameFromCode('IN'), 'India');
  assert.equal(countryNameFromCode('ES'), 'Spain');
  assert.equal(countryNameFromCode('NG'), 'Nigeria');
});

test('countryNameFromCode rejects anything that is not a two-letter uppercase code', () => {
  for (const value of ['', 'in', 'IND', 'I1', '<script>', undefined, null, 42, {}]) {
    assert.equal(countryNameFromCode(value), '', `expected empty for ${JSON.stringify(value)}`);
  }
});

test('countryNameFromCode ignores codes that are not assigned to a region', () => {
  assert.equal(countryNameFromCode('ZZ'), '');
  assert.equal(countryNameFromCode('XX'), '');
});

test('locationContextText is a single short sentence', () => {
  assert.equal(locationContextText('IN'), 'The patient is in India.');
  assert.equal(locationContextText(''), '');
});

test('withLocationContext appends the sentence after the description', () => {
  assert.equal(
    withLocationContext('high fever and chills', 'NG'),
    'high fever and chills\n\nThe patient is in Nigeria.'
  );
});

test('withLocationContext leaves the text untouched without a usable country', () => {
  assert.equal(withLocationContext('high fever', ''), 'high fever');
  assert.equal(withLocationContext('high fever', undefined), 'high fever');
  assert.equal(withLocationContext('high fever', 'ZZ'), 'high fever');
});

test('withLocationContext never turns an empty case into text', () => {
  assert.equal(withLocationContext('', 'IN'), '');
  assert.equal(withLocationContext('   ', 'IN'), '   ');
  assert.equal(withLocationContext(undefined, 'IN'), undefined);
});

test('withLocationContext can be the only text when the evidence is an image (allowEmpty)', () => {
  assert.equal(withLocationContext('', 'IN', { allowEmpty: true }), 'The patient is in India.');
  assert.equal(withLocationContext('   ', 'IN', { allowEmpty: true }), 'The patient is in India.');
  assert.equal(withLocationContext('rash', 'IN', { allowEmpty: true }), 'rash\n\nThe patient is in India.');
  assert.equal(withLocationContext('', '', { allowEmpty: true }), '');
  assert.equal(withLocationContext(undefined, 'IN', { allowEmpty: true }), undefined);
});
