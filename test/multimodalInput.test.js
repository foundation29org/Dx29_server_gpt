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
  insightEvents: [],
  diagnose: async (req, res) => res.status(200).send({ result: 'success' }),
  imageUploads: [],
  imageUploadError: null,
  classifiedImages: [],
  summarize: async (req, res) => res.status(200).send({
    result: 'success',
    data: { summary: 'Valid summary' }
  }),
  imageClassification: {
    classification: 'contains_medical_visual',
    confidence: 0.99,
    hasDocumentText: false,
    hasMedicalVisual: true,
    evidence: []
  },
  imageClassificationError: null,
  documentContent: 'Extracted document content',
  documentPostCalls: 0,
  preprocessingMessages: [],
  pubsubErrors: [],
  teamEmails: [],
  documentPost: async () => ({
    status: '202',
    body: {}
  })
};

stubModule('@azure-rest/ai-document-intelligence', {
  default: () => ({
    path: () => ({
      post: (...args) => {
        state.documentPostCalls += 1;
        return state.documentPost(...args);
      }
    })
  }),
  getLongRunningPoller: () => ({
    pollUntilDone: async () => ({
      body: {
        status: 'succeeded',
        analyzeResult: {
          content: state.documentContent,
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
  translationKey: 'test-key'
});
stubModule('../services/summarizeService', {
  MAX_SUMMARY_INPUT_CHARS: 400000,
  summarize: (...args) => state.summarize(...args)
});
stubModule('../services/blobFiles', {
  uploadImage: async (buffer, options) => {
    if (state.imageUploadError) {
      throw state.imageUploadError;
    }
    state.imageUploads.push({ buffer, options });
    return `${options.owner.tenantId}/${options.uploadId}/${options.index}`;
  },
  listUploadImages: async () => [],
  downloadBlob: async () => Buffer.alloc(0),
  deleteUploadImages: async (owner, uploadId) => {
    state.uploadDeletions.push({ owner, uploadId });
    return state.deletedBlobCount;
  }
});
stubModule('../services/insights', {
  error: () => undefined,
  trackEvent: (name, properties, measurements) =>
    state.insightEvents.push({ name, properties, measurements })
});
stubModule('../services/email', {
  sendMailErrorGPTIP: async (lang, subject, info) => {
    state.teamEmails.push(info);
  }
});
stubModule('../services/costTrackingService', {
  saveCostRecordBestEffort: async () => undefined
});
stubModule('../services/pubsubService', {
  sendProgress: async () => undefined,
  sendPreprocessing: async (userId, data) => {
    state.preprocessingMessages.push({ userId, data });
  },
  sendError: async (userId, error, code) => {
    state.pubsubErrors.push({ userId, message: error?.message, code });
  }
});
stubModule('../services/aiUtils', {
  DEFAULT_AI_MODEL: 'gpt56terra',
  resolveDiagnoseModel: () => 'gpt56terra'
});
stubModule('../services/multimodalImageClassifierService', {
  classifyImage: async (image) => {
    state.classifiedImages.push(image);
    if (state.imageClassificationError) {
      throw state.imageClassificationError;
    }
    return state.imageClassification;
  },
  fallbackClassification: (error) => ({
    classification: 'unknown',
    confidence: 0,
    hasDocumentText: false,
    hasMedicalVisual: false,
    error: error.message
  }),
  isNotMedicalImage: (classification) =>
    classification.classification === 'not_medical' &&
    classification.hasDocumentText === false &&
    classification.hasMedicalVisual === false &&
    classification.confidence >= 0.9,
  shouldExtractDocumentText: (classification) =>
    classification.classification === 'document_only' &&
    classification.hasDocumentText === true &&
    classification.hasMedicalVisual === false &&
    classification.confidence >= 0.9,
  shouldExtractMixedDocumentText: (classification) =>
    classification.classification === 'contains_medical_visual' &&
    classification.hasDocumentText === true &&
    classification.hasMedicalVisual === true &&
    classification.confidence >= 0.9
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

const { deleteUpload, processMultimodalInput } = require('../controllers/all/multimodalInput');
const {
  MAX_FIELD_SIZE_BYTES,
  MAX_MULTIPART_PARTS,
  MAX_NON_FILE_FIELDS,
  validateUploadedFiles
} = require('../services/multimodalInputValidation');

const PNG = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0x66, 0x61, 0x6B, 0x65
]);
const UPLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

function createDeleteRequest({ uploadId, body = {}, query = {}, headers = {} } = {}) {
  const req = {
    method: 'DELETE',
    url: `/api/medical/upload/${uploadId}`,
    headers: { 'x-tenant-id': 'tenant-test', ...headers },
    body,
    query,
    params: { uploadId },
    connection: { remoteAddress: '127.0.0.1' }
  };
  req.get = (name) => req.headers[name.toLowerCase()];
  return req;
}

function createResponse() {
  return {
    body: undefined,
    headersSent: false,
    responseCount: 0,
    statusCode: undefined,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
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

// /medical/analyze responde "processing" nada más validar el multipart. El
// resultado del preprocesado y cualquier error posterior van por Web PubSub.
function published() {
  return state.preprocessingMessages.at(-1)?.data;
}

function assertFailedOverSocket(res) {
  assert.equal(res.statusCode, 200);
  assert.equal(res.responseCount, 1);
  assert.equal(res.body.result, 'processing');
  assert.equal(state.preprocessingMessages.length, 0);
  assert.equal(state.pubsubErrors.length, 1);
  assert.equal(state.pubsubErrors[0].userId, validFields.myuuid);
}

const validFields = {
  myuuid: '12345678-1234-1234-1234-123456789abc',
  lang: 'en',
  timezone: 'UTC'
};

test.beforeEach(() => {
  state.diagnoseCalls = [];
  state.insightEvents = [];
  state.imageUploads = [];
  state.imageUploadError = null;
  state.uploadDeletions = [];
  state.deletedBlobCount = 2;
  state.classifiedImages = [];
  state.imageClassification = {
    classification: 'contains_medical_visual',
    confidence: 0.99,
    hasDocumentText: false,
    hasMedicalVisual: true,
    evidence: []
  };
  state.imageClassificationError = null;
  state.documentContent = 'Extracted document content';
  state.documentPostCalls = 0;
  state.diagnose = async (req, res) => res.status(200).send({ result: 'success' });
  state.summarize = async (req, res) => res.status(200).send({
    result: 'success',
    data: { summary: 'Valid summary' }
  });
  state.documentPost = async () => ({ status: '202', body: {} });
  state.preprocessingMessages = [];
  state.pubsubErrors = [];
  state.teamEmails = [];
});

test('accepts the signatures of every supported file type', () => {
  const ole = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
  const zip = Buffer.from([0x50, 0x4B, 0x03, 0x04]);
  const samples = [
    ['document', 'report.pdf', 'application/pdf', Buffer.from('%PDF-1.7')],
    ['document', 'report.doc', 'application/msword', ole],
    ['document', 'report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.concat([zip, Buffer.from('word/document.xml')])],
    ['document', 'report.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Buffer.concat([zip, Buffer.from('xl/workbook.xml')])],
    ['document', 'report.txt', 'text/plain', Buffer.from('Clinical text')],
    ['image', 'scan.jpg', 'image/jpeg', Buffer.from([0xFF, 0xD8, 0xFF])],
    ['image', 'scan.png', 'image/png', Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])],
    ['image', 'scan.webp', 'image/webp', Buffer.from('RIFF0000WEBP', 'ascii')]
  ];

  for (const [field, originalname, mimetype, buffer] of samples) {
    assert.deepEqual(validateUploadedFiles({
      [field]: [{ originalname, mimetype, buffer, size: buffer.length }]
    }), [], originalname);
  }
});

test('rejects a multipart body with more fields than the configured limit', async () => {
  const fields = { ...validFields, text: 'Patient description' };
  const extraFields = MAX_NON_FILE_FIELDS - Object.keys(fields).length + 1;
  for (let index = 0; index < extraFields; index += 1) {
    fields[`extra${index}`] = 'x';
  }
  const req = createMultipartRequest(fields);
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'LIMIT_FIELD_COUNT');
  assert.equal(state.diagnoseCalls.length, 0);
});

test('rejects a text field that reaches the 1 MB field size', async () => {
  const req = createMultipartRequest({
    ...validFields,
    text: 'x'.repeat(MAX_FIELD_SIZE_BYTES)
  });
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'LIMIT_FIELD_VALUE');
  assert.equal(state.diagnoseCalls.length, 0);
});

test('accepts a text field one byte under the 1 MB field size', async () => {
  const req = createMultipartRequest({
    ...validFields,
    text: 'x'.repeat(MAX_FIELD_SIZE_BYTES - 1)
  });
  const res = createResponse();

  await processMultimodalInput(req, res);

  // Pasa Multer (el tope de resumen es otro límite, más pequeño).
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result, 'processing');
  assert.equal(state.pubsubErrors[0].code, 'INPUT_TOO_LARGE');
});

test('rejects a multipart body that reaches the part limit', async () => {
  const files = Array.from({ length: MAX_MULTIPART_PARTS }, () => ({
    field: 'ignored',
    name: '',
    type: 'application/octet-stream',
    content: 'x'
  }));
  const req = createMultipartRequest({}, files);
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'LIMIT_PART_COUNT');
  assert.equal(state.diagnoseCalls.length, 0);
});

test('rejects legacy Excel: Document Intelligence cannot read it', () => {
  const ole = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
  const errors = validateUploadedFiles({
    document: [{
      originalname: 'report.xls',
      mimetype: 'application/vnd.ms-excel',
      buffer: ole,
      size: ole.length
    }]
  });
  assert.equal(errors.length, 1);
});

test('rejects TIFF and BMP before they can reach the vision model', () => {
  const samples = [
    ['scan.tiff', 'image/tiff', Buffer.from([0x49, 0x49, 0x2A, 0x00])],
    ['scan.bmp', 'image/bmp', Buffer.from([0x42, 0x4D])]
  ];

  for (const [originalname, mimetype, buffer] of samples) {
    const errors = validateUploadedFiles({
      image: [{ originalname, mimetype, buffer, size: buffer.length }]
    });
    assert.equal(errors.length, 1, originalname);
    assert.equal(errors[0].reason, 'File type is not allowed in the image field');
  }
});

test('rejects every image reference on analyze: each analysis is a new upload', async () => {
  const req = createMultipartRequest({
    ...validFields,
    text: 'Patient description',
    uploadId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    assetIds: JSON.stringify(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']),
    imageUrls: JSON.stringify([{ url: 'https://storage.test/blob?sig=secret' }])
  });
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body.details.map((detail) => detail.field), [
    'uploadId',
    'assetIds',
    'imageUrls'
  ]);
  assert.equal(state.diagnoseCalls.length, 0);
  const rejected = state.insightEvents.find(
    (event) => event.name === 'MultimodalInputRejected'
  );
  assert.match(rejected.properties.validationFields, /uploadId/);
});

test('returns and tracks a safe correlation ID without request content', async () => {
  const req = createMultipartRequest({
    ...validFields,
    text: 'Sensitive clinical description'
  });
  req.headers['x-correlation-id'] = 'support-case-123';
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-correlation-id'], 'support-case-123');
  assert.equal(res.body.correlationId, 'support-case-123');
  const completed = state.insightEvents.find(
    (event) => event.name === 'MultimodalAnalysisCompleted'
  );
  assert.equal(completed.properties.correlationId, 'support-case-123');
  assert.doesNotMatch(
    JSON.stringify(completed.properties),
    /Sensitive clinical description|sig=/
  );
});

test('never returns a storage URL or SAS to the client', async () => {
  const req = createMultipartRequest(validFields, [{
    field: 'image',
    name: 'scan.png',
    type: 'image/png',
    content: PNG
  }]);
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 200);
  assert.match(published().uploadId, UPLOAD_ID_PATTERN);
  assert.deepEqual(published().images, [{
    uploadId: published().uploadId,
    index: 0,
    name: 'scan.png',
    size: PNG.length,
    mimeType: 'image/png',
    routing: 'vision',
    diagnosticUse: true
  }]);
  assert.equal(published().imageUrls, undefined);
  assert.doesNotMatch(JSON.stringify(published()), /https?:|sig=|blob\.core/);
});

test('classifies the image inline and stores its route in the same blob write', async () => {
  state.imageClassification = {
    classification: 'contains_medical_visual',
    confidence: 0.97,
    hasDocumentText: false,
    hasMedicalVisual: true,
    evidence: ['skin lesion']
  };
  const req = createMultipartRequest(validFields, [{
    field: 'image',
    name: 'lesion.png',
    type: 'image/png',
    content: PNG
  }]);
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(state.classifiedImages.length, 1);
  assert.match(state.classifiedImages[0].url, /^data:image\/png;base64,/);
  assert.equal(state.imageUploads.length, 1);
  assert.equal(state.imageUploads[0].options.uploadId, published().uploadId);
  assert.equal(state.imageUploads[0].options.owner.tenantId, 'tenant-test');
  assert.equal(state.imageUploads[0].options.owner.myuuid, validFields.myuuid);
  assert.equal(state.imageUploads[0].options.metadata.routing, 'vision');
  assert.equal(state.imageUploads[0].options.metadata.classification, 'contains_medical_visual');
  assert.equal(published().images[0].diagnosticUse, true);
});

test('does not store document-only images: their text already lives in the description', async () => {
  state.imageClassification = {
    classification: 'document_only',
    confidence: 0.98,
    hasDocumentText: true,
    hasMedicalVisual: false,
    evidence: ['lab table']
  };
  state.documentContent = 'Hemoglobin 8.2 g/dL with microcytosis';
  const req = createMultipartRequest(validFields, [{
    field: 'image',
    name: 'lab-report.png',
    type: 'image/png',
    content: PNG
  }]);
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(state.imageUploads.length, 0);
  assert.equal(published().uploadId, null);
  assert.deepEqual(published().images, [{
    uploadId: null,
    index: null,
    name: 'lab-report.png',
    size: PNG.length,
    mimeType: 'image/png',
    routing: 'ocr_text',
    diagnosticUse: false
  }]);
  assert.match(state.diagnoseCalls[0].description, /Hemoglobin 8\.2 g\/dL/);
});

test('sends document images to Document Intelligence as bytes, not as a URL', async () => {
  let payload;
  state.documentPost = async (body) => {
    payload = body;
    return { status: '202', body: {} };
  };
  state.imageClassification = {
    classification: 'document_only',
    confidence: 0.98,
    hasDocumentText: true,
    hasMedicalVisual: false,
    evidence: ['lab table']
  };
  const req = createMultipartRequest(validFields, [{
    field: 'image',
    name: 'lab-report.png',
    type: 'image/png',
    content: PNG
  }]);
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(payload.body.urlSource, undefined);
  assert.deepEqual(Buffer.from(payload.body.base64Source, 'base64'), PNG);
});

test('fails the whole request when an image cannot be stored', async () => {
  state.imageUploadError = new Error('Storage unavailable');
  const req = createMultipartRequest(validFields, [{
    field: 'image',
    name: 'scan.png',
    type: 'image/png',
    content: PNG
  }]);
  const res = createResponse();

  await processMultimodalInput(req, res);

  assertFailedOverSocket(res);
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
  assert.ok(state.insightEvents.some(
    (event) => event.name === 'MultimodalInputRejected'
  ));
  assert.equal(state.insightEvents.some(
    (event) => event.name === 'MultimodalAnalysisFailed'
  ), false);
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
  assert.ok(state.insightEvents.some(
    (event) => event.name === 'MultimodalInputRejected'
  ));
});

test('tracks missing tenant and subscription headers as an input rejection', async () => {
  const req = createMultipartRequest({
    ...validFields,
    text: 'Patient description'
  });
  delete req.headers['x-tenant-id'];
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 400);
  const rejected = state.insightEvents.find(
    (event) => event.name === 'MultimodalInputRejected'
  );
  assert.equal(rejected.properties.phase, 'headers');
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

test('accepts TXT in ANSI and UTF-16 but not binary without NUL bytes', () => {
  const text = 'Niño de 8 años con fiebre';
  const validate = (buffer) => validateUploadedFiles({
    document: [{ originalname: 'notes.txt', mimetype: 'text/plain', buffer, size: buffer.length }]
  });

  assert.deepEqual(validate(Buffer.from(text, 'latin1')), []);
  assert.deepEqual(validate(Buffer.concat([
    Buffer.from([0xFF, 0xFE]),
    Buffer.from(text, 'utf16le')
  ])), []);

  const binary = Buffer.from(Array.from({ length: 64 }, (_, index) => 0x81 + (index % 16)));
  assert.equal(validate(binary).length, 1);
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

test('sends one socket error when every document fails and there is nothing else to diagnose', async () => {
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

  assertFailedOverSocket(res);
  assert.equal(state.pubsubErrors[0].code, 'NO_DOCUMENT');
  assert.equal(state.pubsubErrors[0].message, 'No document could be processed');
  assert.equal(state.diagnoseCalls.length, 0);
});

test('tracks every legacy .doc so its usage can be measured', async () => {
  const previousUrl = process.env.GOTENBERG_URL;
  delete process.env.GOTENBERG_URL;
  try {
    const req = createMultipartRequest(validFields, [{
      field: 'document',
      name: 'informe.doc',
      type: 'application/msword',
      content: Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0x00])
    }]);
    const res = createResponse();

    await processMultimodalInput(req, res);

    const events = state.insightEvents.filter(
      (event) => event.name === 'LegacyWordDocumentProcessed'
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].properties.status, 'failed');
    assert.equal(events[0].properties.errorCode, 'LEGACY_DOC_CONVERSION_UNAVAILABLE');
    assert.equal(state.documentPostCalls, 0);
    assert.equal(state.pubsubErrors[0].code, 'NO_DOCUMENT');
  } finally {
    if (previousUrl !== undefined) {
      process.env.GOTENBERG_URL = previousUrl;
    }
  }
});

test('continues to Diagnose when one document fails and another succeeds', async () => {
  state.documentPost = async (payload) => {
    const content = Buffer.from(payload?.body?.base64Source || '', 'base64').toString();
    if (content.includes('bad')) {
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
  assert.equal(published().documents[0].status, 'failed');
  assert.equal(published().documents[1].status, 'succeeded');
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
  assert.equal(published().documents[0].status, 'failed');
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

  assertFailedOverSocket(res);
  assert.equal(state.diagnoseCalls.length, 0);
  assert.equal(state.teamEmails.length, 1);
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
  assert.equal(published().result, 'processing');
  assert.equal(published().summarized, false);
  assert.equal(state.diagnoseCalls.length, 1);
  assert.equal(
    state.diagnoseCalls[0].description,
    'Patient with fever and a persistent cough'
  );
  assert.equal(state.diagnoseCalls[0].model, 'gpt56terra');
});

test('passes iframeParams sent as a multipart JSON string to Diagnose as an object', async () => {
  const req = createMultipartRequest({
    ...validFields,
    text: 'Patient with fever and a persistent cough',
    iframeParams: JSON.stringify({ centro: 'H1', ambito: 'urgencias' })
  });

  await processMultimodalInput(req, createResponse());

  assert.deepEqual(state.diagnoseCalls[0].iframeParams, { centro: 'H1', ambito: 'urgencias' });
});

test('rejects iframeParams that are not a JSON object before any processing', async () => {
  for (const iframeParams of ['{not json', '["centro"]', '42']) {
    const res = createResponse();
    await processMultimodalInput(createMultipartRequest({
      ...validFields,
      text: 'Patient with fever and a persistent cough',
      iframeParams
    }), res);

    assert.equal(res.statusCode, 400, iframeParams);
    assert.deepEqual(res.body.details, [{ field: 'iframeParams', reason: 'Must be a JSON object' }]);
  }
  assert.equal(state.diagnoseCalls.length, 0);
});

test('tells the client when Diagnose queued the request: the result will not arrive over the socket', async () => {
  const queueInfo = { ticketId: validFields.myuuid, position: 3, estimatedWaitTime: 2 };
  state.diagnose = async (req, res) => res.status(200).send({ result: 'queued', queueInfo });

  await processMultimodalInput(createMultipartRequest({
    ...validFields,
    text: 'Patient with fever and a persistent cough'
  }), createResponse());

  assert.equal(published().isQueued, true);
  assert.deepEqual(published().queueInfo, queueInfo);
});

test('does not mark a normal request as queued', async () => {
  await processMultimodalInput(createMultipartRequest({
    ...validFields,
    text: 'Patient with fever and a persistent cough'
  }), createResponse());

  assert.equal(published().isQueued, undefined);
  assert.equal(published().queueInfo, undefined);
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
  assert.equal(published().isImageOnly, true);
  assert.equal(published().summarized, false);
  assert.equal(state.diagnoseCalls.length, 1);
  assert.equal(state.documentPostCalls, 0);
  assert.equal(state.diagnoseCalls[0].uploadId, published().uploadId);
  assert.equal(state.diagnoseCalls[0].imageUrls, undefined);
  assert.equal(state.diagnoseCalls[0].assetIds, undefined);
  assert.equal(published().images[0].url, undefined);
  // El analyze no inventa texto: Diagnose recibe la descripción vacía.
  assert.equal(state.diagnoseCalls[0].description, '');
  assert.equal(published().description, '');
});

test('converts a high-confidence document-only image to text without sending it to Terra', async () => {
  state.imageClassification = {
    classification: 'document_only',
    confidence: 0.98,
    hasDocumentText: true,
    hasMedicalVisual: false,
    evidence: ['clinical report']
  };
  state.documentContent = 'Potassium 6.1 mmol/L on 2026-06-21';
  const req = createMultipartRequest(validFields, [{
    field: 'image',
    name: 'lab-report.png',
    type: 'image/png',
    content: Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0x66, 0x61, 0x6B, 0x65
    ])
  }]);
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(published().images.length, 1);
  assert.equal(published().imageRouting[0].route, 'ocr_text');
  assert.equal(published().isImageOnly, false);
  assert.equal(state.documentPostCalls, 1);
  // Sin imágenes para visión no hay subida ni referencia para Diagnose.
  assert.equal(state.imageUploads.length, 0);
  assert.equal(state.diagnoseCalls[0].uploadId, undefined);
  assert.match(state.diagnoseCalls[0].description, /Potassium 6\.1 mmol\/L/);
});

const NOT_MEDICAL = {
  classification: 'not_medical',
  confidence: 0.97,
  hasDocumentText: false,
  hasMedicalVisual: false,
  evidence: ['company logo']
};
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0x66, 0x61, 0x6B, 0x65
]);

test('stops before Diagnose when the only upload is a non-medical image', async () => {
  state.imageClassification = NOT_MEDICAL;
  const res = createResponse();

  await processMultimodalInput(createMultipartRequest(validFields, [{
    field: 'image', name: 'logo.png', type: 'image/png', content: PNG_BYTES
  }]), res);

  assertFailedOverSocket(res);
  assert.equal(state.pubsubErrors[0].code, 'NO_MEDICAL_IMAGE');
  assert.equal(state.diagnoseCalls.length, 0);
  assert.equal(state.imageUploads.length, 0);
  assert.equal(state.documentPostCalls, 0);
  const failed = state.insightEvents.find((event) => event.name === 'MultimodalAnalysisFailed');
  assert.equal(failed.properties.phase, 'classify_images');
  assert.equal(failed.measurements.notMedicalImages, 1);
});

test('diagnoses from the text and drops a non-medical image uploaded with it', async () => {
  state.imageClassification = NOT_MEDICAL;

  await processMultimodalInput(createMultipartRequest({
    ...validFields,
    text: 'Patient with fever and a persistent cough'
  }, [{
    field: 'image', name: 'logo.png', type: 'image/png', content: PNG_BYTES
  }]), createResponse());

  assert.equal(state.diagnoseCalls.length, 1);
  assert.equal(state.diagnoseCalls[0].uploadId, undefined);
  assert.equal(state.imageUploads.length, 0);
  assert.equal(published().uploadId, null);
  assert.equal(published().imageRouting[0].route, 'not_medical');
  assert.equal(published().images[0].diagnosticUse, false);
});

test('keeps a low-confidence non-medical image on direct vision', async () => {
  state.imageClassification = { ...NOT_MEDICAL, confidence: 0.6 };

  await processMultimodalInput(createMultipartRequest(validFields, [{
    field: 'image', name: 'photo.png', type: 'image/png', content: PNG_BYTES
  }]), createResponse());

  assert.equal(state.diagnoseCalls.length, 1);
  assert.equal(published().imageRouting[0].route, 'vision');
  assert.equal(state.imageUploads.length, 1);
});

test('adds OCR text while keeping a mixed medical image on direct vision', async () => {
  state.imageClassification = {
    classification: 'contains_medical_visual',
    confidence: 0.99,
    hasDocumentText: true,
    hasMedicalVisual: true,
    evidence: ['radiograph with report text']
  };
  state.documentContent = 'D-dimer 3.2 mg/L FEU with a segmental filling defect';
  const req = createMultipartRequest({
    ...validFields,
    text: 'Patient with shortness of breath'
  }, [{
    field: 'image',
    name: 'mixed-report.png',
    type: 'image/png',
    content: Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0x66, 0x61, 0x6B, 0x65
    ])
  }]);
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(published().imageRouting[0].route, 'vision');
  assert.equal(published().imageRouting[0].ocrTextUsed, true);
  assert.equal(state.documentPostCalls, 1);
  assert.match(state.diagnoseCalls[0].uploadId, UPLOAD_ID_PATTERN);
  assert.match(
    state.diagnoseCalls[0].description,
    /Patient with shortness of breath/
  );
  assert.match(
    state.diagnoseCalls[0].description,
    /D-dimer 3\.2 mg\/L FEU/
  );
});

test('falls back to direct vision when image classification fails', async () => {
  state.imageClassificationError = new Error('Classifier unavailable');
  const req = createMultipartRequest(validFields, [{
    field: 'image',
    name: 'unknown.png',
    type: 'image/png',
    content: Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0x66, 0x61, 0x6B, 0x65
    ])
  }]);
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(published().imageRouting[0].classification, 'unknown');
  assert.equal(published().imageRouting[0].route, 'vision');
  assert.equal(
    published().imageRouting[0].fallbackReason,
    'classification_failed'
  );
  assert.match(state.diagnoseCalls[0].uploadId, UPLOAD_ID_PATTERN);
});

test('falls back to direct vision when OCR of a document image fails', async () => {
  state.imageClassification = {
    classification: 'document_only',
    confidence: 0.98,
    hasDocumentText: true,
    hasMedicalVisual: false,
    evidence: ['clinical report']
  };
  state.documentPost = async () => {
    const error = new Error('InvalidContent');
    error.code = 'InvalidContent';
    error.statusCode = 400;
    throw error;
  };
  const req = createMultipartRequest(validFields, [{
    field: 'image',
    name: 'corrupt-report.png',
    type: 'image/png',
    content: Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0x66, 0x61, 0x6B, 0x65
    ])
  }]);
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(published().imageRouting[0].route, 'vision');
  assert.equal(published().imageRouting[0].fallbackReason, 'ocr_failed');
  assert.match(state.diagnoseCalls[0].uploadId, UPLOAD_ID_PATTERN);
});

test('keeps a mixed image on vision when its additive OCR fails', async () => {
  state.imageClassification = {
    classification: 'contains_medical_visual',
    confidence: 0.99,
    hasDocumentText: true,
    hasMedicalVisual: true,
    evidence: ['medical image and report text']
  };
  state.documentPost = async () => {
    const error = new Error('InvalidContent');
    error.code = 'InvalidContent';
    error.statusCode = 400;
    throw error;
  };
  const req = createMultipartRequest(validFields, [{
    field: 'image',
    name: 'mixed-report.png',
    type: 'image/png',
    content: Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0x66, 0x61, 0x6B, 0x65
    ])
  }]);
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(published().imageRouting[0].route, 'vision');
  assert.equal(published().imageRouting[0].ocrTextUsed, false);
  assert.equal(published().imageRouting[0].fallbackReason, 'ocr_failed');
  assert.match(state.diagnoseCalls[0].uploadId, UPLOAD_ID_PATTERN);
});

test('keeps a mixed image on vision when its OCR text is too short', async () => {
  state.imageClassification = {
    classification: 'contains_medical_visual',
    confidence: 0.99,
    hasDocumentText: true,
    hasMedicalVisual: true,
    evidence: ['medical image and a small report panel']
  };
  state.documentContent = 'short';
  const req = createMultipartRequest(validFields, [{
    field: 'image',
    name: 'mixed-short-text.png',
    type: 'image/png',
    content: Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0x66, 0x61, 0x6B, 0x65
    ])
  }]);
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(published().imageRouting[0].route, 'vision');
  assert.equal(published().imageRouting[0].ocrTextUsed, false);
  assert.equal(
    published().imageRouting[0].fallbackReason,
    'ocr_text_too_short'
  );
  assert.match(state.diagnoseCalls[0].uploadId, UPLOAD_ID_PATTERN);
  assert.doesNotMatch(state.diagnoseCalls[0].description, /short/);
});

test('summarizes the combined patient text and document-image OCR over 1000 characters', async () => {
  state.imageClassification = {
    classification: 'document_only',
    confidence: 0.98,
    hasDocumentText: true,
    hasMedicalVisual: false,
    evidence: ['clinical report']
  };
  state.documentContent = 'Laboratory findings '.repeat(10);
  let summarizedInput = '';
  state.summarize = async (req, res) => {
    summarizedInput = req.body.description;
    return res.status(200).send({
      result: 'success',
      data: { summary: 'Combined clinical summary' }
    });
  };
  const req = createMultipartRequest({
    ...validFields,
    text: 'x'.repeat(950)
  }, [{
    field: 'image',
    name: 'report.png',
    type: 'image/png',
    content: Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0x66, 0x61, 0x6B, 0x65
    ])
  }]);
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(published().summarized, true);
  assert.match(summarizedInput, /^x{100}/);
  assert.match(summarizedInput, /Laboratory findings/);
  assert.equal(
    state.diagnoseCalls[0].description,
    'Combined clinical summary'
  );
  assert.equal(state.diagnoseCalls[0].uploadId, undefined);
});

test('summarizes mixed-image OCR while retaining the original image', async () => {
  state.imageClassification = {
    classification: 'contains_medical_visual',
    confidence: 0.99,
    hasDocumentText: true,
    hasMedicalVisual: true,
    evidence: ['medical image and report text']
  };
  state.documentContent = 'Mixed image report findings '.repeat(10);
  let summarizedInput = '';
  state.summarize = async (req, res) => {
    summarizedInput = req.body.description;
    return res.status(200).send({
      result: 'success',
      data: { summary: 'Combined mixed-image summary' }
    });
  };
  const req = createMultipartRequest({
    ...validFields,
    text: 'x'.repeat(950)
  }, [{
    field: 'image',
    name: 'mixed-report.png',
    type: 'image/png',
    content: Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0x66, 0x61, 0x6B, 0x65
    ])
  }]);
  const res = createResponse();

  await processMultimodalInput(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(published().summarized, true);
  assert.match(summarizedInput, /Mixed image report findings/);
  assert.match(
    state.diagnoseCalls[0].description,
    /Combined mixed-image summary/
  );
  assert.match(state.diagnoseCalls[0].uploadId, UPLOAD_ID_PATTERN);
});

function rejectDiagnoseWith(details) {
  state.diagnose = async (req, res) => res.status(400).send({
    result: 'error',
    message: 'Invalid request format',
    details
  });
}

async function analyzeText(text) {
  const res = createResponse();
  await processMultimodalInput(createMultipartRequest({ ...validFields, text }), res);
  return res;
}

test('reports a short description from Diagnose without emailing the team', async () => {
  rejectDiagnoseWith([{ field: 'description', reason: 'Must be at least 10 characters' }]);

  const res = await analyzeText('Patient description');

  assertFailedOverSocket(res);
  assert.equal(state.diagnoseCalls.length, 1);
  assert.equal(state.pubsubErrors[0].code, 'DESCRIPTION_TOO_SHORT');
  assert.equal(state.teamEmails.length, 0);
});

test('reports suspicious content from Diagnose without emailing the team', async () => {
  rejectDiagnoseWith([{ field: 'description', reason: 'Contains suspicious content: Contains script tags' }]);

  const res = await analyzeText('Patient description');

  assertFailedOverSocket(res);
  assert.equal(state.pubsubErrors[0].code, 'INVALID_DIAGNOSE_INPUT');
  assert.equal(state.teamEmails.length, 0);
});

test('emails the team when our summary exceeds the Diagnose limit', async () => {
  rejectDiagnoseWith([{ field: 'description', reason: 'Must not exceed 8000 characters' }]);

  const res = await analyzeText('Patient description');

  assertFailedOverSocket(res);
  assert.equal(state.pubsubErrors[0].code, 'SUMMARY_TOO_LONG');
  assert.equal(state.teamEmails.length, 1);
  assert.equal(state.teamEmails[0].code, 'SUMMARY_TOO_LONG');
});

test('rejects input above the summarize limit, emails the team and skips the AI calls', async () => {
  let summarizeCalls = 0;
  state.summarize = async (req, res) => {
    summarizeCalls += 1;
    return res.status(200).send({ result: 'success', data: { summary: 'Valid summary' } });
  };

  const res = await analyzeText('x'.repeat(400001));

  assertFailedOverSocket(res);
  assert.equal(summarizeCalls, 0);
  assert.equal(state.diagnoseCalls.length, 0);
  assert.equal(state.pubsubErrors[0].code, 'INPUT_TOO_LARGE');
  assert.equal(state.teamEmails.length, 1);
  assert.equal(state.teamEmails[0].inputChars, 400001);
  assert.equal(JSON.stringify(state.teamEmails[0]).includes('xxxxxxxxxx'), false);
});

test('reports summarize validation errors without emailing the team', async () => {
  state.summarize = async (req, res) => res.status(400).send({
    result: 'error',
    message: 'Invalid request format or content'
  });

  const res = await analyzeText('x'.repeat(1001));

  assertFailedOverSocket(res);
  assert.equal(state.diagnoseCalls.length, 0);
  assert.equal(state.pubsubErrors[0].code, 'SUMMARY_INPUT_REJECTED');
  assert.equal(state.teamEmails.length, 0);
});

const DELETE_UPLOAD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('DELETE /medical/upload scopes the deletion to tenant + myuuid + uploadId', async () => {
  const req = createDeleteRequest({
    uploadId: DELETE_UPLOAD_ID,
    body: { myuuid: validFields.myuuid }
  });
  const res = createResponse();

  await deleteUpload(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result, 'success');
  assert.equal(res.body.deleted, 2);
  assert.equal(state.uploadDeletions.length, 1);
  assert.equal(state.uploadDeletions[0].uploadId, DELETE_UPLOAD_ID);
  assert.equal(state.uploadDeletions[0].owner.tenantId, 'tenant-test');
  assert.equal(state.uploadDeletions[0].owner.myuuid, validFields.myuuid);
  assert.equal(state.insightEvents.at(-1).name, 'MultimodalUploadDeleted');
});

test('DELETE /medical/upload accepts myuuid in the query when the body is dropped', async () => {
  const req = createDeleteRequest({
    uploadId: DELETE_UPLOAD_ID,
    body: undefined,
    query: { myuuid: validFields.myuuid }
  });
  const res = createResponse();

  await deleteUpload(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(state.uploadDeletions[0].owner.myuuid, validFields.myuuid);
});

test('DELETE /medical/upload is idempotent: an expired or foreign upload deletes nothing', async () => {
  state.deletedBlobCount = 0;
  const req = createDeleteRequest({
    uploadId: DELETE_UPLOAD_ID,
    body: { myuuid: validFields.myuuid }
  });
  const res = createResponse();

  await deleteUpload(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deleted, 0);
});

test('DELETE /medical/upload rejects requests without myuuid or with a malformed id', async () => {
  for (const [label, request] of [
    ['missing myuuid', createDeleteRequest({ uploadId: DELETE_UPLOAD_ID })],
    ['bad myuuid', createDeleteRequest({ uploadId: DELETE_UPLOAD_ID, body: { myuuid: 'nope' } })],
    ['bad uploadId', createDeleteRequest({ uploadId: '../other', body: { myuuid: validFields.myuuid } })]
  ]) {
    const res = createResponse();
    await deleteUpload(request, res);
    assert.equal(res.statusCode, 400, label);
    assert.equal(state.uploadDeletions.length, 0, label);
  }
});

test('DELETE /medical/upload requires an authenticated tenant or subscription', async () => {
  const req = createDeleteRequest({
    uploadId: DELETE_UPLOAD_ID,
    body: { myuuid: validFields.myuuid },
    headers: { 'x-tenant-id': undefined }
  });
  delete req.headers['x-tenant-id'];
  const res = createResponse();

  await deleteUpload(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(state.uploadDeletions.length, 0);
});
