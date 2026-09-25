'use strict'

// Transcribe el audio dictado en el cliente con gpt-4o-transcribe (EU Data Zone).
// El audio solo vive en memoria durante la petición; no se guarda ni se registra.

const axios = require('axios')
const multer = require('multer')
const config = require('../../config')
const insights = require('../../services/insights')

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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_BYTES, files: 1, fields: 1 },
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

async function transcribe(req, res) {
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

  try {
    const { data } = await axios.post(endpoint.url, form, {
      headers: { 'api-key': endpoint.apiKey },
      timeout: TRANSCRIBE_TIMEOUT_MS,
      maxBodyLength: MAX_AUDIO_BYTES * 2
    })
    const text = (data?.text || '').trim()
    res.set('Cache-Control', 'no-store')
    return res.status(200).send({ text: hasSpeech(text) ? text : '' })
  } catch (error) {
    insights.error({
      message: 'Audio transcription failed',
      error: error.message,
      status: error.response?.status,
      detail: error.response?.data?.error?.code,
      audioBytes: file.buffer.length,
      mimeType,
      language,
      tenantId: req.headers['x-tenant-id']
    })
    const status = error.response?.status === 429 ? 429 : 502
    return res.status(status).send({ message: 'Could not transcribe audio' })
  }
}

module.exports = {
  transcribe
}
