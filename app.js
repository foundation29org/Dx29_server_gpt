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
const allowedOrigins = config.allowedOrigins;

function setCrossDomain(req, res, next) {
  //instead of * you can define ONLY the sources that we allow.
  //res.header('Access-Control-Allow-Origin', '*');
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin) || req.method === 'GET' || req.method === 'HEAD')  {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Access-Control-Allow-Origin, Accept, Accept-Language, Origin, User-Agent, x-api-key');
    next();
  }else{
    //send email
    const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const requestInfo = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        origin: origin,
        body: req.body, // Asegúrate de que el middleware para parsear el cuerpo ya haya sido usado
        ip: clientIp,
        params: req.params,
        query: req.query,
      };
      if(req.url.indexOf('.well-known/private-click-measurement/report-attribution') === -1){
        try {
          serviceEmail.sendMailControlCall(requestInfo)
        } catch (emailError) {
          console.log('Fail sending email');
        }
      }
    res.status(401).json({ error: 'Origin not allowed' });
  }
  
}

app.use(helmet({
  hidePoweredBy: true, // Ocultar cabecera X-Powered-By
  contentSecurityPolicy: {
    directives: {
        defaultSrc: ["'self'"],
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
            "'script-src-attr'"  // Añadido para permitir event handlers inline
        ],
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
            "https://foundation29.org"
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
            "https://www.googletagmanager.com"
        ],
        connectSrc: [
            "'self'",
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
            "https://www.google.com",
            "https://google.com",
            "https://ipinfo.io" 
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
  crossOriginEmbedderPolicy: false
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
app.use(setCrossDomain);


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
