
const { OpenAIClient, AzureKeyCredential } = require("@azure/openai");
const config = require('../config')
const insights = require('../services/insights')
const request = require('request')
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
  const requiredFields = ['description', 'myuuid', 'operation', 'lang', 'ip'];
  if (!requiredFields.every(field => data.hasOwnProperty(field))) return false;

  // Validar description
  if (typeof data.description !== 'string' ||
    data.description.length < 10 ||
    data.description.length > 4000) return false;

  // Validar myuuid
  if (typeof data.myuuid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(data.myuuid)) {
    return false;
  }

  // Validar operation
  if (data.operation !== 'find disease') return false;

  // Validar lang
  if (typeof data.lang !== 'string' || data.lang.length !== 2) return false;

  // Validar ip
  if (typeof data.ip !== 'string') return false;

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
    ip: data.ip.trim(),
    timezone: data.timezone?.trim() || '' // Manejar caso donde timezone es undefined
  };
}

async function callOpenAi(req, res) {
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
    // Validar y sanitizar el request
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
    const { description, diseases_list, lang, ip, timezone } = sanitizedData;

    // Validar IP
    if (!ip) {
      try {
        await serviceEmail.sendMailErrorGPTIP(lang, description, "", ip, requestInfo);
      } catch (emailError) {
        console.log('Fail sending email');
      }
      return res.status(200).send({ result: "blocked" });
    }

    // 1. Detectar idioma y traducir a inglés si es necesario
    let englishDescription = description;
    let detectedLanguage = lang;
    let englishDiseasesList = diseases_list;
    try {
      detectedLanguage = await translationCtrl.detectLanguage(description, lang);
      if (detectedLanguage && detectedLanguage !== 'en') {
        englishDescription = await translationCtrl.translateText(description, detectedLanguage);
        if (englishDiseasesList) {
          englishDiseasesList = await translationCtrl.translateText(diseases_list, detectedLanguage);
        }
      }
    } catch (translationError) {
      console.error('Translation error:', translationError.message);
      let infoErrorlang = {
        body: req.body,
        error: translationError.message,
        type: translationError.code || 'TRANSLATION_ERROR',
        detectedLanguage: detectedLanguage || 'unknown',
        model: 'gpt4o'
      };
      
      await blobOpenDx29Ctrl.createBlobErrorsDx29(infoErrorlang);
      
      try {
        await serviceEmail.sendMailErrorGPTIP(
          req.body.lang,
          req.body.description,
          translationError,
          req.body.ip,
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

    // 2. Llamar a OpenAI con el texto en inglés
    const prompt = englishDiseasesList ?
      PROMPTS.diagnosis.withDiseases
        .replace("{{description}}", englishDescription)
        .replace("{{diseases_list}}", englishDiseasesList) :
      PROMPTS.diagnosis.withoutDiseases
        .replace("{{description}}", englishDescription);

    const messages = [{ role: "user", content: prompt }];
    const requestBody = {
      messages,
      temperature: 0,
      //max_tokens: calculateMaxTokens(prompt),
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    };

    const endpointUrl = timezone?.includes("America") ?
      'https://apiopenai.azure-api.net/dxgptamerica/deployments/gpt4o' :
      'https://apiopenai.azure-api.net/dxgpt/deployments/gpt4o';

    const openAiResponse = await axios.post(endpointUrl, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': ApiManagementKey,
      }
    });

    if (!openAiResponse.data.choices[0].message.content) {
      throw new Error('Empty OpenAI response');
    }

    // 3. Anonimizar el texto en inglés
    let anonymizedResult = await anonymizeText(englishDescription);
    let anonymizedDescription = anonymizedResult.anonymizedText;
    const hasPersonalInfo = anonymizedResult.hasPersonalInfo;
    //add translation anonimized
    if (detectedLanguage !== 'en') {
      anonymizedDescription = await translationCtrl.translateInvert(anonymizedDescription, detectedLanguage);
      anonymizedResult.htmlText = await translationCtrl.translateInvert(anonymizedResult.htmlText, detectedLanguage);
    }

    // 4. Procesar la respuesta
    let parsedResponse;
    let parsedResponseEnglish;
    try {
      // Log the raw response for debugging
      //console.log('Raw OpenAI response:', openAiResponse.data.choices[0].message.content);

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
      console.error("Failed to parse diagnosis output:", {
        error: parseError.message,
        rawResponse: parseError.rawResponse,
        description: description,
        matchedContent: parseError.matchedContent,
        jsonError: parseError.jsonError
      });
      insights.error({
        message: "Failed to parse diagnosis output",
        error: parseError.message,
        rawResponse: parseError.rawResponse,
        description: description,
        matchedContent: parseError.matchedContent,
        jsonError: parseError.jsonError
      });
      //save error in blob
      let infoError = {
        myuuid: sanitizedData.myuuid,
        operation: sanitizedData.operation,
        lang: sanitizedData.lang,
        description: description,
        error: parseError.message,
        rawResponse: parseError.rawResponse,
        matchedContent: parseError.matchedContent,
        jsonError: parseError.jsonError,
        model: 'gpt4o'
      }
      blobOpenDx29Ctrl.createBlobErrorsDx29(infoError);
      return res.status(200).send({ result: "error" });
    }

    // 5. Traducir la respuesta al idioma original si es necesario
    if (detectedLanguage !== 'en') {
      try {
        parsedResponse = await Promise.all(
          parsedResponse.map(async diagnosis => ({
            diagnosis: await translationCtrl.translateInvert(diagnosis.diagnosis, detectedLanguage),
            description: await translationCtrl.translateInvert(diagnosis.description, detectedLanguage),
            symptoms_in_common: await Promise.all(
              diagnosis.symptoms_in_common.map(symptom =>
                translationCtrl.translateInvert(symptom, detectedLanguage)
              )
            ),
            symptoms_not_in_common: await Promise.all(
              diagnosis.symptoms_not_in_common.map(symptom =>
                translationCtrl.translateInvert(symptom, detectedLanguage)
              )
            )
          }))
        );
      } catch (translationError) {
        console.error('Translation error:', translationError);
        throw translationError;
        //return res.status(500).send({ result: "translation error" });
      }
    }

    let infoTrack = {
      value: anonymizedDescription,
      valueEnglish: englishDescription,
      myuuid: sanitizedData.myuuid,
      operation: sanitizedData.operation,
      lang: sanitizedData.lang,
      response: parsedResponse,
      responseEnglish: parsedResponseEnglish,
      topRelatedConditions: sanitizedData.diseases_list,
      topRelatedConditionsEnglish: englishDiseasesList,
      header_language: header_language,
      timezone: timezone
    }
    blobOpenDx29Ctrl.createBlobOpenDx29(infoTrack, 'v1');

    // 6. Preparar la respuesta final
    return res.status(200).send({
      result: 'success',
      data: parsedResponse,
      anonymization: {
        hasPersonalInfo,
        anonymizedText: anonymizedDescription,
        anonymizedTextHtml: anonymizedResult.htmlText
      },
      detectedLang: detectedLanguage
    });

  } catch (error) {
    console.error('Error:', error);
    insights.error(error);
    let infoError = {
      body: req.body,
      error: error.message,
      rawResponse: error.rawResponse,
      matchedContent: error.matchedContent,
      jsonError: error.jsonError,
      model: 'gpt4o'
    }
    blobOpenDx29Ctrl.createBlobErrorsDx29(infoError);
    try {
      await serviceEmail.sendMailErrorGPTIP(
        req.body.lang,
        req.body.description,
        error,
        req.body.ip,
        requestInfo
      );
    } catch (emailError) {
      console.log('Fail sending email');
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
async function anonymizeText(text) {
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

  const result = await axios.post(
    'https://apiopenai.azure-api.net/dxgpt/anonymized/gpt4o',
    {
      messages,
      temperature: 0,
      max_tokens: calculateMaxTokensAnon(text),
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': ApiManagementKey,
      }
    }
  );

  const resultResponse = {
    hasPersonalInfo: false,
    anonymizedText: '',
    htmlText: ''
  };

  // Verificar si existe el contenido
  if (result.data.choices[0].message.content) {
    const response = result.data.choices[0].message.content
      .replace(/^\s*"""\s*/, '')
      .replace(/\s*"""\s*$/, '');

    const parts = response.split(/(\[ANON-\d+\])/g);
    resultResponse.hasPersonalInfo = parts.length > 1;

    // Preparar versiones del texto
    const htmlParts = parts.map(part => {
      const match = part.match(/\[ANON-(\d+)\]/);
      if (match) {
        const length = parseInt(match[1]);
        return `<span style="background-color: black; display: inline-block; width:${length}em;">&nbsp;</span>`;
      }
      return part;
    });

    const copyParts = parts.map(part => {
      const match = part.match(/\[ANON-(\d+)\]/);
      if (match) {
        const length = parseInt(match[1]);
        return '*'.repeat(length);
      }
      return part;
    });

    // Asignar los valores procesados al objeto de retorno
    resultResponse.anonymizedText = copyParts.join('');
    resultResponse.htmlText = htmlParts.join('').replace(/\n/g, '<br>');
  }

  // Devolver el objeto de respuesta
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
    // Validar y sanitizar el request
    if (!isValidOpenAiRequest(req.body)) {
      return res.status(400).send({
        result: "error",
        message: "Invalid request format or content"
      });
    }

    const sanitizedData = sanitizeOpenAiData(req.body);
    const { description, diseases_list, lang, ip, timezone } = sanitizedData;

    // Validar IP
    if (!ip) {
      try {
        await serviceEmail.sendMailErrorGPTIP(lang, description, "", ip, requestInfo);
      } catch (emailError) {
        console.log('Fail sending email');
      }
      return res.status(200).send({ result: "blocked" });
    }

    // 1. Detectar idioma y traducir a inglés si es necesario
    let englishDescription = description;
    let detectedLanguage = lang;
    let englishDiseasesList = diseases_list;
    try {
      detectedLanguage = await translationCtrl.detectLanguage(description, lang);
      if (detectedLanguage && detectedLanguage !== 'en') {
        englishDescription = await translationCtrl.translateText(description, detectedLanguage);
        if (englishDiseasesList) {
          englishDiseasesList = await translationCtrl.translateText(diseases_list, detectedLanguage);
        }
      }
    } catch (translationError) {
      console.error('Translation error:', translationError.message);
       // Registrar el error en el blob y enviar email
      let infoErrorlang = {
        body: req.body,
        error: translationError.message,
        type: translationError.code || 'TRANSLATION_ERROR',
        detectedLanguage: detectedLanguage || 'unknown',
        model: 'o1-preview'
      };
      
      await blobOpenDx29Ctrl.createBlobErrorsDx29(infoErrorlang);
      
      try {
        await serviceEmail.sendMailErrorGPTIP(
          req.body.lang,
          req.body.description,
          translationError,
          req.body.ip,
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

    const endpointUrl = 'https://apiopenai.azure-api.net/dxgpt/deployments/o1-preview';

    const openAiResponse = await axios.post(endpointUrl, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': ApiManagementKey,
      }
    });

    if (!openAiResponse.data.choices[0].message.content) {
      throw new Error('Empty OpenAI response');
    }

    // 3. Anonimizar el texto en inglés
    let anonymizedResult = await anonymizeText(englishDescription);
    let anonymizedDescription = anonymizedResult.anonymizedText;
    const hasPersonalInfo = anonymizedResult.hasPersonalInfo;
    //add translation anonimized
    if (detectedLanguage !== 'en') {
      anonymizedDescription = await translationCtrl.translateInvert(anonymizedDescription, detectedLanguage);
      anonymizedResult.htmlText = await translationCtrl.translateInvert(anonymizedResult.htmlText, detectedLanguage);
    }

    // 4. Procesar la respuesta
    let parsedResponse;
    let parsedResponseEnglish;
    try {
      // Log the raw response for debugging
      //console.log('Raw OpenAI response:', openAiResponse.data.choices[0].message.content);

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
      console.error("Failed to parse diagnosis output:", {
        error: parseError.message,
        rawResponse: parseError.rawResponse,
        description: description,
        matchedContent: parseError.matchedContent,
        jsonError: parseError.jsonError
      });
      insights.error({
        message: "Failed to parse diagnosis output",
        error: parseError.message,
        rawResponse: parseError.rawResponse,
        description: description,
        matchedContent: parseError.matchedContent,
        jsonError: parseError.jsonError
      });
      //save error in blob
      let infoError = {
        myuuid: sanitizedData.myuuid,
        operation: sanitizedData.operation,
        lang: sanitizedData.lang,
        description: description,
        error: parseError.message,
        rawResponse: parseError.rawResponse,
        matchedContent: parseError.matchedContent,
        jsonError: parseError.jsonError,
        model: 'o1-preview'
      }
      blobOpenDx29Ctrl.createBlobErrorsDx29(infoError);
      return res.status(200).send({ result: "error" });
    }

    // 5. Traducir la respuesta al idioma original si es necesario
    if (detectedLanguage !== 'en') {
      try {
        parsedResponse = await Promise.all(
          parsedResponse.map(async diagnosis => ({
            diagnosis: await translationCtrl.translateInvert(diagnosis.diagnosis, detectedLanguage),
            description: await translationCtrl.translateInvert(diagnosis.description, detectedLanguage),
            symptoms_in_common: await Promise.all(
              diagnosis.symptoms_in_common.map(symptom =>
                translationCtrl.translateInvert(symptom, detectedLanguage)
              )
            ),
            symptoms_not_in_common: await Promise.all(
              diagnosis.symptoms_not_in_common.map(symptom =>
                translationCtrl.translateInvert(symptom, detectedLanguage)
              )
            )
          }))
        );
      } catch (translationError) {
        console.error('Translation error:', translationError);
        throw translationError;
        //return res.status(500).send({ result: "translation error" });
      }
    }

    let infoTrack = {
      value: anonymizedDescription,
      valueEnglish: englishDescription,
      myuuid: sanitizedData.myuuid,
      operation: sanitizedData.operation,
      lang: sanitizedData.lang,
      response: parsedResponse,
      responseEnglish: parsedResponseEnglish,
      topRelatedConditions: sanitizedData.diseases_list,
      topRelatedConditionsEnglish: englishDiseasesList,
      header_language: header_language,
      timezone: timezone
    }
    blobOpenDx29Ctrl.createBlobOpenDx29(infoTrack, 'v2');

    // 6. Preparar la respuesta final
    return res.status(200).send({
      result: 'success',
      data: parsedResponse,
      anonymization: {
        hasPersonalInfo,
        anonymizedText: anonymizedDescription,
        anonymizedTextHtml: anonymizedResult.htmlText
      },
      detectedLang: detectedLanguage
    });

  } catch (error) {
    console.error('Error:', error);
    insights.error(error);
    let infoError = {
      body: req.body,
      error: error.message,
      rawResponse: error.rawResponse,
      matchedContent: error.matchedContent,
      jsonError: error.jsonError,
      model: 'o1-preview'
    }
    blobOpenDx29Ctrl.createBlobErrorsDx29(infoError);
    try {
      await serviceEmail.sendMailErrorGPTIP(
        req.body.lang,
        req.body.description,
        error,
        req.body.ip,
        requestInfo
      );
    } catch (emailError) {
      console.log('Fail sending email');
    }
    return res.status(500).send({ result: "error" });
  }
}


function isValidQuestionRequest(data) {
  // Validar estructura básica
  if (!data || typeof data !== 'object') return false;

  // Validar campos requeridos
  const requiredFields = ['questionType', 'disease', 'myuuid', 'operation', 'lang', 'ip'];
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

  // Validar ip
  if (typeof data.ip !== 'string') return false;

  // Validar timezone si existe
  if (data.timezone !== undefined && typeof data.timezone !== 'string') {
    return false;
  }

  // Validar medicalDescription si existe (requerido para questionType 3 y 4)
  if ([3, 4].includes(data.questionType)) {
    if (!data.medicalDescription ||
      typeof data.medicalDescription !== 'string' ||
      data.medicalDescription.length < 10 ||
      data.medicalDescription.length > 4000) {
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
    ip: data.ip.trim(),
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

    if (req.body.ip === '' || req.body.ip === undefined) {
      try {
        await serviceEmail.sendMailErrorGPTIP(req.body.lang, req.body.value, "", req.body.ip, requestInfo);
      } catch (emailError) {
        console.log('Fail sending email');
      }
      return res.status(200).send({ result: "blocked" });
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

    const endpointUrl = sanitizedData.timezone.includes("America") ?
      'https://apiopenai.azure-api.net/dxgptamerica/deployments/gpt4o' :
      'https://apiopenai.azure-api.net/dxgpt/deployments/gpt4o';

    const result = await axios.post(endpointUrl, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': ApiManagementKey,
      }
    });
    if (!result.data.choices[0].message.content) {
      try {
        await serviceEmail.sendMailErrorGPTIP(lang, req.body, result.data.choices, ip, requestInfo);
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
          const translatedContent = await translationCtrl.translateInvert(processedContent, sanitizedData.detectedLang);
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
          processedContent = await translationCtrl.translateInvert(processedContent, sanitizedData.detectedLang);
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
          req.body?.ip,
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
        req.body?.ip,
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

module.exports = {
  callOpenAi,
  callOpenAiV2,
  callOpenAiQuestions,
  opinion,
  sendFeedback,
  sendGeneralFeedback,
  getFeedBack
}
