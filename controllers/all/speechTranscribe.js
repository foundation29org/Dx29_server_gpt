'use strict'

// Transcribe el audio dictado en el cliente con gpt-4o-transcribe (EU Data Zone).
// El audio solo vive en memoria durante la petición; no se guarda. Solo se registra el coste.

const axios = require('axios')
const multer = require('multer')
const config = require('../../config')
const insights = require('../../services/insights')
const { extractProviderError } = require('../../services/aiUtils')
const CostTrackingService = require('../../services/costTrackingService')
const { calculateTranscriptionPrice } = require('../../services/costUtils')

const TRANSCRIBE_MODEL = 'gpt4o-transcribe'

// ~10 min de Opus a 128 kbps; el límite de la API es 25 MB.
const MAX_AUDIO_BYTES = 10 * 1024 * 1024
const TRANSCRIBE_TIMEOUT_MS = 60000

// La API deduce el formato por la extensión del nombre de archivo.
const AUDIO_EXTENSIONS = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav'
}

const baseMimeType = (mimeType) => (mimeType || '').split(';')[0].trim().toLowerCase()

// Pista de idioma (idioma de la interfaz, ISO-639-1). Sin ella, en audios cortos o poco
// claros el modelo puede detectar mal el idioma y devolver texto en otro alfabeto.
// Es solo una pista: si se dicta en otro idioma, se transcribe en ese idioma.
const languageHint = (value) => (/^[a-z]{2}$/.test(value || '') ? value : null)

// Respuestas sin letras ni números (".", "…") son silencio, no dictado.
const hasSpeech = (text) => /[\p{L}\p{N}]/u.test(text)

// Azure contesta 400 invalid_value ("Audio file might be corrupted or unsupported") cuando no
// puede decodificar el audio, p. ej. un WebM de unos segundos mal cerrado. Es un fallo del
// archivo, no del servicio: reenviarlo no lo arregla.
const isUnreadableAudio = (error) =>
  error.response?.status === 400 && error.response?.data?.error?.code === 'invalid_value'

// 400 para que el cliente no reintente (solo reintenta 429, 5xx y fallos de red).
function failureStatus(error) {
  if (isUnreadableAudio(error)) return 400
  return error.response?.status === 429 ? 429 : 502
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_BYTES, files: 1, fields: 3 },
  fileFilter: (req, file, cb) => {
    if (AUDIO_EXTENSIONS[baseMimeType(file.mimetype)]) {
      cb(null, true)
    } else {
      cb(Object.assign(new Error('Unsupported audio format'), { httpStatus: 415 }))
    }
  }
}).single('audio')

function parseAudio(req, res) {
  return new Promise((resolve, reject) => {
    upload(req, res, (error) => (error ? reject(error) : resolve(req.file)))
  })
}

function transcriptionEndpoint() {
  const { region, deployment, apiVersion } = config.AZURE_OPENAI_TRANSCRIBE
  const regionConfig = config.AZURE_OPENAI_REGIONS[region]
  if (!regionConfig?.baseUrl || !regionConfig?.apiKey) return null
  return {
    url: `${regionConfig.baseUrl}/openai/deployments/${deployment}/audio/transcriptions?api-version=${apiVersion}`,
    apiKey: regionConfig.apiKey
  }
}

function saveTranscriptionCost({ tenantId, body, usage, durationMs, success, error }) {
  const price = calculateTranscriptionPrice(usage)
  const stage = {
    name: 'speech_transcription',
    cost: price.totalCost,
    tokens: { input: price.inputTokens, output: price.outputTokens, total: price.totalTokens },
    model: TRANSCRIBE_MODEL,
    duration: durationMs,
    success
  }
  const data = {
    myuuid: body?.myuuid || 'unknown',
    tenantId,
    lang: languageHint(body?.language) || 'unknown',
    timezone: body?.timezone || 'unknown'
  }
  const failure = error ? { message: error.message, code: String(error.response?.status || '') } : null
  return CostTrackingService.saveSimpleOperationCostBestEffort(data, 'speech_transcribe', stage, success ? 'success' : 'error', failure)
}

async function transcribe(req, res) {
  // Solo tenants. La barrera real es APIM: esta ruta no está en la API pública.
  const tenantId = req.headers['x-tenant-id']
  if (!tenantId) {
    return res.status(403).send({ message: 'Speech transcription is only available to tenants' })
  }

  const endpoint = transcriptionEndpoint()
  if (!endpoint) {
    return res.status(503).send({ message: 'Transcription service not configured' })
  }

  let file
  try {
    file = await parseAudio(req, res)
  } catch (error) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : (error.httpStatus || 400)
    return res.status(status).send({ message: error.message })
  }
  if (!file?.buffer?.length) {
    return res.status(400).send({ message: 'Missing audio' })
  }

  const mimeType = baseMimeType(file.mimetype)
  const form = new FormData()
  form.append('file', new Blob([file.buffer], { type: mimeType }), `dictation.${AUDIO_EXTENSIONS[mimeType]}`)
  form.append('response_format', 'json')
  const language = languageHint(req.body?.language)
  if (language) form.append('language', language)

  const startedAt = Date.now()
  try {
    const { data } = await axios.post(endpoint.url, form, {
      headers: { 'api-key': endpoint.apiKey },
      timeout: TRANSCRIBE_TIMEOUT_MS,
      maxBodyLength: MAX_AUDIO_BYTES * 2
    })
    saveTranscriptionCost({ tenantId, body: req.body, usage: data?.usage, durationMs: Date.now() - startedAt, success: true })
    const text = (data?.text || '').trim()
    res.set('Cache-Control', 'no-store')
    return res.status(200).send({ text: hasSpeech(text) ? text : '' })
  } catch (error) {
    saveTranscriptionCost({ tenantId, body: req.body, durationMs: Date.now() - startedAt, success: false, error })
    // insights.error solo promueve unos pocos campos del objeto `message`; el resto
    // (uuid, estado, motivo del proveedor, tamaño) debe ir como `properties` o se pierde.
    const telemetry = {
      myuuid: req.body?.myuuid || 'unknown',
      statusCode: String(error.response?.status || 'network'),
      audioBytes: String(file.buffer.length),
      language: language || 'none',
      ...extractProviderError(error)
    }
    const status = failureStatus(error)
    if (status === 400) {
      // Un archivo que Azure no abre no es una caída del servicio: evento, no excepción.
      insights.trackEvent('AudioTranscriptionRejected', { mimeType, tenantId, ...telemetry })
      return res.status(400).send({ message: 'Could not read the audio' })
    }
    insights.error(
      {
        message: 'Audio transcription failed',
        error: error.message,
        mimeType,
        tenantId
      },
      telemetry
    )
    return res.status(status).send({ message: 'Could not transcribe audio' })
  }
}

module.exports = {
  transcribe,
  failureStatus
}
