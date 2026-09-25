'use strict';

const crypto = require('node:crypto');
const blobFiles = require('./blobFiles');
const {
  MAX_IMAGE_FILES,
  MIN_TEXT_CHARS_WITHOUT_IMAGES,
  UUID_PATTERN
} = require('./multimodalInputValidation');

// Una subida = un uploadId = una carpeta en el blob. El cliente solo guarda
// el id; el servidor lista la carpeta con su propia credencial, lee la ruta
// de cada imagen de los metadatos del blob y descarga los bytes que van al
// modelo. No hay SAS, base de datos ni registro por imagen.

const IMAGE_ROUTES = Object.freeze(['vision', 'ocr_text']);
const RETIRED_REFERENCE_FIELDS = Object.freeze(['assetIds', 'imageUrls']);

function createUploadId() {
  return crypto.randomUUID();
}

function isValidUploadId(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function createOwnerError() {
  const error = new Error('Upload ownership context is incomplete');
  error.code = 'INVALID_UPLOAD_OWNER';
  error.httpStatus = 400;
  return error;
}

function createInvalidReferenceError() {
  const error = new Error('The upload reference is invalid, expired, or unavailable');
  error.code = 'INVALID_UPLOAD_REFERENCE';
  error.httpStatus = 400;
  return error;
}

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
    throw createOwnerError();
  }
  return owner;
}

function hasUploadReference(data) {
  return data?.uploadId !== undefined && data?.uploadId !== null && data?.uploadId !== '';
}

// Si la subida no existe o caducó, resolveDiagnosticImages responde
// INVALID_UPLOAD_REFERENCE, así que relajar el mínimo aquí no deja pasar
// texto corto sin imágenes.
function validateCaseText(value, field, data, errors) {
  const hasUpload = hasUploadReference(data);
  if (value === undefined || value === null || (value === '' && !hasUpload)) {
    errors.push({ field, reason: 'Field is required' });
  } else if (typeof value !== 'string') {
    errors.push({ field, reason: 'Must be a string' });
  } else if (!hasUpload && value.length < MIN_TEXT_CHARS_WITHOUT_IMAGES) {
    errors.push({ field, reason: `Must be at least ${MIN_TEXT_CHARS_WITHOUT_IMAGES} characters` });
  } else if (value.length > 8000) {
    errors.push({ field, reason: 'Must not exceed 8000 characters' });
  }
}

function validateUploadReferenceFields(data, errors) {
  if (hasUploadReference(data)) {
    if (!isValidUploadId(data.uploadId)) {
      errors.push({ field: 'uploadId', reason: 'Must be a valid upload UUID' });
    }
  }
  for (const field of RETIRED_REFERENCE_FIELDS) {
    const value = data[field];
    if (value === undefined) {
      continue;
    }
    const isEmptyArray = Array.isArray(value) && value.length === 0;
    if (!isEmptyArray) {
      errors.push({
        field,
        reason: 'No longer supported: upload the image and send its uploadId'
      });
    }
  }
}

// Solo para el prompt de diagnóstico, nunca para el clasificador. Con historia
// e imágenes la frase no empeora (MedReaMM n=250); como único texto, junto a
// imágenes sin historia, baja el R@1 de 35% a 27%.
const IMAGE_CONTEXT_TEXT = 'Patient with medical imaging findings that require diagnostic interpretation';

function withImageContext(text, images) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!Array.isArray(images) || images.length === 0 || trimmed.length < MIN_TEXT_CHARS_WITHOUT_IMAGES) {
    return text;
  }
  return `${trimmed}\n\n${IMAGE_CONTEXT_TEXT}`;
}

// Los metadatos de blob solo admiten ASCII y claves tipo identificador.
function encodeImageMetadata({ routing, classification }) {
  return {
    routing: IMAGE_ROUTES.includes(routing) ? routing : 'vision',
    classification: String(classification?.classification || 'unknown'),
    confidence: String(
      Number.isFinite(classification?.confidence) ? classification.confidence : 0
    ),
    hasdocumenttext: classification?.hasDocumentText === true ? 'true' : 'false',
    hasmedicalvisual: classification?.hasMedicalVisual === true ? 'true' : 'false'
  };
}

function decodeImageMetadata(metadata = {}) {
  let originalName = '';
  try {
    originalName = decodeURIComponent(metadata.originalname || '');
  } catch {
    originalName = metadata.originalname || '';
  }
  const routing = IMAGE_ROUTES.includes(metadata.routing) ? metadata.routing : 'vision';
  const confidence = Number(metadata.confidence);
  return {
    originalName,
    routing,
    classification: {
      classification: metadata.classification || 'unknown',
      confidence: Number.isFinite(confidence) ? confidence : 0,
      hasDocumentText: metadata.hasdocumenttext === 'true',
      hasMedicalVisual: metadata.hasmedicalvisual === 'true',
      evidence: []
    }
  };
}

function toImageRecord(uploadId, index, blob) {
  const decoded = decodeImageMetadata(blob.metadata);
  return {
    uploadId,
    index,
    blobName: blob.blobName,
    name: decoded.originalName || blob.blobName.split('/').pop(),
    size: blob.size,
    mimeType: blob.mimeType,
    routing: decoded.routing,
    diagnosticUse: decoded.routing === 'vision',
    classification: decoded.classification
  };
}

// Sin ficheros bajo el prefijo la referencia no vale: o caducó (blobCleanup,
// 24 h) o nunca existió para este propietario.
async function listUploadImages(uploadId, context) {
  if (!isValidUploadId(uploadId)) {
    throw createInvalidReferenceError();
  }
  const owner = normalizeOwner(context);
  const blobs = await blobFiles.listUploadImages(owner, uploadId);
  if (blobs.length === 0 || blobs.length > MAX_IMAGE_FILES) {
    throw createInvalidReferenceError();
  }
  return blobs.map((blob, index) => toImageRecord(uploadId, index, blob));
}

// Borrado explícito antes de que blobCleanup lo haga a las 24 h. Idempotente:
// repetirlo, o llamarlo sobre una subida ya caducada, devuelve 0 sin error.
// Un uploadId ajeno cae en un prefijo de otro propietario y también devuelve 0.
async function deleteUpload(uploadId, context) {
  if (!isValidUploadId(uploadId)) {
    throw createInvalidReferenceError();
  }
  const owner = normalizeOwner(context);
  const deleted = await blobFiles.deleteUploadImages(owner, uploadId);
  return { deleted };
}

// Las imágenes se suben ya clasificadas: la ruta viaja en los metadatos del
// mismo PUT y no hay una segunda escritura que pueda fallar.
async function storeClassifiedImage(file, { uploadId, index, routing, classification }, context) {
  const owner = normalizeOwner(context);
  const blobName = await blobFiles.uploadImage(file.buffer, {
    owner,
    uploadId,
    index,
    originalName: file.originalname,
    mimeType: file.mimetype,
    metadata: encodeImageMetadata({
      routing,
      classification
    })
  });
  return {
    uploadId,
    index,
    blobName,
    name: file.originalname,
    size: file.size,
    mimeType: file.mimetype,
    routing,
    diagnosticUse: routing === 'vision',
    classification,
    buffer: file.buffer
  };
}

// Ruta de inferencia: solo lo que el servidor decidió enviar al modelo, y sin
// bytes; los descarga loadImageDataUrls justo antes de la llamada. En blob
// solo se guardan imágenes `vision`; el filtro por ruta es una red de
// seguridad por si algún día se persiste otra cosa bajo el mismo prefijo.
async function resolveDiagnosticImages(data, context) {
  const uploadId = data?.uploadId;
  if (uploadId === undefined || uploadId === null || uploadId === '') {
    return [];
  }
  const images = await listUploadImages(uploadId, context);
  return images
    .filter((image) => image.diagnosticUse !== false)
    .map(({ classification, ...image }) => image);
}

function toDataUrl(buffer, mimeType) {
  return `data:${mimeType || 'application/octet-stream'};base64,${buffer.toString('base64')}`;
}

async function loadImageBuffer(image, context) {
  if (Buffer.isBuffer(image.buffer)) {
    return image.buffer;
  }
  const owner = normalizeOwner(context);
  return blobFiles.downloadBlob(image.blobName, owner, image.uploadId);
}

async function loadImageDataUrl(image, context) {
  return toDataUrl(await loadImageBuffer(image, context), image.mimeType);
}

// Lo que consume buildVisionDiagnoseRequest y callInfoDisease: {name, url}
// con la imagen embebida. Nada de esto debe acabar en logs ni en tracking.
async function loadImageDataUrls(images, context) {
  return Promise.all((images || []).map(async (image) => ({
    name: image.name,
    url: await loadImageDataUrl(image, context)
  })));
}

function toPublicImage(image) {
  return {
    uploadId: image.uploadId,
    index: image.index,
    name: image.name,
    size: image.size,
    mimeType: image.mimeType,
    routing: image.routing,
    diagnosticUse: image.diagnosticUse !== false
  };
}

module.exports = {
  createUploadId,
  decodeImageMetadata,
  deleteUpload,
  encodeImageMetadata,
  isValidUploadId,
  listUploadImages,
  loadImageBuffer,
  loadImageDataUrl,
  loadImageDataUrls,
  resolveDiagnosticImages,
  storeClassifiedImage,
  toDataUrl,
  toPublicImage,
  IMAGE_CONTEXT_TEXT,
  validateCaseText,
  validateUploadReferenceFields,
  withImageContext
};
