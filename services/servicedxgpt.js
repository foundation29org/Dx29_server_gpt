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
const API_MANAGEMENT_BASE = config.API_MANAGEMENT_BASE;
const OpinionStats = require('../models/opinionstats');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function sanitizeInput(input) {
  // Eliminar caracteres especiales y patrones potencialmente peligrosos
  return input
    .replace(/[<>{}]/g, '') // Eliminar caracteres especiales
    .replace(/(\{|\}|\[|\]|\||\\|\/)/g, '') // Eliminar caracteres que podrían ser usados para inyección
    .replace(/prompt:|system:|assistant:|user:/gi, '') // Eliminar palabras clave de OpenAI con ':'
    .trim();
}

function isValidDiagnoseRequest(data) {
  // Validar estructura básica
  if (!data || typeof data !== 'object') return false;

  // Validar campos requeridos (timezone no incluido)
  const requiredFields = ['description', 'myuuid'];
  if (!requiredFields.every(field => data.hasOwnProperty(field))) return false;

  // Validar lang
  if (data.lang !== undefined && (typeof data.lang !== 'string' || data.lang.length !== 2)) {
    return false;
  }

  // Validar description
  if (typeof data.description !== 'string' ||
    data.description.length < 10 ||
    data.description.length > 8000) return false;

  // Validar myuuid
  if (typeof data.myuuid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(data.myuuid)) {
    return false;
  }

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

function sanitizeAiData(data) {
  return {
    ...data,
    description: sanitizeInput(data.description),
    diseases_list: data.diseases_list ? sanitizeInput(data.diseases_list) : '',
    myuuid: data.myuuid.trim(),
    lang: data.lang ? data.lang.trim().toLowerCase() : 'en', // Usar 'en' como predeterminado
    timezone: data.timezone?.trim() || '' // Manejar caso donde timezone es undefined
  };
}

// Añadir esta constante al inicio del archivo, junto con las otras constantes
  const endpointsMap = {
    gpt4o: {
      asia: [
      `${API_MANAGEMENT_BASE}/as1/call/gpt4o`, // India: 428 calls/min
      `${API_MANAGEMENT_BASE}/as2/call/gpt4o`  // Japan: 300 calls/min
      ],
      europe: [
      `${API_MANAGEMENT_BASE}/eu1/call/gpt4o`, // Suiza: 428 calls/min
      `${API_MANAGEMENT_BASE}/us1/call/gpt4o`  // WestUS: 857 calls/min como backup
      ],
      northamerica: [
      `${API_MANAGEMENT_BASE}/us1/call/gpt4o`, // WestUS: 857 calls/min
      `${API_MANAGEMENT_BASE}/us2/call/gpt4o`  // EastUS2: 420 calls/min
      ],
      southamerica: [
      `${API_MANAGEMENT_BASE}/us1/call/gpt4o`, // WestUS: 857 calls/min
      `${API_MANAGEMENT_BASE}/us2/call/gpt4o`  // EastUS2: 420 calls/min
      ],
      africa: [
      `${API_MANAGEMENT_BASE}/us1/call/gpt4o`, // WestUS: 857 calls/min
      `${API_MANAGEMENT_BASE}/as2/call/gpt4o`  // Japan: 300 calls/min
      ],
      oceania: [
      `${API_MANAGEMENT_BASE}/as2/call/gpt4o`, // Japan: 300 calls/min
      `${API_MANAGEMENT_BASE}/us1/call/gpt4o`  // WestUS: 857 calls/min como backup
      ],
      other: [
      `${API_MANAGEMENT_BASE}/us1/call/gpt4o`, // WestUS: 857 calls/min
      `${API_MANAGEMENT_BASE}/as2/call/gpt4o`  // Japan: 300 calls/min
      ]
    },
    o1: {
      asia: [
      `${API_MANAGEMENT_BASE}/as1/call/o1`, // India
      `${API_MANAGEMENT_BASE}/as2/call/o1`  // Japan
      ],
      europe: [
      `${API_MANAGEMENT_BASE}/eu1/call/o1`, // Suiza
      `${API_MANAGEMENT_BASE}/us1/call/o1`  // WestUS como backup
      ],
      northamerica: [
      `${API_MANAGEMENT_BASE}/us1/call/o1`, // WestUS
      `${API_MANAGEMENT_BASE}/us2/call/o1`  // EastUS2
      ],
      southamerica: [
      `${API_MANAGEMENT_BASE}/us1/call/o1`, // WestUS
      `${API_MANAGEMENT_BASE}/us2/call/o1`  // EastUS2
      ],
      africa: [
      `${API_MANAGEMENT_BASE}/us1/call/o1`, // WestUS
      `${API_MANAGEMENT_BASE}/as2/call/o1`  // Japan
      ],
      oceania: [
      `${API_MANAGEMENT_BASE}/as2/call/o1`, // Japan
      `${API_MANAGEMENT_BASE}/us1/call/o1`  // WestUS como backup
      ],
      other: [
      `${API_MANAGEMENT_BASE}/us1/call/o1`, // WestUS
      `${API_MANAGEMENT_BASE}/as2/call/o1`  // Japan
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

async function callAiWithFailover(requestBody, timezone, model = 'gpt4o', retryCount = 0) {
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
        message: `Fallo AI endpoint ${endpoints[retryCount]}`,
        error: error.message,
        retryCount
      });
      await delay(RETRY_DELAY);
      return callAiWithFailover(requestBody, timezone, model, retryCount + 1);
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
async function processAIRequest(data, requestInfo = null, model = 'gpt4o') {
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

    // 2. Llamar a AI con el texto en inglés
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

  const diagnoseResponse = await callAiWithFailover(requestBody, data.timezone, model);

    if (!diagnoseResponse.data.choices[0].message.content) {
    throw new Error("No response from AI");
    }

  // 3. Anonimizar el texto
  let anonymizedResult = await anonymizeText(englishDescription, data.timezone);
    let anonymizedDescription = anonymizedResult.anonymizedText;
    let anonymizedDescriptionEnglish = anonymizedDescription;
    const hasPersonalInfo = anonymizedResult.hasPersonalInfo;

    if (detectedLanguage !== 'en') {
      try {
        anonymizedDescription = await translateInvertWithRetry(anonymizedDescription, detectedLanguage);
        anonymizedResult.htmlText = await translateInvertWithRetry(anonymizedResult.htmlText, detectedLanguage);
      } catch (translationError) {
        console.error('Error en la traducción inversa:', translationError.message);
        insights.error({
          message: translationError.message,
          stack: translationError.stack,
          code: translationError.code,
          phase: 'translation',
          detectedLanguage: detectedLanguage,
          requestData: data,
          model: model
        });
        throw translationError;
      }
    }

    // 4. Procesar la respuesta
    let parsedResponse;
    let parsedResponseEnglish;
    try {
      const match = diagnoseResponse.data.choices[0].message.content
        .match(/<diagnosis_output>([\s\S]*?)<\/diagnosis_output>/);

      if (!match || !match[1]) {
        const error = new Error("Failed to match diagnosis output");
        error.rawResponse = diagnoseResponse.data.choices[0].message.content;
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
        stack: parseError.stack,
        rawResponse: parseError.rawResponse,
        description: data.description,
        matchedContent: parseError.matchedContent,
        jsonError: parseError.jsonError,
        phase: 'parsing',
        model: model,
        requestData: data
      });
    if (requestInfo) {
      let infoError = {
        myuuid: data.myuuid,
        operation: 'find disease',
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
      insights.error({
        message: translationError.message,
        stack: translationError.stack,
        code: translationError.code,
        phase: 'translation',
        detectedLanguage: detectedLanguage,
        requestData: data,
        model: model
      });
        throw translationError;
      }
    }

  // 6. Guardar información de seguimiento si es una llamada directa
  if (requestInfo) {
    let infoTrack = {
      value: anonymizedDescription,
      valueEnglish: anonymizedDescriptionEnglish,
      myuuid: data.myuuid,
      operation: 'find disease',
      lang: data.lang,
      response: parsedResponse,
      responseEnglish: parsedResponseEnglish,
      topRelatedConditions: data.diseases_list,
      topRelatedConditionsEnglish: englishDiseasesList,
      header_language: requestInfo.header_language,
      timezone: data.timezone,
      model: model
    };
    if(model == 'gpt4o'){
      await blobOpenDx29Ctrl.createBlobOpenDx29(infoTrack, 'v1');
    }else{
      await blobOpenDx29Ctrl.createBlobOpenDx29(infoTrack, 'v2');
    }
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

  const endpoints = getEndpointsByTimezone(timezone, 'gpt4o', 'anonymized');

  const anonymizationPrompt = `The task is to anonymize the following medical document by replacing any personally identifiable information (PII) with [ANON-N], 
  where N is the count of characters that have been anonymized. 
  Only specific information that can directly lead to patient identification needs to be anonymized. This includes but is not limited to: 
  full names, addresses, contact details, Social Security Numbers, and any unique identification numbers. 
  However, it's essential to maintain all medical specifics, such as medical history, diagnosis, treatment plans, and lab results, as they are not classified as PII. 
  Note: Do not anonymize age, as it is not considered PII in this context. 
  The anonymized document should retain the integrity of the original content, apart from the replaced PII. 
  Avoid including any information that wasn't part of the original document and ensure the output reflects the original content structure and intent, albeit anonymized. 
  If any part of the text is already anonymized (represented by asterisks or [ANON-N]), do not anonymize it again. 
  Here is the original document:

  {{text}}

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


function isValidQuestionRequest(data) {
  // Validar estructura básica
  if (!data || typeof data !== 'object') return false;

  // Validar campos requeridos
  const requiredFields = ['questionType', 'disease', 'myuuid'];
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

  // Validar detectedLang si existe  
  if (data.detectedLang !== undefined && (typeof data.detectedLang !== 'string' || data.detectedLang.length !== 2)) return false;

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
    timezone: data.timezone?.trim() || '',
    questionType: Number(data.questionType),
    detectedLang: data.detectedLang ? data.detectedLang.trim().toLowerCase() : 'en'
  };
}


async function callInfoDisease(req, res) {
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
    const result = await callAiWithFailover(requestBody, sanitizedData.timezone, 'gpt4o');
    if (!result.data.choices[0].message.content) {
      try {
        await serviceEmail.sendMailErrorGPTIP(sanitizedData.detectedLang, req.body, result.data.choices, requestInfo);
      } catch (emailError) {
        console.log('Fail sending email');
      }
      insights.error('error ai callInfoDisease');
      let infoError = {
        error: result.data,
        requestInfo: requestInfo
      }
      blobOpenDx29Ctrl.createBlobErrorsDx29(infoError);
      return res.status(200).send({ result: "error ai" });
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
      endpoint: 'callInfoDisease',
      requestData: {
        body: req.body,
        questionType: req.body?.questionType,
        disease: req.body?.disease,
        lang: req.body?.detectedLang || 'en'
      },
      error: {
        message: e.message,
        stack: e.stack,
        name: e.name
      }
    };
    console.error('Detailed API Error:', JSON.stringify(errorDetails, null, 2));
    insights.error({
      message: 'API Error in callInfoDisease',
      details: errorDetails
    });
    blobOpenDx29Ctrl.createBlobErrorsDx29(errorDetails);

    if (e.response) {
      console.log(e.response.status);
      console.log(e.response.data);

      try {
        await serviceEmail.sendMailErrorGPTIP(
          req.body?.detectedLang || 'en',
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
        message: 'Non-API Error in callInfoDisease',
        details: errorDetails
      });
    }

    // Intentar enviar el email de error
    try {
      await serviceEmail.sendMailErrorGPTIP(
        req.body?.detectedLang || 'en',
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
  const requiredFields = ['value', 'myuuid', 'vote'];
  if (!requiredFields.every(field => data.hasOwnProperty(field))) return false;

  // Validar myuuid
  if (typeof data.myuuid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(data.myuuid)) {
    return false;
  }

   // Validar lang
   if (data.lang !== undefined && (typeof data.lang !== 'string' || data.lang.length !== 2)) {
    return false;
  }

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
    lang: data.lang ? data.lang.trim().toLowerCase() : 'en',
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

    // Guardar SIEMPRE la estadística (sin value)
    const stats = new OpinionStats({
      myuuid: sanitizedData.myuuid,
      lang: sanitizedData.lang,
      vote: sanitizedData.vote,
      topRelatedConditions: sanitizedData.topRelatedConditions,
      isNewModel: sanitizedData.isNewModel
    });
    await stats.save();

    // Guardar en blob
    sanitizedData.version = PROMPTS.version;
    await blobOpenDx29Ctrl.createBlobOpenVote(sanitizedData);
    res.status(200).send({ send: true })
  } catch (e) {
    insights.error(e);
    console.error("[ERROR] opinion responded with status: " + e)
    let lang = req.body.lang ? req.body.lang : 'en';
    serviceEmail.sendMailError(lang, req.body.value, e)
      .then(response => {})
      .catch(response => {
        insights.error(response);
        console.log('Fail sending email');
      })
    res.status(500).send('error')
  }
}

function isValidGeneralFeedbackData(data) {
  // Validar estructura básica
  if (!data || typeof data !== 'object') return false;

  // Validar campos requeridos
  const requiredFields = ['value', 'myuuid'];
  if (!requiredFields.every(field => data.hasOwnProperty(field))) return false;

  // Validar myuuid
  if (typeof data.myuuid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(data.myuuid)) {
    return false;
  }

  // Validar lang
  if (data.lang !== undefined && (typeof data.lang !== 'string' || data.lang.length !== 2)) {
    return false;
  }

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

function isValidFollowUpQuestionsRequest(data) {
  // Validar estructura básica
  if (!data || typeof data !== 'object') return false;

  // Validar campos requeridos
  const requiredFields = ['description', 'diseases', 'myuuid'];
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

  // Validar lang
  if (data.lang !== undefined && (typeof data.lang !== 'string' || data.lang.length !== 2)) {
    return false;
  }

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
    lang: data.lang ? data.lang.trim().toLowerCase() : 'en',
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
          lang,
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
    You are a medical assistant helping to gather more information from a patient before making a diagnosis. The patient has provided the following description of their symptoms:

    "${englishDescription}"

    The system has already suggested the following possible conditions: ${englishDiseases}.
    The patient indicated that none of these seem to match their experience.

    Please prioritize follow-up questions that would help clarify or rule out these conditions, focusing on symptoms or details that are commonly used to differentiate them.

    Analyze this description and generate 5–8 relevant follow-up questions to complete the patient's clinical profile.

    When formulating your questions, identify any critical information missing from the description, which may include:
    - Age, sex/gender, height, weight (if not already mentioned)
    - Duration and progression of symptoms
    - Severity, frequency, and triggers
    - Associated symptoms not yet mentioned
    - Relevant medical history or pre-existing conditions
    - Family history if potentially relevant
    - Current medications
    - Previous treatments tried
    - Potential risk factors or exposures (e.g. travel, smoking, occupational hazards, drug use, recent contact with sick individuals)
    - **Any red-flag signs** (confusion, significant weakness, severe pain, hypotension, etc.) if the description suggests an urgent condition
    - **Immunization status or immunosuppression** if indicated by the symptoms

    If the patient is a child, frame your questions as if speaking to a caregiver. Include questions about developmental milestones, immunizations, and relevant birth/early childhood history.
    Do not ask for personal identifiers such as name, address, phone number, email, or ID numbers.

    Your questions should:
    1. Focus first on missing demographic details (age, sex/gender) if not already provided.
    2. Gather more specific details about the symptoms mentioned, including timing, severity, triggers, and alleviating factors.
    3. Explore related or secondary symptoms that haven't been mentioned but could differentiate between conditions.
    4. Ask about relevant medical history, family history, current medications, and any treatments tried.
    5. Incorporate risk factors, exposures, and any red-flag or emergency indicators suggested by the symptoms.
    6. Be clear, concise, and easy for the patient to understand.
    7. Avoid medical jargon whenever possible.

    Format your response as a JSON array of strings. Example:
    ["Question 1?", "Question 2?", "Question 3?", "Question 4?", "Question 5?", "Question 6?", "Question 7?", "Question 8?"]

    Your response should be ONLY the JSON array, with no additional text or explanation.
    `;

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
    const diagnoseResponse = await callAiWithFailover(requestBody, sanitizedData.timezone, 'gpt4o');

    if (!diagnoseResponse.data.choices[0].message.content) {
      throw new Error('Empty AI follow-up response');
    }

    // 3. Procesar la respuesta
    let questions;
    try {
      // Limpiar la respuesta para asegurar que es un JSON válido
      const content = diagnoseResponse.data.choices[0].message.content.trim();
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
        rawResponse: diagnoseResponse.data.choices[0].message.content
      });
      
      let infoError = {
        myuuid: sanitizedData.myuuid,
        operation: 'follow-up',
        lang: sanitizedData.lang,
        description: description,
        error: parseError.message,
        rawResponse: diagnoseResponse.data.choices[0].message.content,
        model: 'follow-up'
      };
      try {
        await serviceEmail.sendMailErrorGPTIP(
          sanitizedData.lang,
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
      operation: 'follow-up',
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
      let lang = req.body.lang ? req.body.lang : 'en';
      await serviceEmail.sendMailErrorGPTIP(
        lang,
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


function isValidERQuestionsRequest(data) {
  // Validar estructura básica
  if (!data || typeof data !== 'object') return false;

  // Validar campos requeridos
  const requiredFields = ['description', 'myuuid'];
  if (!requiredFields.every(field => data.hasOwnProperty(field))) return false;

  // Validar description
  if (typeof data.description !== 'string' ||
    data.description.length < 10 ||
    data.description.length > 8000) return false;

  // Validar myuuid
  if (typeof data.myuuid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(data.myuuid)) {
    return false;
  }

  // Validar lang
  if (data.lang !== undefined && (typeof data.lang !== 'string' || data.lang.length !== 2)) {
    return false;
  }

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
    return pattern.test(normalizedDescription);
  });
}

function sanitizeERQuestionsData(data) {
  return {
    ...data,
    description: sanitizeInput(data.description),
    myuuid: data.myuuid.trim(),
    lang: data.lang ? data.lang.trim().toLowerCase() : 'en',
    timezone: data.timezone?.trim() || '' // Manejar caso donde timezone es undefined
  };
}
async function generateERQuestions(req, res) {
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
    if (!isValidERQuestionsRequest(req.body)) {
      insights.error({
        message: "Invalid request format or content for ER questions",
        request: req.body
      });
      return res.status(400).send({
        result: "error",
        message: "Invalid request format or content"
      });
    }

    const sanitizedData = sanitizeERQuestionsData(req.body);
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
        model: 'follow-up'
      };
      
      await blobOpenDx29Ctrl.createBlobErrorsDx29(infoErrorlang);
      
      try {
        await serviceEmail.sendMailErrorGPTIP(
          lang,
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

    // 2. Construir el prompt para generar preguntas iniciales

    const prompt = `
You are a medical assistant helping to gather more information from a patient before making a diagnosis. The patient has provided the following initial description of their symptoms:

"${englishDescription}"

Analyze this description and generate 5-8 relevant follow-up questions to complete the patient's clinical profile.

When formulating your questions, identify any critical information missing from the description, which may include:
- Age, sex/gender, height, weight (if not already mentioned)
- Duration and progression of symptoms
- Severity, frequency, and triggers
- Associated symptoms not yet mentioned
- Relevant medical history or pre-existing conditions
- Family history if potentially relevant
- Current medications
- Previous treatments tried
- Potential risk factors or exposures (e.g. travel, smoking, occupational hazards, drug use, recent contact with sick individuals)
- **Any red-flag signs** (confusion, significant weakness, severe pain, hypotension, etc.) if the description suggests an urgent condition
- **Immunization status or immunosuppression** if indicated by the symptoms

If the patient appears to be a child or infant, frame the questions as if speaking to a caregiver (parent or guardian). In that case, also include questions about developmental milestones, pediatric immunizations, and relevant birth or early childhood history.

Your questions should:
1. Focus first on missing demographic details (age, sex/gender) if not already provided.
2. Gather more specific details about the symptoms mentioned, including timing, severity, triggers, and alleviating factors.
3. Explore related or secondary symptoms that haven't been mentioned but could differentiate between conditions.
4. Ask about relevant medical history, family history, current medications, and any treatments tried.
5. Incorporate risk factors, exposures, and any red-flag or emergency indicators suggested by the symptoms.
6. Be clear, concise, and easy for the patient to understand.
7. Avoid medical jargon whenever possible.

Do not ask for personal identifiers such as full name, address, phone number, email, or national ID. Focus only on medically relevant information.
Format your response as a JSON array of strings, with each string being a question. For example:
["Question 1?", "Question 2?", "Question 3?", "Question 4?", "Question 5?", "Question 6?", "Question 7?", "Question 8?"]

Your response should be ONLY the JSON array, with no additional text or explanation.
`;


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
    const diagnoseResponse = await callAiWithFailover(requestBody, sanitizedData.timezone, 'gpt4o');

    if (!diagnoseResponse.data.choices[0].message.content) {
      throw new Error('Empty AI er-questions response');
    }

    // 3. Procesar la respuesta
    let questions;
    try {
      // Limpiar la respuesta para asegurar que es un JSON válido
      const content = diagnoseResponse.data.choices[0].message.content.trim();
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
        rawResponse: diagnoseResponse.data.choices[0].message.content
      });
      
      let infoError = {
        myuuid: sanitizedData.myuuid,
        operation: 'er-questions',
        lang: sanitizedData.lang,
        description: description,
        error: parseError.message,
        rawResponse: diagnoseResponse.data.choices[0].message.content,
        model: 'follow-up'
      };
      try {
        await serviceEmail.sendMailErrorGPTIP(
          sanitizedData.lang,
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
      operation: 'er-questions',
      lang: sanitizedData.lang,
      questions: questions,
      header_language: header_language,
      timezone: timezone,
      model: 'er-questions'
    };
    
    blobOpenDx29Ctrl.createBlobQuestions(infoTrack, 'er-questions');

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
      let lang = req.body.lang ? req.body.lang : 'en';
      await serviceEmail.sendMailErrorGPTIP(
        lang,
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
  const requiredFields = ['description', 'answers', 'myuuid'];
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

  // Validar lang
  if (data.lang !== undefined && (typeof data.lang !== 'string' || data.lang.length !== 2)) {
    return false;
  }

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
    lang: data.lang ? data.lang.trim().toLowerCase() : 'en',
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
          lang,
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
    const diagnoseResponse = await callAiWithFailover(requestBody, sanitizedData.timezone, 'gpt4o');

    if (!diagnoseResponse.data.choices[0].message.content) {
      throw new Error('Empty AI process-follow-up response');
    }

    // 3. Obtener la descripción actualizada
    let updatedDescription = diagnoseResponse.data.choices[0].message.content.trim();

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
      operation: 'process-follow-up',
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
    
    let lang = req.body.lang ? req.body.lang : 'en';
    try {
      await serviceEmail.sendMailErrorGPTIP(
        lang,
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
  const requiredFields = ['description', 'myuuid'];
  if (!requiredFields.every(field => data.hasOwnProperty(field))) return false;

  // Validar description - permitir hasta 128k tokens aproximadamente (alrededor de 400k caracteres)
  if (typeof data.description !== 'string' ||
    data.description.length < 10 ||
    data.description.length > 400000) return false;

  // Validar myuuid
  if (typeof data.myuuid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(data.myuuid)) {
    return false;
  }

  // Validar lang
  if (data.lang !== undefined && (typeof data.lang !== 'string' || data.lang.length !== 2)) {
    return false;
  }

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

    const sanitizedData = sanitizeAiData(req.body);
    const { description, lang } = sanitizedData;

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
          lang,
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

    // 3. Llamar a AI con failover

    let endpoint = `${API_MANAGEMENT_BASE}/eu1/summarize/gpt-4o-mini`;
    const diagnoseResponse = await axios.post(endpoint, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': ApiManagementKey,
      }
    });

    if (!diagnoseResponse.data.choices[0].message.content) {
      throw new Error('Empty AI summarize response');
    }

    // 4. Obtener el resumen
    let summary = diagnoseResponse.data.choices[0].message.content.trim();
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
      let lang = req.body.lang ? req.body.lang : 'en';
      await serviceEmail.sendMailErrorGPTIP(
        lang,
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

    const status = await queueService.getTicketStatus(ticketId);
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

async function diagnose(req, res) {
  // Extraer el modelo de la solicitud o usar gpt4o como predeterminado
  const model = req.body.model || 'gpt4o';
  const useQueue = model === 'gpt4o'; // Solo usar colas para el modelo principal (rápido)
  
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
    if (!isValidDiagnoseRequest(req.body)) {
      insights.error({
        message: "Invalid request format or content",
        request: req.body
      });
      return res.status(400).send({
        result: "error",
        message: "Invalid request format or content"
      });
    }

    const sanitizedData = sanitizeAiData(req.body);

    // Sistema de colas (solo para gpt4o)
    if (useQueue) {
      // Verificar el estado de la cola específica de la región
      const queueProperties = await queueService.getQueueProperties(sanitizedData.timezone);
      console.log('queueProperties for region:', queueProperties);
      console.log('queueUtilizationThreshold:', config.queueUtilizationThreshold);
      console.log('queueProperties.utilizationPercentage:', queueProperties.utilizationPercentage);
      
      if (queueProperties.utilizationPercentage >= config.queueUtilizationThreshold) {
        // Si estamos por encima del umbral para esta región, usar su cola específica
        console.log('Adding to queue for region:', sanitizedData.timezone);
        const queueInfo = await queueService.addToQueue(sanitizedData, requestInfo, model);
        console.log('Queue info received:', queueInfo);

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

      // Si no usamos la cola, registrar la petición activa en la región
      const region = await queueService.registerActiveRequest(sanitizedData.timezone);

      try {
        const result = await processAIRequest(sanitizedData, requestInfo, model);
        await queueService.releaseActiveRequest(region);
        return res.status(200).send(result);
      } catch (error) {
        await queueService.releaseActiveRequest(region);
        throw error;
      }
    } else {
      // Para otros modelos (o1), procesamiento directo sin cola
      const result = await processAIRequest(sanitizedData, requestInfo, model);
      return res.status(200).send(result);
    }

  } catch (error) {
    console.error('Error:', error);
    insights.error({
      message: error.message || 'Unknown error in diagnose',
      stack: error.stack,
      code: error.code,
      result: error.result,
      timestamp: new Date().toISOString(),
      endpoint: 'diagnose',
      phase: error.phase || 'unknown',
      requestInfo: {
        method: requestInfo.method,
        url: requestInfo.url,
        origin: requestInfo.origin,
        ip: requestInfo.ip,
        timezone: requestInfo.timezone,
        header_language: requestInfo.header_language
      },
      requestData: req.body,
      model: model
    });
    
    let infoError = {
      body: req.body,
      error: error.message,
      model: model
    };
    
    await blobOpenDx29Ctrl.createBlobErrorsDx29(infoError);
    
    try {
      let lang = req.body.lang ? req.body.lang : 'en';
      await serviceEmail.sendMailErrorGPTIP(
        lang,
        req.body.description,
        infoError,
        requestInfo
      );
    } catch (emailError) {
      console.log('Fail sending email');
    }
    
    if (error.result === 'translation error') {
      return res.status(200).send({
        result: "translation error",
        message: error.message,
        code: error.code || 'TRANSLATION_ERROR'
      });
    } else if (error.result === 'unsupported_language') {
      return res.status(200).send({
        result: "unsupported_language",
        message: error.message,
        code: error.code || 'UNSUPPORTED_LANGUAGE'
      });
    }
    
    return res.status(500).send({ result: "error" });
  }
}

module.exports = {
  diagnose,
  callInfoDisease,
  opinion,
  sendGeneralFeedback,
  generateFollowUpQuestions,
  generateERQuestions,
  processFollowUpAnswers,
  summarize,
  getQueueStatus,
  callAiWithFailover,
  anonymizeText,
  processAIRequest,
  detectLanguageWithRetry,
  translateInvertWithRetry,
  translateTextWithRetry,
  getSystemStatus,
  checkHealth
};
