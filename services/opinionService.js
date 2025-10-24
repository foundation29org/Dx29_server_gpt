const insights = require('./insights');
const OpinionStats = require('../models/opinionstats');
const { shouldSaveToBlob } = require('../utils/blobPolicy');
const blobOpenDx29Ctrl = require('./blobOpenDx29');
const serviceEmail = require('./email');

function getHeader(req, name) {
    return req.headers[name.toLowerCase()];
}

function validateOpinionData(data) {
  const errors = [];

  if (!data || typeof data !== 'object') {
    errors.push({ field: 'request', reason: 'Request must be a JSON object' });
    return errors;
  }

  if (!data.value) {
    errors.push({ field: 'value', reason: 'Field is required' });
  } else if (typeof data.value !== 'string') {
    errors.push({ field: 'value', reason: 'Must be a string' });
  } else if (data.value.length > 10000) {
    errors.push({ field: 'value', reason: 'Must not exceed 10000 characters' });
  }

  if (!data.myuuid) {
    errors.push({ field: 'myuuid', reason: 'Field is required' });
  } else if (typeof data.myuuid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(data.myuuid)) {
    errors.push({ field: 'myuuid', reason: 'Must be a valid UUID v4' });
  }

  if (!data.vote) {
    errors.push({ field: 'vote', reason: 'Field is required' });
  } else if (typeof data.vote !== 'string' || !['up', 'down'].includes(data.vote)) {
    errors.push({ field: 'vote', reason: 'Must be either "up" or "down"' });
  }

  if (data.lang !== undefined) {
    if (typeof data.lang !== 'string' || data.lang.length < 2 || data.lang.length > 8) {
      errors.push({ field: 'lang', reason: 'Must be a valid language code (2-8 characters)' });
    }
  }

  if (!data.versionModel) {
    errors.push({ field: 'versionModel', reason: 'Field is required' });
  } else if (typeof data.versionModel !== 'string') {
    errors.push({ field: 'versionModel', reason: 'Must be a string' });
  }

  if (data.topRelatedConditions) {
    if (!Array.isArray(data.topRelatedConditions)) {
      errors.push({ field: 'topRelatedConditions', reason: 'Must be an array' });
    } else {
      data.topRelatedConditions.forEach((condition, index) => {
        if (!condition || typeof condition !== 'object') {
          errors.push({ field: `topRelatedConditions[${index}]`, reason: 'Must be an object' });
        } else if (!condition.name || typeof condition.name !== 'string') {
          errors.push({ field: `topRelatedConditions[${index}].name`, reason: 'Must be a string' });
        } else if (condition.name.length > 200) {
          errors.push({ field: `topRelatedConditions[${index}].name`, reason: 'Must not exceed 200 characters' });
        }
      });
    }
  }

  // Verificar patrones sospechosos
  const suspiciousPatterns = [
    { pattern: /\{\{[^}]*\}\}/g, reason: 'Contains Handlebars syntax' },
    { pattern: /<script\b[^>]*>[\s\S]*?<\/script>/gi, reason: 'Contains script tags' },
    { pattern: /\$\{[^}]*\}/g, reason: 'Contains template literals' },
    { pattern: /\b(prompt:|system:|assistant:|user:)\b/gi, reason: 'Contains OpenAI keywords' }
  ];

  if (data.value) {
    const normalizedValue = data.value.replace(/\n/g, ' ');
    for (const { pattern, reason } of suspiciousPatterns) {
      if (pattern.test(normalizedValue)) {
        errors.push({ field: 'value', reason: `Contains suspicious content: ${reason}` });
        break;
      }
    }
  }

  return errors;
}

function sanitizeOpinionData(data) {
  return {
    ...data,
    value: typeof data.value === 'string'
      ? data.value
        .replace(/[<>]/g, '')
        .replace(/(\{|\}|\||\\)/g, '')
        .replace(/prompt:|system:|assistant:|user:/gi, '')
        .trim()
      : '',
    myuuid: typeof data.myuuid === 'string' ? data.myuuid.trim() : '',
    lang: data.lang ? String(data.lang).trim().toLowerCase() : 'en',
    topRelatedConditions: Array.isArray(data.topRelatedConditions)
      ? data.topRelatedConditions.map(condition => ({
        ...condition,
        name: typeof condition.name === 'string'
          ? condition.name
            .replace(/[<>]/g, '')
            .replace(/(\{|\}|\||\\)/g, '')
            .trim()
          : ''
      }))
      : [],
    versionModel: typeof data.versionModel === 'string' ? data.versionModel.trim() : 'unknown'
  };
}

async function opinion(req, res) {
  try {
    // Obtener headers
    const subscriptionId = getHeader(req, 'x-subscription-id');
    const tenantId = getHeader(req, 'X-Tenant-Id');

    const validationErrors = validateOpinionData(req.body);
    if (validationErrors.length > 0) {
      insights.error({
        message: "Invalid request format or content",
        request: req.body,
        errors: validationErrors,
        tenantId: tenantId,
        subscriptionId: subscriptionId
      });
      return res.status(400).send({
        result: "error",
        message: "Invalid request format",
        details: validationErrors
      });
    }

    // Sanitizar los datos
    const sanitizedData = sanitizeOpinionData(req.body);
    sanitizedData.version = req.body.version || 'unknown';
    sanitizedData.tenantId = tenantId;
    sanitizedData.subscriptionId = subscriptionId;

    // Guardar SIEMPRE la estadística (sin value)
    const stats = new OpinionStats({
      myuuid: sanitizedData.myuuid,
      lang: sanitizedData.lang,
      vote: sanitizedData.vote,
      version: sanitizedData.version,
      topRelatedConditions: sanitizedData.topRelatedConditions,
      versionModel: sanitizedData.versionModel,
      tenantId: tenantId,
      subscriptionId: subscriptionId
    });
    await stats.save();

    // Guardar en blob SOLO si la política lo permite
    if (await shouldSaveToBlob({ tenantId, subscriptionId })) {
      await blobOpenDx29Ctrl.createBlobOpenVote(sanitizedData);
    }
    res.status(200).send({ send: true })
  } catch (e) {
    let infoError = {
      error: e,
      requestInfo: req.body,
      tenantId: tenantId,
      operation: 'opinion',
      subscriptionId: subscriptionId
    }

    insights.error(infoError);
    console.error("[ERROR] opinion responded with status: " + e)
    let lang = req.body.lang ? req.body.lang : 'en';
    serviceEmail.sendMailError(lang, req.body.value, e)
      .then(response => { })
      .catch(response => {
        insights.error(response);
        console.log('Fail sending email');
      })
    res.status(500).send('error')
  }
}

module.exports = {
  opinion,
  validateOpinionData,
  sanitizeOpinionData
}; 