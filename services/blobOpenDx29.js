'use strict'

const config = require('../config')
const storage = require("@azure/storage-blob")
const insights = require('../services/insights')
const accountnameOpenDx =config.openDxAccessToken.blobAccount;
const keyOpenDx = config.openDxAccessToken.key;
const sharedKeyCredentialOpenDx = new storage.StorageSharedKeyCredential(accountnameOpenDx,keyOpenDx);
const blobServiceOpenDx = new storage.BlobServiceClient(
  `https://${accountnameOpenDx}.blob.core.windows.net`,
  sharedKeyCredentialOpenDx
  );

  async function createBlob(containerName, data, fileNameToSave){
    try {
      const containerClient = blobServiceOpenDx.getContainerClient(containerName);
      const content = data;
      const blockBlobClient = containerClient.getBlockBlobClient(fileNameToSave);
      const uploadBlobResponse = await blockBlobClient.upload(content, content.length);
    } catch (error) {
      insights.error(error);
    }
    
  }

  async function createBlobOpenDx29(body, version){
    var info = JSON.stringify(body);
    var now = new Date();
    var y = now.getFullYear();
    var m = now.getMonth() + 1;
    var d = now.getDate();
    var h = now.getHours();
    var mm = now.getMinutes();
    var ss = now.getSeconds();
    var ff = Math.round(now.getMilliseconds()/10);
    var date='' + y.toString().substr(-2) + (m < 10 ? '0' : '') + m + (d < 10 ? '0' : '') + d + (h < 10 ? '0' : '') + h + (mm < 10 ? '0' : '') + mm + (ss < 10 ? '0' : '') + ss + (ff < 10 ? '0' : '') + ff;
    var fileNameNcr = 'info.json';
    var name = (body.myuuid || 'noid') + '/' + date;
    var url = y.toString().substr(-2) +'/'+ (m < 10 ? '0' : '') + m +'/'+ (d < 10 ? '0' : '') + d +'/'+ name;
    
    // Determinar el prefijo según el tipo de cliente
    let clientPrefix;
    if (body.tenantId) {
        clientPrefix = `tenants/${body.tenantId}/`;
    } else if (body.subscriptionId) {
        clientPrefix = `marketplace/${body.subscriptionId}/`;
    } else {
        throw new Error('No tenantId ni subscriptionId: integración incorrecta, revisar frontend/backend');
    }
    
    var tempUrl = version === 'v3' ? 
      `${clientPrefix}datav3/${url}` : 
      `${clientPrefix}data/${url}`;
    
    var result = await createBlob(tempUrl, info, fileNameNcr);
  }

  async function createBlobOpenVote(body){
    var info = JSON.stringify(body);
    var now = new Date();
    var y = now.getFullYear();
    var m = now.getMonth() + 1;
    var d = now.getDate();
    var h = now.getHours();
    var mm = now.getMinutes();
    var ss = now.getSeconds();
    var ff = Math.round(now.getMilliseconds()/10);
    var date='' + y.toString().substr(-2) + (m < 10 ? '0' : '') + m + (d < 10 ? '0' : '') + d + (h < 10 ? '0' : '') + h + (mm < 10 ? '0' : '') + mm + (ss < 10 ? '0' : '') + ss + (ff < 10 ? '0' : '') + ff;
    var fileNameNcr = 'info.json';
    var name = (body.myuuid || 'noid') + '/' + date;
    var url = y.toString().substr(-2) +'/'+ (m < 10 ? '0' : '') + m +'/'+ (d < 10 ? '0' : '') + d +'/'+ name;
    
    // Determinar el prefijo según el tipo de cliente
    let clientPrefix;
    if (body.tenantId) {
        clientPrefix = `tenants/${body.tenantId}/`;
    } else if (body.subscriptionId) {
        clientPrefix = `marketplace/${body.subscriptionId}/`;
    } else {
        throw new Error('No tenantId ni subscriptionId: integración incorrecta, revisar frontend/backend');
    }
    
    var tempUrl = `${clientPrefix}vote/${url}`;
    
    var result = await createBlob(tempUrl, info, fileNameNcr);
  }

  async function createBlobErrorsDx29(body, tenantId, subscriptionId) {
    var info = JSON.stringify(body);
    var now = new Date();
    var y = now.getFullYear();
    var m = now.getMonth() + 1;
    var d = now.getDate();
    var h = now.getHours();
    var mm = now.getMinutes();
    var ss = now.getSeconds();
    var ff = Math.round(now.getMilliseconds()/10);
    var date='' + y.toString().substr(-2) + (m < 10 ? '0' : '') + m + (d < 10 ? '0' : '') + d + (h < 10 ? '0' : '') + h + (mm < 10 ? '0' : '') + mm + (ss < 10 ? '0' : '') + ss + (ff < 10 ? '0' : '') + ff;
    var fileNameNcr = 'info.json';
    var name = (body.myuuid || 'noid') + '/' + date;
    var url = y.toString().substr(-2) +'/'+ (m < 10 ? '0' : '') + m +'/'+ (d < 10 ? '0' : '') + d +'/'+ name;
    
    // Determinar el prefijo según el tipo de cliente
    let clientPrefix;
    if (tenantId) {
        clientPrefix = `tenants/${tenantId}/`;
    } else if (subscriptionId) {
        clientPrefix = `marketplace/${subscriptionId}/`;
    } else {
        throw new Error('No tenantId ni subscriptionId: integración incorrecta, revisar frontend/backend');
    }
    
    var tempUrl = `${clientPrefix}errors/${url}`;
    
    var result = await createBlob(tempUrl, info, fileNameNcr);
  }

  async function createBlobQuestions(body, operation){
    var info = JSON.stringify(body);
    var now = new Date();
    var y = now.getFullYear();
    var m = now.getMonth() + 1;
    var d = now.getDate();
    var h = now.getHours();
    var mm = now.getMinutes();
    var ss = now.getSeconds();
    var ff = Math.round(now.getMilliseconds()/10);
    var date='' + y.toString().substr(-2) + (m < 10 ? '0' : '') + m + (d < 10 ? '0' : '') + d + (h < 10 ? '0' : '') + h + (mm < 10 ? '0' : '') + mm + (ss < 10 ? '0' : '') + ss + (ff < 10 ? '0' : '') + ff;
    var fileNameNcr = 'info.json';
    var name = (body.myuuid || 'noid') + '/' + date;
    var url = y.toString().substr(-2) +'/'+ (m < 10 ? '0' : '') + m +'/'+ (d < 10 ? '0' : '') + d +'/'+ name;
    
    // Determinar el prefijo según el tipo de cliente
    let clientPrefix;
    if (body.tenantId) {
        clientPrefix = `tenants/${body.tenantId}/`;
    } else if (body.subscriptionId) {
        clientPrefix = `marketplace/${body.subscriptionId}/`;
    } else {
        throw new Error('No tenantId ni subscriptionId: integración incorrecta, revisar frontend/backend');
    }
    
    var tempUrl = `${clientPrefix}questions/${operation}/${url}`;
    
    var result = await createBlob(tempUrl, info, fileNameNcr);
  }

module.exports = {
  createBlobOpenDx29,
  createBlobOpenVote,
  createBlobErrorsDx29,
  createBlobQuestions
}
