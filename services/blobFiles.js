const { BlobServiceClient, StorageSharedKeyCredential } = require('@azure/storage-blob');
const config = require('../config');

const accountname = config.openDxAccessToken.blobAccount;
const key = config.openDxAccessToken.key;
const sharedKeyCredential = new StorageSharedKeyCredential(accountname, key);
const blobServiceClient = new BlobServiceClient(
    `https://${accountname}.blob.core.windows.net`,
    sharedKeyCredential
);

const containerName = 'files'; // Contenedor específico para archivos

function getContainerClient() {
    return blobServiceClient.getContainerClient(containerName);
}

async function createBlob(blobName, data, contentType, metadata) {
    try {
        const containerClient = getContainerClient();
        
        // Crear el contenedor si no existe
        await containerClient.createIfNotExists();
        
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        
        await blockBlobClient.upload(data, data.length, {
            blobHTTPHeaders: { blobContentType: contentType },
            ...(metadata ? { metadata } : {})
        });
        
        return blockBlobClient.url;
    } catch (error) {
        console.error('Error al crear blob:', error);
        throw error;
    }
}

function safePathSegment(value) {
    return String(value).trim().replace(/[^a-zA-Z0-9._-]/g, '_');
}

// El prefijo del propietario sale de las cabeceras autenticadas, nunca del
// body: es lo que impide que un cliente liste o lea ficheros de otro tenant.
function getOwnerPrefix({ tenantId, subscriptionId } = {}) {
    if (tenantId) {
        return `tenants/${safePathSegment(tenantId)}/`;
    }
    if (subscriptionId) {
        return `marketplace/${safePathSegment(subscriptionId)}/`;
    }
    throw new Error('No tenantId ni subscriptionId: integración incorrecta, revisar frontend/backend');
}

// Un upload = una carpeta. El uploadId es aleatorio y el myuuid va en la
// ruta, así que la referencia que guarda el cliente no sirve fuera de su
// propio contexto.
function getUploadPrefix(owner, uploadId) {
    return `${getOwnerPrefix(owner)}files/uploads/` +
        `${safePathSegment(owner.myuuid || 'noid')}/${safePathSegment(uploadId)}/`;
}

function buildUploadBlobName(owner, uploadId, index, originalName) {
    const extension = safePathSegment(
        String(originalName || '').toLowerCase().split('.').pop() || 'bin'
    );
    return `${getUploadPrefix(owner, uploadId)}${String(index).padStart(2, '0')}.${extension}`;
}

async function uploadImage(fileBuffer, { owner, uploadId, index, originalName, mimeType, metadata }) {
    const blobName = buildUploadBlobName(owner, uploadId, index, originalName);
    await createBlob(
        blobName,
        fileBuffer,
        mimeType || getContentType(originalName),
        metadata
    );
    return blobName;
}

async function listUploadImages(owner, uploadId) {
    const prefix = getUploadPrefix(owner, uploadId);
    const blobs = [];
    for await (const blob of getContainerClient().listBlobsFlat({ prefix, includeMetadata: true })) {
        blobs.push({
            blobName: blob.name,
            size: blob.properties.contentLength || 0,
            mimeType: blob.properties.contentType || 'application/octet-stream',
            createdOn: blob.properties.createdOn,
            metadata: blob.metadata || {}
        });
    }
    return blobs.sort((a, b) => a.blobName.localeCompare(b.blobName));
}

function isOwnedBlobName(owner, uploadId, blobName) {
    const prefix = getUploadPrefix(owner, uploadId);
    return typeof blobName === 'string' &&
        blobName.startsWith(prefix) &&
        !blobName.includes('..');
}

async function downloadBlob(blobName, owner, uploadId) {
    if (!isOwnedBlobName(owner, uploadId, blobName)) {
        const error = new Error('Blob is outside the upload prefix');
        error.code = 'INVALID_UPLOAD_REFERENCE';
        throw error;
    }
    return getContainerClient().getBlobClient(blobName).downloadToBuffer();
}

// Borra la carpeta completa de una subida. El prefijo lleva tenant, myuuid y
// uploadId, así que solo puede alcanzar blobs de ese propietario.
async function deleteUploadImages(owner, uploadId) {
    const prefix = getUploadPrefix(owner, uploadId);
    const containerClient = getContainerClient();
    let deleted = 0;
    for await (const blob of containerClient.listBlobsFlat({ prefix })) {
        await containerClient.deleteBlob(blob.name, { deleteSnapshots: 'include' });
        deleted++;
    }
    return deleted;
}

function getContentType(filename) {
    const ext = String(filename || '').split('.').pop().toLowerCase();
    const contentTypes = {
        'pdf': 'application/pdf',
        'doc': 'application/msword',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xls': 'application/vnd.ms-excel',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'txt': 'text/plain',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'tiff': 'image/tiff',
        'bmp': 'image/bmp',
        'webp': 'image/webp'
    };
    return contentTypes[ext] || 'application/octet-stream';
}

module.exports = {
    deleteUploadImages,
    downloadBlob,
    getUploadPrefix,
    isOwnedBlobName,
    listUploadImages,
    uploadImage
}; 
