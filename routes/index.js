// file that contains the routes of the api
'use strict'

const express = require('express')

const langCtrl = require('../controllers/all/lang')
const supportCtrl = require('../controllers/all/support')
const openAIserviceCtrl = require('../services/openaiazure')
const translationCtrl = require('../services/translation')
const ta4hserviceCtrl = require('../services/ta4h')
const cors = require('cors');

const api = express.Router()

// Lista de dominios permitidos
const whitelist = ['https://dxgpt.app'];
//const whitelist = ['https://dxgpt.app', 'http://localhost:4200'];
const corsOptions = {
    origin: function (origin, callback) {
        console.log(origin)
      if (whitelist.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    }
  };

// lang routes, using the controller lang, this controller has methods
api.get('/langs/',  langCtrl.getLangs)

//Support
api.post('/homesupport/', cors(corsOptions), supportCtrl.sendMsgLogoutSupport)
api.post('/subscribe/', cors(corsOptions), supportCtrl.sendMsSubscribe)

api.post('/senderror', cors(corsOptions), supportCtrl.sendError)

//services OPENAI
api.post('/callopenai', cors(corsOptions), openAIserviceCtrl.callOpenAi)
api.post('/callanonymized', cors(corsOptions), openAIserviceCtrl.callOpenAiAnonymized)

//services OPENAI
api.post('/opinion', cors(corsOptions), openAIserviceCtrl.opinion)

api.post('/feedback', cors(corsOptions), openAIserviceCtrl.sendFeedback)

api.post('/generalfeedback', cors(corsOptions), openAIserviceCtrl.sendGeneralFeedback)
//api.get('/generalfeedback', openAIserviceCtrl.getFeedBack)


api.post('/getDetectLanguage', cors(corsOptions), translationCtrl.getDetectLanguage)
api.post('/translation', cors(corsOptions), translationCtrl.getTranslationDictionary)
api.post('/translationinvert', cors(corsOptions), translationCtrl.getTranslationDictionaryInvert)
api.post('/translation/segments', cors(corsOptions), translationCtrl.getTranslationSegments)

//services ta4h
api.post('/callTextAnalytics', cors(corsOptions), ta4hserviceCtrl.callTextAnalytics)

module.exports = api
