'use strict'

const config = require('../config')
const request = require('request')
const insights = require('../services/insights')
const axios = require('axios');

async function detectLanguage(text) {
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

    if (!response.data || !response.data[0] || !response.data[0].language) {
      throw new Error('Invalid response from translation service');
    }

    return response.data[0].language;

  } catch (error) {
    insights.error(error);
    console.error('Translation detection error:', error);
    
    if (error.response?.status === 401) {
      throw new Error('Authentication failed with translation service');
    }
    
    throw new Error('Failed to detect language');
  }
}

async function translateText(text, targetLang) {
  // Validar inputs
  if (!text || typeof text !== 'string') {
    throw new Error('Invalid text input for translation');
  }
  if (!targetLang || typeof targetLang !== 'string' || targetLang.length !== 2) {
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
  if (!targetLang || typeof targetLang !== 'string' || targetLang.length !== 2) {
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
