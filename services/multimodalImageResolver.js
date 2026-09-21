'use strict';

const blobFiles = require('./blobFiles');
const multimodalAssetService = require('./multimodalAssetService');

const ASSET_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MAX_IMAGES = 5;

function validateImageReferenceFields(data, errors) {
  if (data.assetIds !== undefined) {
    if (!Array.isArray(data.assetIds)) {
      errors.push({ field: 'assetIds', reason: 'Must be an array' });
    } else if (data.assetIds.length > MAX_IMAGES) {
      errors.push({ field: 'assetIds', reason: 'Must not contain more than 5 items' });
    } else {
      data.assetIds.forEach((assetId, index) => {
        if (typeof assetId !== 'string' || !ASSET_ID_PATTERN.test(assetId)) {
          errors.push({
            field: `assetIds[${index}]`,
            reason: 'Must be a valid asset UUID'
          });
        }
      });
    }
  }

  if (data.imageUrls !== undefined) {
    if (!Array.isArray(data.imageUrls)) {
      errors.push({ field: 'imageUrls', reason: 'Must be an array' });
    } else if (data.imageUrls.length > MAX_IMAGES) {
      errors.push({ field: 'imageUrls', reason: 'Must not contain more than 5 items' });
    } else {
      data.imageUrls.forEach((image, index) => {
        if (!image || typeof image !== 'object' || typeof image.url !== 'string') {
          errors.push({
            field: `imageUrls[${index}]`,
            reason: 'Must contain an object with a URL'
          });
        }
      });
    }
  }
}

function invalidLegacyReferenceError() {
  const error = new Error('One or more legacy image URLs are invalid or belong to another owner');
  error.code = 'INVALID_IMAGE_URL';
  error.httpStatus = 400;
  return error;
}

async function resolveImageReferences(data, context) {
  if (Array.isArray(data.assetIds) && data.assetIds.length > 0) {
    return multimodalAssetService.resolveImageAssets(data.assetIds, context);
  }

  if (!Array.isArray(data.imageUrls) || data.imageUrls.length === 0) {
    return [];
  }

  if (data.imageUrls.some((image) => !blobFiles.isOwnedBlobUrl(image.url, context))) {
    throw invalidLegacyReferenceError();
  }

  return data.imageUrls.map((image) => ({
    name: typeof image.name === 'string' ? image.name : '',
    url: image.url
  }));
}

module.exports = {
  resolveImageReferences,
  validateImageReferenceFields
};
