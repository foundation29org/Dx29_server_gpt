const config = require('../config')
const insights = require('../services/insights')
const blobOpenDx29Ctrl = require('../services/blobOpenDx29')
const serviceEmail = require('../services/email')
const Support = require('../models/support')
const Generalfeedback = require('../models/generalfeedback')
const axios = require('axios');
const ApiManagementKey = config.API_MANAGEMENT_KEY;
const supportService = require('../controllers/all/support');
const { encodingForModel } = require("js-tiktoken");
const translationCtrl = require('../services/translation')
const PROMPTS = require('../assets/prompts');
const queueService = require('./queueService');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function sanitizeInput(input) {
  // Eliminar caracteres especiales y patrones potencialmente peligrosos
  return input
    .replace(/[<>{}]/g, '') // Eliminar caracteres especiales
    .replace(/(\{|\}|\[|\]|\||\\|\/)/g, '') // Eliminar caracteres que podrían ser usados para inyección
    .replace(/prompt:|system:|assistant:|user:/gi, '') // Eliminar palabras clave de OpenAI con ':'
    .trim();
}

function isValidOpenAiRequest(data) {
  // Validar estructura básica
  if (!data || typeof data !== 'object') return false;

  // Validar campos requeridos (timezone no incluido)
  const requiredFields = ['description', 'myuuid', 'operation', 'lang'];
  if (!requiredFields.every(field => data.hasOwnProperty(field))) return false;

  // Validar description
  if (typeof data.description !== 'string' ||
    data.description.length < 10 ||
    data.description.length > 8000) return false;

  // Validar myuuid
  if (typeof data.myuuid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(data.myuuid)) {
    return false;
  }

  // Validar operation
  if (data.operation !== 'find disease') return false;

  // Validar lang
  if (typeof data.lang !== 'string' || data.lang.length !== 2) return false;

  // Validar timezone si existe
  if (data.timezone !== undefined && typeof data.timezone !== 'string') {
    return false;
  }

  // Validar diseases_list si existe
  if (data.diseases_list !== undefined &&
    (typeof data.diseases_list !== 'string' || data.diseases_list.length > 1000)) {
    return false;
  }

  // Verificar patrones sospechosos
  const suspiciousPatterns = [
    /\{\{[^}]*\}\}/g,  // Handlebars syntax
    /<script\b[^>]*>[\s\S]*?<\/script>/gi,  // Scripts
    /\$\{[^}]*\}/g,    // Template literals
    // Modificar la detección de palabras clave para evitar falsos positivos
    /\b(prompt:|system:|assistant:|user:)\b/gi  // OpenAI keywords con ':'
];

// Normalizar el texto para la validación
const normalizedDescription = data.description.replace(/\n/g, ' ');
const normalizedDiseasesList = data.diseases_list || '';

return !suspiciousPatterns.some(pattern => {
    const descriptionMatch = pattern.test(normalizedDescription);
    const diseasesMatch = data.diseases_list && pattern.test(normalizedDiseasesList);
    
    if (descriptionMatch || diseasesMatch) {
        console.log('Pattern matched:', pattern);
        console.log('In description:', descriptionMatch);
        console.log('In diseases list:', diseasesMatch);
        insights.error({
          message: "Pattern matched",
          pattern: pattern,
          description: descriptionMatch,
          diseases_list: diseasesMatch
        });
    }
    
    return descriptionMatch || diseasesMatch;
});
}

function sanitizeOpenAiData(data) {
  return {
    ...data,
    description: sanitizeInput(data.description),
    diseases_list: data.diseases_list ? sanitizeInput(data.diseases_list) : '',
    myuuid: data.myuuid.trim(),
    lang: data.lang.trim().toLowerCase(),
    timezone: data.timezone?.trim() || '' // Manejar caso donde timezone es undefined
  };
}

// Añadir esta constante al inicio del archivo, junto con las otras constantes
  const endpointsMap = {
    gpt4o: {
      asia: [
      `https://apiopenai.azure-api.net/v2/as1/call/gpt4o`, // India: 428 calls/min
      `https://apiopenai.azure-api.net/v2/as2/call/gpt4o`  // Japan: 300 calls/min
      ],
      europe: [
      `https://apiopenai.azure-api.net/v2/eu1/call/gpt4o`, // Suiza: 428 calls/min
      `https://apiopenai.azure-api.net/v2/us1/call/gpt4o`  // WestUS: 857 calls/min como backup
      ],
      northamerica: [
      `https://apiopenai.azure-api.net/v2/us1/call/gpt4o`, // WestUS: 857 calls/min
      `https://apiopenai.azure-api.net/v2/us2/call/gpt4o`  // EastUS2: 420 calls/min
      ],
      southamerica: [
      `https://apiopenai.azure-api.net/v2/us1/call/gpt4o`, // WestUS: 857 calls/min
      `https://apiopenai.azure-api.net/v2/us2/call/gpt4o`  // EastUS2: 420 calls/min
      ],
      africa: [
      `https://apiopenai.azure-api.net/v2/us1/call/gpt4o`, // WestUS: 857 calls/min
      `https://apiopenai.azure-api.net/v2/as2/call/gpt4o`  // Japan: 300 calls/min
      ],
      oceania: [
      `https://apiopenai.azure-api.net/v2/as2/call/gpt4o`, // Japan: 300 calls/min
      `https://apiopenai.azure-api.net/v2/us1/call/gpt4o`  // WestUS: 857 calls/min como backup
      ],
      other: [
      `https://apiopenai.azure-api.net/v2/us1/call/gpt4o`, // WestUS: 857 calls/min
      `https://apiopenai.azure-api.net/v2/as2/call/gpt4o`  // Japan: 300 calls/min
      ]
    },
    o1: {
      asia: [
      `https://apiopenai.azure-api.net/v2/as1/call/o1`, // India
      `https://apiopenai.azure-api.net/v2/as2/call/o1`  // Japan
      ],
      europe: [
      `https://apiopenai.azure-api.net/v2/eu1/call/o1`, // Suiza
      `https://apiopenai.azure-api.net/v2/us1/call/o1`  // WestUS como backup
      ],
      northamerica: [
      `https://apiopenai.azure-api.net/v2/us1/call/o1`, // WestUS
      `https://apiopenai.azure-api.net/v2/us2/call/o1`  // EastUS2
      ],
      southamerica: [
      `https://apiopenai.azure-api.net/v2/us1/call/o1`, // WestUS
      `https://apiopenai.azure-api.net/v2/us2/call/o1`  // EastUS2
      ],
      africa: [
      `https://apiopenai.azure-api.net/v2/us1/call/o1`, // WestUS
      `https://apiopenai.azure-api.net/v2/as2/call/o1`  // Japan
      ],
      oceania: [
      `https://apiopenai.azure-api.net/v2/as2/call/o1`, // Japan
      `https://apiopenai.azure-api.net/v2/us1/call/o1`  // WestUS como backup
      ],
      other: [
      `https://apiopenai.azure-api.net/v2/us1/call/o1`, // WestUS
      `https://apiopenai.azure-api.net/v2/as2/call/o1`  // Japan
    ]
  }
};

// Modificar la función getEndpointsByTimezone para usar esta constante
function getEndpointsByTimezone(timezone, model = 'gpt4o', mode = 'call') {
  const tz = timezone?.split('/')[0]?.toLowerCase();
  const region = (() => {
    if (tz?.includes('america')) return 'northamerica';
    if (tz?.includes('europe')) return 'europe';
    if (tz?.includes('asia')) return 'asia';
    if (tz?.includes('africa')) return 'africa';
    if (tz?.includes('australia') || tz?.includes('pacific')) return 'oceania';
    return 'other';
  })();
  const suffix = mode === 'anonymized' ? 'anonymized' : 'call';

  const endpoints = endpointsMap[model]?.[region] || endpointsMap[model].other;
  return endpoints.map(endpoint => endpoint.replace('/call/', `/${suffix}/`));
}

// También necesitamos un mapeo de regiones para el status
const REGION_MAPPING_STATUS = {
  'asia': 'India',
  'europe': 'Suiza',
  'northamerica': 'WestUS',
  'southamerica': 'WestUS',
  'africa': 'WestUS',
  'oceania': 'Japan',
  'other': 'WestUS'
};

// Añadir esta constante para definir las capacidades de cada región
const REGION_CAPACITY = config.REGION_CAPACITY;

async function callOpenAiWithFailover(requestBody, timezone, model = 'gpt4o', retryCount = 0) {
  const RETRY_DELAY = 1000;

  const endpoints = getEndpointsByTimezone(timezone, model, 'call');
  try {
    const response = await axios.post(endpoints[retryCount], requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': ApiManagementKey,
      }
    });
    return response;
  } catch (error) {
    if (retryCount < endpoints.length - 1) {
      console.warn(`❌ Error en ${endpoints[retryCount]} — Reintentando en ${RETRY_DELAY}ms...`);
      insights.error({
        message: `Fallo OpenAI endpoint ${endpoints[retryCount]}`,
        error: error.message,
        retryCount
      });
      await delay(RETRY_DELAY);
      return callOpenAiWithFailover(requestBody, timezone, model, retryCount + 1);
    }
    throw error;
  }
}

const translatorEndpoints = [
  {
    name: 'westeurope',
    url: 'https://api.cognitive.microsofttranslator.com',
    key: config.translationKey, // West Europe
    region: 'westeurope'
  },
  {
    name: 'global',
    url: 'https://api.cognitive.microsofttranslator.com',
    key: config.translationKeyGlobal, // global
  }
  // Agregá más si querés
];

async function detectLanguageWithRetry(text, lang, retries = 3, delay = 1000) {
  for (let i = 0; i < translatorEndpoints.length; i++) {
    const endpoint = translatorEndpoints[i];

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await translationCtrl.detectLanguage(text, lang, endpoint);
      } catch (error) {
        const isLastTry = attempt === retries - 1 && i === translatorEndpoints.length - 1;
        if (isLastTry) throw error;

        console.warn(`Error in ${endpoint.region}, retrying... (${attempt + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
}

async function translateTextWithRetry(text, fromLang, retries = 3, delay = 1000) {
  for (let i = 0; i < translatorEndpoints.length; i++) {
    const endpoint = translatorEndpoints[i];

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await translationCtrl.translateText(text, fromLang, endpoint);
      } catch (error) {
        const isLastTry = attempt === retries - 1 && i === translatorEndpoints.length - 1;
        if (isLastTry) throw error;

        console.warn(`Error in ${endpoint.name}, retrying... (${attempt + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
}


async function translateInvertWithRetry(text, toLang, retries = 3, delay = 1000) {
  for (let i = 0; i < translatorEndpoints.length; i++) {
    const endpoint = translatorEndpoints[i];

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await translationCtrl.translateInvert(text, toLang, endpoint);
      } catch (error) {
        const isLastTry = attempt === retries - 1 && i === translatorEndpoints.length - 1;
        if (isLastTry) throw error;

        console.warn(`Error in ${endpoint.name} (invert), retrying... (${attempt + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
}

// Extraer la lógica principal a una función reutilizable
async function processOpenAIRequest(data, requestInfo = null, model = 'gpt4o') {
  // 1. Detectar idioma y traducir a inglés si es necesario
  let englishDescription = data.description;
  let detectedLanguage = data.lang;
  let englishDiseasesList = data.diseases_list;

  try {
    detectedLanguage = await detectLanguageWithRetry(data.description, data.lang);
      if (detectedLanguage && detectedLanguage !== 'en') {
      englishDescription = await translateTextWithRetry(data.description, detectedLanguage);
        if (englishDiseasesList) {
        englishDiseasesList = await translateTextWithRetry(data.diseases_list, detectedLanguage);
        }
      }
    } catch (translationError) {
      console.error('Translation error:', translationError.message);
    if (requestInfo) {
      let infoErrorlang = {
        body: data,
        error: translationError.message,
        type: translationError.code || 'TRANSLATION_ERROR',
        detectedLanguage: detectedLanguage || 'unknown',
        model: model
      };
      
      await blobOpenDx29Ctrl.createBlobErrorsDx29(infoErrorlang);
      
      try {
        await serviceEmail.sendMailErrorGPTIP(
          data.lang,
          data.description,
          infoErrorlang,
          requestInfo
        );
      } catch (emailError) {
        console.log('Fail sending email');
        insights.error(emailError);
      }
    }
    if(translationError.code === 'UNSUPPORTED_LANGUAGE'){
      throw { 
        result: "unsupported_language",
        message: translationError.message
      };
    }else{
      throw {
        result: 'translation error',
        message: translationError.message,
        code: translationError.code || 'TRANSLATION_ERROR'
      };
    }
    
    //throw translationError;
    }

    // 2. Llamar a OpenAI con el texto en inglés
    const prompt = englishDiseasesList ?
      PROMPTS.diagnosis.withDiseases
        .replace("{{description}}", englishDescription)
        .replace("{{diseases_list}}", englishDiseasesList) :
      PROMPTS.diagnosis.withoutDiseases
        .replace("{{description}}", englishDescription);

    const messages = [{ role: "user", content: prompt }];

    const requestBody = {
    messages
  };
  if(model == 'gpt4o'){
    requestBody.temperature = 0;
    requestBody.top_p = 1;
    requestBody.frequency_penalty = 0;
    requestBody.presence_penalty = 0;
  }

  const openAiResponse = await callOpenAiWithFailover(requestBody, data.timezone, model);

    if (!openAiResponse.data.choices[0].message.content) {
    throw new Error("No response from OpenAI");
    }

  // 3. Anonimizar el texto
  let anonymizedResult = await anonymizeText(englishDescription, data.timezone);
    let anonymizedDescription = anonymizedResult.anonymizedText;
    const hasPersonalInfo = anonymizedResult.hasPersonalInfo;

    if (detectedLanguage !== 'en') {
      try {
        anonymizedDescription = await translateInvertWithRetry(anonymizedDescription, detectedLanguage);
        anonymizedResult.htmlText = await translateInvertWithRetry(anonymizedResult.htmlText, detectedLanguage);
      } catch (translationError) {
        console.error('Error en la traducción inversa:', translationError.message);
        insights.error(translationError);
      }
    }

    // 4. Procesar la respuesta
    let parsedResponse;
    let parsedResponseEnglish;
    try {
      const match = openAiResponse.data.choices[0].message.content
        .match(/<diagnosis_output>([\s\S]*?)<\/diagnosis_output>/);

      if (!match || !match[1]) {
        const error = new Error("Failed to match diagnosis output");
        error.rawResponse = openAiResponse.data.choices[0].message.content;
        throw error;
      }

      try {
        parsedResponse = JSON.parse(match[1]);
        parsedResponseEnglish = JSON.parse(match[1]);
      } catch (jsonError) {
        const error = new Error("Failed to parse JSON");
        error.matchedContent = match[1];
        error.jsonError = jsonError.message;
        throw error;
      }
    } catch (parseError) {
      insights.error({
        message: "Failed to parse diagnosis output",
        error: parseError.message,
        rawResponse: parseError.rawResponse,
        description: data.description,
        matchedContent: parseError.matchedContent,
        jsonError: parseError.jsonError
      });
    if (requestInfo) {
      let infoError = {
        myuuid: data.myuuid,
        operation: data.operation,
        lang: data.lang,
        description: data.description,
        error: parseError.message,
        rawResponse: parseError.rawResponse,
        matchedContent: parseError.matchedContent,
        jsonError: parseError.jsonError,
        model: model
      };
      await blobOpenDx29Ctrl.createBlobErrorsDx29(infoError);
      try {
        await serviceEmail.sendMailErrorGPTIP(
          data.lang,
          data.description,
          infoError,
          requestInfo
        );
      } catch (emailError) {
        console.log('Fail sending email');
        insights.error(emailError);
      }
    }
    throw parseError;
  }

  // 5. Traducir la respuesta si es necesario
    if (detectedLanguage !== 'en') {
      try {
        parsedResponse = await Promise.all(
          parsedResponse.map(async diagnosis => ({
            diagnosis: await translateInvertWithRetry(diagnosis.diagnosis, detectedLanguage),
            description: await translateInvertWithRetry(diagnosis.description, detectedLanguage),
            symptoms_in_common: await Promise.all(
              diagnosis.symptoms_in_common.map(symptom =>
                translateInvertWithRetry(symptom, detectedLanguage)
              )
            ),
            symptoms_not_in_common: await Promise.all(
              diagnosis.symptoms_not_in_common.map(symptom =>
                translateInvertWithRetry(symptom, detectedLanguage)
              )
            )
          }))
        );
      } catch (translationError) {
      console.error('Error en la traducción inversa:', translationError.message);
      insights.error(translationError);
        throw translationError;
      }
    }

  // 6. Guardar información de seguimiento si es una llamada directa
  if (requestInfo) {
    let infoTrack = {
      value: anonymizedDescription,
      valueEnglish: englishDescription,
      myuuid: data.myuuid,
      operation: data.operation,
      lang: data.lang,
      response: parsedResponse,
      responseEnglish: parsedResponseEnglish,
      topRelatedConditions: data.diseases_list,
      topRelatedConditionsEnglish: englishDiseasesList,
      header_language: requestInfo.header_language,
      timezone: data.timezone,
      model: model
    };
    await blobOpenDx29Ctrl.createBlobOpenDx29(infoTrack, 'v1');
  }

  // 7. Retornar el resultado
  return {
      result: 'success',
      data: parsedResponse,
      anonymization: {
        hasPersonalInfo,
        anonymizedText: anonymizedDescription,
        anonymizedTextHtml: anonymizedResult.htmlText
      },
      detectedLang: detectedLanguage
  };
}

async function callOpenAi(req, res) {
  const requestInfo = {
    method: req.method,
    url: req.url,
    headers: req.headers,
    origin: req.get('origin'),
    body: req.body,
    ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress,
    params: req.params,
    query: req.query,
    header_language: req.headers['accept-language'],
    timezone: req.body.timezone
  };

  try {
    if (!isValidOpenAiRequest(req.body)) {
      insights.error({
        message: "Invalid request format or content",
        request: req.body
      });
      return res.status(400).send({
        result: "error",
        message: "Invalid request format or content"
      });
    }

    const sanitizedData = sanitizeOpenAiData(req.body);

    // Verificar el estado de la cola específica de la región
    const queueProperties = await queueService.getQueueProperties(sanitizedData.timezone);
    console.log('queueProperties for region:', queueProperties);
    console.log('queueUtilizationThreshold:', config.queueUtilizationThreshold);
    console.log('queueProperties.utilizationPercentage:', queueProperties.utilizationPercentage);
    if (queueProperties.utilizationPercentage >= config.queueUtilizationThreshold) {
      // Si estamos por encima del umbral para esta región, usar su cola específica
      console.log('Adding to queue for region:', sanitizedData.timezone);
      const queueInfo = await queueService.addToQueue(sanitizedData, requestInfo, 'gpt4o');
      console.log('Queue info received:', queueInfo); // Añadir log para debug

      if (!queueInfo || !queueInfo.ticketId) {
          console.error('Invalid queue info received:', queueInfo);
          return res.status(500).send({
              result: 'error',
              message: 'Error adding request to queue'
          });
      }

      return res.status(200).send({
        result: 'queued',
        queueInfo: {
          ticketId: queueInfo.ticketId,
          position: queueInfo.queuePosition,
          estimatedWaitTime: Math.ceil(queueInfo.estimatedWaitTime / 60),
          region: queueInfo.region,
          utilizationPercentage: queueProperties.utilizationPercentage
        }
      });
    }

    // Si no usamos la cola, registrar la petición activa en la región correspondiente
    const region = await queueService.registerActiveRequest(sanitizedData.timezone);

    try {
      const result = await processOpenAIRequest(sanitizedData, requestInfo, 'gpt4o');
      await queueService.releaseActiveRequest(region);
      return res.status(200).send(result);
    } catch (error) {
      await queueService.releaseActiveRequest(region);
      throw error;
    }

  } catch (error) {
    console.error('Error:', error);
    insights.error({
      message: error.message || 'Unknown error in callOpenAi',
      stack: error.stack,
      code: error.code,
      result: error.result,
      timestamp: new Date().toISOString(),
      endpoint: 'callOpenAi',
      requestInfo: {
        method: requestInfo.method,
        url: requestInfo.url,
        origin: requestInfo.origin,
        ip: requestInfo.ip,
        timezone: requestInfo.timezone,
        header_language: requestInfo.header_language
      },
      requestData: req.body
    });
    let infoError = {
      body: req.body,
      error: error.message,
      model: 'gpt4o'
    };
    await blobOpenDx29Ctrl.createBlobErrorsDx29(infoError);
    try {
      await serviceEmail.sendMailErrorGPTIP(
        req.body.lang,
        req.body.description,
        infoError,
        requestInfo
      );
    } catch (emailError) {
      console.log('Fail sending email');
    }
    if (error.result === 'translation error') {
      return res.status(200).send({  // Mantener 400 para que el cliente lo maneje
        result: "translation error",
        message: error.message,
        code: error.code || 'TRANSLATION_ERROR'
      });
    }else if (error.result === 'unsupported_language') {
      return res.status(200).send({  // Mantener 400 para que el cliente lo maneje
        result: "unsupported_language",
        message: error.message,
        code: error.code || 'UNSUPPORTED_LANGUAGE'
      });
    }
    return res.status(500).send({ result: "error" });
  }
}

function calculateMaxTokens(jsonText) {
  const enc = encodingForModel("gpt-4o");

  // Extraer contenido relevante
  const patientDescription = extractContent('patient_description', jsonText);
  const diseasesList = extractContent('diseases_list', jsonText);

  // Contar tokens en el contenido relevante
  const patientDescriptionTokens = enc.encode(patientDescription).length;
  //  console.log('patientDescriptionTokens', patientDescriptionTokens);
  let max_tokens = Math.round(patientDescriptionTokens * 6);
  max_tokens += 500; // Add extra tokens for the prompt
  return max_tokens;
}

// Función auxiliar para anonimizar texto
async function anonymizeText(text, timezone) {
  const RETRY_DELAY = 1000;
  
  //    'https://apiopenai.azure-api.net/dxgpt/anonymized/gpt4o',
  // Determinar el orden de los endpoints según el timezone

  const endpoints = getEndpointsByTimezone(timezone, 'gpt4o', 'anonymized');

  const anonymizationPrompt = `The task is to anonymize the following medical document by replacing any personally identifiable information (PII) with [ANON-N], 
  where N is the count of characters that have been anonymized. 
  Only specific information that can directly lead to patient identification needs to be anonymized. This includes but is not limited to: 
  full names, addresses, contact details, Social Security Numbers, and any unique identification numbers. 
  However, it's essential to maintain all medical specifics, such as medical history, diagnosis, treatment plans, and lab results, as they are not classified as PII. 
  The anonymized document should retain the integrity of the original content, apart from the replaced PII. 
  Avoid including any information that wasn't part of the original document and ensure the output reflects the original content structure and intent, albeit anonymized. 
  If any part of the text is already anonymized (represented by asterisks or [ANON-N]), do not anonymize it again. 
  Here is the original document between the triple quotes:
  ----------------------------------------
  """
  {{text}}
  """
  ----------------------------------------
  ANONYMIZED DOCUMENT:"`;

  const messages = [{ role: "user", content: anonymizationPrompt.replace("{{text}}", text) }];
  const requestBody = {
    messages,
    temperature: 0,
    max_tokens: calculateMaxTokensAnon(text),
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  async function tryEndpoint(endpointUrl) {
    const result = await axios.post(
      endpointUrl,
      requestBody,
      {
        headers: {
          'Content-Type': 'application/json',
          'Ocp-Apim-Subscription-Key': ApiManagementKey,
        }
      }
    );
    return result;
  }

  let result;
  for (let i = 0; i < endpoints.length; i++) {
    try {
      result = await tryEndpoint(endpoints[i]);
      break; // Si la llamada es exitosa, salimos del bucle
    } catch (error) {
      if (i === endpoints.length - 1) {
        // Si es el último endpoint, propagamos el error
        throw error;
      }
      console.log(`Failed to call ${endpoints[i]}, retrying with next endpoint in ${RETRY_DELAY}ms...`);
      insights.error({
        message: `Failed to call anonymization endpoint ${endpoints[i]}`,
        error: error.message,
        retryCount: i
      });
      await delay(RETRY_DELAY);
    }
  }

  const resultResponse = {
    hasPersonalInfo: false,
    anonymizedText: '',
    htmlText: ''
  };

  const content = result?.data?.choices?.[0]?.message?.content;
  // Verificar si existe el contenido
  if (content) {
    const response = content.trim().replace(/^"""\s*|\s*"""$/g, '');
    const parts = response.split(/(\[ANON-\d+\])/g);
    resultResponse.hasPersonalInfo = parts.length > 1;

    resultResponse.anonymizedText = parts.map(part => {
      const match = part.match(/\[ANON-(\d+)\]/);
      return match ? '*'.repeat(parseInt(match[1])) : part;
    }).join('');

    resultResponse.htmlText = parts.map(part => {
      const match = part.match(/\[ANON-(\d+)\]/);
      return match
        ? `<span style="background-color: black; display: inline-block; width:${parseInt(match[1])}em;">&nbsp;</span>`
        : part;
    }).join('').replace(/\n/g, '<br>');
  }

  return resultResponse;
}

function calculateMaxTokensAnon(jsonText) {
  const enc = encodingForModel("gpt-4o");
  // console.log('jsonText', jsonText)
  // Contar tokens en el contenido relevante
  const patientDescriptionTokens = enc.encode(jsonText).length;
  return patientDescriptionTokens + 100;
}

function extractContent(tag, text) {
  const regex = new RegExp(`<${tag}>(.*?)</${tag}>`, 's');
  const match = text.match(regex);
  return match ? match[1].trim() : '';
}

async function callOpenAiV2(req, res) {

  const requestInfo = {
    method: req.method,
    url: req.url,
    headers: req.headers,
    origin: req.get('origin'),
    body: req.body,
    ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress,
    params: req.params,
    query: req.query,
    header_language: req.headers['accept-language'],
    timezone: req.body.timezone
  };

  try {
    // Validar y sanitizar el request
    if (!isValidOpenAiRequest(req.body)) {
      return res.status(400).send({
        result: "error",
        message: "Invalid request format or content"
      });
    }

    const sanitizedData = sanitizeOpenAiData(req.body);

    try {
      const result = await processOpenAIRequest(sanitizedData, requestInfo, 'o1');
      return res.status(200).send(result);
    } catch (error) {
        throw error;
      }

  } catch (error) {
    console.error('Error:', error);
    insights.error(error);
    let infoError = {
      body: req.body,
      error: error.message,
      rawResponse: error.rawResponse,
      matchedContent: error.matchedContent,
      jsonError: error.jsonError,
      model: 'o1'
    }
    blobOpenDx29Ctrl.createBlobErrorsDx29(infoError);
    try {
      await serviceEmail.sendMailErrorGPTIP(
        req.body.lang,
        req.body.description,
        infoError,
        requestInfo
      );
    } catch (emailError) {
      console.log('Fail sending email');
    }
    if (error.result === 'translation error') {
      return res.status(200).send({  // Mantener 400 para que el cliente lo maneje
        result: "translation error",
        message: error.message,
        code: error.code || 'TRANSLATION_ERROR'
      });
    }else if (error.result === 'unsupported_language') {
      return res.status(200).send({  // Mantener 400 para que el cliente lo maneje
        result: "unsupported_language",
        message: error.message,
        code: error.code || 'UNSUPPORTED_LANGUAGE'
      });
    }
    return res.status(500).send({ result: "error" });
  }
}


function isValidQuestionRequest(data) {
  // Validar estructura básica
  if (!data || typeof data !== 'object') return false;

  // Validar campos requeridos
  const requiredFields = ['questionType', 'disease', 'myuuid', 'operation', 'lang'];
  if (!requiredFields.every(field => data.hasOwnProperty(field))) return false;

  // Validar questionType
  if (typeof data.questionType !== 'number' ||
    !Number.isInteger(data.questionType) ||
    data.questionType < 0 ||
    data.questionType > 4) return false;

  // Validar disease
  if (typeof data.disease !== 'string' ||
    data.disease.length < 2 ||
    data.disease.length > 100) return false;

  // Validar myuuid
  if (typeof data.myuuid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(data.myuuid)) {
    return false;
  }

  // Validar operation
  if (data.operation !== 'info disease') return false;

  // Validar lang
  if (typeof data.lang !== 'string' || data.lang.length !== 2) return false;

  // Validar detectedLang
  if (typeof data.detectedLang !== 'string' || data.detectedLang.length !== 2) return false;

  // Validar timezone si existe
  if (data.timezone !== undefined && typeof data.timezone !== 'string') {
    return false;
  }

  // Validar medicalDescription si existe (requerido para questionType 3 y 4)
  if ([3, 4].includes(data.questionType)) {
    if (!data.medicalDescription ||
      typeof data.medicalDescription !== 'string' ||
      data.medicalDescription.length < 10 ||
      data.medicalDescription.length > 8000) {
      return false;
    }
  }

  // Verificar patrones sospechosos
  const suspiciousPatterns = [
    /\{\{[^}]*\}\}/g,  // Handlebars syntax
    /<script\b[^>]*>[\s\S]*?<\/script>/gi,  // Scripts
    /\$\{[^}]*\}/g,    // Template literals
    // Modificar la detección de palabras clave para evitar falsos positivos
    /\b(prompt:|system:|assistant:|user:)\b/gi  // OpenAI keywords con ':'
];

  return !suspiciousPatterns.some(pattern =>
    pattern.test(data.disease) ||
    (data.medicalDescription && pattern.test(data.medicalDescription))
  );
}

function sanitizeQuestionData(data) {
  return {
    ...data,
    disease: sanitizeInput(data.disease),
    medicalDescription: data.medicalDescription ? sanitizeInput(data.medicalDescription) : '',
    myuuid: data.myuuid.trim(),
    lang: data.lang.trim().toLowerCase(),
    timezone: data.timezone?.trim() || '',
    questionType: Number(data.questionType),
    detectedLang: data.detectedLang.trim().toLowerCase()
  };
}


async function callOpenAiQuestions(req, res) {
  const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  const origin = req.get('origin');
  const header_language = req.headers['accept-language'];

  const requestInfo = {
    method: req.method,
    url: req.url,
    headers: req.headers,
    origin: origin,
    body: req.body, // Asegúrate de que el middleware para parsear el cuerpo ya haya sido usado
    ip: clientIp,
    params: req.params,
    query: req.query,
    header_language: header_language,
    timezone: req.body.timezone
  };
  try {
    // Validar los datos de entrada
    if (!isValidQuestionRequest(req.body)) {
      return res.status(400).send({
        result: "error",
        message: "Invalid request format or content"
      });
    }

    // Sanitizar los datos
    const sanitizedData = sanitizeQuestionData(req.body);

    const answerFormat = 'The output should be as HTML but only with <p>, <li>, </ul>, and <span> tags. Use <strong> for titles';

    // Construir el prompt según el tipo de pregunta
    let prompt = '';
    switch (sanitizedData.questionType) {
      case 0:
        prompt = `What are the common symptoms associated with ${sanitizedData.disease}? Please provide a list starting with the most probable symptoms at the top. ${answerFormat}`;
        break;
      case 1:
        prompt = `Can you provide detailed information about ${sanitizedData.disease}? I am a doctor. ${answerFormat}`;
        break;
      case 2:
        prompt = `Provide a diagnosis test for ${sanitizedData.disease}. ${answerFormat}`;
        break;
      case 3:
        //prompt = `Given the medical description: ${sanitizedData.medicalDescription}, what are the potential symptoms not present in the patient that could help in making a differential diagnosis for ${sanitizedData.disease}. Please provide only a list, starting with the most likely symptoms at the top.`;
        prompt = `Given the medical description: ${sanitizedData.medicalDescription} for the disease: ${sanitizedData.disease}, 
          please provide a list of potential symptoms NOT currently mentioned by the patient that would help in making a differential diagnosis.

          Requirements:
          1. Return only a numbered list.
          2. Do not include any headings, introductions, or explanations—only the list itself.
          3. Order them from most likely/relevant to least likely/relevant.`;
        break;
      case 4:
        prompt = `${sanitizedData.medicalDescription}. Why do you think this patient has ${sanitizedData.disease}. Indicate the common symptoms with ${sanitizedData.disease} and the ones that he/she does not have. ${answerFormat}`;
        break;
      default:
        return res.status(400).send({ result: "error", message: "Invalid question type" });
    }

    const messages = [{ role: "user", content: prompt }];
    const requestBody = {
      messages: messages,
      temperature: 0,
      max_tokens: 1000,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    };

    let max_tokens = calculateMaxTokens(prompt);
    if (max_tokens > 4000) {
      requestBody.max_tokens = 4096;
    }

    // Reemplazar la llamada directa a axios con nuestra función de failover
    const result = await callOpenAiWithFailover(requestBody, sanitizedData.timezone, 'gpt4o');
    if (!result.data.choices[0].message.content) {
      try {
        await serviceEmail.sendMailErrorGPTIP(lang, req.body, result.data.choices, requestInfo);
      } catch (emailError) {
        console.log('Fail sending email');
      }
      insights.error('error openai callOpenAiQuestions');
      let infoError = {
        error: result.data,
        requestInfo: requestInfo
      }
      blobOpenDx29Ctrl.createBlobErrorsDx29(infoError);
      return res.status(200).send({ result: "error openai" });
    }

    // Procesar la respuesta
    //console.log(result.data.choices[0].message.content);
    let content = result.data.choices[0].message.content.replace(/^```html\n|\n```$/g, '');
    const splitChar = content.indexOf("\n\n") >= 0 ? "\n\n" : "\n";
    let contentArray = content.split(splitChar);

    // Procesar el array para manejar ambos formatos
    contentArray = contentArray.flatMap(item => {
      // Si el item contiene saltos de línea y números, dividirlo
      if (item.includes('\n') && /\d+\./.test(item)) {
          return item.split('\n')
              .map(line => line.trim())
              .filter(line => line.length > 0);
      }
      return [item];
    });

    // Encontrar el inicio de la lista numerada
    const startIndex = contentArray.findIndex(item => 
        item && typeof item === 'string' && item.trim().startsWith("1.")
    );

    //const startIndex = contentArray.findIndex(item => item.trim().startsWith("1."));
    if (startIndex >= 0) {
      contentArray = contentArray.slice(startIndex);
    }

    let processedContent = contentArray.join(splitChar);

    // Procesar según el tipo de pregunta
    if (sanitizedData.questionType === 3) {
      // Eliminar asteriscos dobles
      processedContent = processedContent.replace(/\*\*/g, '');

      // Traducir si es necesario
      if (sanitizedData.detectedLang !== 'en') {
        try {
          const translatedContent = await translateInvertWithRetry(processedContent, sanitizedData.detectedLang);
          processedContent = translatedContent;
        } catch (translationError) {
          console.error('Translation error:', translationError);
          insights.error(translationError);
        }
      }

      // Procesar lista de síntomas
      const symptoms = processedContent.split("\n")
        .filter(line => line !== '' && line !== ' ' && line !== ':')
        .map(line => {
          let index = line.indexOf('.');
          let name = line.split(".")[1];
          if (index !== -1) {
            name = line.substring(index + 1);
          }
          name = name.trim();
          if (name.endsWith('.')) {
            name = name.slice(0, -1);
          }
          return { name, checked: false };
        });

      return res.status(200).send({
        result: 'success',
        data: {
          type: 'differential',
          symptoms
        }
      });

    } else {
      // Para otros tipos de preguntas
      if (sanitizedData.detectedLang !== 'en') {
        try {
          processedContent = await translateInvertWithRetry(processedContent, sanitizedData.detectedLang);
        } catch (translationError) {
          console.error('Translation error:', translationError);
          insights.error(translationError);
        }
      }

      return res.status(200).send({
        result: 'success',
        data: {
          type: 'general',
          content: processedContent
        }
      });
    }

  } catch (e) {
    insights.error(e);
    console.log(e);
    const errorDetails = {
      timestamp: new Date().toISOString(),
      endpoint: 'callOpenAiQuestions',
      requestData: {
        body: req.body,
        questionType: req.body?.questionType,
        disease: req.body?.disease,
        lang: req.body?.lang
      },
      error: {
        message: e.message,
        stack: e.stack,
        name: e.name
      }
    };
    console.error('Detailed API Error:', JSON.stringify(errorDetails, null, 2));
    insights.error({
      message: 'API Error in callOpenAiQuestions',
      details: errorDetails
    });
    blobOpenDx29Ctrl.createBlobErrorsDx29(errorDetails);

    if (e.response) {
      console.log(e.response.status);
      console.log(e.response.data);

      try {
        await serviceEmail.sendMailErrorGPTIP(
          req.body?.lang || 'en',
          JSON.stringify({
            error: '400 Bad Request',
            details: errorDetails
          }),
          e,
          requestInfo
        );
      } catch (emailError) {
        console.log('Failed sending error email:', emailError);
        insights.error({
          message: 'Failed to send error email',
          emailError: emailError
        });
      }
      return res.status(400).send({
        result: 'error',
        message: 'Bad request',
        details: e.response.data
      });
    } else {
      console.error('Non-API Error:', JSON.stringify(errorDetails, null, 2));
      insights.error({
        message: 'Non-API Error in callOpenAiQuestions',
        details: errorDetails
      });
    }

    // Intentar enviar el email de error
    try {
      await serviceEmail.sendMailErrorGPTIP(
        req.body?.lang || 'en',
        req.body,
        e,
        requestInfo
      );
    } catch (emailError) {
      console.log('Failed sending error email:', emailError);
      insights.error({
        message: 'Failed to send error email',
        emailError: emailError
      });
    }

    res.status(500).send({
      result: 'error',
      message: 'Internal server error',
      errorId: new Date().getTime() // Para poder rastrear el error en los logs
    });
  }
}


function isValidOpinionData(data) {
  // Validar estructura básica
  if (!data || typeof data !== 'object') return false;

  // Validar campos requeridos
  const requiredFields = ['value', 'myuuid', 'operation', 'lang', 'vote'];
  if (!requiredFields.every(field => data.hasOwnProperty(field))) return false;

  // Validar myuuid
  if (typeof data.myuuid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(data.myuuid)) {
    return false;
  }

  // Validar operation
  if (data.operation !== 'vote') return false;

  // Validar lang
  if (typeof data.lang !== 'string' || data.lang.length !== 2) return false;

  // Validar vote
  if (typeof data.vote !== 'string' || !['up', 'down'].includes(data.vote)) return false;

  // Validar value (texto médico)
  if (typeof data.value !== 'string' || data.value.length > 10000) return false;

  if (typeof data.isNewModel !== 'boolean') return false;

  // Verificar patrones sospechosos en el texto
  const suspiciousPatterns = [
    /\{\{[^}]*\}\}/g,  // Handlebars syntax
    /<script\b[^>]*>[\s\S]*?<\/script>/gi,  // Scripts
    /\$\{[^}]*\}/g,    // Template literals
    // Modificar la detección de palabras clave para evitar falsos positivos
    /\b(prompt:|system:|assistant:|user:)\b/gi  // OpenAI keywords con ':'
];

  if (suspiciousPatterns.some(pattern => pattern.test(data.value))) {
    return false;
  }

  // Validar topRelatedConditions si existe
  if (data.topRelatedConditions) {
    if (!Array.isArray(data.topRelatedConditions)) return false;
    if (!data.topRelatedConditions.every(condition =>
      typeof condition === 'object' &&
      typeof condition.name === 'string' &&
      condition.name.length < 200
    )) return false;
  }

  return true;
}

function sanitizeOpinionData(data) {
  return {
    ...data,
    value: data.value
      .replace(/[<>]/g, '')
      .replace(/(\{|\}|\||\\)/g, '')
      .replace(/prompt:|system:|assistant:|user:/gi, '')
      .trim(),
    myuuid: data.myuuid.trim(),
    lang: data.lang.trim().toLowerCase(),
    topRelatedConditions: data.topRelatedConditions?.map(condition => ({
      ...condition,
      name: condition.name
        .replace(/[<>]/g, '')
        .replace(/(\{|\}|\||\\)/g, '')
        .trim()
    })),
    isNewModel: typeof data.isNewModel === 'boolean' ? data.isNewModel : false
  };
}

async function opinion(req, res) {
  try {

    // Validar los datos de entrada
    if (!isValidOpinionData(req.body)) {
      return res.status(400).send({
        result: "error",
        message: "Invalid request format or content"
      });
    }

    // Sanitizar los datos
    const sanitizedData = sanitizeOpinionData(req.body);

    // Añadir la versión del prompt
    sanitizedData.version = PROMPTS.version;
    await blobOpenDx29Ctrl.createBlobOpenVote(sanitizedData);
    res.status(200).send({ send: true })
  } catch (e) {
    insights.error(e);
    console.error("[ERROR] OpenAI responded with status: " + e)
    serviceEmail.sendMailError(req.body.lang, req.body.value, e)
      .then(response => {

      })
      .catch(response => {
        insights.error(response);
        //create user, but Failed sending email.
        console.log('Fail sending email');
      })

    res.status(500).send('error')
  }
}

function isValidFeedbackData(data) {
  // Validar estructura básica
  if (!data || typeof data !== 'object') return false;

  // Validar campos requeridos
  const requiredFields = ['email', 'myuuid', 'lang', 'info', 'value'];
  if (!requiredFields.every(field => data.hasOwnProperty(field))) return false;

  // Validar email
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(data.email)) return false;

  // Validar myuuid
  if (typeof data.myuuid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(data.myuuid)) {
    return false;
  }

  // Validar lang
  if (typeof data.lang !== 'string' || data.lang.length !== 2) return false;

  // Validar info (feedback text)
  if (typeof data.info !== 'string' || data.info.length > 2000) return false;

  // Validar value (texto médico)
  if (typeof data.value !== 'string' || data.value.length > 10000) return false;

  if (typeof data.isNewModel !== 'boolean') return false;

  // Verificar patrones sospechosos en textos
  const suspiciousPatterns = [
    /\{\{[^}]*\}\}/g,  // Handlebars syntax
    /<script\b[^>]*>[\s\S]*?<\/script>/gi,  // Scripts
    /\$\{[^}]*\}/g,    // Template literals
    // Modificar la detección de palabras clave para evitar falsos positivos
    /\b(prompt:|system:|assistant:|user:)\b/gi  // OpenAI keywords con ':'
];

  if (suspiciousPatterns.some(pattern =>
    pattern.test(data.info) ||
    pattern.test(data.value)
  )) {
    return false;
  }

  // Validar topRelatedConditions si existe
  if (data.topRelatedConditions) {
    if (!Array.isArray(data.topRelatedConditions)) return false;
    if (!data.topRelatedConditions.every(condition =>
      typeof condition === 'object' &&
      typeof condition.name === 'string' &&
      condition.name.length < 200
    )) return false;
  }

  // Validar subscribe
  if (data.subscribe !== undefined && typeof data.subscribe !== 'boolean') {
    return false;
  }

  return true;
}

function sanitizeFeedbackData(data) {
  return {
    ...data,
    email: data.email.trim().toLowerCase(),
    myuuid: data.myuuid.trim(),
    lang: data.lang.trim().toLowerCase(),
    info: data.info
      .replace(/[<>]/g, '')
      .replace(/(\{|\}|\||\\)/g, '')
      .replace(/prompt:|system:|assistant:|user:/gi, '')
      .trim(),
    value: data.value
      .replace(/[<>]/g, '')
      .replace(/(\{|\}|\||\\)/g, '')
      .replace(/prompt:|system:|assistant:|user:/gi, '')
      .trim(),
    topRelatedConditions: data.topRelatedConditions?.map(condition => ({
      ...condition,
      name: condition.name
        .replace(/[<>]/g, '')
        .replace(/(\{|\}|\||\\)/g, '')
        .trim()
    })),
    subscribe: !!data.subscribe,
    isNewModel: typeof data.isNewModel === 'boolean' ? data.isNewModel : false
  };
}

async function sendFeedback(req, res) {


  try {
    // Validar los datos de entrada
    if (!isValidFeedbackData(req.body)) {
      return res.status(400).send({
        result: "error",
        message: "Invalid request format or content"
      });
    }


    // Sanitizar los datos
    const sanitizedData = sanitizeFeedbackData(req.body);

    // Guardar feedback en blob storage
    await blobOpenDx29Ctrl.createBlobFeedbackVoteDown(sanitizedData);
    serviceEmail.sendMailFeedback(sanitizedData.email, sanitizedData.lang, sanitizedData)
      .then(response => {

      })
      .catch(response => {
        //create user, but Failed sending email.
        insights.error(response);
        console.log('Fail sending email');
      })


    let support = new Support()
    //support.type = 'Home form'
    support.subject = 'DxGPT vote down'
    support.subscribe = sanitizedData.subscribe
    support.email = sanitizedData.email
    support.description = sanitizedData.info
    var d = new Date(Date.now());
    var a = d.toString();
    support.date = a;


    supportService.sendFlow(support, sanitizedData.lang)
    support.save((err, supportStored) => {
    })

    res.status(200).send({ send: true })
  } catch (e) {
    insights.error(e);
    console.error("[ERROR] OpenAI responded with status: " + e);

    try {
      await serviceEmail.sendMailError(req.body.lang, req.body.value, e);
    } catch (emailError) {
      insights.error(emailError);
      console.log('Fail sending email');
    }

    return res.status(500).send('error');
  }
}

function isValidGeneralFeedbackData(data) {
  // Validar estructura básica
  if (!data || typeof data !== 'object') return false;

  // Validar campos requeridos
  const requiredFields = ['value', 'myuuid', 'lang'];
  if (!requiredFields.every(field => data.hasOwnProperty(field))) return false;

  // Validar myuuid
  if (typeof data.myuuid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(data.myuuid)) {
    return false;
  }

  // Validar lang
  if (typeof data.lang !== 'string' || data.lang.length !== 2) return false;

  // Validar value (objeto del formulario)
  if (!data.value || typeof data.value !== 'object') return false;

  // Validar campos específicos del formulario
  const formFields = {
    pregunta1: (val) => typeof val === 'number' && val >= 0 && val <= 5,
    pregunta2: (val) => typeof val === 'number' && val >= 0 && val <= 5,
    userType: (val) => typeof val === 'string' && val.length < 100,
    moreFunct: (val) => typeof val === 'string' && val.length < 1000,
    freeText: (val) => !val || (typeof val === 'string' && val.length < 2000),
    email: (val) => !val || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)
  };

  return Object.entries(formFields).every(([field, validator]) => {
    if (field === 'freeText' || field === 'email') {
      // Estos campos son opcionales
      return !data.value[field] || validator(data.value[field]);
    }
    return data.value.hasOwnProperty(field) && validator(data.value[field]);
  });
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
    lang: data.lang.trim().toLowerCase(),
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

async function sendGeneralFeedback(req, res) {


  try {

    // Validar los datos de entrada
    if (!isValidGeneralFeedbackData(req.body)) {
      return res.status(400).send({
        result: "error",
        message: "Invalid request format or content"
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
      date: new Date(Date.now()).toString()
    });
    sendFlow(generalfeedback, sanitizedData.lang)
    await generalfeedback.save();
    try {
      await serviceEmail.sendMailGeneralFeedback(sanitizedData.value, sanitizedData.myuuid);
    } catch (emailError) {
      insights.error(emailError);
      console.log('Fail sending email');
    }

    return res.status(200).send({ send: true })
  } catch (e) {
    insights.error(e);
    console.error("[ERROR] OpenAI responded with status: " + e)
    try {
      await serviceEmail.sendMailError(req.body.lang, req.body, e);
    } catch (emailError) {
      insights.error(emailError);
      console.log('Fail sending email');
    }

    return res.status(500).send('error')
  }
}

async function sendFlow(generalfeedback, lang) {
  let requestBody = {
    myuuid: generalfeedback.myuuid,
    pregunta1: generalfeedback.pregunta1,
    pregunta2: generalfeedback.pregunta2,
    userType: generalfeedback.userType,
    moreFunct: generalfeedback.moreFunct,
    freeText: generalfeedback.freeText,
    date: generalfeedback.date,
    email: generalfeedback.email,
    lang: lang
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
    insights.error(error);
  }

}

function getFeedBack(req, res) {

  Generalfeedback.find({}, function (err, generalfeedbackList) {
    let frecuenciasP1 = {};
    let frecuenciasP2 = {};
    generalfeedbackList.forEach(function (doc) {
      let p1 = doc.pregunta1;
      let p2 = doc.pregunta2;

      if (frecuenciasP1[p1]) {
        frecuenciasP1[p1]++;
      } else {
        frecuenciasP1[p1] = 1;
      }

      if (frecuenciasP2[p2]) {
        frecuenciasP2[p2]++;
      } else {
        frecuenciasP2[p2] = 1;
      }
    });

    res.status(200).send({
      pregunta1: frecuenciasP1,
      pregunta2: frecuenciasP2
    });
  })

}

function isValidFollowUpQuestionsRequest(data) {
  // Validar estructura básica
  if (!data || typeof data !== 'object') return false;

  // Validar campos requeridos
  const requiredFields = ['description', 'diseases', 'myuuid', 'operation', 'lang'];
  if (!requiredFields.every(field => data.hasOwnProperty(field))) return false;

  // Validar description
  if (typeof data.description !== 'string' ||
    data.description.length < 10 ||
    data.description.length > 8000) return false;

  // Validar diseases
  if (typeof data.diseases !== 'string' ||
    data.diseases.length < 2 ||
    data.diseases.length > 1000) return false;

  // Validar myuuid
  if (typeof data.myuuid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(data.myuuid)) {
    return false;
  }

  // Validar operation
  if (data.operation !== 'generate follow-up questions') return false;

  // Validar lang
  if (typeof data.lang !== 'string' || data.lang.length !== 2) return false;

  // Validar timezone si existe
  if (data.timezone !== undefined && typeof data.timezone !== 'string') {
    return false;
  }

  // Verificar patrones sospechosos
  const suspiciousPatterns = [
    /\{\{[^}]*\}\}/g,  // Handlebars syntax
    /<script\b[^>]*>[\s\S]*?<\/script>/gi,  // Scripts
    /\$\{[^}]*\}/g,    // Template literals
    /\b(prompt:|system:|assistant:|user:)\b/gi  // OpenAI keywords con ':'
  ];

  // Normalizar el texto para la validación
  const normalizedDescription = data.description.replace(/\n/g, ' ');
  const normalizedDiseases = data.diseases.replace(/\n/g, ' ');

  return !suspiciousPatterns.some(pattern => {
    return pattern.test(normalizedDescription) || pattern.test(normalizedDiseases);
  });
}

function sanitizeFollowUpQuestionsData(data) {
  return {
    ...data,
    description: sanitizeInput(data.description),
    diseases: sanitizeInput(data.diseases),
    myuuid: data.myuuid.trim(),
    lang: data.lang.trim().toLowerCase(),
    timezone: data.timezone?.trim() || '' // Manejar caso donde timezone es undefined
  };
}

async function generateFollowUpQuestions(req, res) {
  const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  const origin = req.get('origin');
  const header_language = req.headers['accept-language'];

  const requestInfo = {
    method: req.method,
    url: req.url,
    headers: req.headers,
    origin: origin,
    body: req.body,
    ip: clientIp,
    params: req.params,
    query: req.query,
    header_language: header_language,
    timezone: req.body.timezone
  };

  try {
    // Validar y sanitizar el request
    if (!isValidFollowUpQuestionsRequest(req.body)) {
      insights.error({
        message: "Invalid request format or content for follow-up questions",
        request: req.body
      });
      return res.status(400).send({
        result: "error",
        message: "Invalid request format or content"
      });
    }

    const sanitizedData = sanitizeFollowUpQuestionsData(req.body);
    const { description, diseases, lang, timezone } = sanitizedData;

    // 1. Detectar idioma y traducir a inglés si es necesario
    let englishDescription = description;
    let detectedLanguage = lang;
    let englishDiseases = diseases;
    try {
      detectedLanguage = await detectLanguageWithRetry(description, lang);
      if (detectedLanguage && detectedLanguage !== 'en') {
        englishDescription = await translateTextWithRetry(description, detectedLanguage);
        if (englishDiseases) {
          englishDiseases = await translateTextWithRetry(diseases, detectedLanguage);
        }
      }
    } catch (translationError) {
      console.error('Translation error:', translationError.message);
      let infoErrorlang = {
        body: req.body,
        error: translationError.message,
        type: translationError.code || 'TRANSLATION_ERROR',
        detectedLanguage: detectedLanguage || 'unknown',
        model: 'follow-up'
      };
      
      await blobOpenDx29Ctrl.createBlobErrorsDx29(infoErrorlang);
      
      try {
        await serviceEmail.sendMailErrorGPTIP(
          req.body.lang,
          req.body.description,
          infoErrorlang,
          requestInfo
        );
      } catch (emailError) {
        console.log('Fail sending email');
        insights.error(emailError);
      }
      
      if (translationError.code === 'UNSUPPORTED_LANGUAGE') {
        insights.error({
          type: 'UNSUPPORTED_LANGUAGE',
          message: translationError.message
        });

        return res.status(200).send({ 
          result: "unsupported_language",
          message: translationError.message
        });
      }

      // Otros errores de traducción
      insights.error({
        type: 'TRANSLATION_ERROR',
        message: translationError.message
      });

      return res.status(500).send({ 
        result: "error",
        message: "An error occurred during translation"
      });
    }

    // 2. Construir el prompt para generar preguntas de seguimiento
    const prompt = `
    You are a medical assistant helping to gather more information from a patient. The patient has provided the following description of their symptoms:
    
    "${englishDescription}"
    
    Based on this description, the system has identified these potential conditions: ${englishDiseases}
    
    The patient has indicated that none of these conditions seem to match their experience. Please generate 5 specific follow-up questions that would help clarify the patient's condition and potentially lead to a more accurate diagnosis.
    
    The questions should:
    1. Focus on getting more specific details about symptoms already mentioned
    2. Explore potential related symptoms that haven't been mentioned
    3. Ask about timing, severity, triggers, or alleviating factors
    4. Be clear, concise, and easy for a patient to understand
    5. Avoid medical jargon when possible
    
    Format your response as a JSON array of strings, with each string being a question. Example:
    ["Question 1?", "Question 2?", "Question 3?", "Question 4?", "Question 5?"]
    
    Your response should be ONLY the JSON array, nothing else.`;

    const messages = [{ role: "user", content: prompt }];
    const requestBody = {
      messages,
      temperature: 0.7,
      max_tokens: 1000,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    };

    // Reemplazar la llamada directa a axios con nuestra función de failover
    const openAiResponse = await callOpenAiWithFailover(requestBody, sanitizedData.timezone, 'gpt4o');

    if (!openAiResponse.data.choices[0].message.content) {
      throw new Error('Empty OpenAI response');
    }

    // 3. Procesar la respuesta
    let questions;
    try {
      // Limpiar la respuesta para asegurar que es un JSON válido
      const content = openAiResponse.data.choices[0].message.content.trim();
      const jsonContent = content.replace(/^```json\s*|\s*```$/g, '');
      questions = JSON.parse(jsonContent);
      
      if (!Array.isArray(questions)) {
        throw new Error('Response is not an array');
      }
    } catch (parseError) {
      console.error("Failed to parse questions:", parseError);
      insights.error({
        message: "Failed to parse follow-up questions",
        error: parseError.message,
        rawResponse: openAiResponse.data.choices[0].message.content
      });
      
      let infoError = {
        myuuid: sanitizedData.myuuid,
        operation: sanitizedData.operation,
        lang: sanitizedData.lang,
        description: description,
        error: parseError.message,
        rawResponse: openAiResponse.data.choices[0].message.content,
        model: 'follow-up'
      };
      try {
        await serviceEmail.sendMailErrorGPTIP(
          req.body.lang,
          req.body.description,
          infoError,
          requestInfo
        );
      } catch (emailError) {
        console.log('Fail sending email');
        insights.error(emailError);
      }
      
      blobOpenDx29Ctrl.createBlobErrorsDx29(infoError);
      return res.status(200).send({ result: "error" });
    }

    // 4. Traducir las preguntas al idioma original si es necesario
    if (detectedLanguage !== 'en') {
      try {
        questions = await Promise.all(
          questions.map(question => translateInvertWithRetry(question, detectedLanguage))
        );
      } catch (translationError) {
        console.error('Translation error:', translationError);
        throw translationError;
      }
    }

    // 5. Guardar información para seguimiento
    let infoTrack = {
      value: description,
      valueEnglish: englishDescription,
      myuuid: sanitizedData.myuuid,
      operation: sanitizedData.operation,
      lang: sanitizedData.lang,
      diseases: diseases,
      diseasesEnglish: englishDiseases,
      questions: questions,
      header_language: header_language,
      timezone: timezone,
      model: 'follow-up'
    };
    
    blobOpenDx29Ctrl.createBlobQuestions(infoTrack, 'follow-up');

    // 6. Preparar la respuesta final
    return res.status(200).send({
      result: 'success',
      data: {
        questions: questions
      },
      detectedLang: detectedLanguage
    });

  } catch (error) {
    console.error('Error:', error);
    insights.error(error);
    let infoError = {
      body: req.body,
      error: error.message,
      model: 'follow-up'
    };
    
    blobOpenDx29Ctrl.createBlobErrorsDx29(infoError);
    
    try {
      await serviceEmail.sendMailErrorGPTIP(
        req.body.lang,
        req.body.description,
        infoError,
        requestInfo
      );
    } catch (emailError) {
      console.log('Fail sending email');
    }
    
    return res.status(500).send({ result: "error" });
  }
}

function isValidProcessFollowUpRequest(data) {
  // Validar estructura básica
  if (!data || typeof data !== 'object') return false;

  // Validar campos requeridos
  const requiredFields = ['description', 'answers', 'myuuid', 'operation', 'lang'];
  if (!requiredFields.every(field => data.hasOwnProperty(field))) return false;

  // Validar description
  if (typeof data.description !== 'string' ||
    data.description.length < 10 ||
    data.description.length > 8000) return false;

  // Validar answers
  if (!Array.isArray(data.answers) || data.answers.length === 0) return false;
  
  // Validar estructura de cada respuesta
  for (const answer of data.answers) {
    if (!answer || typeof answer !== 'object') return false;
    if (!answer.question || typeof answer.question !== 'string') return false;
    if (!answer.answer || typeof answer.answer !== 'string') return false;
  }

  // Validar myuuid
  if (typeof data.myuuid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(data.myuuid)) {
    return false;
  }

  // Validar operation
  if (data.operation !== 'process follow-up answers') return false;

  // Validar lang
  if (typeof data.lang !== 'string' || data.lang.length !== 2) return false;

  // Validar timezone si existe
  if (data.timezone !== undefined && typeof data.timezone !== 'string') {
    return false;
  }

  // Verificar patrones sospechosos
  const suspiciousPatterns = [
    /\{\{[^}]*\}\}/g,  // Handlebars syntax
    /<script\b[^>]*>[\s\S]*?<\/script>/gi,  // Scripts
    /\$\{[^}]*\}/g,    // Template literals
    /\b(prompt:|system:|assistant:|user:)\b/gi  // OpenAI keywords con ':'
  ];

  // Normalizar el texto para la validación
  const normalizedDescription = data.description.replace(/\n/g, ' ');
  
  if (suspiciousPatterns.some(pattern => pattern.test(normalizedDescription))) {
    return false;
  }
  
  // Verificar patrones sospechosos en las respuestas
  for (const answer of data.answers) {
    if (suspiciousPatterns.some(pattern => 
      pattern.test(answer.question) || pattern.test(answer.answer))) {
      return false;
    }
  }

  return true;
}

function sanitizeProcessFollowUpData(data) {
  return {
    ...data,
    description: sanitizeInput(data.description),
    answers: data.answers.map(answer => ({
      question: sanitizeInput(answer.question),
      answer: sanitizeInput(answer.answer)
    })),
    myuuid: data.myuuid.trim(),
    lang: data.lang.trim().toLowerCase(),
    timezone: data.timezone?.trim() || '' // Manejar caso donde timezone es undefined
  };
}

async function processFollowUpAnswers(req, res) {
  const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  const origin = req.get('origin');
  const header_language = req.headers['accept-language'];

  const requestInfo = {
    method: req.method,
    url: req.url,
    headers: req.headers,
    origin: origin,
    body: req.body,
    ip: clientIp,
    params: req.params,
    query: req.query,
    header_language: header_language,
    timezone: req.body.timezone
  };

  try {
    // Validar y sanitizar el request
    if (!isValidProcessFollowUpRequest(req.body)) {
      insights.error({
        message: "Invalid request format or content for processing follow-up answers",
        request: req.body
      });
      return res.status(400).send({
        result: "error",
        message: "Invalid request format or content"
      });
    }

    const sanitizedData = sanitizeProcessFollowUpData(req.body);
    const { description, answers, lang, timezone } = sanitizedData;

    // 1. Detectar idioma y traducir a inglés si es necesario
    let englishDescription = description;
    let detectedLanguage = lang;
    let englishAnswers = answers;
    
    try {
      detectedLanguage = await detectLanguageWithRetry(description, lang);
      if (detectedLanguage && detectedLanguage !== 'en') {
        englishDescription = await translateTextWithRetry(description, detectedLanguage);
        
        // Traducir las preguntas y respuestas
        englishAnswers = await Promise.all(
          answers.map(async (item) => ({
            question: await translateTextWithRetry(item.question, detectedLanguage),
            answer: await translateTextWithRetry(item.answer, detectedLanguage)
          }))
        );
      }
    } catch (translationError) {
      console.error('Translation error:', translationError.message);
      let infoErrorlang = {
        body: req.body,
        error: translationError.message,
        type: translationError.code || 'TRANSLATION_ERROR',
        detectedLanguage: detectedLanguage || 'unknown',
        model: 'process-follow-up'
      };
      
      await blobOpenDx29Ctrl.createBlobErrorsDx29(infoErrorlang);
      
      try {
        await serviceEmail.sendMailErrorGPTIP(
          req.body.lang,
          req.body.description,
          infoErrorlang,
          requestInfo
        );
      } catch (emailError) {
        console.log('Fail sending email');
        insights.error(emailError);
      }
      
      if (translationError.code === 'UNSUPPORTED_LANGUAGE') {
        insights.error({
          type: 'UNSUPPORTED_LANGUAGE',
          message: translationError.message
        });

        return res.status(200).send({ 
          result: "unsupported_language",
          message: translationError.message
        });
      }

      // Otros errores de traducción
      insights.error({
        type: 'TRANSLATION_ERROR',
        message: translationError.message
      });

      return res.status(500).send({ 
        result: "error",
        message: "An error occurred during translation"
      });
    }

    // 2. Construir el prompt para procesar las respuestas y actualizar la descripción
    const questionsAndAnswers = englishAnswers.map(item => 
      `Question: ${item.question}\nAnswer: ${item.answer}`
    ).join('\n\n');
    
    const prompt = `
    You are a medical assistant helping to update a patient's symptom description based on their answers to follow-up questions.
    
    Original description:
    "${englishDescription}"
    
    Follow-up questions and answers:
    ${questionsAndAnswers}
    
    Please create an updated, comprehensive description that integrates the original information with the new details from the follow-up questions. The updated description should:
    
    1. Maintain all relevant information from the original description
    2. Seamlessly incorporate the new information from the answers
    3. Be well-organized and clear
    4. Be written in first person, as if the patient is describing their symptoms
    5. Not include the questions themselves, only the information
    
    Return ONLY the updated description, with no additional commentary or explanation.`;

    const messages = [{ role: "user", content: prompt }];
    const requestBody = {
      messages,
      temperature: 0.3,
      max_tokens: 2000,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    };

    // Reemplazar la llamada directa a axios con nuestra función de failover
    const openAiResponse = await callOpenAiWithFailover(requestBody, sanitizedData.timezone, 'gpt4o');

    if (!openAiResponse.data.choices[0].message.content) {
      throw new Error('Empty OpenAI response');
    }

    // 3. Obtener la descripción actualizada
    let updatedDescription = openAiResponse.data.choices[0].message.content.trim();

    // 4. Traducir la descripción actualizada al idioma original si es necesario
    if (detectedLanguage !== 'en') {
      try {
        updatedDescription = await translateInvertWithRetry(updatedDescription, detectedLanguage);
      } catch (translationError) {
        console.error('Translation error:', translationError);
        throw translationError;
      }
    }

    // 5. Guardar información para seguimiento
    let infoTrack = {
      originalDescription: description,
      originalDescriptionEnglish: englishDescription,
      myuuid: sanitizedData.myuuid,
      operation: sanitizedData.operation,
      lang: sanitizedData.lang,
      answers: answers,
      answersEnglish: englishAnswers,
      updatedDescription: updatedDescription,
      header_language: header_language,
      timezone: timezone,
      model: 'process-follow-up'
    };
    
    blobOpenDx29Ctrl.createBlobQuestions(infoTrack, 'process-follow-up');

    // 6. Preparar la respuesta final
    return res.status(200).send({
      result: 'success',
      data: {
        updatedDescription: updatedDescription
      },
      detectedLang: detectedLanguage
    });

  } catch (error) {
    console.error('Error:', error);
    insights.error(error);
    let infoError = {
      body: req.body,
      error: error.message,
      model: 'process-follow-up'
    };
    
    blobOpenDx29Ctrl.createBlobErrorsDx29(infoError);
    
    try {
      await serviceEmail.sendMailErrorGPTIP(
        req.body.lang,
        req.body.description,
        infoError,
        requestInfo
      );
    } catch (emailError) {
      console.log('Fail sending email');
    }
    
    return res.status(500).send({ result: "error" });
  }
}

function isValidSummarizeRequest(data) {
  // Validar estructura básica
  if (!data || typeof data !== 'object') return false;

  // Validar campos requeridos
  const requiredFields = ['description', 'myuuid', 'operation', 'lang'];
  if (!requiredFields.every(field => data.hasOwnProperty(field))) return false;

  // Validar description - permitir hasta 128k tokens aproximadamente (alrededor de 400k caracteres)
  if (typeof data.description !== 'string' ||
    data.description.length < 10 ||
    data.description.length > 400000) return false;

  // Validar myuuid
  if (typeof data.myuuid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(data.myuuid)) {
    return false;
  }

  // Validar operation
  if (data.operation !== 'summarize text') return false;

  // Validar lang
  if (typeof data.lang !== 'string' || data.lang.length !== 2) return false;

  // Validar timezone si existe
  if (data.timezone !== undefined && typeof data.timezone !== 'string') {
    return false;
  }

  // Verificar patrones sospechosos
  const suspiciousPatterns = [
    /\{\{[^}]*\}\}/g,  // Handlebars syntax
    /<script\b[^>]*>[\s\S]*?<\/script>/gi,  // Scripts
    /\$\{[^}]*\}/g,    // Template literals
    /\b(prompt:|system:|assistant:|user:)\b/gi  // OpenAI keywords con ':'
  ];

  // Normalizar el texto para la validación
  const normalizedDescription = data.description.replace(/\n/g, ' ');

  return !suspiciousPatterns.some(pattern => {
    const descriptionMatch = pattern.test(normalizedDescription);
    
    if (descriptionMatch) {
      console.log('Pattern matched:', pattern);
      insights.error({
        message: "Pattern matched in summarize request",
        pattern: pattern,
        description: descriptionMatch
      });
    }
    
    return descriptionMatch;
  });
}

async function summarize(req, res) {
  const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  const origin = req.get('origin');
  const header_language = req.headers['accept-language'];

  const requestInfo = {
    method: req.method,
    url: req.url,
    headers: req.headers,
    origin: origin,
    body: req.body,
    ip: clientIp,
    params: req.params,
    query: req.query,
    header_language: header_language,
    timezone: req.body.timezone
  };

  try {
    // Validar y sanitizar el request
    if (!isValidSummarizeRequest(req.body)) {
      insights.error({
        message: "Invalid request format or content for summarization",
        request: req.body
      });
      return res.status(400).send({
        result: "error",
        message: "Invalid request format or content"
      });
    }

    const sanitizedData = sanitizeOpenAiData(req.body);
    const { description, lang, timezone } = sanitizedData;

    // 1. Detectar idioma y traducir a inglés si es necesario
    let englishDescription = description;
    let detectedLanguage = lang;
    try {
      detectedLanguage = await detectLanguageWithRetry(description, lang);
      if (detectedLanguage && detectedLanguage !== 'en') {
        englishDescription = await translateTextWithRetry(description, detectedLanguage);
      }
    } catch (translationError) {
      console.error('Translation error:', translationError.message);
      let infoErrorlang = {
        body: req.body,
        error: translationError.message,
        type: translationError.code || 'TRANSLATION_ERROR',
        detectedLanguage: detectedLanguage || 'unknown',
        model: 'summarize'
      };
      try {
        await serviceEmail.sendMailErrorGPTIP(
          req.body.lang,
          req.body.description,
          infoErrorlang,
          requestInfo
        );
      } catch (emailError) {
        console.log('Fail sending email');
        insights.error(emailError);
      }
      
      await blobOpenDx29Ctrl.createBlobErrorsDx29(infoErrorlang);
      
      if (translationError.code === 'UNSUPPORTED_LANGUAGE') {
        return res.status(200).send({ 
          result: "unsupported_language",
          message: translationError.message
        });
      }

      return res.status(500).send({ 
        result: "error",
        message: "An error occurred during translation"
      });
    }

    // 2. Construir el prompt para el resumen
    const prompt = `
    Summarize the following patient's medical description, keeping only relevant clinical information such as symptoms, evolution time, important medical history, and physical signs. Do not include irrelevant details or repeat phrases. The result should be shorter, clearer, and maintain the medical essence:

    "${englishDescription}"

    Return ONLY the summarized description, with no additional commentary or explanation.`;

    const messages = [{ role: "user", content: prompt }];
    const requestBody = {
      messages,
      temperature: 0, // Cambiado a 0 para máxima precisión
      max_tokens: 1000,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    };

    // 3. Llamar a OpenAI con failover

    let endpoint= 'https://apiopenai.azure-api.net/v2/eu1/summarize/gpt-4o-mini';
    const openAiResponse = await axios.post(endpoint, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': ApiManagementKey,
      }
    });

    if (!openAiResponse.data.choices[0].message.content) {
      throw new Error('Empty OpenAI response');
    }

    // 4. Obtener el resumen
    let summary = openAiResponse.data.choices[0].message.content.trim();
    let summaryEnglish = summary;

    // 5. Traducir el resumen al idioma original si es necesario
    if (detectedLanguage !== 'en') {
      try {
        summary = await translateInvertWithRetry(summary, detectedLanguage);
      } catch (translationError) {
        console.error('Translation error:', translationError);
        throw translationError;
      }
    }

    // 6. Guardar información para seguimiento
    let infoTrack = {
      originalText: description,
      originalTextEnglish: englishDescription,
      myuuid: sanitizedData.myuuid,
      operation: sanitizedData.operation,
      lang: sanitizedData.lang,
      summary: summary,
      summaryEnglish: summaryEnglish,
      header_language: header_language,
      timezone: timezone,
      model: 'summarize'
    };
    
    blobOpenDx29Ctrl.createBlobSummarize(infoTrack);

    // 7. Preparar la respuesta final
    return res.status(200).send({
      result: 'success',
      data: {
        summary: summary
      },
      detectedLang: detectedLanguage
    });

  } catch (error) {
    console.error('Error:', error);
    insights.error(error);
    let infoError = {
      body: req.body,
      error: error.message,
      model: 'summarize'
    };
    
    blobOpenDx29Ctrl.createBlobErrorsDx29(infoError);
    
    try {
      await serviceEmail.sendMailErrorGPTIP(
        req.body.lang,
        req.body.description,
        infoError,
        requestInfo
      );
    } catch (emailError) {
      console.log('Fail sending email');
    }
    
    return res.status(500).send({ result: "error" });
  }
}

// Nueva función para consultar estado
async function getQueueStatus(req, res) {
  try {
    const ticketId = req.params.ticketId;
    const timezone = req.body.timezone; // Opcional: obtener timezone de query params

    if (!ticketId) {
      return res.status(400).send({ 
        result: 'error', 
        message: 'ticketId is required' 
      });
    }

    const status = await queueService.getTicketStatus(ticketId, timezone);
    return res.status(200).send(status);
    
  } catch (error) {
    console.error('Error getting queue status:', error);
    insights.error(error);
    return res.status(500).send({ 
      result: 'error',
      message: 'Internal server error while checking queue status'
    });
  }
}

// Modificar la función getSystemStatus
async function getSystemStatus(req, res) {
  try {
    const status = await queueService.getAllRegionsStatus();
    
    // Añadir información de endpoints sin exponer las URLs
    const endpointsStatus = {};
    for (const [region] of Object.entries(endpointsMap.gpt4o)) {
      const mappedRegion = REGION_MAPPING_STATUS[region];
      const regionStatus = status.regions[mappedRegion];
      endpointsStatus[region] = {
        capacity: REGION_CAPACITY[mappedRegion] || 'N/A',  // Usar REGION_CAPACITY en lugar de regionStatus?.capacity
        utilizationPercentage: regionStatus?.utilizationPercentage || 0,
        activeRequests: regionStatus?.activeRequests || 0,
        queuedMessages: regionStatus?.queuedMessages || 0,
        status: {
          primary: regionStatus?.activeRequests > 0 ? 'active' : 'idle',
          backup: 'standby'
        }
      };
    }

    return res.status(200).send({
      result: 'success',
      data: {
        queues: {
          timestamp: status.timestamp,
          regions: status.regions,
          global: status.global
        },
        endpoints: endpointsStatus,
        lastUpdate: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error getting system status:', error);
    return res.status(500).send({
      result: 'error',
      message: 'Error getting system status'
    });
  }
}

async function checkHealth(req, res) {
  const health = await queueService.checkHealth();
  return res.status(200).send(health);
}

module.exports = {
  callOpenAi,
  callOpenAiV2,
  callOpenAiQuestions,
  opinion,
  sendFeedback,
  sendGeneralFeedback,
  getFeedBack,
  generateFollowUpQuestions,
  processFollowUpAnswers,
  summarize,
  getQueueStatus,
  callOpenAiWithFailover,  // Añadir esta exportación
  anonymizeText,           // Añadir esta exportación
  processOpenAIRequest,  // Asegurarnos de que está exportada
  detectLanguageWithRetry,
  translateInvertWithRetry,
  translateTextWithRetry,
  getSystemStatus,
  checkHealth
};
