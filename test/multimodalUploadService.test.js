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
  listed: [],
  listCalls: [],
  uploads: [],
  downloads: []
};

stubModule('../services/blobFiles', {
  listUploadImages: async (owner, uploadId) => {
    state.listCalls.push({ owner, uploadId });
    return state.listed;
  },
  uploadImage: async (buffer, options) => {
    state.uploads.push({ buffer, options });
    return `${options.owner.tenantId}/${options.uploadId}/${options.index}`;
  },
  downloadBlob: async (blobName, owner, uploadId) => {
    state.downloads.push({ blobName, owner, uploadId });
    return Buffer.from(`bytes-of-${blobName}`);
  }
});

const {
  decodeImageMetadata,
  encodeImageMetadata,
  listUploadImages,
  loadImageDataUrls,
  resolveDiagnosticImages,
  storeClassifiedImage,
  validateUploadReferenceFields
} = require('../services/multimodalUploadService');

const UPLOAD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const owner = {
  myuuid: '12345678-1234-1234-1234-123456789abc',
  tenantId: 'tenant-test'
};

function listedBlob(name, routing, extra = {}) {
  return {
    blobName: `tenants/tenant-test/files/uploads/${owner.myuuid}/${UPLOAD_ID}/${name}`,
    size: 12,
    mimeType: 'image/png',
    metadata: encodeImageMetadata({
      originalName: extra.originalName || name,
      routing,
      classification: extra.classification
    })
  };
}

test.beforeEach(() => {
  state.listed = [];
  state.listCalls = [];
  state.uploads = [];
  state.downloads = [];
});

test('validates the uploadId shape and rejects retired reference fields', () => {
  const errors = [];
  validateUploadReferenceFields({
    uploadId: 'not-a-uuid',
    assetIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    imageUrls: [{ url: 'https://storage.test/blob?sig=secret' }]
  }, errors);

  assert.deepEqual(errors, [
    { field: 'uploadId', reason: 'Must be a valid upload UUID' },
    { field: 'assetIds', reason: 'No longer supported: upload the image and send its uploadId' },
    { field: 'imageUrls', reason: 'No longer supported: upload the image and send its uploadId' }
  ]);
});

test('accepts a valid uploadId and empty legacy arrays', () => {
  const errors = [];
  validateUploadReferenceFields({ uploadId: UPLOAD_ID, assetIds: [], imageUrls: [] }, errors);
  assert.deepEqual(errors, []);
});

test('stores the routing decision without the original filename', () => {
  const classification = {
    classification: 'document_only',
    confidence: 0.98,
    hasDocumentText: true,
    hasMedicalVisual: false
  };
  const metadata = encodeImageMetadata({
    originalName: 'Captura de pantalla · análisis.png',
    routing: 'ocr_text',
    classification
  });

  for (const value of Object.values(metadata)) {
    assert.match(value, /^[\x20-\x7E]*$/, `metadata value must be ASCII: ${value}`);
  }
  assert.equal(metadata.originalname, undefined);
  const decoded = decodeImageMetadata(metadata);
  assert.equal(decoded.originalName, '');
  assert.equal(decoded.routing, 'ocr_text');
  assert.equal(decoded.classification.classification, 'document_only');
  assert.equal(decoded.classification.confidence, 0.98);
  assert.equal(decoded.classification.hasDocumentText, true);
  assert.equal(decoded.classification.hasMedicalVisual, false);
});

test('still reads a filename left by an older upload', () => {
  const decoded = decodeImageMetadata({
    originalname: encodeURIComponent('Captura de pantalla · análisis.png'),
    routing: 'vision'
  });
  assert.equal(decoded.originalName, 'Captura de pantalla · análisis.png');
});

test('unknown or missing metadata falls open to vision', () => {
  const decoded = decodeImageMetadata({});
  assert.equal(decoded.routing, 'vision');
  assert.equal(decoded.classification.classification, 'unknown');
});

test('lists an upload only inside the authenticated owner prefix', async () => {
  state.listed = [listedBlob('00.png', 'vision'), listedBlob('01.png', 'ocr_text')];

  const images = await listUploadImages(UPLOAD_ID, owner);

  assert.deepEqual(state.listCalls, [{
    owner: { myuuid: owner.myuuid, tenantId: 'tenant-test', subscriptionId: null },
    uploadId: UPLOAD_ID
  }]);
  assert.equal(images.length, 2);
  assert.equal(images[0].diagnosticUse, true);
  assert.equal(images[1].diagnosticUse, false);
  assert.equal(images[1].routing, 'ocr_text');
});

test('rejects an upload reference without a tenant or subscription owner', async () => {
  await assert.rejects(
    listUploadImages(UPLOAD_ID, { myuuid: owner.myuuid }),
    (error) => error.code === 'INVALID_UPLOAD_OWNER' && error.httpStatus === 400
  );
  assert.equal(state.listCalls.length, 0);
});

test('treats an empty prefix as an expired or foreign upload', async () => {
  await assert.rejects(
    listUploadImages(UPLOAD_ID, owner),
    (error) => error.code === 'INVALID_UPLOAD_REFERENCE' && error.httpStatus === 400
  );
  await assert.rejects(
    listUploadImages('not-a-uuid', owner),
    (error) => error.code === 'INVALID_UPLOAD_REFERENCE'
  );
});

test('resolves only vision images for inference and never returns bytes or URLs', async () => {
  state.listed = [listedBlob('00.png', 'ocr_text'), listedBlob('01.png', 'vision')];

  const images = await resolveDiagnosticImages({ uploadId: UPLOAD_ID }, owner);

  assert.equal(images.length, 1);
  assert.equal(images[0].name, '01.png');
  assert.equal(images[0].url, undefined);
  assert.equal(images[0].buffer, undefined);
  assert.equal(images[0].classification, undefined);
  assert.deepEqual(await resolveDiagnosticImages({}, owner), []);
});

test('embeds the blob bytes as a data URL right before the model call', async () => {
  const blobName = `tenants/tenant-test/files/uploads/${owner.myuuid}/${UPLOAD_ID}/00.png`;
  const images = await loadImageDataUrls([
    {
      name: 'stored.png',
      mimeType: 'image/png',
      blobName,
      uploadId: UPLOAD_ID
    },
    { name: 'in-memory.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('jpeg-bytes') }
  ], owner);

  assert.deepEqual(state.downloads, [{
    blobName,
    owner: { myuuid: owner.myuuid, tenantId: 'tenant-test', subscriptionId: null },
    uploadId: UPLOAD_ID
  }]);
  assert.equal(
    images[0].url,
    `data:image/png;base64,${Buffer.from(`bytes-of-${blobName}`).toString('base64')}`
  );
  assert.equal(
    images[1].url,
    `data:image/jpeg;base64,${Buffer.from('jpeg-bytes').toString('base64')}`
  );
  assert.doesNotMatch(JSON.stringify(images), /sig=|https:/);
});

test('uploads a classified image with its route in the same write', async () => {
  const file = {
    buffer: Buffer.from('png-bytes'),
    originalname: 'scan.png',
    mimetype: 'image/png',
    size: 9
  };

  const image = await storeClassifiedImage(file, {
    uploadId: UPLOAD_ID,
    index: 0,
    routing: 'ocr_text',
    classification: { classification: 'document_only', confidence: 0.95 }
  }, owner);

  assert.equal(state.uploads.length, 1);
  assert.equal(state.uploads[0].options.metadata.routing, 'ocr_text');
  assert.equal(state.uploads[0].options.metadata.originalname, undefined);
  assert.equal(image.diagnosticUse, false);
  assert.equal(image.uploadId, UPLOAD_ID);
  assert.equal(image.buffer, file.buffer);
});
