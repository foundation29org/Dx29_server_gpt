'use strict';

const { randomUUID } = require('node:crypto');

const CORRELATION_HEADER = 'x-correlation-id';
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function getHeader(req, name) {
  const value = req?.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function normalizeCorrelationId(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return SAFE_CORRELATION_ID.test(normalized) ? normalized : null;
}

function ensureCorrelationId(req, res) {
  const existing = normalizeCorrelationId(req?.correlationId);
  const incoming = normalizeCorrelationId(getHeader(req, CORRELATION_HEADER)) ||
    normalizeCorrelationId(getHeader(req, 'x-request-id')) ||
    normalizeCorrelationId(getHeader(req, 'request-id'));
  const correlationId = existing || incoming || randomUUID();

  if (req) {
    req.correlationId = correlationId;
    req.headers = req.headers || {};
    req.headers[CORRELATION_HEADER] = correlationId;
  }
  if (res && typeof res.setHeader === 'function' && !res.headersSent) {
    res.setHeader(CORRELATION_HEADER, correlationId);
  }
  return correlationId;
}

function correlationMiddleware(req, res, next) {
  ensureCorrelationId(req, res);
  next();
}

module.exports = {
  CORRELATION_HEADER,
  correlationMiddleware,
  ensureCorrelationId,
  normalizeCorrelationId
};
