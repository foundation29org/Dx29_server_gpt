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
const myApiKey = config.Server_Key;
// Lista de dominios permitidos
const whitelist = config.allowedOrigins;

  // Middleware personalizado para CORS
  function corsWithOptions(req, res, next) {
    const corsOptions = {
      origin: function (origin, callback) {
        console.log(origin);
        if (whitelist.includes(origin)) {
          callback(null, true);
        } else {
            // La IP del cliente
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
            callback(new Error('Not allowed by CORS'));
        }
      },
    };
  
    cors(corsOptions)(req, res, next);
  }

  const checkApiKey = (req, res, next) => {
    // Permitir explícitamente solicitudes de tipo OPTIONS para el "preflight" de CORS
    if (req.method === 'OPTIONS') {
      return next();
    } else {
      const apiKey = req.get('x-api-key');
      if (apiKey && apiKey === myApiKey) {
        return next();
      } else {
        return res.status(401).json({ error: 'API Key no válida o ausente' });
      }
    }
  };

// lang routes, using the controller lang, this controller has methods
api.get('/langs/',  langCtrl.getLangs)

//Support
api.post('/homesupport/', corsWithOptions, checkApiKey, supportCtrl.sendMsgLogoutSupport)

//services OPENAI
api.post('/callopenai', corsWithOptions, checkApiKey, openAIserviceCtrl.callOpenAi)
api.post('/callopenaiV2', corsWithOptions, checkApiKey, openAIserviceCtrl.callOpenAiV2)
api.post('/callopenaiquestions', corsWithOptions, checkApiKey, openAIserviceCtrl.callOpenAiQuestions)
api.post('/generatefollowupquestions', corsWithOptions, checkApiKey, openAIserviceCtrl.generateFollowUpQuestions)
api.post('/processfollowupanswers', corsWithOptions, checkApiKey, openAIserviceCtrl.processFollowUpAnswers)
api.post('/summarize', corsWithOptions, checkApiKey, openAIserviceCtrl.summarize)

api.post('/opinion', corsWithOptions, checkApiKey, openAIserviceCtrl.opinion)
api.post('/feedback', corsWithOptions, checkApiKey, openAIserviceCtrl.sendFeedback)
api.post('/generalfeedback', corsWithOptions, checkApiKey, openAIserviceCtrl.sendGeneralFeedback)
//api.get('/generalfeedback', openAIserviceCtrl.getFeedBack)


module.exports = api
