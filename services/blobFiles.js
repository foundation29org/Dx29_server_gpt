const { BlobServiceClient, StorageSharedKeyCredential, generateBlobSASQueryParameters, BlobSASPermissions } = require('@azure/storage-blob');
const crypto = require('node:crypto');
const config = require('../config');

const accountname = config.openDxAccessToken.blobAccount;
const key = config.openDxAccessToken.key;
const sharedKeyCredential = new StorageSharedKeyCredential(accountname, key);
const blobServiceClient = new BlobServiceClient(
    `https://${accountname}.blob.core.windows.net`,
    sharedKeyCredential
);

const containerName = 'files'; // Contenedor específico para archivos

async function createBlob(blobName, data, contentType) {
    try {
        const containerClient = blobServiceClient.getContainerClient(containerName);
        
        // Crear el contenedor si no existe
        await containerClient.createIfNotExists();
        
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        
        await blockBlobClient.upload(data, data.length, {
            blobHTTPHeaders: { blobContentType: contentType }
        });
        
        return blockBlobClient.url;
    } catch (error) {
        console.error('Error al crear blob:', error);
        throw error;
    }
}

const DEFAULT_READ_SAS_MS = 60 * 60 * 1000;
const DEFAULT_PREVIEW_SAS_MS = 24 * 60 * 60 * 1000;

function resolveSasTtlMs(expiresInMs, fallbackMs) {
    return Number.isFinite(expiresInMs) && expiresInMs > 0 ? expiresInMs : fallbackMs;
}

function generateBlobReadUrl(blobName, expiresInMs) {
    const ttlMs = resolveSasTtlMs(
        expiresInMs,
        config.BLOB_READ_SAS_MS || DEFAULT_READ_SAS_MS
    );
    const startDate = new Date();
    const expiryDate = new Date();
    startDate.setTime(startDate.getTime() - 5 * 60 * 1000); // 5 minutos antes
    expiryDate.setTime(expiryDate.getTime() + ttlMs);

    const sasToken = generateBlobSASQueryParameters({
        containerName: containerName,
        blobName: blobName,
        permissions: BlobSASPermissions.parse("r"), // Solo lectura
        startsOn: startDate,
        expiresOn: expiryDate,
        protocol: 'https'
    }, sharedKeyCredential).toString();

    return {
        url: `https://${accountname}.blob.core.windows.net/${containerName}/${blobName}?${sasToken}`,
        expiresAt: expiryDate
    };
}

function generatePreviewReadUrl(blobName) {
    return generateBlobReadUrl(
        blobName,
        config.BLOB_PREVIEW_SAS_MS || DEFAULT_PREVIEW_SAS_MS
    );
}

function generateSasUrl(blobName) {
    return generateBlobReadUrl(blobName).url;
}

function safePathSegment(value) {
    return String(value).trim().replace(/[^a-zA-Z0-9._-]/g, '_');
}

function isOwnedBlobUrl(value, context = {}) {
    if (typeof value !== 'string') {
        return false;
    }
    try {
        const parsedUrl = new URL(value);
        if (
            parsedUrl.protocol !== 'https:' ||
            parsedUrl.hostname !== `${accountname}.blob.core.windows.net`
        ) {
            return false;
        }

        const ownerPrefix = context.tenantId
            ? `tenants/${safePathSegment(context.tenantId)}/`
            : context.subscriptionId
                ? `marketplace/${safePathSegment(context.subscriptionId)}/`
                : null;
        return ownerPrefix !== null &&
            parsedUrl.pathname.startsWith(`/${containerName}/${ownerPrefix}files/`);
    } catch {
        return false;
    }
}

async function createBlobFileWithMetadata(fileBuffer, originalName, body, mimeType) {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const d = now.getDate();
    const h = now.getHours();
    const mm = now.getMinutes();
    const ss = now.getSeconds();
    const ff = Math.round(now.getMilliseconds()/10);
    const date = '' + y.toString().substr(-2) + 
                (m < 10 ? '0' : '') + m + 
                (d < 10 ? '0' : '') + d + 
                (h < 10 ? '0' : '') + h + 
                (mm < 10 ? '0' : '') + mm + 
                (ss < 10 ? '0' : '') + ss + 
                (ff < 10 ? '0' : '') + ff;
    
    // Extraer la extensión del archivo original
    const fileExtension = originalName.toLowerCase().split('.').pop();
    
    const uniqueSuffix = crypto.randomUUID();
    const name = safePathSegment(body.myuuid || 'noid') + '/' + date + '-' + uniqueSuffix + '.' + fileExtension;
    const url = y.toString().substr(-2) + '/' + 
                (m < 10 ? '0' : '') + m + '/' + 
                (d < 10 ? '0' : '') + d + '/' + 
                name;
    
    // Determinar el prefijo según el tipo de cliente
    let clientPrefix;
    if (body.tenantId) {
        clientPrefix = `tenants/${safePathSegment(body.tenantId)}/`;
    } else if (body.subscriptionId) {
        clientPrefix = `marketplace/${safePathSegment(body.subscriptionId)}/`;
    } else {
        throw new Error('No tenantId ni subscriptionId: integración incorrecta, revisar frontend/backend');
    }
    
    const tempUrl = `${clientPrefix}files/${url}`;
    const contentType = mimeType || getContentType(originalName);
    
    // Crear el blob
    await createBlob(tempUrl, fileBuffer, contentType);
    
    // Generar URL con SAS token
    const sas = generatePreviewReadUrl(tempUrl);
    
    return {
        blobName: tempUrl,
        containerName,
        url: sas.url,
        sasExpiresAt: sas.expiresAt
    };
}

async function createBlobFile(fileBuffer, originalName, body, mimeType) {
    const asset = await createBlobFileWithMetadata(fileBuffer, originalName, body, mimeType);
    return asset.url;
}

function getContentType(filename) {
    const ext = filename.split('.').pop().toLowerCase();
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
    createBlobFile,
    createBlobFileWithMetadata,
    generateBlobReadUrl,
    generatePreviewReadUrl,
    isOwnedBlobUrl
}; 