/*
* EXPRESS CONFIGURATION FILE
*/
'use strict'

const express = require('express')
const compression = require('compression');
const bodyParser = require('body-parser');
const config= require('./config')
const app = express()
// habilitar compresión 
app.use(compression());

const myApiKey = config.Server_Key;


const api = require ('./routes')
const path = require('path')
//CORS middleware
const allowedOrigins = ['https://dxgpt.app', 'http://localhost:4200'];

function setCrossDomain(req, res, next) {
  //instead of * you can define ONLY the sources that we allow.
  //res.header('Access-Control-Allow-Origin', '*');
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  //http methods allowed for CORS.
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Access-Control-Allow-Origin, Accept, Accept-Language, Origin, User-Agent, x-api-key');
  //res.header('Access-Control-Allow-Headers', '*');
  next();
}

app.use(bodyParser.urlencoded({limit: '50mb', extended: false}))
app.use(bodyParser.json({limit: '50mb'}))
app.use(setCrossDomain);

const checkApiKey = (req, res, next) => {
  // Permitir explícitamente solicitudes de tipo OPTIONS para el "preflight" de CORS
  if (req.method === 'OPTIONS') {
    next();
  } else {
    const apiKey = req.get('x-api-key');
    if (apiKey && apiKey === myApiKey) {
      next();
    } else {
      res.status(401).json({ error: 'API Key no válida o ausente' });
    }
  }
};

app.use(checkApiKey);

// use the forward slash with the module api api folder created routes
app.use('/api',api)

app.use('/apidoc',express.static('apidoc', {'index': ['index.html']}))

//ruta angular, poner carpeta dist publica
app.use(express.static(path.join(__dirname, 'dist')));
// Send all other requests to the Angular app
app.get('*', function (req, res, next) {
    res.sendFile('dist/index.html', { root: __dirname });
 });
module.exports = app
