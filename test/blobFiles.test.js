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
    }
  }
};

const blobFiles = require('../services/blobFiles');

const UPLOAD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('scopes every upload under the authenticated tenant and the caller myuuid', () => {
  const prefix = blobFiles.getUploadPrefix(
    { tenantId: 'tenant-a', myuuid: '12345678-1234-1234-1234-123456789abc' },
    UPLOAD_ID
  );
  assert.equal(
    prefix,
    `tenants/tenant-a/files/uploads/12345678-1234-1234-1234-123456789abc/${UPLOAD_ID}/`
  );
});

test('uses the marketplace prefix when only a subscription is present', () => {
  const prefix = blobFiles.getUploadPrefix(
    { subscriptionId: 'sub-1', myuuid: 'user' },
    UPLOAD_ID
  );
  assert.match(prefix, /^marketplace\/sub-1\/files\/uploads\/user\//);
});

test('neutralises path traversal in owner-controlled segments', () => {
  const prefix = blobFiles.getUploadPrefix(
    { tenantId: 'tenant-a', myuuid: '../../other-user' },
    '../escape'
  );
  assert.doesNotMatch(prefix, /\.\.\//);
  assert.match(prefix, /^tenants\/tenant-a\/files\/uploads\//);
});

test('refuses to build a prefix without tenant or subscription', () => {
  assert.throws(
    () => blobFiles.getUploadPrefix({ myuuid: 'user' }, UPLOAD_ID),
    /No tenantId ni subscriptionId/
  );
});

test('refuses a blob name outside the owner upload prefix', () => {
  const owner = {
    tenantId: 'tenant-a',
    myuuid: '12345678-1234-1234-1234-123456789abc'
  };
  const prefix = blobFiles.getUploadPrefix(owner, UPLOAD_ID);
  assert.equal(blobFiles.isOwnedBlobName(owner, UPLOAD_ID, `${prefix}00.png`), true);
  assert.equal(blobFiles.isOwnedBlobName(
    owner,
    UPLOAD_ID,
    `tenants/other/files/uploads/${owner.myuuid}/${UPLOAD_ID}/00.png`
  ), false);
});

test('no longer exposes any SAS signing helper', () => {
  for (const name of Object.keys(blobFiles)) {
    assert.doesNotMatch(name, /sas|Sas|SAS|ReadUrl/, name);
  }
});
