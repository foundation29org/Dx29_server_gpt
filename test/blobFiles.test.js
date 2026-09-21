'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const configPath = require.resolve('../config');
require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: {
    openDxAccessToken: {
      blobAccount: 'dxgptstorage',
      key: Buffer.alloc(32, 1).toString('base64')
    },
    BLOB_READ_SAS_MS: 60 * 1000,
    BLOB_PREVIEW_SAS_MS: 24 * 60 * 60 * 1000
  }
};

const { generateBlobReadUrl, generatePreviewReadUrl, isOwnedBlobUrl } = require('../services/blobFiles');

test('accepts a legacy blob URL owned by the tenant', () => {
  assert.equal(isOwnedBlobUrl(
    'https://dxgptstorage.blob.core.windows.net/files/tenants/tenant-a/files/26/09/21/user/image.png?sig=secret',
    { tenantId: 'tenant-a' }
  ), true);
});

function signedExpiryMs(url) {
  return Date.parse(new URL(url).searchParams.get('se'));
}

test('creates a 1-minute read SAS without waiting an hour', () => {
  const before = Date.now();
  const sas = generateBlobReadUrl('tenants/tenant-a/files/image.png', 60 * 1000);
  const after = Date.now();
  const signedExpiry = signedExpiryMs(sas.url);

  assert.match(sas.url, /^https:\/\/dxgptstorage\.blob\.core\.windows\.net\/files\//);
  assert.ok(sas.expiresAt.getTime() >= before + 60 * 1000);
  assert.ok(sas.expiresAt.getTime() <= after + 60 * 1000 + 1000);
  assert.ok(signedExpiry >= before + 60 * 1000 - 1000);
  assert.ok(signedExpiry <= after + 60 * 1000 + 2000);
});

test('default read SAS follows BLOB_READ_SAS_MINUTES from config', () => {
  const sas = generateBlobReadUrl('tenants/tenant-a/files/image.png');
  const ttlMs = signedExpiryMs(sas.url) - Date.now();

  assert.ok(ttlMs > 50 * 1000);
  assert.ok(ttlMs <= 62 * 1000);
});

test('preview SAS lasts a day so the edit modal does not expire after one hour', () => {
  const sas = generatePreviewReadUrl('tenants/tenant-a/files/image.png');
  const ttlMs = sas.expiresAt.getTime() - Date.now();

  assert.ok(ttlMs > 23 * 60 * 60 * 1000);
  assert.ok(ttlMs <= 24 * 60 * 60 * 1000);
});

test('rejects external and cross-tenant image URLs', () => {
  const context = { tenantId: 'tenant-a' };
  assert.equal(isOwnedBlobUrl(
    'https://attacker.test/image.png',
    context
  ), false);
  assert.equal(isOwnedBlobUrl(
    'https://dxgptstorage.blob.core.windows.net/files/tenants/tenant-b/files/image.png?sig=secret',
    context
  ), false);
});
