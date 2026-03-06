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

    if (data.healthcareSpecialty !== undefined) {
      if (typeof data.healthcareSpecialty !== 'string' || data.healthcareSpecialty.length > 200) {
        errors.push({ field: 'healthcareSpecialty', reason: 'Must be a string with a maximum of 200 characters' });
      }
    }

    if (data.inferenceMeta !== undefined) {
      if (!data.inferenceMeta || typeof data.inferenceMeta !== 'object' || Array.isArray(data.inferenceMeta)) {
        errors.push({ field: 'inferenceMeta', reason: 'Must be an object' });
      } else {
        const serializedMeta = JSON.stringify(data.inferenceMeta);
        if (serializedMeta.length > 10000) {
          errors.push({ field: 'inferenceMeta', reason: 'Must not exceed 10000 characters once serialized' });
        }
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
  const sanitizeOptionalText = (text, maxLength = 200) => {
    if (text === undefined || text === null || text === '') return null;
    const sanitized = sanitizeText(String(text));
    return sanitized.length > maxLength ? sanitized.slice(0, maxLength) : sanitized;
  };
  const sanitizeOptionalBoolean = (value) => (typeof value === 'boolean' ? value : null);
  const sanitizeOptionalNumber = (value, min = null, max = null) => {
    if (value === undefined || value === null || value === '') return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    if (min !== null && numeric < min) return null;
    if (max !== null && numeric > max) return null;
    return numeric;
  };

  const rawInferenceMeta = data.inferenceMeta && typeof data.inferenceMeta === 'object' && !Array.isArray(data.inferenceMeta)
    ? data.inferenceMeta
    : null;

  const sanitizedInferenceMeta = rawInferenceMeta
    ? {
      hasSuggestions: sanitizeOptionalBoolean(rawInferenceMeta.hasSuggestions),
      suggestedUserType: sanitizeOptionalText(rawInferenceMeta.suggestedUserType, 100),
      suggestedTopSpecialties: Array.isArray(rawInferenceMeta.suggestedTopSpecialties)
        ? rawInferenceMeta.suggestedTopSpecialties
          .map((item) => sanitizeOptionalText(item, 200))
          .filter(Boolean)
          .slice(0, 3)
        : [],
      feedbackAutofillRecommended: sanitizeOptionalBoolean(rawInferenceMeta.feedbackAutofillRecommended),
      confidence: sanitizeOptionalNumber(rawInferenceMeta.confidence, 0, 1),
      confidenceThreshold: sanitizeOptionalNumber(rawInferenceMeta.confidenceThreshold, 0, 1),
      autofillApplied: sanitizeOptionalBoolean(rawInferenceMeta.autofillApplied),
      autofilledUserType: sanitizeOptionalText(rawInferenceMeta.autofilledUserType, 100),
      autofilledHealthcareSpecialty: sanitizeOptionalText(rawInferenceMeta.autofilledHealthcareSpecialty, 200),
      finalUserType: sanitizeOptionalText(rawInferenceMeta.finalUserType, 100),
      finalHealthcareSpecialty: sanitizeOptionalText(rawInferenceMeta.finalHealthcareSpecialty, 200),
      changedUserType: sanitizeOptionalBoolean(rawInferenceMeta.changedUserType),
      changedPrimarySpecialty: sanitizeOptionalBoolean(rawInferenceMeta.changedPrimarySpecialty),
      changedAfterAutofill: sanitizeOptionalBoolean(rawInferenceMeta.changedAfterAutofill),
      selectedFromTop3: sanitizeOptionalBoolean(rawInferenceMeta.selectedFromTop3),
      selectedTop3Rank: sanitizeOptionalNumber(rawInferenceMeta.selectedTop3Rank, 1, 3),
      selectedViaSuggestedPill: sanitizeOptionalBoolean(rawInferenceMeta.selectedViaSuggestedPill),
      suggestedPillClicks: sanitizeOptionalNumber(rawInferenceMeta.suggestedPillClicks, 0, 1000)
    }
    : null;

  const healthcareSpecialty = sanitizeText(data.healthcareSpecialty || '');
  const hasHealthcareSpecialty = healthcareSpecialty.length > 0;
  const providedHealthcareSpecialty = hasHealthcareSpecialty;

  return {
    ...data,
    myuuid: data.myuuid.trim(),
    lang: data.lang ? data.lang.trim().toLowerCase() : 'en',
    healthcareSpecialty: healthcareSpecialty,
    providedHealthcareSpecialty: providedHealthcareSpecialty,
    inferenceMeta: sanitizedInferenceMeta,
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
    healthcareSpecialty: generalfeedback.healthcareSpecialty,
    providedHealthcareSpecialty: generalfeedback.providedHealthcareSpecialty,
    lang: lang,
    tenantId: tenantId,
    subscriptionId: subscriptionId
  }

  const endpointUrl = config.client_server.indexOf('dxgpt.app') === -1
    ? 'https://default163d001a45914200a300b9062d2e31.ec.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/6b6ab71c5e514ce08788a3a0599e9f0e/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=X-kFUWvqV0tMlPuKvzuKDYcrlSr6OcWY13_egHaV85U'
    : 'https://default163d001a45914200a300b9062d2e31.ec.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/28e2bf2fb424494f8f82890efb4fcbbf/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=pqqiiqIKGD1-O7I0j3T8ZD5N_R87XQMaBCt2vFVdupM';

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

  // Validar que al menos uno de los dos headers esté presente
  // APIM convierte Ocp-Apim-Subscription-Key a x-subscription-id, tenants envían X-Tenant-Id
  if (!tenantId && !subscriptionId) {
    insights.error({
      message: "Missing required headers: at least one of X-Tenant-Id or Ocp-Apim-Subscription-Key is required",
      headers: req.headers,
      endpoint: 'sendGeneralFeedback'
    });
    return res.status(400).send({
      result: "error",
      message: "Missing required headers: at least one of X-Tenant-Id or Ocp-Apim-Subscription-Key is required"
    });
  }

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
    let isBetaPage = sanitizedData.isBetaPage || false;
    const generalfeedback = new Generalfeedback({
      myuuid: sanitizedData.myuuid,
      pregunta1: sanitizedData.value.pregunta1,
      pregunta2: sanitizedData.value.pregunta2,
      userType: sanitizedData.value.userType,
      moreFunct: sanitizedData.value.moreFunct,
      freeText: sanitizedData.value.freeText,
      email: sanitizedData.value.email,
      healthcareSpecialty: sanitizedData.healthcareSpecialty,
      providedHealthcareSpecialty: sanitizedData.providedHealthcareSpecialty,
      inferenceMeta: sanitizedData.inferenceMeta,
      date: new Date(Date.now()).toString(),
      fileNames: sanitizedData.fileNames,
      model: sanitizedData.model,
      tenantId: tenantId,
      subscriptionId: subscriptionId,
      isBetaPage: isBetaPage
    });
    sendFlow(generalfeedback, sanitizedData.lang, tenantId, subscriptionId)
    await generalfeedback.save();
    try {
      const mailPayload = {
        ...sanitizedData.value,
        healthcareSpecialty: sanitizedData.healthcareSpecialty,
        providedHealthcareSpecialty: sanitizedData.providedHealthcareSpecialty
      };
      await serviceEmail.sendMailGeneralFeedback(mailPayload, sanitizedData.myuuid, tenantId, subscriptionId, sanitizedData.fileNames, sanitizedData.model, isBetaPage);
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