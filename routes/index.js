// file that contains the routes of the api
'use strict'

const express = require('express')

const langCtrl = require('../controllers/all/lang')
const supportCtrl = require('../controllers/all/support')
const openAIserviceCtrl = require('../services/openai')

const api = express.Router()

// lang routes, using the controller lang, this controller has methods
api.get('/langs/',  langCtrl.getLangs)

//Support
api.post('/homesupport/', supportCtrl.sendMsgLogoutSupport)

//services OPENAI
api.post('/callopenai', openAIserviceCtrl.callOpenAi)

//services OPENAI
api.post('/opinion', openAIserviceCtrl.opinion)

module.exports = api
