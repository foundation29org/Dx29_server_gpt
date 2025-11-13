const insights = require('./insights');
const QuestionsFeedback = require('../models/questionsfeedback');

function getHeader(req, name) {
  return req.headers[name.toLowerCase()];
}

function validateQuestionsFeedbackData(data) {
  const errors = [];

  if (!data || typeof data !== 'object') {
    errors.push({ field: 'request', reason: 'Request must be a JSON object' });
    return errors;
  }

  if (!data.myuuid || typeof data.myuuid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(data.myuuid)) {
    errors.push({ field: 'myuuid', reason: 'Must be a valid UUID v4' });
  }

  if (data.lang !== undefined) {
    if (typeof data.lang !== 'string' || data.lang.length < 2 || data.lang.length > 8) {
      errors.push({ field: 'lang', reason: 'Must be a valid language code (2-8 characters)' });
    }
  }

  if (!data.type || typeof data.type !== 'string' || data.type.length > 100) {
    errors.push({ field: 'type', reason: 'Field is required and must be a string' });
  }

  if (typeof data.helpful !== 'boolean') {
    errors.push({ field: 'helpful', reason: 'Field is required and must be boolean' });
  }

  if (data.comments !== undefined && (typeof data.comments !== 'string' || data.comments.length > 4000)) {
    errors.push({ field: 'comments', reason: 'Invalid format' });
  }

  if (data.email !== undefined && (typeof data.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email))) {
    errors.push({ field: 'email', reason: 'Invalid email' });
  }

  if (data.question !== undefined && (typeof data.question !== 'string' || data.question.length > 8000)) {
    errors.push({ field: 'question', reason: 'Invalid format' });
  }

  if (data.answerHtml !== undefined && (typeof data.answerHtml !== 'string' || data.answerHtml.length > 200000)) {
    errors.push({ field: 'answerHtml', reason: 'Invalid format' });
  }

  if (data.references !== undefined && !Array.isArray(data.references)) {
    errors.push({ field: 'references', reason: 'Must be an array' });
  }

  if (data.detectedLang !== undefined && data.detectedLang !== '') {
    if (typeof data.detectedLang !== 'string' || data.detectedLang.trim().length < 2 || data.detectedLang.trim().length > 8) {
      errors.push({ field: 'detectedLang', reason: 'Must be a valid language code (2-8 characters)' });
    }
  }

  if (data.model !== undefined && (typeof data.model !== 'string' || data.model.length > 200)) {
    errors.push({ field: 'model', reason: 'Invalid format' });
  }

  if (data.fileNames !== undefined && !(typeof data.fileNames === 'string' || Array.isArray(data.fileNames))) {
    errors.push({ field: 'fileNames', reason: 'Must be string or array' });
  }

  return errors;
}

function sanitizeQuestionsFeedbackData(data) {
  const sanitizeText = (text) => {
    if (!text) return text;
    return text
      .replace(/[<>]/g, '')
      .replace(/(\{|\}|\||\\)/g, '')
      .replace(/prompt:|system:|assistant:|user:/gi, '')
      .trim();
  };

  const sanitizeHtml = (html) => {
    if (!html || typeof html !== 'string') return html;
    // Eliminar etiquetas <script> peligrosas manteniendo el resto del HTML
    return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  };

  let fileNames = data.fileNames;
  if (Array.isArray(fileNames)) {
    try { fileNames = JSON.stringify(fileNames); } catch (_) { fileNames = ''; }
  }

  let references = data.references;
  if (Array.isArray(references)) {
    try { references = JSON.stringify(references); } catch (_) { references = ''; }
  }

  return {
    ...data,
    myuuid: data.myuuid.trim(),
    lang: data.lang ? data.lang.trim().toLowerCase() : 'en',
    detectedLang: data.detectedLang ? data.detectedLang.trim().toLowerCase() : undefined,
    type: sanitizeText(data.type),
    comments: sanitizeText(data.comments),
    email: data.email ? data.email.trim().toLowerCase() : undefined,
    question: sanitizeText(data.question),
    answerHtml: sanitizeHtml(data.answerHtml),
    model: data.model ? data.model.trim() : undefined,
    fileNames: typeof fileNames === 'string' ? fileNames : undefined,
    references: typeof references === 'string' ? references : undefined
  };
}

async function sendQuestionsFeedback(req, res) {
  const subscriptionId = getHeader(req, 'x-subscription-id');
  const tenantId = getHeader(req, 'X-Tenant-Id');

  try {
    const validationErrors = validateQuestionsFeedbackData(req.body);
    if (validationErrors.length > 0) {
      return res.status(400).send({
        result: 'error',
        message: 'Invalid request format',
        details: validationErrors
      });
    }

    const sanitized = sanitizeQuestionsFeedbackData(req.body);

    const record = new QuestionsFeedback({
      myuuid: sanitized.myuuid,
      type: sanitized.type,
      helpful: sanitized.helpful,
      comments: sanitized.comments,
      email: sanitized.email,
      question: sanitized.question,
      answerHtml: sanitized.answerHtml,
      detectedLang: sanitized.detectedLang,
      model: sanitized.model,
      fileNames: sanitized.fileNames,
      references: sanitized.references,
      date: new Date(Date.now()).toString(),
      tenantId: tenantId,
      subscriptionId: subscriptionId
    });

    await record.save();
    return res.status(200).send({ send: true });
  } catch (e) {
    let infoError = {
      error: e,
      requestInfo: req.body,
      tenantId: tenantId,
      operation: 'sendQuestionsFeedback',
      subscriptionId: subscriptionId
    };
    insights.error(infoError);
    return res.status(500).send('error');
  }
}

module.exports = {
  sendQuestionsFeedback,
  sanitizeQuestionsFeedbackData
};


