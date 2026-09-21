'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

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
  diagnoseCalls: [],
  diagnose: async (req, res) => res.status(200).send({ result: 'success' }),
  resolvedAssets: [],
  imageUploadCount: 0,
  summarize: async (req, res) => res.status(200).send({
    result: 'success',
    data: { summary: 'Valid summary' }
  }),
  documentPost: async () => ({
    status: '202',
    body: {}
  })
};

stubModule('@azure-rest/ai-document-intelligence', {
  default: () => ({
    path: () => ({
      post: (...args) => state.documentPost(...args)
    })
  }),
  getLongRunningPoller: () => ({
    pollUntilDone: async () => ({
      body: {
        status: 'succeeded',
        analyzeResult: {
          content: 'Extracted document content',
          pages: [{}]
        }
      }
    })
  }),
  isUnexpected: () => false
});
stubModule('../config', {
  AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: 'https://document-intelligence.test',
  AZURE_DOCUMENT_INTELLIGENCE_KEY: 'test-key',
  translationKey: 'test-key',
  DOCUMENT_INTELLIGENCE_MAX_ATTEMPTS: 1,
  DOCUMENT_INTELLIGENCE_CONCURRENCY: 2
});
stubModule('../services/summarizeService', {
  summarize: (...args) => state.summarize(...args)
});
stubModule('../services/blobFiles', {
  createBlobFile: async (_buffer, originalName) => `https://storage.test/${originalName || 'blob'}?sig=secret`,
  createBlobFileWithMetadata: async () => {
    state.imageUploadCount += 1;
    return {
      blobName: 'tenants/tenant-test/files/scan.png',
      containerName: 'files',
      url: 'https://storage.test/blob?sig=secret',
      sasExpiresAt: new Date('2026-09-21T15:00:00Z')
    };
  },
  isOwnedBlobUrl: () => true
});
stubModule('../services/multimodalAssetService', {
  registerImageAsset: (...args) => state.registerImageAsset(...args),
  resolveImageAssets: (...args) => state.resolveImageAssets(...args)
});
stubModule('../services/insights', { error: () => undefined });
stubModule('../services/email', { sendMailErrorGPTIP: async () => undefined });
stubModule('../services/costTrackingService', {
  saveCostRecordBestEffort: async () => undefined
});
stubModule('../services/pubsubService', { sendProgress: async () => undefined });
stubModule('../services/aiUtils', {
  DEFAULT_AI_MODEL: 'gpt56terra',
  resolveDiagnoseModel: () => 'gpt56terra'
});
stubModule('../services/translation', {
  translateInvert: async (text) => text
});
stubModule('../services/helpDiagnose', {
  diagnose: async (req, res) => {
    state.diagnoseCalls.push(req.body);
    return state.diagnose(req, res);
  }
});

const { processMultimodalInput } = require('../controllers/all/multimodalInput');
const { validateUploadedFiles } = require('../services/multimodalInputValidation');
const { validateImageReferenceFields } = require('../services/multimodalImageResolver');

function createMultipartRequest(fields, files = []) {
  const boundary = '----dxgpt-test-boundary';
  const chunks = [];

  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      `${value}\r\n`
    ));
  }

  for (const file of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\n` +
      `Content-Type: ${file.type}\r\n\r\n`
    ));
    chunks.push(Buffer.isBuffer(file.content)
      ? file.content
      : Buffer.from(file.content));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(chunks);
  const req = Readable.from(body);
  req.method = 'POST';
  req.url = '/api/medical/analyze';
  req.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'content-length': String(body.length),
    'x-tenant-id': 'tenant-test'
  };
  req.connection = { remoteAddress: '127.0.0.1' };
  req.params = {};
  req.query = {};
  req.ip = '127.0.0.1';
  req.get = (name) => req.headers[name.toLowerCase()];
  return req;
}

function createResponse() {
  return {
    body: undefined,
    headersSent: false,
    responseCount: 0,
    statusCode: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(payload) {
      this.body = payload;
      this.headersSent = true;
      this.responseCount += 1;
      return this;
    },
    json(payload) {
      return this.send(payload);
    }
  };
}

const validFields = {
  myuuid: '12345678-1234-1234-1234-123456789abc',
  lang: 'en',
  timezone: 'UTC'
};

test.beforeEach(() => {
  state.diagnoseCalls = [];
  state.resolvedAssets = [];
  state.imageUploadCount = 0;
  state.resolveImageAssets = async () => state.resolvedAssets;
  state.diagnose = async (req, res) => res.status(200).send({ result: 'success' });
  state.summarize = async (req, res) => res.status(200).send({
    result: 'success',
    data: { summary: 'Valid summary' }
  });
  state.documentPost = async () => ({ status: '202', body: {} });
  state.registerImageAsset = async (blob, file) => ({
    assetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: file.originalname,
    url: blob.url,
    sasExpiresAt: blob.sasExpiresAt,
    expiresAt: new Date('2026-09-22T14:00:00Z')
  });
});

test('accepts the signatures of every supported file type', () => {
  const ole = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
  const zip = Buffer.from([0x50, 0x4B, 0x03, 0x04]);
  const samples = [
    ['document', 'report.pdf', 'application/pdf', Buffer.from('%PDF-1.7')],
    ['document', 'report.doc', 'application/msword', ole],
    ['document', 'report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.concat([zip, Buffer.from('word/document.xml')])],
    ['document', 'report.xls', 'application/vnd.ms-excel', ole],
    ['document', 'report.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Buffer.concat([zip, Buffer.from('xl/workbook.xml')])],
    ['document', 'report.txt', 'text/plain', Buffer.from('Clinical text')],
    ['image', 'scan.jpg', 'image/jpeg', Buffer.from([0xFF, 0xD8, 0xFF])],
    ['image', 'scan.png', 'image/png', Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])],
    ['image', 'scan.tiff', 'image/tiff', Buffer.from([0x49, 0x49, 0x2A, 0x00])],
    ['image', 'scan.bmp', 'image/bmp', Buffer.from([0x42, 0x4D])],
    ['image', 'scan.webp', 'image/webp', Buffer.from('RIFF0000WEBP', 'ascii')]
  ];

  for (const [field, originalname, mimetype, buffer] of samples) {
    assert.deepEqual(validateUploadedFiles({
      [field]: [{ originalname, mimetype, buffer, size: buffer.length }]
    }), [], originalname);
  }
});

test('validates assetId and image URL request shapes', () => {
  const errors = [];
  validateImageReferenceFields({
    assetIds: ['invalid'],
    imageUrls: [{}]
  }, errors);

  assert.deepEqual(errors, [
    { field: 'assetIds[0]', reason: 'Must be a valid asset UUID' },
    { field: 'imageUrls[0]', reason: 'Must contain an object with a URL' }
  ]);
});

test('reuses an existing image asset without uploading it again', async () => {
  const existingAsset = {
    assetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'scan.png',
    size: 12,
    url: 'https://storage.test/renewed?sig=secret'
  };
  state.resolvedAssets = [existingAsset];
  const req = createMultipartRequest({
    ...validFields,
    assetIds: JSON.stringify([existingAsset.assetId])
  });
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.responseCount, 1);
  assert.equal(state.imageUploadCount, 0);
  assert.deepEqual(res.body.imageUrls, [existingAsset]);
  assert.deepEqual(state.diagnoseCalls[0].assetIds, [existingAsset.assetId]);
});

test('preserves the asset error code so the client can request a re-upload', async () => {
  state.resolveImageAssets = async () => {
    const error = new Error('One or more image assets are invalid, expired, or unavailable');
    error.code = 'INVALID_ASSET_REFERENCE';
    error.httpStatus = 400;
    throw error;
  };
  const req = createMultipartRequest({
    ...validFields,
    assetIds: JSON.stringify(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'])
  });
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.result, 'error');
  assert.equal(res.body.code, 'INVALID_ASSET_REFERENCE');
  assert.equal(state.diagnoseCalls.length, 0);
});

test('returns one 400 response for a Multer file validation error', async () => {
  const req = createMultipartRequest(validFields, [{
    field: 'image',
    name: 'payload.exe',
    type: 'application/octet-stream',
    content: 'not-an-image'
  }]);
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.responseCount, 1);
  assert.match(res.body.error, /Tipo de archivo no soportado/);
  assert.equal(state.diagnoseCalls.length, 0);
});

test('validates required multipart fields after Multer parses them', async () => {
  const req = createMultipartRequest({
    myuuid: 'not-a-uuid',
    lang: 'en',
    timezone: 'UTC',
    text: 'Patient description'
  });
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.responseCount, 1);
  assert.deepEqual(res.body.details, [{
    field: 'myuuid',
    reason: 'A valid UUID is required'
  }]);
  assert.equal(state.diagnoseCalls.length, 0);
});

test('rejects a file whose content does not match its declared type', async () => {
  const req = createMultipartRequest(validFields, [{
    field: 'image',
    name: 'scan.png',
    type: 'image/png',
    content: 'this-is-not-a-png'
  }]);
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.responseCount, 1);
  assert.deepEqual(res.body.details, [{
    field: 'image[0]',
    filename: 'scan.png',
    reason: 'File content does not match its declared type'
  }]);
  assert.equal(state.diagnoseCalls.length, 0);
});

test('rejects binary content disguised as a TXT document', async () => {
  const req = createMultipartRequest(validFields, [{
    field: 'document',
    name: 'report.txt',
    type: 'text/plain',
    content: Buffer.from([0x41, 0x00, 0x42, 0xFF])
  }]);
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.responseCount, 1);
  assert.equal(res.body.details[0].field, 'document[0]');
  assert.equal(state.diagnoseCalls.length, 0);
});

test('rejects files whose combined size exceeds 20 MB', async () => {
  const createJpeg = (size) => {
    const content = Buffer.alloc(size);
    content.set([0xFF, 0xD8, 0xFF]);
    return content;
  };
  const req = createMultipartRequest(validFields, [
    {
      field: 'image',
      name: 'scan-1.jpg',
      type: 'image/jpeg',
      content: createJpeg((10 * 1024 * 1024) + 1)
    },
    {
      field: 'image',
      name: 'scan-2.jpg',
      type: 'image/jpeg',
      content: createJpeg((10 * 1024 * 1024) + 1)
    }
  ]);
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.responseCount, 1);
  assert.equal(res.body.error, 'The combined file size must not exceed 20 MB');
  assert.equal(state.diagnoseCalls.length, 0);
});

test('returns one 400 response when every document fails and there is nothing else to diagnose', async () => {
  state.documentPost = async () => {
    const error = new Error('InvalidContent');
    error.code = 'InvalidContent';
    error.statusCode = 400;
    throw error;
  };
  const req = createMultipartRequest(validFields, [{
    field: 'document',
    name: 'report.pdf',
    type: 'application/pdf',
    content: '%PDF-1.7\nfake-pdf'
  }]);
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.responseCount, 1);
  assert.equal(res.body.error, 'No document could be processed');
  assert.equal(res.body.documents[0].status, 'failed');
  assert.equal(state.diagnoseCalls.length, 0);
});

test('continues to Diagnose when one document fails and another succeeds', async () => {
  state.documentPost = async (payload) => {
    if (payload?.body?.urlSource?.includes('bad.pdf')) {
      const error = new Error('InvalidContent');
      error.code = 'InvalidContent';
      error.statusCode = 400;
      throw error;
    }
    return { status: '202', body: {} };
  };
  const req = createMultipartRequest(validFields, [
    {
      field: 'document',
      name: 'bad.pdf',
      type: 'application/pdf',
      content: '%PDF-1.7\nbad'
    },
    {
      field: 'document',
      name: 'good.pdf',
      type: 'application/pdf',
      content: '%PDF-1.7\ngood'
    }
  ]);
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(state.diagnoseCalls.length, 1);
  assert.match(state.diagnoseCalls[0].description, /good\.pdf/);
  assert.doesNotMatch(state.diagnoseCalls[0].description, /--- Documento 1: bad\.pdf ---/);
  assert.equal(res.body.documents[0].status, 'failed');
  assert.equal(res.body.documents[1].status, 'succeeded');
});

test('continues to Diagnose from patient text when the only document fails', async () => {
  state.documentPost = async () => {
    const error = new Error('InvalidContent');
    error.code = 'InvalidContent';
    error.statusCode = 400;
    throw error;
  };
  const req = createMultipartRequest({
    ...validFields,
    text: 'Patient with fever and a persistent cough'
  }, [{
    field: 'document',
    name: 'report.pdf',
    type: 'application/pdf',
    content: '%PDF-1.7\nfake-pdf'
  }]);
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(state.diagnoseCalls.length, 1);
  assert.match(state.diagnoseCalls[0].description, /Patient with fever/);
  assert.equal(res.body.documents[0].status, 'failed');
});

test('does not continue to Diagnose when summarization returns an error', async () => {
  state.summarize = async (req, res) => res.status(500).send({
    result: 'error',
    message: 'Summarization unavailable'
  });
  const req = createMultipartRequest({
    ...validFields,
    text: 'x'.repeat(1001)
  });
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.responseCount, 1);
  assert.equal(state.diagnoseCalls.length, 0);
});

test('passes valid parsed text to Diagnose and returns processing once', async () => {
  const req = createMultipartRequest({
    ...validFields,
    text: 'Patient with fever and a persistent cough'
  });
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.responseCount, 1);
  assert.equal(res.body.result, 'processing');
  assert.equal(res.body.summarized, false);
  assert.equal(state.diagnoseCalls.length, 1);
  assert.equal(
    state.diagnoseCalls[0].description,
    'Patient with fever and a persistent cough\n\n'
  );
  assert.equal(state.diagnoseCalls[0].model, 'gpt56terra');
});

test('keeps image-only input on the direct vision path to Diagnose', async () => {
  const req = createMultipartRequest(validFields, [{
    field: 'image',
    name: 'scan.png',
    type: 'image/png',
    content: Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0x66, 0x61, 0x6B, 0x65
    ])
  }]);
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.responseCount, 1);
  assert.equal(res.body.isImageOnly, true);
  assert.equal(res.body.summarized, false);
  assert.equal(state.diagnoseCalls.length, 1);
  assert.equal(state.diagnoseCalls[0].imageUrls.length, 1);
  assert.equal(
    state.diagnoseCalls[0].imageUrls[0].assetId,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
  assert.equal(
    state.diagnoseCalls[0].imageUrls[0].url,
    'https://storage.test/blob?sig=secret'
  );
  assert.equal(
    state.diagnoseCalls[0].description,
    'Patient with medical imaging findings that require diagnostic interpretation'
  );
});

test('still diagnoses if the asset registry fails after the blob upload', async () => {
  state.registerImageAsset = async () => {
    throw new Error('Cosmos unavailable');
  };
  const req = createMultipartRequest(validFields, [{
    field: 'image',
    name: 'scan.png',
    type: 'image/png',
    content: Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0x66, 0x61, 0x6B, 0x65
    ])
  }]);
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(state.diagnoseCalls.length, 1);
  assert.equal(state.diagnoseCalls[0].imageUrls[0].url, 'https://storage.test/blob?sig=secret');
  assert.equal(state.diagnoseCalls[0].imageUrls[0].assetId, undefined);
});

test('does not report processing when Diagnose rejects the request', async () => {
  state.diagnose = async (req, res) => res.status(400).send({
    result: 'error',
    message: 'Invalid request'
  });
  const req = createMultipartRequest({
    ...validFields,
    text: 'Patient description'
  });
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.responseCount, 1);
  assert.equal(state.diagnoseCalls.length, 1);
});
