'use strict';

const { default: createDocumentIntelligenceClient, getLongRunningPoller, isUnexpected } = require('@azure-rest/ai-document-intelligence');
const config = require('../config');

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_CONCURRENCY = 2;
const MAX_RETRY_DELAY_MS = 8000;
const NON_RETRYABLE_CODES = new Set([
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

function failedDocumentResult(originalName, mimeType, errorMessage, attempts = 1) {
  return {
    name: originalName,
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

async function submitDocumentAnalysis(client, blobUrl, options = {}) {
  const {
    sleep = delay,
    random = Math.random,
    maxAttempts = config.DOCUMENT_INTELLIGENCE_MAX_ATTEMPTS || DEFAULT_MAX_ATTEMPTS
  } = options;
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const initialResponse = await client
        .path('/documentModels/{modelId}:analyze', 'prebuilt-layout')
        .post({
          contentType: 'application/json',
          body: { urlSource: blobUrl },
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

async function analyzeWithDocumentIntelligence(blobUrl, options = {}) {
  const client = createClient();
  const startedAt = Date.now();
  const submission = await submitDocumentAnalysis(client, blobUrl, options);
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

async function extractDocument({ fileBuffer, originalName, mimeType, blobUrl }, options = {}) {
  if (mimeType === 'text/plain') {
    return {
      name: originalName,
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

  const analyzed = await analyzeWithDocumentIntelligence(blobUrl, options);
  return {
    name: originalName,
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
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_ATTEMPTS
};
