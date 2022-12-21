'use strict'

const config = require('../config')
const request = require('request')
const storage = require("@azure/storage-blob")
const accountnameOpenDx =config.openDxAccessToken.blobAccount;
const keyOpenDx = config.openDxAccessToken.key;
const sharedKeyCredentialOpenDx = new storage.StorageSharedKeyCredential(accountnameOpenDx,keyOpenDx);
const blobServiceOpenDx = new storage.BlobServiceClient(
    // When using AnonymousCredential, following url should include a valid SAS or support public access
    `https://${accountnameOpenDx}.blob.core.windows.net`,
    sharedKeyCredentialOpenDx
  );

  async function createBlob(containerName, data, fileNameToSave){
    const containerClient = blobServiceOpenDx.getContainerClient(containerName);
    const content = data;
    const blockBlobClient = containerClient.getBlockBlobClient(fileNameToSave);
    const uploadBlobResponse = await blockBlobClient.upload(content, content.length);
  }

  async function createBlobOpenDx29(body, response){
    body.response = response
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
      var name = body.myuuid+'/'+date;
      var url = y.toString().substr(-2) +'/'+ (m < 10 ? '0' : '') + m +'/'+ (d < 10 ? '0' : '') + d +'/'+ name;
      var tempUrl = 'data'+'/'+url;
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
      var name = body.myuuid+'/'+date;
      var url = y.toString().substr(-2) +'/'+ (m < 10 ? '0' : '') + m +'/'+ (d < 10 ? '0' : '') + d +'/'+ name;
      var tempUrl = 'vote'+'/'+url;
      var result = await createBlob(tempUrl, info, fileNameNcr);
  }

  async function createBlobFeedbackVoteDown(body){
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
      var name = body.myuuid+'/'+date;
      var url = y.toString().substr(-2) +'/'+ (m < 10 ? '0' : '') + m +'/'+ (d < 10 ? '0' : '') + d +'/'+ name;
      var tempUrl = 'feedback'+'/'+url;
      var result = await createBlob(tempUrl, info, fileNameNcr);
  }

module.exports = {
  createBlobOpenDx29,
  createBlobOpenVote,
  createBlobFeedbackVoteDown
}
