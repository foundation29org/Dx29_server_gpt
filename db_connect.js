'use strict';

const mongoose = require('mongoose');
const config = require('./config');
const mongodbkey = config.mongodbkey;
const mongodbname = config.mongodbname;
if (!mongodbkey || !mongodbname) {
    throw new Error('Mongo secrets missing in env vars');
  }
const pwd = encodeURIComponent(mongodbkey); 
const host = `${mongodbname}.mongo.cosmos.azure.com`;
let url = `mongodb://${mongodbname}:${pwd}@${host}:10255/test?ssl=true&retrywrites=false&appName=@${mongodbname}@`;
if(config.NODE_ENV === 'production'){
  url = `mongodb://${mongodbname}:${pwd}@${host}:10255/admin?ssl=true&retrywrites=false&appName=@${mongodbname}@`;
}
mongoose.connect(url);

module.exports = mongoose;