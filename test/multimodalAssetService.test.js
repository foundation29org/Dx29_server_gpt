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
  created: null,
  found: []
};

const model = {
  async create(data) {
    state.created = data;
    return {
      ...data,
      assetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    };
  },
  find(query) {
    state.query = query;
    return {
      lean: async () => state.found
    };
  }
};

stubModule('../models/multimodalAsset', model);
stubModule('../services/blobFiles', {
  generateBlobReadUrl: (blobName) => ({
    url: `https://storage.test/${blobName}?sig=renewed`,
    expiresAt: new Date('2026-09-21T16:00:00Z')
  })
});

const {
  registerImageAsset,
  resolveImageAssets
} = require('../services/multimodalAssetService');

const owner = {
  myuuid: '12345678-1234-1234-1234-123456789abc',
  tenantId: 'tenant-test'
};

test.beforeEach(() => {
  state.created = null;
  state.found = [];
  state.query = null;
});

test('registers an image asset with ownership and expiry', async () => {
  const result = await registerImageAsset({
    blobName: 'tenants/tenant-test/files/image.png',
    containerName: 'files',
    url: 'https://storage.test/original?sig=secret',
    sasExpiresAt: new Date('2026-09-21T15:00:00Z')
  }, {
    originalname: 'image.png',
    mimetype: 'image/png',
    size: 123
  }, owner);

  assert.equal(state.created.myuuid, owner.myuuid);
  assert.equal(state.created.tenantId, owner.tenantId);
  assert.equal(result.assetId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(result.size, 123);
});

test('renews SAS only for an asset owned by the requester', async () => {
  state.found = [{
    assetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    blobName: 'tenants/tenant-test/files/image.png',
    originalName: 'image.png',
    size: 123,
    expiresAt: new Date('2026-09-22T14:00:00Z')
  }];

  const result = await resolveImageAssets(
    ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    owner
  );

  assert.equal(state.query.myuuid, owner.myuuid);
  assert.equal(state.query.tenantId, owner.tenantId);
  assert.match(result[0].url, /sig=renewed/);
});

test('does not reveal whether a foreign or expired asset exists', async () => {
  await assert.rejects(
    resolveImageAssets(
      ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      owner
    ),
    (error) =>
      error.code === 'INVALID_ASSET_REFERENCE' &&
      error.httpStatus === 400
  );
});
