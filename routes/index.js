// file that contains the routes of the api
'use strict'

const express = require('express')

const langCtrl = require('../controllers/all/lang')
const supportCtrl = require('../controllers/all/support')
const serviceDxGPTCtrl = require('../services/servicedxgpt')
const multimodalCtrl = require('../controllers/all/multimodalInput')
const permalinkCtrl = require('../controllers/all/permalink')
const pubsubRoutes = require('./pubsub')
const costTrackingRoutes = require('./costTracking')
const api = express.Router()
const { smartLimiter, healthLimiter } = require('../services/rateLimiter')

// Aplicar rate limiting inteligente globalmente
api.use(smartLimiter);

api.get('/internal/langs/', smartLimiter, langCtrl.getLangs)

api.post('/internal/homesupport/', smartLimiter, supportCtrl.sendMsgLogoutSupport)

api.post('/diagnose', smartLimiter, serviceDxGPTCtrl.diagnose)

api.post('/disease/info', smartLimiter, serviceDxGPTCtrl.callInfoDisease)

api.post('/questions/followup', smartLimiter, serviceDxGPTCtrl.generateFollowUpQuestions)
api.post('/questions/emergency', smartLimiter, serviceDxGPTCtrl.generateERQuestions)
api.post('/patient/update', smartLimiter, serviceDxGPTCtrl.processFollowUpAnswers)

api.post('/medical/summarize', smartLimiter, serviceDxGPTCtrl.summarize)

api.post('/medical/analyze', smartLimiter, multimodalCtrl.processMultimodalInput)

api.post('/internal/status/:ticketId', smartLimiter, serviceDxGPTCtrl.getQueueStatus)

api.get('/internal/getSystemStatus', healthLimiter, serviceDxGPTCtrl.getSystemStatus)
api.get('/internal/health', healthLimiter, serviceDxGPTCtrl.checkHealth)

api.post('/internal/opinion', smartLimiter, serviceDxGPTCtrl.opinion)

api.post('/internal/generalfeedback', smartLimiter, serviceDxGPTCtrl.sendGeneralFeedback)

// Rutas de Permalinks
api.post('/internal/permalink', smartLimiter, permalinkCtrl.createPermalink)
api.get('/internal/permalink/:id', smartLimiter, permalinkCtrl.getPermalink)

// Rutas de Azure Web PubSub
api.use('/pubsub', smartLimiter, pubsubRoutes)

// Rutas de Cost Tracking
//api.use('/cost-tracking', smartLimiter, costTrackingRoutes)

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
