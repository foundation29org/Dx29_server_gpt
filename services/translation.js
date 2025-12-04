'use strict'

const insights = require('../services/insights')
const axios = require('axios');

const SUPPORTED = require('./translatorSupported.json');
const NORMALIZE = require('./langNormalize.json');

function normalizeSourceLang(lang) {
  if (!lang) return null;

  let code = lang.trim().toLowerCase();

  // Aplico normalizaciones (tl -> fil, etc.)
  if (NORMALIZE[code]) {
    code = NORMALIZE[code];
  }

  // Si después de normalizar sigue sin estar soportado, dejamos que Azure autodetecte
  if (!SUPPORTED[code]) {
    return null; // clave: null => no pondremos &from=
  }

  return code;
}

function normalizeTargetLang(lang) {
  if (!lang) return 'en';

  let code = lang.trim().toLowerCase();

  if (NORMALIZE[code]) {
    code = NORMALIZE[code];
  }

  // Si no está soportado, devolvemos 'en' como fallback
  if (!SUPPORTED[code]) {
    return 'en';
  }

  return code;
}


async function detectLanguage(text, lang, endpoint) {
  // Validar input
  if (!text || typeof text !== 'string') {
    throw new Error('Invalid text input for language detection');
  }

  const jsonText = [{ "Text": text }];

  try {

    const headers = {
      'Content-Type': 'application/json',
      'Ocp-Apim-Subscription-Key': endpoint.key
    };

    if (endpoint.region) {
      headers['Ocp-Apim-Subscription-Region'] = endpoint.region;
    }

    const response = await axios.post(
      'https://api.cognitive.microsofttranslator.com/detect?api-version=3.0',
      jsonText,
      { headers }
    );

    if (!response.data || !response.data[0]) {
      const error = new Error('Invalid response from translation service');
      error.code = 'TRANSLATION_ERROR';
      throw error;
    }

    const detectionResult = response.data[0];
    
    if (!detectionResult.isTranslationSupported) {

      const raw = detectionResult.language;
      const normalized = normalizeTargetLang(raw); // o normalizeSourceLang, según prefieras
      
      // Si la normalización da algo distinto de 'en', mejor usamos eso
      if (normalized !== 'en') {
        return normalized;
      }

      const error = new Error(
        `Detected language '${detectionResult.language}' is not supported for translation (confidence: ${detectionResult.score})`
      );
      error.code = 'UNSUPPORTED_LANGUAGE';
      insights.error?.({
        type: 'UNSUPPORTED_LANGUAGE',
        raw,
        normalized,
        score: detectionResult.score,
        message: error.message,
      });
      
      return 'en';
    }

    const confidenceThreshold = 0.9;
    if (detectionResult.score < confidenceThreshold) {
      if (lang === 'es' || (lang && detectionResult.score < 0.7)) {
        return lang;
      }
    }
    return detectionResult.language;

  } catch (error) {
    let infoError = {
      text: text,
      lang: lang,
      error: error.message,
      endpoint: endpoint
    }
    insights.error(infoError);
    throw error;
  }
}

async function translateText(text, targetLang, endpoint) {
  // Validar inputs
  if (!text || typeof text !== 'string') {
    throw new Error('Invalid text input for translation');
  }
  if (!targetLang || typeof targetLang !== 'string') {
    throw new Error('Invalid target language for translation');
  }

  const sourceLang = normalizeSourceLang(targetLang);

  const jsonText = [{ "Text": text }];
  const headers = {
    'Content-Type': 'application/json',
    'Ocp-Apim-Subscription-Key': endpoint.key
  };

  if (endpoint.region) {  
    headers['Ocp-Apim-Subscription-Region'] = endpoint.region;
  }

  let url =
    'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=en';

  // Añadimos &from solo si tenemos un idioma origen soportado
  if (sourceLang) {
    url += `&from=${encodeURIComponent(sourceLang)}`;
  }

  try {
    const response = await axios.post(
      url,
      jsonText,
      { headers }
    );

    if (!response.data || 
        !response.data[0] || 
        !response.data[0].translations || 
        !response.data[0].translations[0] || 
        !response.data[0].translations[0].text) {
      throw new Error('Invalid response from translation service');
    }
    return response.data[0].translations[0].text;

  } catch (error) {
    const infoError = {
      text,
      fromLang: targetLang,
      normalizedFrom: sourceLang,
      endpoint,
      error: error.message,
      translatorError: error.response?.data,
    };
    insights.error(infoError);
    console.error('Translation error:', error.response?.data || error);
    
    if (error.response?.status === 401) {
      throw new Error('Authentication failed with translation service');
    }
    
    throw new Error('Failed to translate text');
  }
}

async function translateInvert(text, targetLang, endpoint) {
  // Validar inputs
  if (!text || typeof text !== 'string') {
    throw new Error('Invalid text input for translation');
  }
  if (!targetLang || typeof targetLang !== 'string') {
    throw new Error('Invalid target language for translation');
  }

  const normalizedTarget = normalizeTargetLang(targetLang);
  if (normalizedTarget === 'en') {
    // Si al normalizar acabamos en inglés, no tiene sentido traducir
    return text;
  }

  const jsonText = [{ "Text": text }];
  const headers = {
    'Content-Type': 'application/json',
    'Ocp-Apim-Subscription-Key': endpoint.key
  };

  if (endpoint.region) {
    headers['Ocp-Apim-Subscription-Region'] = endpoint.region;
  }

  const url = `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=${encodeURIComponent(
    normalizedTarget
  )}`;

  try {
    const response = await axios.post(
      url,
      jsonText,
      { headers }
    );

    if (!response.data || 
        !response.data[0] || 
        !response.data[0].translations || 
        !response.data[0].translations[0] || 
        !response.data[0].translations[0].text) {
      throw new Error('Invalid response from translation service');
    }

    return response.data[0].translations[0].text;

  } catch (error) {
    const infoError = {
      text,
      originalTargetLang: targetLang,
      normalizedTargetLang: normalizedTarget,
      endpoint,
      error: error.message,
      translatorError: error.response?.data,
    };
    insights.error(infoError);
    console.error('Translation invert error:', error.response?.data || error);
    
    if (error.response?.status === 401) {
      throw new Error('Authentication failed with translation service');
    }
    
    throw new Error('Failed to translate text from English');
  }
}

module.exports = {
  detectLanguage,
  translateText,
  translateInvert
}
