// file that contains the routes of the api
'use strict'

const express = require('express')

const langCtrl = require('../controllers/all/lang')
const supportCtrl = require('../controllers/all/support')
const helpDiagnoseCtrl = require('../services/helpDiagnose')
const callInfoDiseaseCtrl = require('../services/callInfoDiseaseService')
const summarizeCtrl = require('../services/summarizeService')
const followUpCtrl = require('../services/followUpService')
const generalFeedbackCtrl = require('../services/generalFeedbackService')
const questionsFeedbackCtrl = require('../services/questionsFeedbackService')
const opinionCtrl = require('../services/opinionService')
const systemStatusCtrl = require('../services/systemStatusService')
const multimodalCtrl = require('../controllers/all/multimodalInput')
const permalinkCtrl = require('../controllers/all/permalink')
const pubsubRoutes = require('./pubsub')
const costTrackingRoutes = require('./costTracking')
const reprocesarErrores = require('../scripts/reprocesar_errores')
const api = express.Router()
const { smartLimiter, healthLimiter } = require('../services/rateLimiter')

// Aplicar rate limiting inteligente globalmente
api.use(smartLimiter);

api.get('/internal/langs/', smartLimiter, langCtrl.getLangs)

api.post('/internal/homesupport/', smartLimiter, supportCtrl.sendMsgLogoutSupport)

api.post('/diagnose', smartLimiter, helpDiagnoseCtrl.diagnose)

api.post('/disease/info', smartLimiter, callInfoDiseaseCtrl.callInfoDisease)

api.post('/questions/followup', smartLimiter, followUpCtrl.generateFollowUpQuestions)
api.post('/questions/emergency', smartLimiter, followUpCtrl.generateERQuestions)
api.post('/patient/update', smartLimiter, followUpCtrl.processFollowUpAnswers)

api.post('/medical/summarize', smartLimiter, summarizeCtrl.summarize)

api.post('/medical/analyze', smartLimiter, multimodalCtrl.processMultimodalInput)

api.post('/internal/status/:ticketId', smartLimiter, systemStatusCtrl.getQueueStatus)

api.get('/internal/getSystemStatus', healthLimiter, systemStatusCtrl.getSystemStatus)
api.get('/internal/health', healthLimiter, systemStatusCtrl.checkHealth)

api.post('/internal/opinion', smartLimiter, opinionCtrl.opinion)

api.post('/internal/generalfeedback', smartLimiter, generalFeedbackCtrl.sendGeneralFeedback)

api.post('/internal/questionsfeedback', smartLimiter, questionsFeedbackCtrl.sendQuestionsFeedback)

// Rutas de Permalinks
api.post('/internal/permalink', smartLimiter, permalinkCtrl.createPermalink)
api.get('/internal/permalink/:id', smartLimiter, permalinkCtrl.getPermalink)

// Rutas de Azure Web PubSub
api.use('/pubsub', smartLimiter, pubsubRoutes)

// Rutas de Cost Tracking
//api.use('/cost-tracking', smartLimiter, costTrackingRoutes)

// Rutas de reprocesar errores
//api.get('/reprocesar-errores', reprocesarErrores)

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
