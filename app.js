/*
* EXPRESS CONFIGURATION FILE
*/
'use strict'

const express = require('express');
const compression = require('compression');
const bodyParser = require('body-parser');
const config = require('./config');
const app = express();
app.set('trust proxy', 1);
app.use(compression());
const serviceEmail = require('./services/email');
const api = require('./routes');
const cors = require('cors');

const isLocal = process.env.NODE_ENV === 'local'
if (isLocal) {
  app.use(cors({
    origin: '*', // O pon la URL de tu frontend, ej: 'http://localhost:4200'
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Ocp-Apim-Subscription-Key', 'X-MS-AUTH-TOKEN', 'X-Tenant-Id'],
  }));
}

// Middlewares básicos
app.use(bodyParser.urlencoded({ limit: '50mb', extended: false }));
app.use(bodyParser.json({ limit: '50mb' }));


// API y //rutas
app.use('/api', api);

// Middleware general para redireccionar rutas sin /api a /api
/*app.use((req, res, next) => {
  // Verificar si la ruta no empieza con /api
  if (!req.path.startsWith('/api')) {
    // Reescribir la URL para añadir el prefijo /api
    req.url = '/api' + req.url;
    // Reenviar a las rutas de la API
    return api(req, res, next);
  }
  next();
});*/

module.exports = app;