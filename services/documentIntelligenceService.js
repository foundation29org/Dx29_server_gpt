'use strict';

const { default: createDocumentIntelligenceClient, getLongRunningPoller, isUnexpected } = require('@azure-rest/ai-document-intelligence');
const config = require('../config');

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_CONCURRENCY = 2;
const MAX_RETRY_DELAY_MS = 8000;
const LEGACY_WORD_MIME_TYPE = 'application/msword';
const GOTENBERG_TIMEOUT_MS = 45000;
const NON_RETRYABLE_CODES = new Set([
  'LEGACY_DOC_CONVERSION_UNAVAILABLE',
  'InvalidContent',
  'InvalidRequest',
  'InvalidArgument',
  'UnsupportedMediaType',
  'InvalidContentLength',
  'InvalidImage',
  'BadArgument'
]);
const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404, 413, 415, 422]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStatus(error) {
  return Number(
    error?.statusCode ||
    error?.status ||
    error?.response?.status ||
    error?.details?.statusCode
  );
}

function getErrorCode(error) {
  return error?.code ||
    error?.innererror?.code ||
    error?.body?.error?.code ||
    error?.error?.code ||
    error?.details?.code;
}

function getHeader(headers, name) {
  if (!headers) {
    return undefined;
  }
  if (typeof headers.get === 'function') {
    return headers.get(name) || headers.get(name.toLowerCase());
  }
  return headers[name] || headers[name.toLowerCase()];
}

function isRetryableDocumentError(error) {
  const code = getErrorCode(error);
  if (code && NON_RETRYABLE_CODES.has(String(code))) {
    return false;
  }

  const status = getStatus(error);
  if (NON_RETRYABLE_STATUSES.has(status)) {
    return false;
  }
  if (status === 408 || status === 429 || status >= 500) {
    return true;
  }

  const message = String(error?.message || '').toLowerCase();
  return message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('econnreset') ||
    message.includes('socket') ||
    message.includes('429') ||
    !status;
}

function parseRetryAfterMs(error) {
  const headers = error?.headers || error?.response?.headers;
  const retryAfterMs = Number(getHeader(headers, 'retry-after-ms'));
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return retryAfterMs;
  }

  const retryAfter = getHeader(headers, 'retry-after');
  const asSeconds = Number(retryAfter);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return asSeconds * 1000;
  }
  if (retryAfter) {
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      return Math.max(0, dateMs - Date.now());
    }
  }
  return null;
}

function getRetryDelayMs(error, attempt, { random = Math.random } = {}) {
  const retryAfter = parseRetryAfterMs(error);
  if (retryAfter !== null) {
    return Math.min(retryAfter, MAX_RETRY_DELAY_MS);
  }
  const base = Math.min(500 * (2 ** attempt), MAX_RETRY_DELAY_MS);
  return base + Math.floor(random() * 250);
}

async function mapWithConcurrency(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let nextIndex = 0;
  const limit = Math.max(1, Math.min(concurrency || DEFAULT_CONCURRENCY, list.length || 1));

  async function run() {
    while (nextIndex < list.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(list[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, () => run()));
  return results;
}

function createClient() {
  return createDocumentIntelligenceClient(
    config.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT,
    { key: config.AZURE_DOCUMENT_INTELLIGENCE_KEY },
    { apiVersion: '2024-11-30' }
  );
}

function failedDocumentResult(
  originalName,
  mimeType,
  errorMessage,
  attempts = 1,
  size
) {
  return {
    name: originalName,
    ...(Number.isFinite(size) ? { size } : {}),
    status: 'failed',
    method: mimeType === 'text/plain' ? 'txt' : 'document_intelligence',
    content: '',
    pages: 0,
    durationMs: 0,
    attempts,
    warnings: [],
    error: errorMessage || 'The document could not be processed'
  };
}

function toPublicDocumentResult(result) {
  return {
    name: result.name,
    ...(Number.isFinite(result.size) ? { size: result.size } : {}),
    status: result.status,
    method: result.method,
    pages: result.pages || 0,
    durationMs: result.durationMs || 0,
    attempts: result.attempts || 1,
    warnings: result.warnings || [],
    error: result.error || null
  };
}

function normalizeDocumentError(error, fallbackMessage) {
  if (error instanceof Error) {
    return error;
  }
  const normalized = new Error(error?.message || fallbackMessage);
  if (error && typeof error === 'object') {
    normalized.code = error.code;
    normalized.statusCode = error.statusCode;
    normalized.innererror = error.innererror;
  }
  return normalized;
}

// Los bytes viajan dentro de la petición: Document Intelligence no necesita
// leer del blob y no hace falta firmar ninguna URL.
function buildAnalyzeSource({ fileBuffer, blobUrl }) {
  if (Buffer.isBuffer(fileBuffer)) {
    return { base64Source: fileBuffer.toString('base64') };
  }
  if (typeof blobUrl === 'string' && blobUrl) {
    return { urlSource: blobUrl };
  }
  throw new Error('Document Intelligence needs a file buffer or a URL');
}

async function submitDocumentAnalysis(client, source, options = {}) {
  const {
    sleep = delay,
    random = Math.random,
    maxAttempts = DEFAULT_MAX_ATTEMPTS
  } = options;
  const body = buildAnalyzeSource(source);
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const initialResponse = await client
        .path('/documentModels/{modelId}:analyze', 'prebuilt-layout')
        .post({
          contentType: 'application/json',
          body,
          queryParameters: { outputContentFormat: 'markdown' }
        });

      if (isUnexpected(initialResponse)) {
        const error = normalizeDocumentError(
          initialResponse.body?.error,
          'Unexpected Document Intelligence response'
        );
        error.statusCode = Number(initialResponse.status);
        error.headers = initialResponse.headers;
        throw error;
      }

      return {
        initialResponse,
        attempts: attempt + 1
      };
    } catch (error) {
      lastError = normalizeDocumentError(error, 'Document Intelligence submission failed');
      lastError.attempts = attempt + 1;
      if (!isRetryableDocumentError(error) || attempt >= maxAttempts - 1) {
        break;
      }
      await sleep(getRetryDelayMs(error, attempt, { random }));
    }
  }

  throw lastError;
}

async function analyzeWithDocumentIntelligence(source, options = {}) {
  const client = createClient();
  const startedAt = Date.now();
  const submission = await submitDocumentAnalysis(client, source, options);
  let result;

  try {
    const poller = getLongRunningPoller(client, submission.initialResponse);
    const flatResponse = await poller.pollUntilDone();
    result = flatResponse.body;
  } catch (error) {
    const pollingError = normalizeDocumentError(error, 'Document Intelligence polling failed');
    pollingError.attempts = submission.attempts;
    pollingError.phase = 'document_intelligence_polling';
    throw pollingError;
  }

  if (result.status === 'failed') {
    const analysisError = normalizeDocumentError(
      result.error,
      'Document Intelligence analysis failed'
    );
    analysisError.attempts = submission.attempts;
    analysisError.phase = 'document_intelligence_analysis';
    throw analysisError;
  }

  const warnings = [];
  const content = result.analyzeResult?.content || '';
  if (!content.trim()) {
    warnings.push('Document Intelligence returned no text');
  }

  return {
    content,
    pages: Array.isArray(result.analyzeResult?.pages) ? result.analyzeResult.pages.length : 1,
    durationMs: Date.now() - startedAt,
    method: 'document_intelligence',
    attempts: submission.attempts,
    warnings
  };
}

// Document Intelligence no lee el Word antiguo (OLE). Gotenberg lo abre con
// LibreOffice: son ficheros de usuarios anónimos, así que tiene que ser un
// servicio interno y sin salida a internet.
async function convertLegacyWordToPdf(fileBuffer, {
  gotenbergUrl = process.env.GOTENBERG_URL,
  fetchImpl = fetch
} = {}) {
  const baseUrl = String(gotenbergUrl || '').replace(/\/+$/, '');
  if (!baseUrl) {
    const error = new Error('Legacy .doc conversion is not configured');
    error.code = 'LEGACY_DOC_CONVERSION_UNAVAILABLE';
    throw error;
  }

  const form = new FormData();
  // Gotenberg elige el conversor por la extensión; el nombre real no hace falta.
  form.append('files', new Blob([fileBuffer], { type: LEGACY_WORD_MIME_TYPE }), 'document.doc');
  const response = await fetchImpl(`${baseUrl}/forms/libreoffice/convert`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(GOTENBERG_TIMEOUT_MS)
  });
  if (!response.ok) {
    const error = new Error(`Legacy .doc conversion failed (${response.status})`);
    error.code = 'LEGACY_DOC_CONVERSION_FAILED';
    error.statusCode = response.status;
    throw error;
  }
  return Buffer.from(await response.arrayBuffer());
}

async function extractDocument({
  fileBuffer,
  originalName,
  mimeType,
  blobUrl,
  size
}, options = {}) {
  if (mimeType === 'text/plain') {
    return {
      name: originalName,
      ...(Number.isFinite(size) ? { size } : {}),
      status: 'succeeded',
      method: 'txt',
      content: Buffer.isBuffer(fileBuffer) ? fileBuffer.toString('utf-8') : String(fileBuffer || ''),
      pages: 0,
      durationMs: 0,
      attempts: 1,
      warnings: [],
      error: null
    };
  }

  const analyzeSource = mimeType === LEGACY_WORD_MIME_TYPE
    ? { fileBuffer: await convertLegacyWordToPdf(fileBuffer, options) }
    : { fileBuffer, blobUrl };
  const analyzed = await analyzeWithDocumentIntelligence(analyzeSource, options);
  return {
    name: originalName,
    ...(Number.isFinite(size) ? { size } : {}),
    status: 'succeeded',
    method: analyzed.method,
    content: analyzed.content,
    pages: analyzed.pages,
    durationMs: analyzed.durationMs,
    attempts: analyzed.attempts,
    warnings: analyzed.warnings,
    error: null
  };
}

module.exports = {
  extractDocument,
  failedDocumentResult,
  toPublicDocumentResult,
  mapWithConcurrency,
  isRetryableDocumentError,
  getRetryDelayMs,
  LEGACY_WORD_MIME_TYPE,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_ATTEMPTS
};
