// file that contains the routes of the api
'use strict'

const express = require('express')

const langCtrl = require('../controllers/all/lang')
const supportCtrl = require('../controllers/all/support')
const openAIserviceCtrl = require('../services/openai2')
const translationCtrl = require('../services/translation')
const ta4hserviceCtrl = require('../services/ta4h')

const api = express.Router()

// lang routes, using the controller lang, this controller has methods
api.get('/langs/',  langCtrl.getLangs)

//Support
api.post('/homesupport/', supportCtrl.sendMsgLogoutSupport)
api.post('/subscribe/', supportCtrl.sendMsSubscribe)

api.post('/senderror', supportCtrl.sendError)

//services OPENAI
api.post('/callopenai', openAIserviceCtrl.callOpenAi)

//services OPENAI
api.post('/opinion', openAIserviceCtrl.opinion)

api.post('/feedback', openAIserviceCtrl.sendFeedback)


api.post('/getDetectLanguage', translationCtrl.getDetectLanguage)
api.post('/translation', translationCtrl.getTranslationDictionary)
api.post('/translationinvert', translationCtrl.getTranslationDictionaryInvert)
api.post('/translation/segments', translationCtrl.getTranslationSegments)

//services ta4h
api.post('/callTextAnalytics', ta4hserviceCtrl.callTextAnalytics)

module.exports = api
