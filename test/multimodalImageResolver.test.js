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
  ownedUrl: true,
  resolvedAssets: []
};

stubModule('../services/blobFiles', {
  isOwnedBlobUrl: () => state.ownedUrl
});
stubModule('../services/multimodalAssetService', {
  resolveImageAssets: async () => state.resolvedAssets
});

const { resolveImageReferences } = require('../services/multimodalImageResolver');

test.beforeEach(() => {
  state.ownedUrl = true;
  state.resolvedAssets = [];
});

test('prefers assetIds and ignores client-provided URLs', async () => {
  state.resolvedAssets = [{
    assetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'scan.png',
    url: 'https://storage.test/renewed'
  }];

  const result = await resolveImageReferences({
    assetIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    imageUrls: [{ url: 'https://attacker.test/image.png' }]
  }, {
    myuuid: '12345678-1234-1234-1234-123456789abc',
    tenantId: 'tenant-test'
  });

  assert.deepEqual(result, state.resolvedAssets);
});

test('rejects an arbitrary legacy image URL', async () => {
  state.ownedUrl = false;

  await assert.rejects(
    resolveImageReferences({
      imageUrls: [{ name: 'foreign.png', url: 'https://attacker.test/image.png' }]
    }, {
      myuuid: '12345678-1234-1234-1234-123456789abc',
      tenantId: 'tenant-test'
    }),
    (error) => error.code === 'INVALID_IMAGE_URL' && error.httpStatus === 400
  );
});
