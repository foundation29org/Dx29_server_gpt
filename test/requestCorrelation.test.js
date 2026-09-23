'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ensureCorrelationId,
  normalizeCorrelationId
} = require('../services/requestCorrelation');

test('keeps safe incoming correlation IDs', () => {
  const req = { headers: { 'x-correlation-id': 'support-case:123' } };
  const headers = {};
  const res = {
    headersSent: false,
    setHeader: (name, value) => {
      headers[name.toLowerCase()] = value;
    }
  };

  assert.equal(ensureCorrelationId(req, res), 'support-case:123');
  assert.equal(req.correlationId, 'support-case:123');
  assert.equal(headers['x-correlation-id'], 'support-case:123');
});

test('replaces unsafe correlation IDs with a UUID', () => {
  const req = { headers: { 'x-correlation-id': 'unsafe value\r\nheader' } };
  const correlationId = ensureCorrelationId(req);

  assert.match(
    correlationId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
});

test('normalizes only bounded header-safe values', () => {
  assert.equal(normalizeCorrelationId(' trace-123 '), 'trace-123');
  assert.equal(normalizeCorrelationId('contains spaces'), null);
  assert.equal(normalizeCorrelationId('x'.repeat(129)), null);
});
