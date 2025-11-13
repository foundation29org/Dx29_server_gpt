const config = require('../config');
const serviceEmail = require('./email');
const insights = require('./insights');
const Generalfeedback = require('../models/generalfeedback');
const axios = require('axios');

function getHeader(req, name) {
    return req.headers[name.toLowerCase()];
}

function validateGeneralFeedbackData(data) {
    const errors = [];
  
    if (!data || typeof data !== 'object') {
      errors.push({ field: 'request', reason: 'Request must be a JSON object' });
      return errors;
    }
  
    if (!data.value || typeof data.value !== 'object') {
      errors.push({ field: 'value', reason: 'Field is required and must be an object' });
    } else {
      // Validar campos específicos del formulario
      const formFields = {
        pregunta1: (val) => typeof val === 'number' && val >= 0 && val <= 5,
        pregunta2: (val) => typeof val === 'number' && val >= 0 && val <= 5,
        userType: (val) => typeof val === 'string' && val.length < 100,
        moreFunct: (val) => typeof val === 'string' && val.length < 1000,
        freeText: (val) => !val || (typeof val === 'string' && val.length < 2000),
        email: (val) => !val || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)
      };
      for (const [field, validator] of Object.entries(formFields)) {
        if (field === 'freeText' || field === 'email') {
          if (data.value[field] && !validator(data.value[field])) {
            errors.push({ field: `value.${field}`, reason: 'Invalid format' });
          }
        } else {
          if (!data.value.hasOwnProperty(field)) {
            errors.push({ field: `value.${field}`, reason: 'Field is required' });
          } else if (!validator(data.value[field])) {
            errors.push({ field: `value.${field}`, reason: 'Invalid format' });
          }
        }
      }
    }
  
    if (!data.myuuid) {
      errors.push({ field: 'myuuid', reason: 'Field is required' });
    } else if (typeof data.myuuid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(data.myuuid)) {
      errors.push({ field: 'myuuid', reason: 'Must be a valid UUID v4' });
    }
  
    if (data.lang !== undefined) {
      if (typeof data.lang !== 'string' || data.lang.length < 2 || data.lang.length > 8) {
        errors.push({ field: 'lang', reason: 'Must be a valid language code (2-8 characters)' });
      }
    }
  
    return errors;
  }

function sanitizeGeneralFeedbackData(data) {
  const sanitizeText = (text) => {
    if (!text) return text;
    return text
      .replace(/[<>]/g, '')
      .replace(/(\{|\}|\||\\)/g, '')
      .replace(/prompt:|system:|assistant:|user:/gi, '')
      .trim();
  };

  return {
    ...data,
    myuuid: data.myuuid.trim(),
    lang: data.lang ? data.lang.trim().toLowerCase() : 'en',
    value: {
      ...data.value,
      userType: sanitizeText(data.value.userType),
      moreFunct: sanitizeText(data.value.moreFunct),
      freeText: sanitizeText(data.value.freeText),
      email: data.value.email?.trim().toLowerCase(),
      // Mantener los valores numéricos sin cambios
      pregunta1: data.value.pregunta1,
      pregunta2: data.value.pregunta2
    }
  };
}

async function sendFlow(generalfeedback, lang, tenantId, subscriptionId) {
  let requestBody = {
    myuuid: generalfeedback.myuuid,
    pregunta1: generalfeedback.pregunta1,
    pregunta2: generalfeedback.pregunta2,
    userType: generalfeedback.userType,
    moreFunct: generalfeedback.moreFunct,
    freeText: generalfeedback.freeText,
    date: generalfeedback.date,
    email: generalfeedback.email,
    lang: lang,
    tenantId: tenantId,
    subscriptionId: subscriptionId
  }

  const endpointUrl = config.client_server.indexOf('dxgpt.app') === -1
    ? 'https://prod-63.westeurope.logic.azure.com:443/workflows/6b6ab71c5e514ce08788a3a0599e9f0e/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=M6yotP-WV7WoEB-QhKbrJPib9kgScK4f2Z1X6x5N8Ps'
    : 'https://prod-180.westeurope.logic.azure.com:443/workflows/28e2bf2fb424494f8f82890efb4fcbbf/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=WwF6wOV9cd4n1-AIfPZ4vnRmWx_ApJDXJH2QdtvK2BU';

  try {
    await axios.post(endpointUrl, requestBody, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.log(error)
    console.error('Error al enviar datos:', error.message);
    let infoError = {
      error: error,
      requestInfo: requestBody,
      tenantId: tenantId,
      operation: 'sendFlow',
      subscriptionId: subscriptionId
    }
    insights.error(infoError);
  }
}

async function sendGeneralFeedback(req, res) {
  // Obtener headers
  const subscriptionId = getHeader(req, 'x-subscription-id');
  const tenantId = getHeader(req, 'X-Tenant-Id');

  try {
    // Validar los datos de entrada
    const validationErrors = validateGeneralFeedbackData(req.body);
    if (validationErrors.length > 0) {
      return res.status(400).send({
        result: "error",
        message: "Invalid request format",
        details: validationErrors
      });
    }

    // Sanitizar los datos
    const sanitizedData = sanitizeGeneralFeedbackData(req.body);
    const generalfeedback = new Generalfeedback({
      myuuid: sanitizedData.myuuid,
      pregunta1: sanitizedData.value.pregunta1,
      pregunta2: sanitizedData.value.pregunta2,
      userType: sanitizedData.value.userType,
      moreFunct: sanitizedData.value.moreFunct,
      freeText: sanitizedData.value.freeText,
      email: sanitizedData.value.email,
      date: new Date(Date.now()).toString(),
      fileNames: sanitizedData.fileNames,
      model: sanitizedData.model,
      tenantId: tenantId,
      subscriptionId: subscriptionId
    });
    sendFlow(generalfeedback, sanitizedData.lang, tenantId, subscriptionId)
    await generalfeedback.save();
    try {
      await serviceEmail.sendMailGeneralFeedback(sanitizedData.value, sanitizedData.myuuid, tenantId, subscriptionId, sanitizedData.fileNames, sanitizedData.model);
    } catch (emailError) {
      insights.error(emailError);
      console.log('Fail sending email');
    }

    return res.status(200).send({ send: true })
  } catch (e) {
    let infoError = {
      error: e,
      requestInfo: req.body,
      tenantId: tenantId,
      operation: 'sendGeneralFeedback',
      subscriptionId: subscriptionId
    }
    insights.error(infoError);
    console.error("[ERROR] sendGeneralFeedback responded with status: " + e)
    try {
      let lang = req.body.lang ? req.body.lang : 'en';
      await serviceEmail.sendMailError(lang, req.body, e);
    } catch (emailError) {
      insights.error(emailError);
      console.log('Fail sending email');
    }

    return res.status(500).send('error')
  }
}

module.exports = {
  sendGeneralFeedback,
  sendFlow,
  sanitizeGeneralFeedbackData
}; 