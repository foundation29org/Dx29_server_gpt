'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function stubModule(modulePath, exports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports
  };
}

const state = {
  posts: 0,
  isUnexpected: false,
  pollBody: {
    status: 'succeeded',
    analyzeResult: {
      content: 'Extracted document content',
      pages: [{}]
    }
  }
};

stubModule('../config', {
  AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: 'https://document-intelligence.test',
  AZURE_DOCUMENT_INTELLIGENCE_KEY: 'test-key'
});
stubModule('@azure-rest/ai-document-intelligence', {
  default: () => ({
    path: () => ({
      post: async (request) => {
        state.posts += 1;
        state.lastBody = request?.body;
        if (typeof state.post === 'function') {
          return state.post();
        }
        return { status: '202', body: {}, headers: {} };
      }
    })
  }),
  getLongRunningPoller: () => ({
    pollUntilDone: async () => {
      if (typeof state.poll === 'function') {
        return state.poll();
      }
      return { body: state.pollBody };
    }
  }),
  isUnexpected: () => state.isUnexpected
});

delete require.cache[require.resolve('../services/documentIntelligenceService')];

const {
  extractDocument,
  mapWithConcurrency,
  isRetryableDocumentError,
  getRetryDelayMs
} = require('../services/documentIntelligenceService');

test.beforeEach(() => {
  state.posts = 0;
  state.lastBody = null;
  state.isUnexpected = false;
  state.post = null;
  state.poll = null;
  state.pollBody = {
    status: 'succeeded',
    analyzeResult: {
      content: 'Extracted document content',
      pages: [{}]
    }
  };
});

test('reads TXT locally without calling Document Intelligence', async () => {
  const result = await extractDocument({
    fileBuffer: Buffer.from('Plain clinical notes'),
    originalName: 'notes.txt',
    mimeType: 'text/plain',
    blobUrl: 'https://storage.test/notes.txt'
  });

  assert.equal(result.method, 'txt');
  assert.equal(result.status, 'succeeded');
  assert.equal(result.content, 'Plain clinical notes');
  assert.equal(state.posts, 0);
});

test('does not retry corrupt or invalid document content', async () => {
  state.post = async () => {
    const error = new Error('InvalidContent');
    error.code = 'InvalidContent';
    error.statusCode = 400;
    throw error;
  };

  await assert.rejects(
    extractDocument({
      fileBuffer: Buffer.from('%PDF-1.7'),
      originalName: 'corrupt.pdf',
      mimeType: 'application/pdf',
      blobUrl: 'https://storage.test/corrupt.pdf'
    }, { sleep: async () => undefined }),
    (error) => error.code === 'InvalidContent' && state.posts === 1
  );
});

test('retries 429 responses while submitting and honors Retry-After', async () => {
  const delays = [];
  state.post = async () => {
    if (state.posts < 3) {
      const error = new Error('Too many requests');
      error.statusCode = 429;
      error.headers = { 'retry-after': '0' };
      throw error;
    }
    return { status: '202', body: {}, headers: {} };
  };

  const result = await extractDocument({
    fileBuffer: Buffer.from('%PDF-1.7'),
    originalName: 'report.pdf',
    mimeType: 'application/pdf',
    blobUrl: 'https://storage.test/report.pdf'
  }, {
    sleep: async (ms) => {
      delays.push(ms);
    }
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.attempts, 3);
  assert.equal(state.posts, 3);
  assert.deepEqual(delays, [0, 0]);
});

test('retries a timeout and a 5xx response while submitting', async () => {
  const delays = [];
  state.post = async () => {
    if (state.posts === 1) {
      throw new Error('Request timed out');
    }
    if (state.posts === 2) {
      const error = new Error('Service unavailable');
      error.statusCode = 503;
      throw error;
    }
    return { status: '202', body: {}, headers: {} };
  };

  const result = await extractDocument({
    fileBuffer: Buffer.from('%PDF-1.7'),
    originalName: 'report.pdf',
    mimeType: 'application/pdf',
    blobUrl: 'https://storage.test/report.pdf'
  }, {
    sleep: async (ms) => {
      delays.push(ms);
    },
    random: () => 0
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.attempts, 3);
  assert.equal(state.posts, 3);
  assert.deepEqual(delays, [500, 1000]);
});

test('does not submit a second analysis when polling fails', async () => {
  state.poll = async () => {
    const error = new Error('Polling connection reset');
    error.statusCode = 503;
    throw error;
  };

  await assert.rejects(
    extractDocument({
      fileBuffer: Buffer.from('%PDF-1.7'),
      originalName: 'report.pdf',
      mimeType: 'application/pdf',
      blobUrl: 'https://storage.test/report.pdf'
    }, { sleep: async () => undefined }),
    (error) =>
      error.phase === 'document_intelligence_polling' &&
      error.attempts === 1
  );
  assert.equal(state.posts, 1);
});

test('converts a legacy .doc to PDF before Document Intelligence', async () => {
  const pdf = Buffer.from('%PDF-1.7 converted');
  const conversions = [];
  const result = await extractDocument({
    fileBuffer: Buffer.from([0xD0, 0xCF, 0x11, 0xE0]),
    originalName: 'informe.doc',
    mimeType: 'application/msword'
  }, {
    gotenbergUrl: 'http://gotenberg.test/',
    fetchImpl: async (url, init) => {
      conversions.push({ url, file: init.body.get('files') });
      return new Response(pdf, { status: 200 });
    }
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(conversions.length, 1);
  assert.equal(conversions[0].url, 'http://gotenberg.test/forms/libreoffice/convert');
  assert.equal(conversions[0].file.name, 'document.doc');
  assert.deepEqual(state.lastBody, { base64Source: pdf.toString('base64') });
});

test('fails a legacy .doc without calling Document Intelligence when Gotenberg is missing', async () => {
  await assert.rejects(
    extractDocument({
      fileBuffer: Buffer.from([0xD0, 0xCF, 0x11, 0xE0]),
      originalName: 'informe.doc',
      mimeType: 'application/msword'
    }, { gotenbergUrl: '' }),
    (error) => error.code === 'LEGACY_DOC_CONVERSION_UNAVAILABLE'
  );
  assert.equal(state.posts, 0);
});

test('fails a legacy .doc when Gotenberg cannot convert it', async () => {
  await assert.rejects(
    extractDocument({
      fileBuffer: Buffer.from([0xD0, 0xCF, 0x11, 0xE0]),
      originalName: 'informe.doc',
      mimeType: 'application/msword'
    }, {
      gotenbergUrl: 'http://gotenberg.test',
      fetchImpl: async () => new Response('bad file', { status: 400 })
    }),
    (error) => error.code === 'LEGACY_DOC_CONVERSION_FAILED' && error.statusCode === 400
  );
  assert.equal(state.posts, 0);
});

test('keeps original document order with limited concurrency', async () => {
  const inFlight = [];
  let maxInFlight = 0;
  const results = await mapWithConcurrency([1, 2, 3], 2, async (value) => {
    inFlight.push(value);
    maxInFlight = Math.max(maxInFlight, inFlight.length);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight.splice(inFlight.indexOf(value), 1);
    return value * 10;
  });

  assert.deepEqual(results, [10, 20, 30]);
  assert.equal(maxInFlight, 2);
});

test('classifies retryable and non-retryable document errors', () => {
  assert.equal(isRetryableDocumentError({ statusCode: 429 }), true);
  assert.equal(isRetryableDocumentError({ statusCode: 503 }), true);
  assert.equal(isRetryableDocumentError({ statusCode: 408 }), true);
  assert.equal(isRetryableDocumentError({ code: 'InvalidContent', statusCode: 400 }), false);
  assert.equal(isRetryableDocumentError({ statusCode: 415 }), false);
});

test('uses Retry-After before exponential backoff', () => {
  assert.equal(getRetryDelayMs({
    headers: { 'retry-after': '2' }
  }, 0, { random: () => 0 }), 2000);
  assert.equal(getRetryDelayMs({}, 0, { random: () => 0 }), 500);
  assert.equal(getRetryDelayMs({}, 1, { random: () => 0 }), 1000);
});
