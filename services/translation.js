'use strict'

const config = require('../config')
const request = require('request')
const insights = require('../services/insights')
const axios = require('axios');

async function detectLanguage(text, lang) {
  // Validar input
  if (!text || typeof text !== 'string') {
    throw new Error('Invalid text input for language detection');
  }

  const jsonText = [{ "Text": text }];
  const translationKey = config.translationKey;

  try {
    const response = await axios.post(
      'https://api.cognitive.microsofttranslator.com/detect?api-version=3.0',
      jsonText,
      {
        headers: {
          'Content-Type': 'application/json',
          'Ocp-Apim-Subscription-Key': translationKey,
          'Ocp-Apim-Subscription-Region': 'northeurope'
        }
      }
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
    if (detectionResult.score < confidenceThreshold && lang == 'es') {
      return lang;
    }else{
      return detectionResult.language;
    }

  } catch (error) {
    throw error;
  }
}

async function translateText(text, targetLang) {
  // Validar inputs
  if (!text || typeof text !== 'string') {
    throw new Error('Invalid text input for translation');
  }
  if (!targetLang || typeof targetLang !== 'string') {
    throw new Error('Invalid target language for translation');
  }

  const jsonText = [{ "Text": text }];
  const translationKey = config.translationKey;

  try {
    const response = await axios.post(
      `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&&from=${targetLang}&to=en`,
      jsonText,
      {
        headers: {
          'Content-Type': 'application/json',
          'Ocp-Apim-Subscription-Key': translationKey,
          'Ocp-Apim-Subscription-Region': 'northeurope'
        }
      }
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
    insights.error(error);
    console.error('Translation error:', error);
    
    if (error.response?.status === 401) {
      throw new Error('Authentication failed with translation service');
    }
    
    throw new Error('Failed to translate text');
  }
}

async function translateInvert(text, targetLang) {
  // Validar inputs
  if (!text || typeof text !== 'string') {
    throw new Error('Invalid text input for translation');
  }
  if (!targetLang || typeof targetLang !== 'string') {
    throw new Error('Invalid target language for translation');
  }

  const jsonText = [{ "Text": text }];
  const translationKey = config.translationKey;

  try {
    const response = await axios.post(
      `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=${targetLang}`,
      jsonText,
      {
        headers: {
          'Content-Type': 'application/json',
          'Ocp-Apim-Subscription-Key': translationKey,
          'Ocp-Apim-Subscription-Region': 'northeurope'
        }
      }
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
    insights.error(error);
    console.error('Translation invert error:', error);
    
    if (error.response?.status === 401) {
      throw new Error('Authentication failed with translation service');
    }
    
    throw new Error('Failed to translate text from English');
  }
}

function translateSegments(text, lang){

  var translationKey = config.translationKey;
  request.post({url:'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&&from=en&to='+lang+'&textType=html',json: true,headers: {'Ocp-Apim-Subscription-Key': translationKey, 'Ocp-Apim-Subscription-Region': 'northeurope' },body:text}, (error, response, body) => {
      if (error) {
        console.error(error)
        insights.error(error);
        res.status(500).send(error)
      }
      if(body=='Missing authentication token.'){
        res.status(401).send(body)
      }else{
        res.status(200).send(body)
      }
  
    });
  }

module.exports = {
  detectLanguage,
  translateText,
  translateInvert,
  translateSegments
}
