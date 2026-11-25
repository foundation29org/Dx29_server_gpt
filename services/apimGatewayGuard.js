'use strict';

// El backend solo debe atender peticiones que llegan por API Management (dxgpt-apim).
// Hoy lo garantiza la regla de IP del Container App (IP fija del NAT del APIM). En Basic v2
// no hay IP fija de salida, así que el APIM añade una cabecera secreta en su política global
// y aquí se comprueba. Ver docs/apim/backend-gateway-key.md.
//
// APIM_GATEWAY_SECRET       secreto esperado; varios separados por comas para rotarlo.
//                           Sin valor, el control está desactivado (comportamiento actual).
// APIM_GATEWAY_SECRET_MODE  'enforce' (por defecto) rechaza con 403;
//                           'report' deja pasar y solo registra el evento.

const crypto = require('crypto');

const HEADER = 'x-dxgpt-gateway-key';
// Solo dice que el proceso responde; no hace falta pasar por el APIM.
const OPEN_PATHS = new Set(['/api/internal/health']);
const MAX_EVENTS_PER_MINUTE = 20;

function digest(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

function parseSecrets(raw) {
  return String(raw || '')
    .split(',')
    .map((secret) => secret.trim())
    .filter(Boolean);
}

function normalizeMode(raw) {
  return String(raw || '').trim().toLowerCase() === 'report' ? 'report' : 'enforce';
}

function normalizePath(path) {
  const value = String(path || '');
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

function defaultTrack(name, properties) {
  try {
    require('./insights').trackEvent(name, properties);
  } catch (_) {
    // La telemetría nunca debe tumbar una petición
  }
}

function createApimGatewayGuard({
  secrets = process.env.APIM_GATEWAY_SECRET,
  mode = process.env.APIM_GATEWAY_SECRET_MODE,
  track = defaultTrack,
  now = Date.now
} = {}) {
  const expected = parseSecrets(secrets).map(digest);
  if (expected.length === 0) {
    return function apimGatewayGuardDisabled(req, res, next) {
      // Aunque no se compruebe, la cabecera no sigue: varios controladores mandan
      // req.headers completo a App Insights cuando hay un error.
      delete req.headers[HEADER];
      next();
    };
  }
  const effectiveMode = normalizeMode(mode);
  let windowStart = 0;
  let sentInWindow = 0;
  let dropped = 0;

  function report(req, reason) {
    const current = now();
    if (current - windowStart >= 60000) {
      windowStart = current;
      sentInWindow = 0;
    }
    if (sentInWindow >= MAX_EVENTS_PER_MINUTE) {
      dropped += 1;
      return;
    }
    sentInWindow += 1;
    track('ApimGatewayKeyRejected', {
      reason,
      mode: effectiveMode,
      method: req.method,
      path: normalizePath(req.path).slice(0, 120),
      correlationId: req.correlationId || '',
      droppedSinceLastEvent: String(dropped)
    });
    dropped = 0;
  }

  return function apimGatewayGuard(req, res, next) {
    const provided = req.headers[HEADER];
    // No se propaga más allá de este punto (logs, reenvíos, controladores)
    delete req.headers[HEADER];

    if (req.method === 'GET' && OPEN_PATHS.has(normalizePath(req.path))) {
      return next();
    }

    let reason = 'missing';
    if (typeof provided === 'string' && provided.length > 0) {
      const candidate = digest(provided);
      if (expected.some((secret) => crypto.timingSafeEqual(secret, candidate))) {
        return next();
      }
      reason = 'mismatch';
    } else if (Array.isArray(provided)) {
      reason = 'repeated';
    }

    report(req, reason);
    if (effectiveMode === 'report') {
      return next();
    }
    return res.status(403).json({ error: 'forbidden' });
  };
}

module.exports = {
  HEADER,
  createApimGatewayGuard
};
