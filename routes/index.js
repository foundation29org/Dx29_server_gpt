// file that contains the routes of the api
'use strict'

const express = require('express')

const langCtrl = require('../controllers/all/lang')
const supportCtrl = require('../controllers/all/support')
const serviceDxGPTCtrl = require('../services/servicedxgpt')
const multimodalCtrl = require('../controllers/all/multimodalInput')
const api = express.Router()
const { needsLimiter, healthLimiter, globalLimiter } = require('../services/rateLimiter')
// Lista de dominios permitidos
api.use(globalLimiter);

api.get('/internal/langs/', needsLimiter, langCtrl.getLangs)

api.post('/internal/homesupport/', needsLimiter, supportCtrl.sendMsgLogoutSupport)

api.post('/diagnose', needsLimiter, serviceDxGPTCtrl.diagnose)

api.post('/disease/info', needsLimiter, serviceDxGPTCtrl.callInfoDisease)

api.post('/questions/followup', needsLimiter, serviceDxGPTCtrl.generateFollowUpQuestions)
api.post('/questions/emergency', needsLimiter, serviceDxGPTCtrl.generateERQuestions)
api.post('/patient/update', needsLimiter, serviceDxGPTCtrl.processFollowUpAnswers)

api.post('/medical/summarize', needsLimiter, serviceDxGPTCtrl.summarize)

api.post('/medical/analyze', needsLimiter, multimodalCtrl.processMultimodalInput)

api.post('/internal/status/:ticketId', needsLimiter, serviceDxGPTCtrl.getQueueStatus)

api.get('/internal/getSystemStatus', needsLimiter, serviceDxGPTCtrl.getSystemStatus)
api.get('/internal/health', healthLimiter, serviceDxGPTCtrl.checkHealth)

api.post('/internal/opinion', needsLimiter, serviceDxGPTCtrl.opinion)

api.post('/internal/generalfeedback', needsLimiter, serviceDxGPTCtrl.sendGeneralFeedback)

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
