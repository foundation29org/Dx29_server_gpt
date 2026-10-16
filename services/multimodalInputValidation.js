'use strict';

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MAX_TOTAL_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_DOCUMENT_FILES = 5;
const MAX_IMAGE_FILES = 5;
// Sin imágenes, un texto más corto no es un caso clínico. Con imágenes de
// visión el texto puede ser corto o estar vacío: la evidencia es la imagen.
const MIN_TEXT_CHARS_WITHOUT_IMAGES = 10;
// Multer deja fieldSize en 1 MB si no se indica. `text` es el único campo
// grande y hoy ya puede acercarse a ese tamaño; el tope sigue siendo el mismo.
// Busboy rechaza el valor en cuanto lo alcanza, así que cabe 1 byte menos.
const MAX_FIELD_SIZE_BYTES = 1024 * 1024;
// text, lang, myuuid, timezone, model, iframeParams, y los que /analyze
// parsea para rechazarlos (uploadId, assetIds, imageUrls). Por encima, el
// defecto de Multer es Infinity.
const MAX_NON_FILE_FIELDS = 12;
// Busboy emite partsLimit al alcanzar el número, así que el tope queda uno
// por encima del máximo válido: campos + documentos + imágenes.
const MAX_MULTIPART_PARTS =
  MAX_NON_FILE_FIELDS + MAX_DOCUMENT_FILES + MAX_IMAGE_FILES + 1;
const FILE_EMPTY_CODE = 'FILE_EMPTY';
const FILE_CONTENT_MISMATCH_CODE = 'FILE_CONTENT_MISMATCH';
const DOCX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SUPPORTED_DOCUMENT_TYPES = Object.freeze([
  'application/pdf',
  'application/msword',
  DOCX_MIME_TYPE,
  XLSX_MIME_TYPE,
  'text/plain'
]);
// TIFF y BMP no entran: los modelos de visión solo leen JPEG, PNG y WEBP.
// Un TIFF de varias páginas tampoco se puede convertir a una sola imagen
// sin perder hojas; el camino para un escáner es el PDF.
const SUPPORTED_IMAGE_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp'
]);

const SIGNATURES = {
  pdf: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D]),
  ole: Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]),
  jpeg: Buffer.from([0xFF, 0xD8, 0xFF]),
  png: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  riff: Buffer.from([0x52, 0x49, 0x46, 0x46]),
  webp: Buffer.from([0x57, 0x45, 0x42, 0x50]),
  zipLocal: Buffer.from([0x50, 0x4B, 0x03, 0x04]),
  zipEmpty: Buffer.from([0x50, 0x4B, 0x05, 0x06]),
  zipSpanned: Buffer.from([0x50, 0x4B, 0x07, 0x08]),
  utf16le: Buffer.from([0xFF, 0xFE]),
  utf16be: Buffer.from([0xFE, 0xFF])
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

function decodeTextBytes(buffer) {
  if (startsWith(buffer, SIGNATURES.utf16le)) {
    return new TextDecoder('utf-16le').decode(buffer);
  }
  if (startsWith(buffer, SIGNATURES.utf16be)) {
    return new TextDecoder('utf-16be').decode(buffer);
  }
  if (buffer.includes(0x00)) {
    return null;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    // ANSI del Bloc de notas antiguo y de exportaciones de programas viejos.
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

// Windows-1252 acepta casi cualquier byte, así que lo que separa un TXT de un
// binario renombrado son los caracteres de control (C0 y C1) del resultado.
function decodeText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return null;
  }
  const text = decodeTextBytes(buffer);
  if (text === null) {
    return null;
  }

  let disallowedControlChars = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    const isC0 = code < 0x20 &&
      code !== 0x09 &&
      code !== 0x0A &&
      code !== 0x0C &&
      code !== 0x0D;
    if (isC0 || (code >= 0x80 && code <= 0x9F)) {
      disallowedControlChars += 1;
    }
  }
  return disallowedControlChars <= Math.max(4, Math.floor(text.length * 0.01))
    ? text
    : null;
}

function isValidText(buffer) {
  return decodeText(buffer) !== null;
}

function matchesDeclaredType(file) {
  const buffer = file.buffer;
  switch (file.mimetype) {
    case 'application/pdf':
      return hasSignatureWithin(buffer, SIGNATURES.pdf, 1024);
    case 'application/msword':
      return startsWith(buffer, SIGNATURES.ole);
    case DOCX_MIME_TYPE:
      return hasZipSignature(buffer) && containsAscii(buffer, 'word/');
    case XLSX_MIME_TYPE:
      return hasZipSignature(buffer) && containsAscii(buffer, 'xl/');
    case 'text/plain':
      return isValidText(buffer);
    case 'image/jpeg':
      return startsWith(buffer, SIGNATURES.jpeg);
    case 'image/png':
      return startsWith(buffer, SIGNATURES.png);
    case 'image/webp':
      return startsWith(buffer, SIGNATURES.riff) &&
        startsWith(buffer, SIGNATURES.webp, 8);
    default:
      return false;
  }
}

function isAllowedInField(fieldName, mimetype) {
  return fieldName === 'image'
    ? SUPPORTED_IMAGE_TYPES.includes(mimetype)
    : SUPPORTED_DOCUMENT_TYPES.includes(mimetype);
}

// Qué tipo soportado demuestra ser el contenido. El navegador declara el tipo por
// la extensión, así que un DOCX guardado como ".doc" llega como msword. Solo cuentan
// firmas inequívocas: OLE (.doc/.xls/.ppt) y el texto plano quedan fuera porque su
// cabecera no dice de qué formato son. Un zip que parece Word y Excel a la vez
// tampoco se adivina. Se buscan las partes principales (nombres que el zip guarda
// sin comprimir): "xl/" o "word/" sueltos podrían salir por azar en un archivo grande.
function detectSupportedMimeType(buffer) {
  if (hasSignatureWithin(buffer, SIGNATURES.pdf, 1024)) return 'application/pdf';
  if (startsWith(buffer, SIGNATURES.jpeg)) return 'image/jpeg';
  if (startsWith(buffer, SIGNATURES.png)) return 'image/png';
  if (startsWith(buffer, SIGNATURES.riff) && startsWith(buffer, SIGNATURES.webp, 8)) {
    return 'image/webp';
  }
  if (hasZipSignature(buffer)) {
    const isWord = containsAscii(buffer, 'word/document.xml');
    const isExcel = containsAscii(buffer, 'xl/workbook.xml');
    if (isWord && !isExcel) return DOCX_MIME_TYPE;
    if (isExcel && !isWord) return XLSX_MIME_TYPE;
  }
  return null;
}

// Cuando el contenido contradice el tipo declarado pero es otro tipo que ya
// aceptamos en ese mismo campo, manda el contenido: el archivo se procesa como lo
// que es. Una foto en el campo de documentos o un archivo que no es nada soportado
// siguen rechazándose en validateUploadedFiles. Muta los archivos de Multer y
// devuelve las correcciones (sin nombres de archivo) para medirlas.
function reconcileDeclaredTypes(files = {}) {
  const corrections = [];
  for (const fieldName of ['document', 'image']) {
    const uploaded = Array.isArray(files[fieldName]) ? files[fieldName] : [];
    uploaded.forEach((file, index) => {
      if (!isAllowedInField(fieldName, file.mimetype) || matchesDeclaredType(file)) {
        return;
      }
      const detected = detectSupportedMimeType(file.buffer);
      if (!detected || !isAllowedInField(fieldName, detected)) {
        return;
      }
      corrections.push({
        field: `${fieldName}[${index}]`,
        declared: file.mimetype,
        detected
      });
      file.declaredMimetype = file.mimetype;
      file.mimetype = detected;
    });
  }
  return corrections;
}

// Qué es realmente un archivo, mirando solo su cabecera. Sirve para diagnosticar un
// rechazo "no coincide con su tipo" (p. ej. una foto renombrada a .pdf), no para validar.
function sniffContentType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return 'empty';
  if (hasSignatureWithin(buffer, SIGNATURES.pdf, 1024)) return 'pdf';
  if (startsWith(buffer, SIGNATURES.jpeg)) return 'jpeg';
  if (startsWith(buffer, SIGNATURES.png)) return 'png';
  if (startsWith(buffer, SIGNATURES.riff) && startsWith(buffer, SIGNATURES.webp, 8)) return 'webp';
  if (startsWith(buffer, Buffer.from('GIF8', 'ascii'))) return 'gif';
  if (startsWith(buffer, Buffer.from('ftyp', 'ascii'), 4)) return 'iso_media_heic_or_mp4';
  if (startsWith(buffer, SIGNATURES.ole)) return 'ole';
  if (hasZipSignature(buffer)) return 'zip';
  if (buffer.indexOf(SIGNATURES.pdf) !== -1) return 'pdf_header_after_1024_bytes';
  const head = buffer.subarray(0, 64).toString('latin1').trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html')) return 'html';
  return isValidText(buffer) ? 'text' : 'unknown_binary';
}

// Sin nombres de archivo (pueden llevar el nombre del paciente): solo tipo declarado,
// tipo real, tamaño y los 8 primeros bytes.
function describeUploadedFiles(files = {}) {
  return getUploadedFiles(files).map((file) => ({
    field: `${file.fieldName}[${file.index}]`,
    declared: file.mimetype,
    detected: sniffContentType(file.buffer),
    bytes: file.buffer?.length ?? file.size ?? 0,
    firstBytes: Buffer.isBuffer(file.buffer) ? file.buffer.subarray(0, 8).toString('hex') : ''
  }));
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
    if (!isAllowedInField(file.fieldName, file.mimetype)) {
      errors.push({
        field: `${file.fieldName}[${file.index}]`,
        filename: file.originalname,
        reason: `File type is not allowed in the ${file.fieldName} field`
      });
      continue;
    }

    if (!matchesDeclaredType(file)) {
      // `code` es el contrato con el cliente, que lo traduce a un mensaje por
      // idioma. `reason` es solo para quien lea la respuesta o los logs.
      const isEmpty = (file.buffer?.length ?? file.size ?? 0) === 0;
      errors.push({
        field: `${file.fieldName}[${file.index}]`,
        filename: file.originalname,
        code: isEmpty ? FILE_EMPTY_CODE : FILE_CONTENT_MISMATCH_CODE,
        reason: isEmpty
          ? 'File is empty'
          : 'File content does not match its declared type'
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

  if (!hasText && !hasDocuments && !hasImages) {
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

  if (body.timezone !== undefined && typeof body.timezone !== 'string') {
    errors.push({
      field: 'timezone',
      reason: 'Must be a string'
    });
  }

  if (body.iframeParams !== undefined && parseIframeParams(body.iframeParams) === null) {
    errors.push({
      field: 'iframeParams',
      reason: 'Must be a JSON object'
    });
  }

  return errors;
}

// En multipart todos los campos llegan como texto; /diagnose exige un objeto.
// Devuelve null si no es un objeto JSON. El contenido lo valida /diagnose.
function parseIframeParams(value) {
  if (value === undefined || value === '') {
    return {};
  }
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
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
    // Un 400 es el contenido del paciente (p. ej. patrones sospechosos), no
    // un fallo nuestro: no hay nada que revisar por email.
    if (statusCode === 400) {
      error.httpStatus = 400;
      error.code = 'SUMMARY_INPUT_REJECTED';
    }
    throw error;
  }
  return summary.trim();
}

module.exports = {
  MAX_DOCUMENT_FILES,
  MAX_FIELD_SIZE_BYTES,
  MAX_IMAGE_FILES,
  MAX_MULTIPART_PARTS,
  MAX_NON_FILE_FIELDS,
  MAX_TOTAL_UPLOAD_BYTES,
  MIN_TEXT_CHARS_WITHOUT_IMAGES,
  SUPPORTED_DOCUMENT_TYPES,
  SUPPORTED_IMAGE_TYPES,
  UUID_PATTERN,
  decodeText,
  describeUploadedFiles,
  getSuccessfulSummary,
  parseIframeParams,
  reconcileDeclaredTypes,
  validateParsedMultimodalInput,
  validateUploadedFiles
};
