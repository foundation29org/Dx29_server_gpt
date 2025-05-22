'use strict'

const insights = require('../services/insights')
const axios = require('axios');

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
      const error = new Error(`Detected language '${detectionResult.language}' is not supported for translation (confidence: ${detectionResult.score})`);
      error.code = 'UNSUPPORTED_LANGUAGE';
      throw error;
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

  const jsonText = [{ "Text": text }];
  const headers = {
    'Content-Type': 'application/json',
    'Ocp-Apim-Subscription-Key': endpoint.key
  };

  if (endpoint.region) {  
    headers['Ocp-Apim-Subscription-Region'] = endpoint.region;
  }

  try {
    const response = await axios.post(
      `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&&from=${targetLang}&to=en`,
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
    let infoError = {
      text: text,
      targetLang: targetLang,
      endpoint: endpoint,
      error: error.message
    }
    insights.error(infoError);
    console.error('Translation error:', error);
    
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

  const jsonText = [{ "Text": text }];
  const headers = {
    'Content-Type': 'application/json',
    'Ocp-Apim-Subscription-Key': endpoint.key
  };

  if (endpoint.region) {
    headers['Ocp-Apim-Subscription-Region'] = endpoint.region;
  }

  try {
    const response = await axios.post(
      `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=${targetLang}`,
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
    let infoError = {
      text: text,
      targetLang: targetLang,
      endpoint: endpoint,
      error: error.message
    }
    insights.error(infoError);
    console.error('Translation invert error:', error);
    
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
