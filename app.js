/*
* EXPRESS CONFIGURATION FILE
*/
'use strict'

const express = require('express');
const compression = require('compression');
const bodyParser = require('body-parser');
const geoip = require('geoip-lite');
const config = require('./config');
const app = express();

app.use(compression());
const serviceEmail = require('./services/email');
const api = require('./routes');
const path = require('path');

const allowedOrigins = config.allowedOrigins;

function getRealIp(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0] || req.connection.remoteAddress || '').trim();
}

function isInternalIp(ip) {
  return (
    !ip ||
    ip.startsWith('::ffff:169.254.') ||
    ip.startsWith('169.254.') ||
    ip === '::1'
  );
}

function setCrossDomain(req, res, next) {
  const origin = req.headers.origin;
  const clientIp = getRealIp(req);

  // ⚠️ Bloqueo de IPs internas
  if (isInternalIp(clientIp)) {
    console.warn(`⛔ Bloqueada IP interna o no válida: ${clientIp}`);
    return res.status(401).json({ error: 'Blocked internal or missing IP' });
  }

  // 🌍 Bloqueo por país (opcional)
  const geo = geoip.lookup(clientIp);
  const blockedCountries = ['RU', 'BY', 'KP'];
  if (geo && blockedCountries.includes(geo.country)) {
    console.warn(`🌍 Acceso bloqueado desde país: ${geo.country} (${clientIp})`);
    return res.status(403).json({ error: 'Access denied by geo-block' });
  }

  // ✅ CORS válido
  if (allowedOrigins.includes(origin) || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Methods', 'HEAD,GET,PUT,POST,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Access-Control-Allow-Origin, Accept, Accept-Language, Origin, User-Agent, x-api-key');
    return next();
  } else {
    console.warn(`❌ Origin no permitido: ${origin}`);
    return res.status(401).json({ error: 'Origin not allowed' });
  }
}

// Middlewares básicos
app.use(bodyParser.urlencoded({ limit: '50mb', extended: false }));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(setCrossDomain);

// Opciones CORS preflight
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

// API y rutas
app.use('/api', api);
app.use('/apidoc', express.static('apidoc', { 'index': ['index.html'] }));

// Frontend Angular
app.use(express.static(path.join(__dirname, 'dist')));
app.get('*', function (req, res, next) {
  res.sendFile('dist/index.html', { root: __dirname });
});

module.exports = app;