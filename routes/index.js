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
const speechTranscribeCtrl = require('../controllers/all/speechTranscribe')
const pubsubRoutes = require('./pubsub')
const reprocesarErrores = require('../scripts/reprocesar_errores')
const api = express.Router()
const { smartLimiter, healthLimiter } = require('../services/rateLimiter')

// Rate limiting de todo lo que cuelga de /api, incluidas rutas desconocidas.
// Va UNA sola vez: poner smartLimiter también en cada ruta cuenta cada
// petición dos veces y deja el tope en la mitad (50 en vez de 100 / 15 min).
// Solo healthLimiter se añade por ruta: tiene su propio contador.
api.use(smartLimiter);

api.get('/internal/langs/', langCtrl.getLangs)

api.post('/internal/homesupport/', supportCtrl.sendMsgLogoutSupport)

api.post('/diagnose', helpDiagnoseCtrl.diagnose)
api.post('/ask', helpDiagnoseCtrl.ask)

api.post('/disease/info', callInfoDiseaseCtrl.callInfoDisease)

api.post('/questions/followup', followUpCtrl.generateFollowUpQuestions)
api.post('/questions/emergency', followUpCtrl.generateERQuestions)
api.post('/patient/update', followUpCtrl.processFollowUpAnswers)

api.post('/medical/summarize', summarizeCtrl.summarize)

api.post('/medical/analyze', multimodalCtrl.processMultimodalInput)
api.delete('/medical/upload/:uploadId', multimodalCtrl.deleteUpload)

api.post('/internal/status/:ticketId', systemStatusCtrl.getQueueStatus)

api.get('/internal/getSystemStatus', healthLimiter, systemStatusCtrl.getSystemStatus)
api.get('/internal/health', healthLimiter, systemStatusCtrl.checkHealth)

api.post('/internal/opinion', opinionCtrl.opinion)

api.post('/internal/generalfeedback', generalFeedbackCtrl.sendGeneralFeedback)

api.post('/internal/questionsfeedback', questionsFeedbackCtrl.sendQuestionsFeedback)

// Rutas de Permalinks
api.post('/internal/permalink', permalinkCtrl.createPermalink)
api.get('/internal/permalink/:id', permalinkCtrl.getPermalink)

// Dictado por voz: audio -> texto. Solo tenants, no forma parte de la API pública.
api.post('/internal/speech/transcribe', speechTranscribeCtrl.transcribe)

// Rutas de Azure Web PubSub
api.use('/pubsub', pubsubRoutes)

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
