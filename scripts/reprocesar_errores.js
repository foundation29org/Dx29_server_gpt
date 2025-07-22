const express = require('express');
const config = require('../config');
const { processAIRequestInternal } = require('../services/helpDiagnose');
const { BlobServiceClient, StorageSharedKeyCredential } = require('@azure/storage-blob');

const accountname = config.openDxAccessToken.blobAccount;
const key = config.openDxAccessToken.key;
const sharedKeyCredential = new StorageSharedKeyCredential(accountname, key);
const blobServiceClient = new BlobServiceClient(
    `https://${accountname}.blob.core.windows.net`,
    sharedKeyCredential
);

const containerName = 'tenants';
const errorPrefix = 'dxgpt-prod/errors/25/06';

async function streamToString(readableStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readableStream.on('data', (data) => {
      chunks.push(data.toString());
    });
    readableStream.on('end', () => {
      resolve(chunks.join(''));
    });
    readableStream.on('error', reject);
  });
}

const reprocesarErrores = async (req, res) => {
  try {
    const containerClient = blobServiceClient.getContainerClient(containerName);
    let resultados = [];

    for await (const blob of containerClient.listBlobsFlat({ prefix: errorPrefix })) {
      if (!blob.name.endsWith('.json')) continue;

      const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
      const downloadBlockBlobResponse = await blockBlobClient.download(0);
      const downloaded = await streamToString(downloadBlockBlobResponse.readableStreamBody);

      let errorData;
      try {
        errorData = JSON.parse(downloaded);
      } catch (e) {
        resultados.push({ blob: blob.name, error: 'Error parseando JSON' });
        continue;
      }

       // Solo procesar si el modelo original era 'o1'
        if (errorData.model !== 'o1') {
            resultados.push({ blob: blob.name, status: 'SKIPPED', reason: `Modelo original: ${errorData.model}` });
            continue;
        }

      try {
        const result = await processAIRequestInternal(
          {
            description: errorData.description,
            myuuid: errorData.myuuid,
            lang: errorData.lang,
            tenantId: errorData.tenantId,
            subscriptionId: errorData.subscriptionId,
            diseases_list: errorData.diseases_list || '',
            timezone: errorData.timezone || 'Europe/Madrid',
            iframeParams: errorData.iframeParams || {}
          },
          null, // requestInfo
          'o3', // modelo
          errorData.myuuid,
          null // region
        );
        resultados.push({ blob: blob.name, status: 'OK', result });
      } catch (err) {
        resultados.push({ blob: blob.name, status: 'ERROR', error: err.message || err });
      }
    }

    res.json(resultados);
  } catch (err) {
    res.status(500).json({ error: err.message || err });
  }
};

module.exports = reprocesarErrores;