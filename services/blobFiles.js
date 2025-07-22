const { BlobServiceClient, StorageSharedKeyCredential, generateBlobSASQueryParameters, BlobSASPermissions } = require('@azure/storage-blob');
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

function generateSasUrl(blobName) {
    const startDate = new Date();
    const expiryDate = new Date();
    startDate.setTime(startDate.getTime() - 5 * 60 * 1000); // 5 minutos antes
    expiryDate.setTime(expiryDate.getTime() + 60 * 60 * 1000); // 1 hora después

    const sasToken = generateBlobSASQueryParameters({
        containerName: containerName,
        blobName: blobName,
        permissions: BlobSASPermissions.parse("r"), // Solo lectura
        startsOn: startDate,
        expiresOn: expiryDate,
        protocol: 'https'
    }, sharedKeyCredential).toString();

    return `https://${accountname}.blob.core.windows.net/${containerName}/${blobName}?${sasToken}`;
}

async function createBlobFile(fileBuffer, originalName, body) {
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
    
    const name = (body.myuuid || 'noid') + '/' + date;
    const url = y.toString().substr(-2) + '/' + 
                (m < 10 ? '0' : '') + m + '/' + 
                (d < 10 ? '0' : '') + d + '/' + 
                name;
    
    // Determinar el prefijo según el tipo de cliente
    let clientPrefix;
    if (body.tenantId) {
        clientPrefix = `tenants/${body.tenantId}/`;
    } else if (body.subscriptionId) {
        clientPrefix = `marketplace/${body.subscriptionId}/`;
    } else {
        throw new Error('No tenantId ni subscriptionId: integración incorrecta, revisar frontend/backend');
    }
    
    const tempUrl = `${clientPrefix}files/${url}`;
    const contentType = getContentType(originalName);
    
    // Crear el blob
    await createBlob(tempUrl, fileBuffer, contentType);
    
    // Generar URL con SAS token
    const sasUrl = generateSasUrl(tempUrl);
    
    return sasUrl;
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
    createBlobFile
}; 