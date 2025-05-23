// file that contains the routes of the api
'use strict'

const express = require('express')

const langCtrl = require('../controllers/all/lang')
const supportCtrl = require('../controllers/all/support')
const serviceDxGPTCtrl = require('../services/servicedxgpt')
const cors = require('cors');
const serviceEmail = require('../services/email')
const api = express.Router()
const config= require('../config')
const { needsLimiter, healthLimiter, globalLimiter } = require('../services/rateLimiter')
// Lista de dominios permitidos
const whitelist = config.allowedOrigins;
api.use(globalLimiter);

api.get('/langs/', needsLimiter, langCtrl.getLangs)

api.post('/homesupport/', needsLimiter, supportCtrl.sendMsgLogoutSupport)

api.post('/diagnose', needsLimiter, serviceDxGPTCtrl.diagnose)

api.post('/disease/info', needsLimiter, serviceDxGPTCtrl.callInfoDisease)

api.post('/questions/followup', needsLimiter, serviceDxGPTCtrl.generateFollowUpQuestions)
api.post('/questions/emergency', needsLimiter, serviceDxGPTCtrl.generateERQuestions)
api.post('/patient/update', needsLimiter, serviceDxGPTCtrl.processFollowUpAnswers)

api.post('/medical/summarize', needsLimiter, serviceDxGPTCtrl.summarize)

api.post('/status/:ticketId', needsLimiter, serviceDxGPTCtrl.getQueueStatus)

api.get('/getSystemStatus', needsLimiter, serviceDxGPTCtrl.getSystemStatus)
api.get('/health', healthLimiter, serviceDxGPTCtrl.checkHealth)

api.post('/opinion', needsLimiter, serviceDxGPTCtrl.opinion)

api.post('/generalfeedback', needsLimiter, serviceDxGPTCtrl.sendGeneralFeedback)

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
