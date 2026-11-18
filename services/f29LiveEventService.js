'use strict';

const axios = require('axios');
const config = require('../config');

const ENABLED = process.env.F29_LIVE_EVENTS_ENABLED !== 'false';
const URL = process.env.F29_LIVE_EVENTS_URL || config.F29_LIVE_EVENTS_URL;
const API_KEY = process.env.F29_API_KEY || config.F29_API_KEY;

const PROD_TENANTS = new Set(['dxgpt-prod', 'dxeugpt-prod']);

async function notifyDiagnosisFinished(payload = {}) {
  if (!ENABLED || !URL || !API_KEY) {
    return;
  }

  const tenantId = String(payload.tenantId || '').trim();
  if (tenantId && !PROD_TENANTS.has(tenantId)) {
    return;
  }

  await axios.post(
    URL,
    {
      countryCode: payload.countryCode || '',
      countryName: payload.countryName || '',
      timezone: payload.timezone || '',
      tenantId,
    },
    {
      headers: { 'x-api-key': API_KEY },
      // Nadie espera esta llamada: se lanza después de dar el diagnóstico. Con
      // 3 s se perdían ~3 avisos al día (picos y reinicios de F29), cada uno
      // registrado como excepción en App Insights.
      timeout: 10000,
    },
  );
}

module.exports = {
  notifyDiagnosisFinished,
};
