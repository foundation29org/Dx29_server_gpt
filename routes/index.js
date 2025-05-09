// file that contains the routes of the api
'use strict'

const express = require('express')

const langCtrl = require('../controllers/all/lang')
const supportCtrl = require('../controllers/all/support')
const openAIserviceCtrl = require('../services/openaiazure')
const cors = require('cors');
const serviceEmail = require('../services/email')
const api = express.Router()
const config= require('../config')
const { needsLimiter, healthLimiter, globalLimiter } = require('../services/rateLimiter')
const myApiKey = config.Server_Key;
// Lista de dominios permitidos
const whitelist = config.allowedOrigins;
api.use(globalLimiter);

  // Middleware personalizado para CORS
  function corsWithOptions(req, res, next) {
    const corsOptions = {
      origin: function (origin, callback) {
        // Si no hay origin y el host es uno de nuestros dominios permitidos, permitir la petición
        /*if (!origin) {
          const host = req.headers.host;
          if (whitelist.some(allowed => allowed.includes(host))) {
            callback(null, true);
            return;
          }else{
            callback(new Error('Not allowed by CORS'));
          }
        }*/

        if (!origin) {
          return callback(new Error('Missing Origin header')); // Bloquear sin origin
        }
        // Para peticiones con origin, verificar whitelist
        if (whitelist.includes(origin)) {
          callback(null, true);
        } else {
          /*const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
          const requestInfo = {
            method: req.method,
            url: req.url,
            headers: req.headers,
            origin: origin,
            body: req.body,
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
          callback(new Error('Not allowed by CORS'));
        }
      }
    };
  
    cors(corsOptions)(req, res, next);
  }

  const checkApiKey = (req, res, next) => {
    const apiKey = req.get('x-api-key');
    if (apiKey && apiKey === myApiKey) {
      return next();
    } else {
      return res.status(401).json({ error: 'API Key no válida o ausente' });
    }
  };

// lang routes, using the controller lang, this controller has methods
api.get('/langs/', needsLimiter, langCtrl.getLangs)

//Support
api.post('/homesupport/', corsWithOptions, checkApiKey, needsLimiter, supportCtrl.sendMsgLogoutSupport)

//services OPENAI
api.post('/callopenai', corsWithOptions, checkApiKey, needsLimiter, openAIserviceCtrl.callOpenAi)
api.post('/callopenaiV2', corsWithOptions, checkApiKey, needsLimiter, openAIserviceCtrl.callOpenAiV2)
api.post('/callopenaiquestions', corsWithOptions, checkApiKey, needsLimiter, openAIserviceCtrl.callOpenAiQuestions)
api.post('/generatefollowupquestions', corsWithOptions, checkApiKey, needsLimiter, openAIserviceCtrl.generateFollowUpQuestions)
api.post('/generateerquestions', corsWithOptions, checkApiKey, needsLimiter, openAIserviceCtrl.generateERQuestions)
api.post('/processfollowupanswers', corsWithOptions, checkApiKey, needsLimiter, openAIserviceCtrl.processFollowUpAnswers)
api.post('/summarize', corsWithOptions, checkApiKey, needsLimiter, openAIserviceCtrl.summarize)
api.post('/queue-status/:ticketId', corsWithOptions, checkApiKey, needsLimiter, openAIserviceCtrl.getQueueStatus)
api.get('/getSystemStatus', checkApiKey, needsLimiter, openAIserviceCtrl.getSystemStatus)
api.get('/health', checkApiKey, healthLimiter, openAIserviceCtrl.checkHealth)

api.post('/opinion', corsWithOptions, checkApiKey, needsLimiter, openAIserviceCtrl.opinion)
api.post('/generalfeedback', corsWithOptions, checkApiKey, needsLimiter, openAIserviceCtrl.sendGeneralFeedback)
api.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    // Dejar pasar los OPTIONS (preflight) para CORS
    return next();
  }
  
  if (req.originalUrl.startsWith('/admin') || req.originalUrl.startsWith('/host')) {
    return res.status(403).send('Forbidden');
  }
  
  // El resto ➔ 404 Not Found
  res.status(404).send('Not found');
});

module.exports = api
