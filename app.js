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
const helmet = require('helmet');
const cors = require('cors');
const allowedOrigins = config.allowedOrigins;

const isDevelopment = config.NODE_ENV === 'development' || config.NODE_ENV  === 'local';
app.use((req, res, next) => {
  console.log('Before CSP:', res.getHeader('Content-Security-Policy'));
  next();
});
app.use(helmet({
  hidePoweredBy: true, // Ocultar cabecera X-Powered-By
  contentSecurityPolicy: {
    directives: {
        defaultSrc: ["'self'"],
        scriptSrcAttr: ["'unsafe-inline'"],
        scriptSrc: [
            "'self'",
            "'unsafe-inline'",
            "'unsafe-eval'",
            "https://apis.google.com",
            "https://maps.googleapis.com",
            "https://www.google.com",
            "https://www.gstatic.com",
            "https://kit.fontawesome.com",
            "https://www.googletagmanager.com",
            "https://static.hotjar.com",
            "https://script.hotjar.com",
            "https://region1.google-analytics.com",
            "https://maps-api-v3.googleapis.com",
            "'unsafe-hashes'",
            //"'script-src-attr'"
        ],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: [
            "'self'",
            "'unsafe-inline'",
            "https://fonts.googleapis.com",
            "https://kit-free.fontawesome.com",
            "https://ka-f.fontawesome.com"
        ],
        imgSrc: [
            "'self'",
            "data:",
            "blob:",
            "https:",
            "https://maps.gstatic.com",
            "https://maps.googleapis.com",
            "https://foundation29.org",
            "https://www.googleadservices.com",
            "https://googleads.g.doubleclick.net",
            "https://www.google.com",
            "https://dxgpt.app",
            "https://www.dxgpt.app"
        ],
        fontSrc: [
            "'self'",
            "data:",
            "https://fonts.gstatic.com",
            "https://kit-free.fontawesome.com",
            "https://ka-f.fontawesome.com",
            "https://script.hotjar.com"
        ],
        frameSrc: [
            "'self'",
            "https://www.google.com",
            "https://vars.hotjar.com",
            "https://www.googletagmanager.com",
            "https://app.powerbi.com"
        ],
        connectSrc: [
            "'self'",
            ...(isDevelopment ? ["http://localhost:*", "ws://localhost:*"] : []),
            "http://localhost:8443",
            "https://apis.google.com",
            "https://maps.googleapis.com",
            "https://*.hotjar.com",
            "wss://*.hotjar.com",
            "https://*.hotjar.io",
            "https://*.google-analytics.com",
            "https://analytics.google.com",
            "https://stats.g.doubleclick.net",
            "https://ka-f.fontawesome.com",
            "https://region1.google-analytics.com",
            "https://ipinfo.io",
            "https://www.google.com",
            "https://google.com",
            "https://www.googletagmanager.com",
            "https://www.googleadservices.com",
            "https://googleads.g.doubleclick.net",
            "https://fonts.gstatic.com"
        ],
        workerSrc: ["'self'", "blob:"],
        childSrc: ["blob:"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"]
    }
  },
  frameguard: {
      action: 'DENY'
  },
  hidePoweredBy: true,
  hsts: {
      maxAge: 63072000,
      includeSubDomains: true,
      preload: true
  },
  ieNoOpen: true,
  noSniff: true,
  xssFilter: true,
  referrerPolicy: {
      policy: 'no-referrer-when-downgrade'
  },
  crossOriginEmbedderPolicy: false,  // Necesario para recursos de terceros
}));

app.use((req, res, next) => {
  console.log('After CSP:', res.getHeader('Content-Security-Policy'));
  next();
});

app.use(cors({
  origin: [
    'https://dxgpt.app', 
    'https://www.dxgpt.app', 
    'https://dxgpt-dev.azurewebsites.net', 
    'http://localhost:4200',
    'http://localhost:8443'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'Access-Control-Allow-Origin','Accept', 'Accept-Language', 'Origin', 'User-Agent'],
}));

app.use((req, res, next) => {
  // Eliminar cabeceras que exponen información
  res.removeHeader('X-Powered-By');
  res.removeHeader('Server');
  res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Permissions-Policy', 
    'geolocation=(), camera=(), microphone=(), payment=(), usb=()');
  next();
});

app.use(bodyParser.urlencoded({limit: '1mb', extended: false}))
app.use(bodyParser.json({
  limit: '1mb',
  strict: true // Rechazar payload que no sea JSON válido
}));


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
