'use strict';

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MAX_TOTAL_UPLOAD_BYTES = 20 * 1024 * 1024;

const SIGNATURES = {
  pdf: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D]),
  ole: Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]),
  jpeg: Buffer.from([0xFF, 0xD8, 0xFF]),
  png: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  tiffLittleEndian: Buffer.from([0x49, 0x49, 0x2A, 0x00]),
  tiffBigEndian: Buffer.from([0x4D, 0x4D, 0x00, 0x2A]),
  bmp: Buffer.from([0x42, 0x4D]),
  riff: Buffer.from([0x52, 0x49, 0x46, 0x46]),
  webp: Buffer.from([0x57, 0x45, 0x42, 0x50]),
  zipLocal: Buffer.from([0x50, 0x4B, 0x03, 0x04]),
  zipEmpty: Buffer.from([0x50, 0x4B, 0x05, 0x06]),
  zipSpanned: Buffer.from([0x50, 0x4B, 0x07, 0x08])
};

function hasUploadedFiles(files, fieldName) {
  return Array.isArray(files?.[fieldName]) && files[fieldName].length > 0;
}

function getUploadedFiles(files = {}) {
  return ['document', 'image'].flatMap((fieldName) =>
    (Array.isArray(files[fieldName]) ? files[fieldName] : []).map((file, index) => ({
      ...file,
      fieldName,
      index
    }))
  );
}

function startsWith(buffer, signature, offset = 0) {
  return Buffer.isBuffer(buffer) &&
    buffer.length >= offset + signature.length &&
    buffer.subarray(offset, offset + signature.length).equals(signature);
}

function hasSignatureWithin(buffer, signature, maxOffset) {
  if (!Buffer.isBuffer(buffer)) {
    return false;
  }
  const searchEnd = Math.min(buffer.length, maxOffset + signature.length);
  return buffer.subarray(0, searchEnd).indexOf(signature) !== -1;
}

function hasZipSignature(buffer) {
  return startsWith(buffer, SIGNATURES.zipLocal) ||
    startsWith(buffer, SIGNATURES.zipEmpty) ||
    startsWith(buffer, SIGNATURES.zipSpanned);
}

function containsAscii(buffer, text) {
  return buffer.includes(Buffer.from(text, 'ascii'));
}

function isValidText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.includes(0x00)) {
    return false;
  }

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return false;
  }

  let disallowedControlBytes = 0;
  for (const byte of buffer) {
    if (
      byte < 0x20 &&
      byte !== 0x09 &&
      byte !== 0x0A &&
      byte !== 0x0C &&
      byte !== 0x0D
    ) {
      disallowedControlBytes += 1;
    }
  }
  return disallowedControlBytes <= Math.max(4, Math.floor(buffer.length * 0.01));
}

function matchesDeclaredType(file) {
  const buffer = file.buffer;
  switch (file.mimetype) {
    case 'application/pdf':
      return hasSignatureWithin(buffer, SIGNATURES.pdf, 1024);
    case 'application/msword':
    case 'application/vnd.ms-excel':
      return startsWith(buffer, SIGNATURES.ole);
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return hasZipSignature(buffer) && containsAscii(buffer, 'word/');
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return hasZipSignature(buffer) && containsAscii(buffer, 'xl/');
    case 'text/plain':
      return isValidText(buffer);
    case 'image/jpeg':
      return startsWith(buffer, SIGNATURES.jpeg);
    case 'image/png':
      return startsWith(buffer, SIGNATURES.png);
    case 'image/tiff':
      return startsWith(buffer, SIGNATURES.tiffLittleEndian) ||
        startsWith(buffer, SIGNATURES.tiffBigEndian);
    case 'image/bmp':
      return startsWith(buffer, SIGNATURES.bmp);
    case 'image/webp':
      return startsWith(buffer, SIGNATURES.riff) &&
        startsWith(buffer, SIGNATURES.webp, 8);
    default:
      return false;
  }
}

function validateUploadedFiles(files = {}) {
  const uploadedFiles = getUploadedFiles(files);
  const errors = [];
  const totalBytes = uploadedFiles.reduce(
    (total, file) => total + (Number.isFinite(file.size) ? file.size : file.buffer?.length || 0),
    0
  );

  if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
    errors.push({
      field: 'files',
      reason: 'The combined file size must not exceed 20 MB'
    });
  }

  for (const file of uploadedFiles) {
    const belongsToField = file.fieldName === 'image'
      ? file.mimetype.startsWith('image/')
      : !file.mimetype.startsWith('image/');
    if (!belongsToField) {
      errors.push({
        field: `${file.fieldName}[${file.index}]`,
        filename: file.originalname,
        reason: `File type is not allowed in the ${file.fieldName} field`
      });
      continue;
    }

    if (!matchesDeclaredType(file)) {
      errors.push({
        field: `${file.fieldName}[${file.index}]`,
        filename: file.originalname,
        reason: 'File content does not match its declared type'
      });
    }
  }

  return errors;
}

function validateParsedMultimodalInput(body = {}, files = {}) {
  const errors = [];
  const hasText = typeof body.text === 'string' && body.text.trim().length > 0;
  const hasDocuments = hasUploadedFiles(files, 'document');
  const hasImages = hasUploadedFiles(files, 'image');
  const hasExistingAssets = Array.isArray(body.assetIds) && body.assetIds.length > 0;

  if (!hasText && !hasDocuments && !hasImages && !hasExistingAssets) {
    errors.push({
      field: 'input',
      reason: 'At least one of text, document, or image is required'
    });
  }

  if (typeof body.myuuid !== 'string' || !UUID_PATTERN.test(body.myuuid.trim())) {
    errors.push({
      field: 'myuuid',
      reason: 'A valid UUID is required'
    });
  }

  if (
    body.lang !== undefined &&
    (typeof body.lang !== 'string' || body.lang.length < 2 || body.lang.length > 8)
  ) {
    errors.push({
      field: 'lang',
      reason: 'Must be a valid language code between 2 and 8 characters'
    });
  }

  if (
    body.timezone !== undefined &&
    (typeof body.timezone !== 'string' || body.timezone.trim().length === 0)
  ) {
    errors.push({
      field: 'timezone',
      reason: 'Must be a non-empty string when provided'
    });
  }

  return errors;
}

function getSuccessfulSummary(summaryResult, statusCode) {
  const summary = summaryResult?.data?.summary;
  if (
    statusCode !== 200 ||
    summaryResult?.result !== 'success' ||
    typeof summary !== 'string' ||
    summary.trim().length === 0
  ) {
    const error = new Error('The medical summary could not be generated');
    error.phase = 'summarize_input';
    throw error;
  }
  return summary.trim();
}

module.exports = {
  MAX_TOTAL_UPLOAD_BYTES,
  getSuccessfulSummary,
  validateParsedMultimodalInput,
  validateUploadedFiles
};
