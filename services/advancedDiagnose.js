'use strict';

// Modo avanzado del diagnóstico: el usuario que no queda convencido con la respuesta
// de Sol puede pedir otra a Claude Fable 5.2 (77 % de acierto en el primer puesto
// frente a 67 % de Sol en los 210 casos reales de narrative_v2, nov-2026).
//
// Se ofrece tras un voto negativo o desde un botón, y antes se pregunta por qué no
// convenció la primera respuesta, con motivos cerrados (sin texto libre). El motivo se
// guarda para analizarlo, pero no se pasa al modelo: Fable se evaluó con el mismo
// prompt que Sol y sin ese contexto.
//
// Activo en la web de DxGPT (también la versión EU); de momento no en SaludGPT. Los
// clientes de la API no lo tienen (no está en la página de precios): se distinguen por
// el producto de APIM. Una vez por caso: lo controla el cliente.

const ADVANCED_DIAGNOSE_MODEL = 'claudefable52';

const ADVANCED_REASONS = [
  'missing_suspected', // no aparece lo que sospecho
  'too_generic', // demasiado generales
  'not_matching', // no encaja con los síntomas, la edad o el sexo
  'want_second_opinion', // quiero contrastarlo
  'other'
];
const ADVANCED_SOURCES = ['vote_down', 'button'];

function isAdvancedRequest(data) {
  return Boolean(data) && data.advanced === true;
}

// Errores de formato de los campos del modo avanzado, con el formato de validateDiagnoseRequest
function advancedFieldErrors(data) {
  const errors = [];
  if (!data || data.advanced === undefined) return errors;
  if (typeof data.advanced !== 'boolean') {
    errors.push({ field: 'advanced', reason: 'Must be a boolean' });
    return errors;
  }
  if (!data.advanced) return errors;
  if (!ADVANCED_REASONS.includes(data.advancedReason)) {
    errors.push({ field: 'advancedReason', reason: `Must be one of: ${ADVANCED_REASONS.join(', ')}` });
  }
  if (!ADVANCED_SOURCES.includes(data.advancedSource)) {
    errors.push({ field: 'advancedSource', reason: `Must be one of: ${ADVANCED_SOURCES.join(', ')}` });
  }
  return errors;
}

// Productos de APIM de las webs (Static Web Apps, validan su token): DxGPT, DxGPT EU y
// SaludGPT, con el mismo id en la APIM de prod y en la de dev. La API dxgpt-api fija
// x-product-id con exists-action="override", así que un cliente no puede falsearlo; los
// productos de la API (Freemium, Pro, Research, Marketplace...) no están aquí.
const WEB_APIM_PRODUCTS = new Set([
  'brave-water-0ce6c5a03',
  'delightful-moss-0b31d2b03'
  // 'lemon-glacier-023c47f03' (SaludGPT): ver ADVANCED_EXCLUDED_TENANT_PREFIXES
]);

// Webs que aún no lo tienen. SaludGPT (Aragón), hasta que apruebe que los casos se
// procesen con Claude Fable, que hoy corre en infraestructura de Anthropic y puede
// procesarse fuera de la UE (12-nov-2026). Para activarlo: quitarlo de aquí, volver a
// poner su producto en WEB_APIM_PRODUCTS y quitarlo también en el cliente
// (ADVANCED_EXCLUDED_TENANT_PREFIXES en undiagnosed-page.component.ts).
const ADVANCED_EXCLUDED_TENANT_PREFIXES = ['salud-gpt'];

// Por qué no se puede usar el modo avanzado en esta petición, o null si se puede.
function advancedRequestRejection({ flow, tenantId, subscriptionId, productId, data, nodeEnv = process.env.NODE_ENV }) {
  // Solo la web. X-Tenant-Id no basta: la API pública lo admite como cabecera opcional.
  if (!tenantId) return 'ADVANCED_NOT_AVAILABLE_FOR_API';
  if (ADVANCED_EXCLUDED_TENANT_PREFIXES.some((prefix) => String(tenantId).startsWith(prefix))) {
    return 'ADVANCED_NOT_AVAILABLE_FOR_TENANT';
  }
  if (subscriptionId) {
    // Por APIM: solo los productos de las webs
    if (!WEB_APIM_PRODUCTS.has(String(productId || ''))) return 'ADVANCED_NOT_AVAILABLE_FOR_API';
  } else if (nodeEnv === 'production') {
    // Sin APIM solo en local y en pruebas: en producción todo debe llegar por APIM
    return 'ADVANCED_NOT_AVAILABLE_FOR_API';
  }
  if (flow !== 'diagnose') return 'ADVANCED_ONLY_DIAGNOSE';
  if (data.response_mode === 'direct') return 'ADVANCED_ONLY_ASYNC';
  // «Cargar más» sigue con el modelo normal: el cliente no lo pide con el modo avanzado
  if (data.diseases_list && String(data.diseases_list).trim()) return 'ADVANCED_NO_LOAD_MORE';
  return null;
}

// Lo que se guarda en el registro de coste: solo códigos
function advancedMeta(data) {
  return {
    reason: data.advancedReason,
    source: data.advancedSource
  };
}

module.exports = {
  ADVANCED_DIAGNOSE_MODEL,
  WEB_APIM_PRODUCTS,
  ADVANCED_EXCLUDED_TENANT_PREFIXES,
  ADVANCED_REASONS,
  ADVANCED_SOURCES,
  isAdvancedRequest,
  advancedFieldErrors,
  advancedRequestRejection,
  advancedMeta
};
