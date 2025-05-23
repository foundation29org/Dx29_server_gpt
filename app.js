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
const allowedOrigins = config.allowedOrigins;



function setCrossDomain(req, res, next) {
  //instead of * you can define ONLY the sources that we allow.
  //res.header('Access-Control-Allow-Origin', '*');
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin) || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS')  {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Methods', 'HEAD,GET,PUT,POST,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Access-Control-Allow-Origin, Accept, Accept-Language, Origin, User-Agent, ocp-apim-subscription-key, Ocp-Apim-Subscription-Key');
    
    // Para solicitudes OPTIONS (preflight), enviar 200 OK inmediatamente
    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }
    next();
  }else{
    //send email
    /*const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
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
      }*/
    res.status(401).json({ error: 'Origin not allowed' });
  }
  
}

// Middlewares básicos
app.use(bodyParser.urlencoded({ limit: '50mb', extended: false }));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(setCrossDomain);

// API y rutas
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