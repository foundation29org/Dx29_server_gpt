/*
* EXPRESS CONFIGURATION FILE
*/
'use strict'

const express = require('express')
const compression = require('compression');
const bodyParser = require('body-parser');
const config = require('./config')
const app = express()
app.use(compression());
const serviceEmail = require('./services/email')
const api = require ('./routes')
const path = require('path')
const allowedOrigins = config.allowedOrigins;

function setCrossDomain(req, res, next) {
  const origin = req.headers.origin;
  const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

  // Evitar alertas o bloqueos por IPs internas de Azure o sin IP válida
  /*const isInternalIp = ip => {
    return !ip || ip.startsWith('::ffff:169.254.') || ip.startsWith('169.254.');
  };

  if (isInternalIp(clientIp)) {
    // Opcional: puedes hacer un next() aquí si quieres permitir health checks internos
    return res.status(401).json({ error: 'Blocked internal or missing IP' });
  }*/

  if (allowedOrigins.includes(origin) || req.method === 'GET' || req.method === 'HEAD') {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Methods', 'HEAD,GET,PUT,POST,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Access-Control-Allow-Origin, Accept, Accept-Language, Origin, User-Agent, x-api-key');
    return next();
  } else {
    return res.status(401).json({ error: 'Origin not allowed' });
  }
}

app.use(bodyParser.urlencoded({limit: '50mb', extended: false}))
app.use(bodyParser.json({limit: '50mb'}))
app.use(setCrossDomain);

app.options('*', (req, res) => {
  console.log(`[CORS PRE-FLIGHT] ${req.method} ${req.path} from ${req.headers.origin}`);
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'HEAD,GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
    return res.sendStatus(200);
  } else {
    return res.sendStatus(403);
  }
});

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
