'use strict';

const MultimodalAsset = require('../models/multimodalAsset');
const blobFiles = require('./blobFiles');

const ASSET_LIFETIME_MS = 24 * 60 * 60 * 1000;
const ASSET_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function normalizeOwner(context = {}) {
  const owner = {
    myuuid: typeof context.myuuid === 'string' ? context.myuuid.trim() : '',
    tenantId: typeof context.tenantId === 'string' && context.tenantId.trim()
      ? context.tenantId.trim()
      : null,
    subscriptionId: typeof context.subscriptionId === 'string' && context.subscriptionId.trim()
      ? context.subscriptionId.trim()
      : null
  };

  if (!owner.myuuid || (!owner.tenantId && !owner.subscriptionId)) {
    const error = new Error('Asset ownership context is incomplete');
    error.code = 'INVALID_ASSET_OWNER';
    error.httpStatus = 400;
    throw error;
  }
  return owner;
}

function createOwnershipQuery(owner) {
  const query = { myuuid: owner.myuuid };
  if (owner.tenantId) {
    query.tenantId = owner.tenantId;
  }
  if (owner.subscriptionId) {
    query.subscriptionId = owner.subscriptionId;
  }
  return query;
}

function createInvalidReferenceError() {
  const error = new Error('One or more image assets are invalid, expired, or unavailable');
  error.code = 'INVALID_ASSET_REFERENCE';
  error.httpStatus = 400;
  return error;
}

async function registerImageAsset(blob, file, context) {
  const owner = normalizeOwner(context);
  const expiresAt = new Date(Date.now() + ASSET_LIFETIME_MS);
  const asset = await MultimodalAsset.create({
    blobName: blob.blobName,
    containerName: blob.containerName,
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
    ...owner,
    expiresAt
  });

  return {
    assetId: asset.assetId,
    name: asset.originalName,
    size: asset.size,
    url: blob.url,
    sasExpiresAt: blob.sasExpiresAt,
    expiresAt: asset.expiresAt
  };
}

async function resolveImageAssets(assetIds, context) {
  if (!Array.isArray(assetIds) || assetIds.length === 0) {
    return [];
  }

  const uniqueAssetIds = [...new Set(assetIds)];
  if (
    assetIds.length > 5 ||
    uniqueAssetIds.some((assetId) =>
      typeof assetId !== 'string' || !ASSET_ID_PATTERN.test(assetId)
    )
  ) {
    throw createInvalidReferenceError();
  }

  const owner = normalizeOwner(context);
  const assets = await MultimodalAsset.find({
    assetId: { $in: uniqueAssetIds },
    ...createOwnershipQuery(owner),
    expiresAt: { $gt: new Date() }
  }).lean();

  if (assets.length !== uniqueAssetIds.length) {
    throw createInvalidReferenceError();
  }

  const assetsById = new Map(assets.map((asset) => [asset.assetId, asset]));
  return assetIds.map((assetId) => {
    const asset = assetsById.get(assetId);
    if (!asset) {
      throw createInvalidReferenceError();
    }
    const sas = blobFiles.generateBlobReadUrl(asset.blobName);
    return {
      assetId: asset.assetId,
      name: asset.originalName,
      size: asset.size,
      url: sas.url,
      sasExpiresAt: sas.expiresAt,
      expiresAt: asset.expiresAt
    };
  });
}

module.exports = {
  registerImageAsset,
  resolveImageAssets
};
