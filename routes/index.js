// file that contains the routes of the api
'use strict'

const express = require('express')

const langCtrl = require('../controllers/all/lang')
const supportCtrl = require('../controllers/all/support')
const openAIserviceCtrl = require('../services/openaiazure')
const translationCtrl = require('../services/translation')
const ta4hserviceCtrl = require('../services/ta4h')
const cors = require('cors');
const serviceEmail = require('../services/email')
const api = express.Router()

// Lista de dominios permitidos
const whitelist = ['https://dxgpt.app'];
//const whitelist = ['https://dxgpt.app', 'http://localhost:4200'];

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
            serviceEmail.sendMailControlCall(requestInfo)
            callback(new Error('Not allowed by CORS'));
        }
      },
    };
  
    cors(corsOptions)(req, res, next);
  }

// lang routes, using the controller lang, this controller has methods
api.get('/langs/',  langCtrl.getLangs)

//Support
api.post('/homesupport/', corsWithOptions, supportCtrl.sendMsgLogoutSupport)
api.post('/subscribe/', corsWithOptions, supportCtrl.sendMsSubscribe)

api.post('/senderror', corsWithOptions, supportCtrl.sendError)

//services OPENAI
api.post('/callopenai', corsWithOptions, openAIserviceCtrl.callOpenAi)
api.post('/callanonymized', corsWithOptions, openAIserviceCtrl.callOpenAiAnonymized)

//services OPENAI
api.post('/opinion', corsWithOptions, openAIserviceCtrl.opinion)

api.post('/feedback', corsWithOptions, openAIserviceCtrl.sendFeedback)

api.post('/generalfeedback', corsWithOptions, openAIserviceCtrl.sendGeneralFeedback)
//api.get('/generalfeedback', openAIserviceCtrl.getFeedBack)


api.post('/getDetectLanguage', corsWithOptions, translationCtrl.getDetectLanguage)
api.post('/translation', corsWithOptions, translationCtrl.getTranslationDictionary)
api.post('/translationinvert', corsWithOptions, translationCtrl.getTranslationDictionaryInvert)
api.post('/translation/segments', corsWithOptions, translationCtrl.getTranslationSegments)

//services ta4h
api.post('/callTextAnalytics', corsWithOptions, ta4hserviceCtrl.callTextAnalytics)

module.exports = api
