const config = require('../config')
const insights = require('../services/insights')
const blobOpenDx29Ctrl = require('../services/blobOpenDx29')
const serviceEmail = require('../services/email')
const Generalfeedback = require('../models/generalfeedback')
const axios = require('axios');
const ApiManagementKey = config.API_MANAGEMENT_KEY;
const { encodingForModel } = require("js-tiktoken");
const translationCtrl = require('../services/translation')
const PROMPTS = require('../assets/prompts');
const queueService = require('./queueService');
const API_MANAGEMENT_BASE = config.API_MANAGEMENT_BASE;
const OpinionStats = require('../models/opinionstats');
const { shouldSaveToBlob } = require('../utils/blobPolicy');
const azureAIGenomicService = require('./azureAIGenomicService');
const CostTrackingService = require('./costTrackingService');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Precios por 1K tokens (en USD) - actualizados según OpenAI pricing
const PRICING = {
  gpt4o: {
    input: 0.0025,    // $2.50 per 1M tokens
    output: 0.01      // $10.00 per 1M tokens
  },
  o3: {
    input: 0.002,     // $2 per 1M tokens  
    output: 0.008      // $8 per 1M tokens
  },
  'gpt-4o-mini': {
    input: 0.0005,      // $0.50 per 1M tokens (Azure AI Studio con file search)
    output: 0.0015      // $1.50 per 1M tokens (Azure AI Studio con file search)
  }
};

// Función para calcular el precio de una llamada a la API
function calculatePrice(usage, model = 'gpt4o') {
  // Compatibilidad con o3 y gpt-4o
  const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? (promptTokens + completionTokens);

  const pricing = PRICING[model] || PRICING.gpt4o;
  const inputCost = (promptTokens / 1000) * pricing.input;
  const outputCost = (completionTokens / 1000) * pricing.output;

  return {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    totalTokens: totalTokens,
    inputCost: parseFloat(inputCost.toFixed(6)),
    outputCost: parseFloat(outputCost.toFixed(6)),
    totalCost: parseFloat((inputCost + outputCost).toFixed(6)),
    model: model
  };
}

// Función para calcular tokens de un texto
function calculateTokens(text, model = 'gpt4o') {
  // Usar directamente el modelo para obtener el encoding correcto
  const enc = encodingForModel(model);
  return enc.encode(text).length;
}

// Función para formatear costos de manera legible
function formatCost(cost) {
  return `$${cost.toFixed(6)}`; // Siempre en dólares con 6 decimales
}

// Función para calcular tokens y costos de Azure AI Studio (asistente con file search)
function calculateAzureAIStudioCost(inputText, outputText) {
  const inputTokens = calculateTokens(inputText, 'gpt-4o-mini-2024-07-18');
  const outputTokens = calculateTokens(outputText, 'gpt-4o-mini-2024-07-18');
  const totalTokens = inputTokens + outputTokens;
  
  // Calcular costos usando precios de Azure AI Studio (asistente con archivos adjuntos)
  const inputCost = (inputTokens / 1000) * PRICING['gpt-4o-mini'].input;
  const outputCost = (outputTokens / 1000) * PRICING['gpt-4o-mini'].output;
  const totalCost = inputCost + outputCost;
  
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    inputCost: parseFloat(inputCost.toFixed(6)),
    outputCost: parseFloat(outputCost.toFixed(6)),
    totalCost: parseFloat(totalCost.toFixed(6)),
    model: 'azure_ai_studio'
  };
}

function sanitizeInput(input) {
  // Eliminar caracteres especiales y patrones potencialmente peligrosos
  return input
    .replace(/[<>{}]/g, '') // Eliminar caracteres especiales
    .replace(/(\{|\}|\[|\]|\||\\|\/)/g, '') // Eliminar caracteres que podrían ser usados para inyección
    .replace(/prompt:|system:|assistant:|user:/gi, '') // Eliminar palabras clave de OpenAI con ':'
    .trim();
}

// Función para sanitizar parámetros del iframe que pueden incluir información adicional
// para tenants específicos como centro médico, ámbito, especialidad, etc.
function sanitizeIframeParams(iframeParams) {
  if (!iframeParams || typeof iframeParams !== 'object') {
    return {};
  }

  const sanitized = {};
  const validFields = ['centro', 'ambito', 'especialidad', 'medicalText', 'turno', 'servicio', 'id_paciente'];
  
  for (const field of validFields) {
    if (iframeParams[field] && typeof iframeParams[field] === 'string') {
      sanitized[field] = sanitizeInput(iframeParams[field]);
    }
  }
  
  return sanitized;
}

function sanitizeAiData(data) {
  return {
    ...data,
    description: sanitizeInput(data.description),
    diseases_list: data.diseases_list ? sanitizeInput(data.diseases_list) : '',
    myuuid: data.myuuid.trim(),
    lang: data.lang ? data.lang.trim().toLowerCase() : 'en', // Usar 'en' como predeterminado
    timezone: data.timezone?.trim() || '', // Manejar caso donde timezone es undefined
    iframeParams: sanitizeIframeParams(data.iframeParams) // Sanitizar iframeParams
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
  o3: {
    asia: [
      `${API_MANAGEMENT_BASE}/eu1/call/o3`, // Suiza
      `${API_MANAGEMENT_BASE}/us2/call/o3`  // EastUS2
    ],
    europe: [
      `${API_MANAGEMENT_BASE}/eu1/call/o3`, // Suiza
      `${API_MANAGEMENT_BASE}/us2/call/o3`  // EastUS2 como backup
    ],
    northamerica: [
      `${API_MANAGEMENT_BASE}/us2/call/o3`, // EastUS2
      `${API_MANAGEMENT_BASE}/eu1/call/o3`  // Suiza como backup
    ],
    southamerica: [
      `${API_MANAGEMENT_BASE}/us2/call/o3`, // EastUS2
      `${API_MANAGEMENT_BASE}/eu1/call/o3`  // Suiza como backup
    ],
    africa: [
      `${API_MANAGEMENT_BASE}/eu1/call/o3`, // Suiza
      `${API_MANAGEMENT_BASE}/us2/call/o3`  // EastUS2 como backup
    ],
    oceania: [
      `${API_MANAGEMENT_BASE}/us2/call/o3`, // EastUS2
      `${API_MANAGEMENT_BASE}/eu1/call/o3`  // Suiza como backup
    ],
    other: [
      `${API_MANAGEMENT_BASE}/eu1/call/o3`, // Suiza
      `${API_MANAGEMENT_BASE}/us2/call/o3`  // EastUS2 como backup
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

async function callAiWithFailover(requestBody, timezone, model = 'gpt4o', retryCount = 0, dataRequest = null) {
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
        retryCount,
        requestBody,
        timezone,
        model,
        dataRequest
      });
      await delay(RETRY_DELAY);
      return callAiWithFailover(requestBody, timezone, model, retryCount + 1, dataRequest);
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
async function processAIRequest(data, requestInfo = null, model = 'gpt4o', region = null) {
  // Si es un modelo largo, usar WebPubSub con progreso
  const isLongModel = (model === 'o3');
  const userId = data.myuuid;

  if (isLongModel) {
    console.log(`Processing long model ${model} for user ${userId} via WebPubSub`);

    try {
      const pubsubService = require('./pubsubService');

      // Enviar progreso inicial
      await pubsubService.sendProgress(userId, 'translation', 'Translating description...', 10);

      // Continuar con el procesamiento normal pero enviando progreso
      const result = await processAIRequestInternal(data, requestInfo, model, userId, region);

      // Enviar resultado final via WebPubSub
      await pubsubService.sendResult(userId, result);

      // Devolver resultado simple para la cola
      return { result: 'success', message: 'Sent via WebPubSub' };

    } catch (error) {
      // Enviar error via WebPubSub
      try {
        const pubsubService = require('./pubsubService');
        await pubsubService.sendError(userId, error, 'PROCESSING_ERROR');
      } catch (pubsubError) {
        console.error('Error sending WebPubSub error notification:', pubsubError);
      }
      throw error;
    }
  }

  // Para modelos rápidos, procesamiento normal sin WebPubSub
  return await processAIRequestInternal(data, requestInfo, model, userId, region);
}

// Función interna que contiene toda la lógica de procesamiento
async function processAIRequestInternal(data, requestInfo = null, model = 'gpt4o', userId = null, region = null) {
  const pubsubService = userId ? require('./pubsubService') : null;
  
  // Inicializar objeto para rastrear costos de cada etapa
  const costTracking = {
    etapa1_diagnosticos: { cost: 0, tokens: { input: 0, output: 0, total: 0 } },
    etapa2_expansion: { cost: 0, tokens: { input: 0, output: 0, total: 0 } },
    etapa3_anonimizacion: { cost: 0, tokens: { input: 0, output: 0, total: 0 } },
    total: { cost: 0, tokens: { input: 0, output: 0, total: 0 } }
  };
  
  console.log(`🚀 Iniciando processAIRequestInternal con modelo: ${model}`);
  
  try {
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

      // Progreso: traducción completada
      if (pubsubService) {
        await pubsubService.sendProgress(userId, 'ai_processing', 'Analyzing symptoms with AI...', 30);
      }
    } catch (translationError) {
      console.error('Translation error:', translationError.message);
      if (requestInfo) {
        let infoErrorlang = {
          body: data,
          error: translationError.message,
          type: translationError.code || 'TRANSLATION_ERROR',
          detectedLanguage: detectedLanguage || 'unknown',
          model: model,
          myuuid: data.myuuid,
          tenantId: data.tenantId,
          subscriptionId: data.subscriptionId,
          iframeParams: data.iframeParams || {}
        };

        await blobOpenDx29Ctrl.createBlobErrorsDx29(infoErrorlang, data.tenantId, data.subscriptionId);

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
      if (translationError.code === 'UNSUPPORTED_LANGUAGE') {
        throw {
          result: "unsupported_language",
          message: translationError.message
        };
      } else {
        throw {
          result: 'translation error',
          message: translationError.message,
          code: translationError.code || 'TRANSLATION_ERROR'
        };
      }

      //throw translationError;
    }

    // 2. FASE 1: Obtener solo los nombres de los diagnósticos
    const namesOnlyPrompt = englishDiseasesList ?
      PROMPTS.diagnosis.namesOnlyExcludingPrevious
        .replace("{{description}}", englishDescription)
        .replace("{{previous_diagnoses}}", englishDiseasesList) :
      PROMPTS.diagnosis.namesOnly
        .replace("{{description}}", englishDescription);
    console.log('Calling diseases')
    let requestBody;

    if (model === 'o3') {
      // Formato específico para o3
      requestBody = {
        model: "o3-dxgpt",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: namesOnlyPrompt }
            ]
          }
        ],
        tools: [],
        text: {
          format: {
            type: "text"
          }
        },
        reasoning: {
          effort: "high"
        }
      };
    } else {
      // Formato para gpt4o
      const messages = [{ role: "user", content: namesOnlyPrompt }];
      requestBody = {
        messages
      };
      if (model == 'gpt4o') {
        requestBody.temperature = 0;
        requestBody.top_p = 1;
        requestBody.frequency_penalty = 0;
        requestBody.presence_penalty = 0;
      }
    }

    let dataRequest = {
      tenantId: data.tenantId,
      subscriptionId: data.subscriptionId,
      myuuid: data.myuuid
    }
    const namesResponse = await callAiWithFailover(requestBody, data.timezone, model, 0, dataRequest);
    let usage = null;

    // Progreso: primera fase de IA completada
    if (pubsubService) {
      await pubsubService.sendProgress(userId, 'ai_details', 'Getting diagnosis details...', 60);
    }
    
    // Procesar la respuesta de nombres según el modelo
    let namesResponseText;
    if (model === 'o3') {
      // Formato de respuesta para o3
      usage = namesResponse.data.usage;
      
      namesResponseText = namesResponse.data.output.find(el => el.type === "message")?.content?.[0]?.text?.trim();
    } else {
      // Formato de respuesta para gpt4o
      usage = namesResponse.data.usage;
      namesResponseText = namesResponse.data.choices[0].message.content;
    }

    console.log('usage', namesResponse.data.usage);
    
    // Calcular costos de la Etapa 1: Generar 5 diagnósticos
    if (usage) {
      const etapa1Cost = calculatePrice(usage, model);
      costTracking.etapa1_diagnosticos = {
        cost: etapa1Cost.totalCost,
        tokens: {
          input: etapa1Cost.inputTokens,
          output: etapa1Cost.outputTokens,
          total: etapa1Cost.totalTokens
        }
      };
      costTracking.total.cost += etapa1Cost.totalCost;
      costTracking.total.tokens.input += etapa1Cost.inputTokens;
      costTracking.total.tokens.output += etapa1Cost.outputTokens;
      costTracking.total.tokens.total += etapa1Cost.totalTokens;
      
      console.log(`💰 Etapa 1 - Diagnósticos: ${formatCost(etapa1Cost.totalCost)} (${etapa1Cost.totalTokens} tokens)`);
    }
    console.log('namesResponseText', namesResponseText);

    if (!namesResponseText) {
      insights.error({
        message: "No response from AI for names",
        requestData: data,
        model: model,
        response: namesResponse,
        operation: 'diagnosis-names',
        myuuid: data.myuuid,
        tenantId: data.tenantId,
        subscriptionId: data.subscriptionId
      });
      throw new Error("No response from AI for names");
    }

    // Parsear los nombres de diagnósticos
    let diagnosisNames;
    try {
      // Limpiar la respuesta para asegurar que es un JSON válido
      const cleanResponse = namesResponseText.trim().replace(/^```json\s*|\s*```$/g, '');
      diagnosisNames = JSON.parse(cleanResponse);

      if (!Array.isArray(diagnosisNames)) {
        throw new Error('Response is not an array');
      }

      // Validar que todos los elementos son strings
      for (let i = 0; i < diagnosisNames.length; i++) {
        if (typeof diagnosisNames[i] !== 'string' || diagnosisNames[i].trim() === '') {
          throw new Error(`Diagnosis name at index ${i} is not a valid string`);
        }
      }
    } catch (parseError) {
      insights.error({
        message: "Failed to parse diagnosis names",
        error: parseError.message,
        rawResponse: namesResponseText,
        phase: 'names-parsing',
        model: model,
        requestData: data
      });
      // throw parseError;
      diagnosisNames = [];
    }

    //vars for anonymization
    let anonymizedResult = {
      hasPersonalInfo: false,
      anonymizedText: '',
      htmlText: ''
    };

    let anonymizedDescription = '';
    let anonymizedDescriptionEnglish = '';
    let hasPersonalInfo = false;
    let parsedResponse = [];
    let parsedResponseEnglish;

    if (diagnosisNames.length > 0) {
      console.log('Calling details')
      // 3. FASE 2: Obtener detalles para todos los diagnósticos en una sola llamada
      // Crear un prompt que maneje múltiples diagnósticos usando detailsForDiagnosis como base
      const detailsPrompt = PROMPTS.diagnosis.detailsForMultipleDiagnoses
        .replace("{{description}}", englishDescription)
        .replace("{{diagnoses}}", diagnosisNames.join(', '));

      // Para la Fase 2, usar solo gpt4o para detailsForMultipleDiagnoses
      const messages = [{ role: "user", content: detailsPrompt }];
      const detailsRequestBody = {
        messages,
        temperature: 0,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0,
      };

      const diagnoseResponse = await callAiWithFailover(detailsRequestBody, data.timezone, 'gpt4o', 0, dataRequest);
      console.log('usage details Calling details', diagnoseResponse.data);

      // Progreso: detalles obtenidos, comenzando anonimización
      if (pubsubService) {
        await pubsubService.sendProgress(userId, 'anonymization', 'Anonymizing personal information...', 80);
      }
      
      // Calcular costos de la Etapa 2: Expandir cada diagnóstico
      const etapa2Usage = diagnoseResponse.data.usage;
      if (etapa2Usage) {
        const etapa2Cost = calculatePrice(etapa2Usage, 'gpt4o'); // Siempre gpt4o para detalles
        costTracking.etapa2_expansion = {
          cost: etapa2Cost.totalCost,
          tokens: {
            input: etapa2Cost.inputTokens,
            output: etapa2Cost.outputTokens,
            total: etapa2Cost.totalTokens
          }
        };
        costTracking.total.cost += etapa2Cost.totalCost;
        costTracking.total.tokens.input += etapa2Cost.inputTokens;
        costTracking.total.tokens.output += etapa2Cost.outputTokens;
        costTracking.total.tokens.total += etapa2Cost.totalTokens;
        
        console.log(`💰 Etapa 2 - Expansión: ${formatCost(etapa2Cost.totalCost)} (${etapa2Cost.totalTokens} tokens)`);
      }
      
      // Procesar la respuesta según el modelo (siempre gpt4o para detalles)
      let aiResponse = diagnoseResponse.data.choices[0].message.content;

      if (!aiResponse) {
        insights.error({
          message: "No response from AI for details",
          requestData: data,
          model: model,
          response: diagnoseResponse,
          operation: 'diagnosis-details',
          myuuid: data.myuuid,
          tenantId: data.tenantId,
          subscriptionId: data.subscriptionId
        });
        throw new Error("No response from AI for details");
      }


      // 4. Procesar la respuesta de detalles
      try {
        // Limpiar la respuesta para asegurar que es un JSON válido
        let jsonContent = aiResponse.trim();

        // Remover backticks y marcadores de código si existen
        jsonContent = jsonContent.replace(/^```json\s*|\s*```$/g, '');
        jsonContent = jsonContent.replace(/^```\s*|\s*```$/g, '');

        // Intentar parsear directamente
        try {
          parsedResponse = JSON.parse(jsonContent);
          parsedResponseEnglish = JSON.parse(jsonContent);
        } catch (directParseError) {
          // Si falla, intentar con el formato XML como fallback
          const match = aiResponse.match(/<diagnosis_output>([\s\S]*?)<\/diagnosis_output>/);
          if (match && match[1]) {
            jsonContent = match[1].trim();
            parsedResponse = JSON.parse(jsonContent);
            parsedResponseEnglish = JSON.parse(jsonContent);
          } else {
            throw directParseError;
          }
        }

        // Validar que es una lista con los parámetros esperados
        if (!Array.isArray(parsedResponse)) {
          const error = new Error("Response is not an array");
          error.rawResponse = aiResponse;
          error.parsedResponse = parsedResponse;
          throw error;
        }

        // Validar cada elemento de la lista
        const requiredFields = ['diagnosis', 'description', 'symptoms_in_common', 'symptoms_not_in_common'];
        for (let i = 0; i < parsedResponse.length; i++) {
          const item = parsedResponse[i];
          if (!item || typeof item !== 'object') {
            const error = new Error(`Item at index ${i} is not an object`);
            error.rawResponse = aiResponse;
            error.item = item;
            throw error;
          }

          for (const field of requiredFields) {
            if (!item.hasOwnProperty(field)) {
              const error = new Error(`Missing required field '${field}' in item at index ${i}`);
              error.rawResponse = aiResponse;
              error.item = item;
              error.missingField = field;
              throw error;
            }
          }

          // Validar que symptoms_in_common y symptoms_not_in_common son arrays
          if (!Array.isArray(item.symptoms_in_common)) {
            const error = new Error(`'symptoms_in_common' in item at index ${i} is not an array`);
            error.rawResponse = aiResponse;
            error.item = item;
            throw error;
          }

          if (!Array.isArray(item.symptoms_not_in_common)) {
            const error = new Error(`'symptoms_not_in_common' in item at index ${i} is not an array`);
            error.rawResponse = aiResponse;
            error.item = item;
            throw error;
          }

          // Validar que diagnosis y description son strings
          if (typeof item.diagnosis !== 'string' || item.diagnosis.trim() === '') {
            const error = new Error(`'diagnosis' in item at index ${i} is not a valid string`);
            error.rawResponse = aiResponse;
            error.item = item;
            throw error;
          }

          if (typeof item.description !== 'string' || item.description.trim() === '') {
            const error = new Error(`'description' in item at index ${i} is not a valid string`);
            error.rawResponse = aiResponse;
            error.item = item;
            throw error;
          }
        }

      } catch (parseError) {
        insights.error({
          message: "Failed to parse or validate diagnosis output",
          error: parseError.message,
          stack: parseError.stack,
          rawResponse: parseError.rawResponse,
          description: data.description,
          matchedContent: parseError.matchedContent,
          jsonError: parseError.jsonError,
          parsedResponse: parseError.parsedResponse,
          item: parseError.item,
          missingField: parseError.missingField,
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
            parsedResponse: parseError.parsedResponse,
            item: parseError.item,
            missingField: parseError.missingField,
            model: model,
            tenantId: data.tenantId,
            subscriptionId: data.subscriptionId,
            iframeParams: data.iframeParams || {}
          };
          await blobOpenDx29Ctrl.createBlobErrorsDx29(infoError, data.tenantId, data.subscriptionId);
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

      // 5. Anonimizar el texto
      console.log('parsedResponse', parsedResponse);
      console.log('parsedResponse.length 1: ', parsedResponse.length);
      if (parsedResponse.length > 0) {
        anonymizedResult = await anonymizeText(englishDescription, data.timezone, data.tenantId, data.subscriptionId, data.myuuid);
        anonymizedDescription = anonymizedResult.anonymizedText;
        anonymizedDescriptionEnglish = anonymizedDescription;
        hasPersonalInfo = anonymizedResult.hasPersonalInfo;
        
        // Calcular costos de la Etapa 3: Anonimización
        if (anonymizedResult.usage) {
          const etapa3Cost = calculatePrice(anonymizedResult.usage, 'gpt4o'); // Siempre gpt4o para anonimización
          costTracking.etapa3_anonimizacion = {
            cost: etapa3Cost.totalCost,
            tokens: {
              input: etapa3Cost.inputTokens,
              output: etapa3Cost.outputTokens,
              total: etapa3Cost.totalTokens
            }
          };
          costTracking.total.cost += etapa3Cost.totalCost;
          costTracking.total.tokens.input += etapa3Cost.inputTokens;
          costTracking.total.tokens.output += etapa3Cost.outputTokens;
          costTracking.total.tokens.total += etapa3Cost.totalTokens;
          
          console.log(`💰 Etapa 3 - Anonimización: ${formatCost(etapa3Cost.totalCost)} (${etapa3Cost.totalTokens} tokens)`);
        }

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
      }

      // 6. Traducir la respuesta si es necesario
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

      // 7. Guardar información de seguimiento si es una llamada directa
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
          model: model,
          tenantId: data.tenantId,
          subscriptionId: data.subscriptionId,
          usage: usage,
          costTracking: costTracking,
          iframeParams: data.iframeParams || {}
        };
        if (await shouldSaveToBlob({ tenantId: data.tenantId, subscriptionId: data.subscriptionId })) {
          console.log('Saving to blob');
          console.log('parsedResponse.length 2: ', parsedResponse.length);
          if (parsedResponse.length == 0) {
            await blobOpenDx29Ctrl.createBlobErrorsDx29(infoTrack, data.tenantId, data.subscriptionId);
          } else {
            if (model == 'gpt4o') {
              await blobOpenDx29Ctrl.createBlobOpenDx29(infoTrack, 'v1');
            } else if (model == 'o3') {
              await blobOpenDx29Ctrl.createBlobOpenDx29(infoTrack, 'v3');
            }
          }

        }
      }
    } else {
      let infoTrackNoDiagnosis = {
        value: data.description,
        valueEnglish: data.description,
        myuuid: data.myuuid,
        operation: 'find disease',
        lang: data.lang,
        response: namesResponseText,
        responseEnglish: namesResponseText,
        topRelatedConditions: data.diseases_list,
        topRelatedConditionsEnglish: englishDiseasesList,
        header_language: requestInfo.header_language,
        timezone: data.timezone,
        model: model,
        tenantId: data.tenantId,
        subscriptionId: data.subscriptionId,
        iframeParams: data.iframeParams || {}
      };
      await blobOpenDx29Ctrl.createBlobErrorsDx29(infoTrackNoDiagnosis, data.tenantId, data.subscriptionId);
      try {
        await serviceEmail.sendMailErrorGPTIP(
          data.lang,
          data.description,
          infoTrackNoDiagnosis,
          requestInfo
        );
      } catch (emailError) {
        console.log('Fail sending email');
        insights.error(emailError);
      }
    }


    // Mostrar resumen final de costos
    console.log(`\n💰 RESUMEN DE COSTOS:`);
    console.log(`   Etapa 1 - Diagnósticos: ${formatCost(costTracking.etapa1_diagnosticos.cost)}`);
    console.log(`   Etapa 2 - Expansión: ${formatCost(costTracking.etapa2_expansion.cost)}`);
    console.log(`   Etapa 3 - Anonimización: ${formatCost(costTracking.etapa3_anonimizacion.cost)}`);
    console.log(`   ──────────────────────────`);
    console.log(`   TOTAL: ${formatCost(costTracking.total.cost)} (${costTracking.total.tokens.total} tokens)\n`);
    
    // Convertir costTracking a array de etapas para guardar en DB
    const stages = [];
    
    // Etapa 1: Diagnósticos
    if (costTracking.etapa1_diagnosticos.cost > 0) {
      stages.push({
        name: 'ai_call',
        cost: costTracking.etapa1_diagnosticos.cost,
        tokens: costTracking.etapa1_diagnosticos.tokens,
        model: model,
        duration: 0, // No tenemos duración específica para esta etapa
        success: true
      });
    }
    
    // Etapa 2: Expansión
    if (costTracking.etapa2_expansion.cost > 0) {
      stages.push({
        name: 'ai_call',
        cost: costTracking.etapa2_expansion.cost,
        tokens: costTracking.etapa2_expansion.tokens,
        model: model,
        duration: 0, // No tenemos duración específica para esta etapa
        success: true
      });
    }
    
    // Etapa 3: Anonimización
    if (costTracking.etapa3_anonimizacion.cost > 0) {
      stages.push({
        name: 'anonymization',
        cost: costTracking.etapa3_anonimizacion.cost,
        tokens: costTracking.etapa3_anonimizacion.tokens,
        model: model,
        duration: 0, // No tenemos duración específica para esta etapa
        success: true
      });
    }
    
    // Guardar costos en la base de datos
    try {
      await CostTrackingService.saveDiagnoseCost(data, stages, 'success');
      console.log('✅ Costos guardados en la base de datos');
    } catch (costError) {
      console.error('❌ Error guardando costos en DB:', costError.message);
      insights.error({
        message: 'Error guardando costos en DB',
        error: costError.message,
        myuuid: data.myuuid,
        tenantId: data.tenantId,
        subscriptionId: data.subscriptionId
      });
      // No fallar la operación principal por un error en el guardado de costos
    }
    
    // Progreso final
    if (pubsubService) {
      await pubsubService.sendProgress(userId, 'finalizing', 'Finalizing diagnosis...', 95);
    }

    // 8. Retornar el resultado
    let diseasesList = [];
    if (parsedResponse.length > 0) {
      diseasesList = parsedResponse;
    }

    const result = {
      result: 'success',
      data: diseasesList,
      anonymization: {
        hasPersonalInfo,
        anonymizedText: anonymizedDescription,
        anonymizedTextHtml: anonymizedResult.htmlText
      },
      detectedLang: detectedLanguage,
      model: model,
      costTracking: costTracking
    };
    return result;
  } catch (error) {
    // Guardar costos en caso de error (si hay costos calculados)
    if (costTracking && costTracking.total.cost > 0) {
      try {
        // Convertir costTracking a array de etapas para guardar en DB
        const stages = [];
        
        // Etapa 1: Diagnósticos
        if (costTracking.etapa1_diagnosticos.cost > 0) {
          stages.push({
            name: 'ai_call',
            cost: costTracking.etapa1_diagnosticos.cost,
            tokens: costTracking.etapa1_diagnosticos.tokens,
            model: model,
            duration: 0,
            success: false
          });
        }
        
        // Etapa 2: Expansión
        if (costTracking.etapa2_expansion.cost > 0) {
          stages.push({
            name: 'ai_call',
            cost: costTracking.etapa2_expansion.cost,
            tokens: costTracking.etapa2_expansion.tokens,
            model: model,
            duration: 0,
            success: false
          });
        }
        
        // Etapa 3: Anonimización
        if (costTracking.etapa3_anonimizacion.cost > 0) {
          stages.push({
            name: 'anonymization',
            cost: costTracking.etapa3_anonimizacion.cost,
            tokens: costTracking.etapa3_anonimizacion.tokens,
            model: model,
            duration: 0,
            success: false
          });
        }
        
        await CostTrackingService.saveDiagnoseCost(data, stages, 'error', {
          message: error.message,
          code: error.code || 'UNKNOWN_ERROR',
          phase: error.phase || 'unknown'
        });
        console.log('✅ Costos de operación fallida guardados en la base de datos');
      } catch (costError) {
        console.error('❌ Error guardando costos de operación fallida:', costError.message);
      }
    }
    throw error;
  } finally {
    // Libera el recurso SIEMPRE, aunque haya error
    if (region) {
      await queueService.releaseActiveRequest(region, model);
    }
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
async function anonymizeText(text, timezone, tenantId, subscriptionId, myuuid) {
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
        retryCount: i,
        operation: 'anonymizeText',
        requestData: text,
        model: 'gpt4o',
        timezone: timezone,
        tenantId: tenantId,
        subscriptionId: subscriptionId,
        myuuid: myuuid
      });
      await delay(RETRY_DELAY);
    }
  }

  const resultResponse = {
    hasPersonalInfo: false,
    anonymizedText: '',
    htmlText: '',
    usage: result?.data?.usage || null
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

function validateQuestionRequest(data) {
  const errors = [];

  if (!data || typeof data !== 'object') {
    errors.push({ field: 'request', reason: 'Request must be a JSON object' });
    return errors;
  }

  if (data.questionType === undefined) {
    errors.push({ field: 'questionType', reason: 'Field is required' });
  } else if (typeof data.questionType !== 'number' || !Number.isInteger(data.questionType) || data.questionType < 0 || data.questionType > 5) {
    errors.push({ field: 'questionType', reason: 'Must be an integer between 0 and 5' });
  }

  if (!data.disease) {
    errors.push({ field: 'disease', reason: 'Field is required' });
  } else if (typeof data.disease !== 'string') {
    errors.push({ field: 'disease', reason: 'Must be a string' });
  } else if (data.disease.length < 2) {
    errors.push({ field: 'disease', reason: 'Must be at least 2 characters' });
  } else if (data.disease.length > 100) {
    errors.push({ field: 'disease', reason: 'Must not exceed 100 characters' });
  }

  if (!data.myuuid) {
    errors.push({ field: 'myuuid', reason: 'Field is required' });
  } else if (typeof data.myuuid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(data.myuuid)) {
    errors.push({ field: 'myuuid', reason: 'Must be a valid UUID v4' });
  }

  if (!data.timezone) {
    errors.push({ field: 'timezone', reason: 'Field is required' });
  } else if (typeof data.timezone !== 'string') {
    errors.push({ field: 'timezone', reason: 'Must be a string' });
  }

  if (data.detectedLang !== undefined && (typeof data.detectedLang !== 'string' || data.detectedLang.length !== 2)) {
    errors.push({ field: 'detectedLang', reason: 'Must be a 2-character language code' });
  }

  // Validar medicalDescription si questionType es 3, 4 o 5
  if ([3, 4, 5].includes(data.questionType)) {
    if (!data.medicalDescription) {
      errors.push({ field: 'medicalDescription', reason: 'Field is required for questionType 3, 4 or 5' });
    } else if (typeof data.medicalDescription !== 'string') {
      errors.push({ field: 'medicalDescription', reason: 'Must be a string' });
    } else if (data.medicalDescription.length < 10) {
      errors.push({ field: 'medicalDescription', reason: 'Must be at least 10 characters' });
    } else if (data.medicalDescription.length > 8000) {
      errors.push({ field: 'medicalDescription', reason: 'Must not exceed 8000 characters' });
    }
  }

  // Verificar patrones sospechosos
  const suspiciousPatterns = [
    { pattern: /\{\{[^}]*\}\}/g, reason: 'Contains Handlebars syntax' },
    { pattern: /<script\b[^>]*>[\s\S]*?<\/script>/gi, reason: 'Contains script tags' },
    { pattern: /\$\{[^}]*\}/g, reason: 'Contains template literals' },
    { pattern: /\b(prompt:|system:|assistant:|user:)\b/gi, reason: 'Contains OpenAI keywords' }
  ];

  if (data.disease) {
    const normalizedDisease = data.disease.replace(/\n/g, ' ');
    for (const { pattern, reason } of suspiciousPatterns) {
      if (pattern.test(normalizedDisease)) {
        errors.push({ field: 'disease', reason: `Contains suspicious content: ${reason}` });
        break;
      }
    }
  }
  if ([3, 4, 5].includes(data.questionType) && data.medicalDescription) {
    const normalizedMedicalDescription = data.medicalDescription.replace(/\n/g, ' ');
    for (const { pattern, reason } of suspiciousPatterns) {
      if (pattern.test(normalizedMedicalDescription)) {
        errors.push({ field: 'medicalDescription', reason: `Contains suspicious content: ${reason}` });
        break;
      }
    }
  }

  return errors;
}

async function callInfoDisease(req, res) {
  const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  const origin = req.get('origin');
  const header_language = req.headers['accept-language'];
  const subscriptionId = getHeader(req, 'x-subscription-id');
  const tenantId = getHeader(req, 'X-Tenant-Id');

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
    timezone: req.body.timezone,
    myuuid: req.body.myuuid,
    tenantId: tenantId,
    subscriptionId: subscriptionId
  };

  // Variables para cost tracking
  const costTrackingData = {
    myuuid: req.body.myuuid,
    tenantId: tenantId,
    subscriptionId: subscriptionId,
    lang: req.body.detectedLang || 'en',
    timezone: req.body.timezone,
    description: `${req.body.questionType || 'unknown'} - ${req.body.disease || 'unknown disease'}`,
    questionType: req.body.questionType,
    disease: req.body.disease,
    iframeParams: req.body.iframeParams || {}
  };
  
  const stages = [];
  let translationStartTime, translationEndTime;
  let reverseTranslationStartTime, reverseTranslationEndTime;
  let aiStartTime, aiEndTime;
  try {
    // Validar los datos de entrada
    const validationErrors = validateQuestionRequest(req.body);
    if (validationErrors.length > 0) {
      return res.status(400).send({
        result: "error",
        message: "Invalid request format",
        details: validationErrors
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
      case 5:
        // Caso especial para pruebas genéticas del NHS - usar Azure AI Studio
        try {
          aiStartTime = Date.now();
          const genomicRecommendations = await azureAIGenomicService.generateGenomicTestRecommendations(
            sanitizedData.disease, 
            sanitizedData.medicalDescription
          );
          aiEndTime = Date.now();
          
          // Calcular tokens y costos para Azure AI Studio (asistente con file search)
          const inputText = `${sanitizedData.disease} ${sanitizedData.medicalDescription || ''}`;
          const outputText = JSON.stringify(genomicRecommendations);
          const azureCosts = calculateAzureAIStudioCost(inputText, outputText);
          
          // Agregar etapa de IA para Azure AI Studio (asistente con file search)
          stages.push({
            name: 'ai_call',
            cost: azureCosts.totalCost,
            tokens: { 
              input: azureCosts.inputTokens, 
              output: azureCosts.outputTokens, 
              total: azureCosts.totalTokens 
            },
            model: 'azure_ai_studio',
            duration: aiEndTime - aiStartTime,
            success: true
          });
          
          console.log(`💰 callInfoDisease - Azure AI Studio (file search): $${formatCost(azureCosts.totalCost)} (${azureCosts.totalTokens} tokens, ${aiEndTime - aiStartTime}ms)`);
          console.log(`   Input: ${azureCosts.inputTokens} tokens ($${formatCost(azureCosts.inputCost)})`);
          console.log(`   Output: ${azureCosts.outputTokens} tokens ($${formatCost(azureCosts.outputCost)})`);

          // Guardar información para seguimiento
          /*if (await shouldSaveToBlob({ tenantId, subscriptionId })) {
            let infoTrack = {
              value: sanitizedData.disease,
              valueEnglish: sanitizedData.disease,
              myuuid: sanitizedData.myuuid,
              operation: 'nhs_genomic_tests',
              lang: sanitizedData.detectedLang || 'en',
              response: genomicRecommendations,
              header_language: header_language,
              timezone: sanitizedData.timezone,
              model: 'azure_ai_studio',
              tenantId: tenantId,
              subscriptionId: subscriptionId,
              iframeParams: sanitizedData.iframeParams || {}
            };
            await blobOpenDx29Ctrl.createBlobOpenDx29(infoTrack, 'nhs_genomic');
          }*/

          // Procesar la respuesta JSON y convertir a HTML
          let processedContent = '';
          
          // Definir sectionTitles fuera del bloque if/else para que esté disponible en ambos casos
          let sectionTitles = {
            source: 'Source:'
          };
          
          if (genomicRecommendations.hasRecommendations && genomicRecommendations.recommendations) {
            const data = genomicRecommendations.recommendations;
            
            // Verificar si no se encontraron pruebas
            const noTestsFound = data.noTestsFound === true || 
                                (data.recommendedTests && data.recommendedTests.length === 0);
            
            if (noTestsFound) {
              // Caso: No hay pruebas genéticas disponibles
              let noTestsLabels = {
                consultationResult: 'CONSULTATION RESULT:',
                noTestsFound: 'No specific genetic tests were found in the NHS directory for this condition.',
                reason: 'Reason:',
                alternativeRecommendations: 'ALTERNATIVE RECOMMENDATIONS:',
                suggestedNextSteps: 'SUGGESTED NEXT STEPS:',
                applicationProcess: 'Application process:',
                specialConsiderations: 'Special considerations:',
                consultGeneticist: 'Consult with a clinical geneticist for individualized assessment',
                considerPathways: 'Consider whether the condition might qualify for testing through other pathways',
                evaluateResearch: 'Evaluate if research or commercial tests are available',
                reviewCriteria: 'Review if there are special eligibility criteria that might apply'
              };
              
              // Traducir etiquetas si es necesario
              if (sanitizedData.detectedLang !== 'en') {
                try {
                  reverseTranslationStartTime = Date.now();
                  const labelsToTranslate = Object.values(noTestsLabels).concat([sectionTitles.source]);
                  const translatedLabels = await Promise.all(
                    labelsToTranslate.map(label => translateInvertWithRetry(label, sanitizedData.detectedLang))
                  );
                  reverseTranslationEndTime = Date.now();
                  
                  // Agregar etapa de traducción inversa
                  stages.push({
                    name: 'reverse_translation',
                    cost: 0,
                    tokens: { input: 0, output: 0, total: 0 },
                    model: 'translation_service',
                    duration: reverseTranslationEndTime - reverseTranslationStartTime,
                    success: true
                  });
                  
                  // Actualizar las etiquetas traducidas
                  Object.keys(noTestsLabels).forEach((key, index) => {
                    noTestsLabels[key] = translatedLabels[index];
                  });
                  
                  // Actualizar sectionTitles.source
                  sectionTitles.source = translatedLabels[translatedLabels.length - 1];
                  
                } catch (translationError) {
                  console.error('Translation error for no-tests labels:', translationError);
                  insights.error({
                    message: 'Error traduciendo etiquetas de no-tests',
                    error: translationError.message,
                    disease: sanitizedData.disease,
                    tenantId: tenantId,
                    subscriptionId: subscriptionId
                  });
                }
              }
              
              processedContent = `<p><strong>${noTestsLabels.consultationResult}</strong></p>`;
              processedContent += `<p><strong>${noTestsLabels.noTestsFound}</strong></p>`;
              
              if (data.reason) {
                processedContent += `<p><strong>${noTestsLabels.reason}</strong> ${data.reason}</p>`;
              }
              
              processedContent += `<p><strong>${noTestsLabels.alternativeRecommendations}</strong></p>`;
              if (data.additionalInformation) {
                processedContent += '<ul>';
                processedContent += `<li><strong>${noTestsLabels.applicationProcess}</strong> ${data.additionalInformation.applicationProcess}</li>`;
                processedContent += `<li><strong>${noTestsLabels.specialConsiderations}</strong> ${data.additionalInformation.specialConsiderations}</li>`;
                processedContent += '</ul>';
              }
              
              processedContent += `<p><strong>${noTestsLabels.suggestedNextSteps}</strong></p>`;
              processedContent += '<ul>';
              processedContent += `<li>${noTestsLabels.consultGeneticist}</li>`;
              processedContent += `<li>${noTestsLabels.considerPathways}</li>`;
              processedContent += `<li>${noTestsLabels.evaluateResearch}</li>`;
              processedContent += `<li>${noTestsLabels.reviewCriteria}</li>`;
              processedContent += '</ul>';
              
            } else {
              // Caso: Se encontraron pruebas genéticas
              sectionTitles = {
                listTitle: 'LIST OF RECOMMENDED TESTS:',
                eligibilityTitle: 'ELIGIBILITY CRITERIA:',
                additionalTitle: 'ADDITIONAL INFORMATION:',
                source: 'Source:'
              };
              
              let fieldLabels = {
                test: 'test:',
                testName: 'Test name:',
                targetGenes: 'Target genes:',
                testMethod: 'Test method:',
                category: 'Category:',
                documentSection: 'Section of the eligibility document:',
                nhsCriteria: 'NHS specific criteria:',
                specialties: 'Specialties that can request the test:',
                applicationProcess: 'Application process:',
                expectedResponseTimes: 'Expected response times:',
                specialConsiderations: 'Special considerations:'
              };
              
              // Traducir etiquetas si es necesario
              if (sanitizedData.detectedLang !== 'en') {
                try {
                  reverseTranslationStartTime = Date.now();
                  const labelsToTranslate = Object.values(fieldLabels).concat(Object.values(sectionTitles));
                  const translatedLabels = await Promise.all(
                    labelsToTranslate.map(label => translateInvertWithRetry(label, sanitizedData.detectedLang))
                  );
                  reverseTranslationEndTime = Date.now();
                  
                  // Agregar etapa de traducción inversa
                  stages.push({
                    name: 'reverse_translation',
                    cost: 0,
                    tokens: { input: 0, output: 0, total: 0 },
                    model: 'translation_service',
                    duration: reverseTranslationEndTime - reverseTranslationStartTime,
                    success: true
                  });
                  
                  // Actualizar las etiquetas traducidas
                  const labelKeys = Object.keys(fieldLabels);
                  const titleKeys = Object.keys(sectionTitles);
                  
                  labelKeys.forEach((key, index) => {
                    fieldLabels[key] = translatedLabels[index];
                  });
                  
                  titleKeys.forEach((key, index) => {
                    sectionTitles[key] = translatedLabels[labelKeys.length + index];
                  });
                  
                } catch (translationError) {
                  console.error('Translation error for labels:', translationError);
                  insights.error({
                    message: 'Error traduciendo etiquetas genéticas',
                    error: translationError.message,
                    disease: sanitizedData.disease,
                    tenantId: tenantId,
                    subscriptionId: subscriptionId
                  });
                }
              }
              
              processedContent = `<p><strong>${sectionTitles.listTitle}</strong></p>`;
              
              if (data.recommendedTests && data.recommendedTests.length > 0) {
                processedContent += '<ul>';
                data.recommendedTests.forEach(test => {
                  processedContent += `<li><strong>${fieldLabels.test}</strong> ${test.testCode}</li>`;
                  processedContent += `<li><strong>${fieldLabels.testName}</strong> ${test.testName}</li>`;
                  processedContent += `<li><strong>${fieldLabels.targetGenes}</strong> ${test.targetGenes}</li>`;
                  processedContent += `<li><strong>${fieldLabels.testMethod}</strong> ${test.testMethod}</li>`;
                  processedContent += `<li><strong>${fieldLabels.category}</strong> ${test.category}</li>`;
                });
                processedContent += '</ul>';
              }
              
              processedContent += `<p><strong>${sectionTitles.eligibilityTitle}</strong></p>`;
              if (data.eligibilityCriteria) {
                processedContent += '<ul>';
                processedContent += `<li><strong>${fieldLabels.documentSection}</strong> ${data.eligibilityCriteria.documentSection}</li>`;
                processedContent += `<li><strong>${fieldLabels.nhsCriteria}</strong> ${data.eligibilityCriteria.nhsCriteria}</li>`;
                if (data.eligibilityCriteria.specialties && data.eligibilityCriteria.specialties.length > 0) {
                  processedContent += `<li><strong>${fieldLabels.specialties}</strong> ${data.eligibilityCriteria.specialties.join(', ')}</li>`;
                }
                processedContent += '</ul>';
              }
              
              processedContent += `<p><strong>${sectionTitles.additionalTitle}</strong></p>`;
              if (data.additionalInformation) {
                processedContent += '<ul>';
                processedContent += `<li><strong>${fieldLabels.applicationProcess}</strong> ${data.additionalInformation.applicationProcess}</li>`;
                processedContent += `<li><strong>${fieldLabels.expectedResponseTimes}</strong> ${data.additionalInformation.expectedResponseTimes}</li>`;
                processedContent += `<li><strong>${fieldLabels.specialConsiderations}</strong> ${data.additionalInformation.specialConsiderations}</li>`;
                processedContent += '</ul>';
              }
            }
            
            processedContent += `<p>${sectionTitles.source} ${data.source || 'NHS Genomic Test Directory'}</p>`;
            processedContent += `<p><img src="assets/img/home/nhs.png" alt="NHS Logo" style="max-width: 200px; height: auto; margin-top: 10px;"></p>`;
            
            // Añadir mensaje informativo para todos los usuarios
            let disclaimerMessage = 'NHS genomic test information is only applicable within the United Kingdom. Please consult with local medical services for equivalent options in your country.';
            
            // Traducir si es necesario
            if (sanitizedData.detectedLang !== 'en') {
              try {
                reverseTranslationStartTime = Date.now();
                disclaimerMessage = await translateInvertWithRetry(disclaimerMessage, sanitizedData.detectedLang);
                reverseTranslationEndTime = Date.now();
                
                // Agregar etapa de traducción inversa
                stages.push({
                  name: 'reverse_translation',
                  cost: 0,
                  tokens: { input: 0, output: 0, total: 0 },
                  model: 'translation_service',
                  duration: reverseTranslationEndTime - reverseTranslationStartTime,
                  success: true
                });
              } catch (translationError) {
                console.error('Translation error for disclaimer message:', translationError);
                insights.error({
                  message: 'Error traduciendo mensaje de disclaimer',
                  error: translationError.message,
                  disease: sanitizedData.disease,
                  tenantId: tenantId,
                  subscriptionId: subscriptionId
                });
              }
            }
            
            processedContent += `<p style="margin-top: 15px; padding: 10px; background-color: #f8f9fa; border-left: 4px solid #007bff; font-style: italic;">${disclaimerMessage}</p>`;
          } else {
            let errorMessage = 'Unable to generate recommendations at this time. Please consult with a clinical geneticist.';
            
            // Traducir si es necesario
            if (sanitizedData.detectedLang !== 'en') {
              try {
                errorMessage = await translateInvertWithRetry(errorMessage, sanitizedData.detectedLang);
              } catch (translationError) {
                console.error('Translation error for error message:', translationError);
                insights.error({
                  message: 'Error traduciendo mensaje de error',
                  error: translationError.message,
                  disease: sanitizedData.disease,
                  tenantId: tenantId,
                  subscriptionId: subscriptionId
                });
              }
            }
            
            let errorTitle = 'Error';
            
            // Traducir título si es necesario
            if (sanitizedData.detectedLang !== 'en') {
              try {
                errorTitle = await translateInvertWithRetry(errorTitle, sanitizedData.detectedLang);
              } catch (translationError) {
                console.error('Translation error for error title:', translationError);
              }
            }
            
            processedContent = `<p><strong>${errorTitle}</strong></p><p>${genomicRecommendations.message || errorMessage}</p>`;
          }

          // Guardar cost tracking
          try {
            await CostTrackingService.saveSimpleOperationCost(
              costTrackingData,
              'info_disease',
              stages[0], // La etapa de Azure AI Studio
              'success'
            );
          } catch (costError) {
            console.error('Error guardando cost tracking:', costError);
            insights.error({
              message: 'Error guardando cost tracking en callInfoDisease',
              error: costError.message,
              tenantId: tenantId,
              subscriptionId: subscriptionId
            });
          }

          return res.status(200).send({
            result: 'success',
            data: {
              type: 'general',
              content: processedContent
            }
          });

        } catch (error) {
          console.error('Error en Azure AI Genomic service:', error);
          insights.error({
            message: 'Error en Azure AI Genomic service',
            error: error.message,
            disease: sanitizedData.disease,
            tenantId: tenantId,
            subscriptionId: subscriptionId
          });

          const errorMessage = "Unable to generate recommendations at this time. Please consult with a clinical geneticist.";

          return res.status(200).send({
            result: 'success',
            data: {
              type: 'general',
              content: `<p><strong>Error</strong></p><p>${errorMessage}</p>`
            }
          });
        }
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
    let dataRequest = {
      tenantId: tenantId,
      subscriptionId: subscriptionId,
      myuuid: sanitizedData.myuuid
    }
    
    aiStartTime = Date.now();
    const result = await callAiWithFailover(requestBody, sanitizedData.timezone, 'gpt4o', 0, dataRequest);
    aiEndTime = Date.now();
    // Calcular costos y tokens para la llamada AI
    const usage = result.data.usage;
    const costData = calculatePrice(usage, 'gpt4o');
    
    // Agregar etapa de IA
    stages.push({
      name: 'ai_call',
      cost: costData.totalCost,
      tokens: { input: costData.inputTokens, output: costData.outputTokens, total: costData.totalTokens },
      model: 'gpt4o',
      duration: aiEndTime - aiStartTime,
      success: true
    });
    
    console.log(`💰 callInfoDisease - AI Call: $${formatCost(costData.totalCost)} (${costData.totalTokens} tokens, ${aiEndTime - aiStartTime}ms)`);
    
    // Mostrar resumen de costos si hay múltiples etapas
    if (stages.length > 1) {
      const totalCost = stages.reduce((sum, stage) => sum + (stage.cost || 0), 0);
      const totalTokens = stages.reduce((sum, stage) => sum + (stage.tokens?.total || 0), 0);
      const totalDuration = stages.reduce((sum, stage) => sum + (stage.duration || 0), 0);
      
      console.log(`💰 RESUMEN DE COSTOS callInfoDisease:`);
      stages.forEach((stage, index) => {
        console.log(`   Etapa ${index + 1} - ${stage.name}: $${formatCost(stage.cost)} (${stage.tokens?.total || 0} tokens, ${stage.duration}ms)`);
      });
      console.log(`   ──────────────────────────`);
      console.log(`   TOTAL: $${formatCost(totalCost)} (${totalTokens} tokens, ${totalDuration}ms)`);
    }
    
    if (!result.data.choices[0].message.content) {
      try {
        await serviceEmail.sendMailErrorGPTIP(sanitizedData.detectedLang, req.body, result.data.choices, requestInfo);
      } catch (emailError) {
        console.log('Fail sending email');
      }

      let infoError = {
        error: result.data,
        requestInfo: requestInfo,
        myuuid: req.body.myuuid,
        tenantId: tenantId,
        operation: 'callInfoDisease',
        subscriptionId: subscriptionId
      }
      insights.error(infoError);
      blobOpenDx29Ctrl.createBlobErrorsDx29(infoError, tenantId, subscriptionId);
      
      // Guardar cost tracking con error
      try {
        stages[stages.length - 1].success = false;
        stages[stages.length - 1].error = { message: 'Empty AI response', code: 'EMPTY_RESPONSE' };
        await CostTrackingService.saveSimpleOperationCost(
          costTrackingData,
          'info_disease',
          stages[0],
          'error',
          { message: 'Empty AI response', code: 'EMPTY_RESPONSE' }
        );
      } catch (costError) {
        console.error('Error guardando cost tracking:', costError);
      }
      
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
          reverseTranslationStartTime = Date.now();
          const translatedContent = await translateInvertWithRetry(processedContent, sanitizedData.detectedLang);
          reverseTranslationEndTime = Date.now();
          processedContent = translatedContent;
          
          // Agregar etapa de traducción inversa
          stages.push({
            name: 'reverse_translation',
            cost: 0,
            tokens: { input: 0, output: 0, total: 0 },
            model: 'translation_service',
            duration: reverseTranslationEndTime - reverseTranslationStartTime,
            success: true
          });
        } catch (translationError) {
          console.error('Translation error:', translationError);
          let infoError = {
            error: translationError,
            requestInfo: requestInfo,
            myuuid: req.body.myuuid,
            tenantId: tenantId,
            operation: 'callInfoDisease',
            subscriptionId: subscriptionId
          }
          insights.error(infoError);
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

      // Guardar cost tracking
      try {
        await CostTrackingService.saveSimpleOperationCost(
          costTrackingData,
          'info_disease',
          stages[0], // La etapa de IA
          'success'
        );
      } catch (costError) {
        console.error('Error guardando cost tracking:', costError);
        insights.error({
          message: 'Error guardando cost tracking en callInfoDisease',
          error: costError.message,
          tenantId: tenantId,
          subscriptionId: subscriptionId
        });
      }

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
          reverseTranslationStartTime = Date.now();
          processedContent = await translateInvertWithRetry(processedContent, sanitizedData.detectedLang);
          reverseTranslationEndTime = Date.now();
          
          // Agregar etapa de traducción inversa
          stages.push({
            name: 'reverse_translation',
            cost: 0,
            tokens: { input: 0, output: 0, total: 0 },
            model: 'translation_service',
            duration: reverseTranslationEndTime - reverseTranslationStartTime,
            success: true
          });
        } catch (translationError) {
          console.error('Translation error:', translationError);
          let infoError = {
            error: translationError,
            requestInfo: requestInfo,
            myuuid: req.body.myuuid,
            tenantId: tenantId,
            operation: 'callInfoDisease',
            subscriptionId: subscriptionId
          }
          insights.error(infoError);
        }
      }

      // Guardar cost tracking
      try {
        await CostTrackingService.saveSimpleOperationCost(
          costTrackingData,
          'info_disease',
          stages[0], // La etapa de IA
          'success'
        );
      } catch (costError) {
        console.error('Error guardando cost tracking:', costError);
        insights.error({
          message: 'Error guardando cost tracking en callInfoDisease',
          error: costError.message,
          tenantId: tenantId,
          subscriptionId: subscriptionId
        });
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
    
    // Guardar cost tracking con error
    try {
      if (stages.length > 0) {
        stages[stages.length - 1].success = false;
        stages[stages.length - 1].error = { message: e.message, code: e.name };
        await CostTrackingService.saveSimpleOperationCost(
          costTrackingData,
          'info_disease',
          stages[0],
          'error',
          { message: e.message, code: e.name }
        );
      }
    } catch (costError) {
      console.error('Error guardando cost tracking en catch:', costError);
    }
    
    const errorDetails = {
      timestamp: new Date().toISOString(),
      endpoint: 'callInfoDisease',
      myuuid: req.body.myuuid,
      tenantId: tenantId,
      subscriptionId: subscriptionId,
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
      details: errorDetails,
      myuuid: req.body.myuuid,
      tenantId: tenantId,
      subscriptionId: subscriptionId
    });
    blobOpenDx29Ctrl.createBlobErrorsDx29(errorDetails, tenantId, subscriptionId);

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
    if (typeof data.lang !== 'string' || data.lang.length !== 2) {
      errors.push({ field: 'lang', reason: 'Must be a 2-character language code' });
    }
  }

  if (typeof data.isNewModel !== 'boolean') {
    errors.push({ field: 'isNewModel', reason: 'Must be a boolean' });
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
    isNewModel: typeof data.isNewModel === 'boolean' ? data.isNewModel : false
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
    sanitizedData.version = PROMPTS.version;
    sanitizedData.tenantId = tenantId;
    sanitizedData.subscriptionId = subscriptionId;

    // Guardar SIEMPRE la estadística (sin value)
    const stats = new OpinionStats({
      myuuid: sanitizedData.myuuid,
      lang: sanitizedData.lang,
      vote: sanitizedData.vote,
      version: sanitizedData.version,
      topRelatedConditions: sanitizedData.topRelatedConditions,
      isNewModel: sanitizedData.isNewModel,
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
    if (typeof data.lang !== 'string' || data.lang.length !== 2) {
      errors.push({ field: 'lang', reason: 'Must be a 2-character language code' });
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
      tenantId: tenantId,
      subscriptionId: subscriptionId
    });
    sendFlow(generalfeedback, sanitizedData.lang, tenantId, subscriptionId)
    await generalfeedback.save();
    try {
      await serviceEmail.sendMailGeneralFeedback(sanitizedData.value, sanitizedData.myuuid, tenantId, subscriptionId);
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

function validateFollowUpQuestionsRequest(data) {
  const errors = [];

  if (!data || typeof data !== 'object') {
    errors.push({ field: 'request', reason: 'Request must be a JSON object' });
    return errors;
  }

  if (!data.description) {
    errors.push({ field: 'description', reason: 'Field is required' });
  } else if (typeof data.description !== 'string') {
    errors.push({ field: 'description', reason: 'Must be a string' });
  } else if (data.description.length < 10) {
    errors.push({ field: 'description', reason: 'Must be at least 10 characters' });
  } else if (data.description.length > 8000) {
    errors.push({ field: 'description', reason: 'Must not exceed 8000 characters' });
  }

  if (!data.diseases) {
    errors.push({ field: 'diseases', reason: 'Field is required' });
  } else if (typeof data.diseases !== 'string') {
    errors.push({ field: 'diseases', reason: 'Must be a string' });
  } else if (data.diseases.length < 2) {
    errors.push({ field: 'diseases', reason: 'Must be at least 2 characters' });
  } else if (data.diseases.length > 1000) {
    errors.push({ field: 'diseases', reason: 'Must not exceed 1000 characters' });
  }

  if (!data.myuuid) {
    errors.push({ field: 'myuuid', reason: 'Field is required' });
  } else if (typeof data.myuuid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(data.myuuid)) {
    errors.push({ field: 'myuuid', reason: 'Must be a valid UUID v4' });
  }

  if (!data.timezone) {
    errors.push({ field: 'timezone', reason: 'Field is required' });
  } else if (typeof data.timezone !== 'string') {
    errors.push({ field: 'timezone', reason: 'Must be a string' });
  }

  if (data.lang !== undefined) {
    if (typeof data.lang !== 'string' || data.lang.length !== 2) {
      errors.push({ field: 'lang', reason: 'Must be a 2-character language code' });
    }
  }

  // Verificar patrones sospechosos
  const suspiciousPatterns = [
    { pattern: /\{\{[^}]*\}\}/g, reason: 'Contains Handlebars syntax' },
    { pattern: /<script\b[^>]*>[\s\S]*?<\/script>/gi, reason: 'Contains script tags' },
    { pattern: /\$\{[^}]*\}/g, reason: 'Contains template literals' },
    { pattern: /\b(prompt:|system:|assistant:|user:)\b/gi, reason: 'Contains OpenAI keywords' }
  ];

  if (data.description) {
    const normalizedDescription = data.description.replace(/\n/g, ' ');
    for (const { pattern, reason } of suspiciousPatterns) {
      if (pattern.test(normalizedDescription)) {
        errors.push({ field: 'description', reason: `Contains suspicious content: ${reason}` });
        break;
      }
    }
  }
  if (data.diseases) {
    const normalizedDiseases = data.diseases.replace(/\n/g, ' ');
    for (const { pattern, reason } of suspiciousPatterns) {
      if (pattern.test(normalizedDiseases)) {
        errors.push({ field: 'diseases', reason: `Contains suspicious content: ${reason}` });
        break;
      }
    }
  }

  return errors;
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
  const subscriptionId = getHeader(req, 'x-subscription-id');
  const tenantId = getHeader(req, 'X-Tenant-Id');


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
    const validationErrors = validateFollowUpQuestionsRequest(req.body);
    if (validationErrors.length > 0) {
      insights.error({
        message: "Invalid request format or content for follow-up questions",
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

    const sanitizedData = sanitizeFollowUpQuestionsData(req.body);
    const { description, diseases, lang, timezone } = sanitizedData;

    // Variables para cost tracking
    const costTrackingData = {
      myuuid: req.body.myuuid,
      tenantId: tenantId,
      subscriptionId: subscriptionId,
      lang: detectedLanguage || lang,
      timezone: timezone,
      description: `${description} - Follow-up questions`,
      iframeParams: req.body.iframeParams || {}
    };

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
        model: 'follow-up',
        myuuid: req.body.myuuid,
        tenantId: tenantId,
        subscriptionId: subscriptionId
      };

      await blobOpenDx29Ctrl.createBlobErrorsDx29(infoErrorlang, tenantId, subscriptionId);

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
          message: translationError.message,
          tenantId: tenantId,
          subscriptionId: subscriptionId,
          operation: 'generateFollowUpQuestions',
          requestInfo: requestInfo
        });

        return res.status(200).send({
          result: "unsupported_language",
          message: translationError.message
        });
      }

      // Otros errores de traducción
      insights.error({
        type: 'TRANSLATION_ERROR',
        message: translationError.message,
        tenantId: tenantId,
        subscriptionId: subscriptionId,
        operation: 'generateFollowUpQuestions',
        requestInfo: requestInfo
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
    let dataRequest = {
      tenantId: tenantId,
      subscriptionId: subscriptionId,
      myuuid: sanitizedData.myuuid
    }
    const aiStartTime = Date.now();
    const diagnoseResponse = await callAiWithFailover(requestBody, sanitizedData.timezone, 'gpt4o', 0, dataRequest);
    const aiEndTime = Date.now();

    // Calcular costos y tokens para la llamada AI
    const usage = diagnoseResponse.data.usage;
    const costData = calculatePrice(usage, 'gpt4o');

    console.log(`💰 generateFollowUpQuestions - AI Call: $${formatCost(costData.totalCost)} (${costData.totalTokens} tokens, ${aiEndTime - aiStartTime}ms)`);

    if (!diagnoseResponse.data.choices[0].message.content) {
      insights.error({
        message: "No response from AI",
        requestInfo: requestInfo,
        response: diagnoseResponse,
        operation: 'follow-up',
        myuuid: sanitizedData.myuuid,
        tenantId: tenantId,
        subscriptionId: subscriptionId
      });

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
        rawResponse: diagnoseResponse.data.choices[0].message.content,
        tenantId: tenantId,
        subscriptionId: subscriptionId,
        operation: 'generateFollowUpQuestions',
        requestInfo: requestInfo
      });

      let infoError = {
        myuuid: sanitizedData.myuuid,
        operation: 'follow-up',
        lang: sanitizedData.lang,
        description: description,
        error: parseError.message,
        rawResponse: diagnoseResponse.data.choices[0].message.content,
        model: 'follow-up',
        tenantId: tenantId,
        subscriptionId: subscriptionId
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

      blobOpenDx29Ctrl.createBlobErrorsDx29(infoError, tenantId, subscriptionId);
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
      model: 'follow-up',
      tenantId: tenantId,
      subscriptionId: subscriptionId
    };

    if (await shouldSaveToBlob({ tenantId, subscriptionId })) {
      blobOpenDx29Ctrl.createBlobQuestions(infoTrack, 'follow-up');
    }

    // Guardar cost tracking solo en caso de éxito
    try {
      const aiStage = {
        name: 'ai_call',
        cost: costData.totalCost,
        tokens: { input: costData.inputTokens, output: costData.outputTokens, total: costData.totalTokens },
        model: 'gpt4o',
        duration: aiEndTime - aiStartTime,
        success: true
      };
      await CostTrackingService.saveSimpleOperationCost(
        costTrackingData,
        'follow_up_questions',
        aiStage,
        'success'
      );
    } catch (costError) {
      console.error('Error guardando cost tracking:', costError);
    }

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

    let infoError = {
      body: req.body,
      error: error.message,
      model: 'follow-up',
      myuuid: req.body.myuuid,
      tenantId: tenantId,
      subscriptionId: subscriptionId
    };
    insights.error(infoError);

    blobOpenDx29Ctrl.createBlobErrorsDx29(infoError, tenantId, subscriptionId);

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


function validateERQuestionsRequest(data) {
  const errors = [];

  if (!data || typeof data !== 'object') {
    errors.push({ field: 'request', reason: 'Request must be a JSON object' });
    return errors;
  }

  if (!data.description) {
    errors.push({ field: 'description', reason: 'Field is required' });
  } else if (typeof data.description !== 'string') {
    errors.push({ field: 'description', reason: 'Must be a string' });
  } else if (data.description.length < 10) {
    errors.push({ field: 'description', reason: 'Must be at least 10 characters' });
  } else if (data.description.length > 8000) {
    errors.push({ field: 'description', reason: 'Must not exceed 8000 characters' });
  }

  if (!data.myuuid) {
    errors.push({ field: 'myuuid', reason: 'Field is required' });
  } else if (typeof data.myuuid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(data.myuuid)) {
    errors.push({ field: 'myuuid', reason: 'Must be a valid UUID v4' });
  }

  if (!data.timezone) {
    errors.push({ field: 'timezone', reason: 'Field is required' });
  } else if (typeof data.timezone !== 'string') {
    errors.push({ field: 'timezone', reason: 'Must be a string' });
  }

  if (data.lang !== undefined) {
    if (typeof data.lang !== 'string' || data.lang.length !== 2) {
      errors.push({ field: 'lang', reason: 'Must be a 2-character language code' });
    }
  }

  // Verificar patrones sospechosos
  const suspiciousPatterns = [
    { pattern: /\{\{[^}]*\}\}/g, reason: 'Contains Handlebars syntax' },
    { pattern: /<script\b[^>]*>[\s\S]*?<\/script>/gi, reason: 'Contains script tags' },
    { pattern: /\$\{[^}]*\}/g, reason: 'Contains template literals' },
    { pattern: /\b(prompt:|system:|assistant:|user:)\b/gi, reason: 'Contains OpenAI keywords' }
  ];

  if (data.description) {
    const normalizedDescription = data.description.replace(/\n/g, ' ');
    for (const { pattern, reason } of suspiciousPatterns) {
      if (pattern.test(normalizedDescription)) {
        errors.push({ field: 'description', reason: `Contains suspicious content: ${reason}` });
        break;
      }
    }
  }
  if (data.diseases) {
    const normalizedDiseases = data.diseases.replace(/\n/g, ' ');
    for (const { pattern, reason } of suspiciousPatterns) {
      if (pattern.test(normalizedDiseases)) {
        errors.push({ field: 'diseases', reason: `Contains suspicious content: ${reason}` });
        break;
      }
    }
  }

  return errors;
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
  const subscriptionId = getHeader(req, 'x-subscription-id');
  const tenantId = getHeader(req, 'X-Tenant-Id');


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
    const validationErrors = validateERQuestionsRequest(req.body);
    if (validationErrors.length > 0) {
      insights.error({
        message: "Invalid request format or content for ER questions",
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

    const sanitizedData = sanitizeERQuestionsData(req.body);
    const { description, lang, timezone } = sanitizedData;

    // Variables para cost tracking
    const costTrackingData = {
      myuuid: req.body.myuuid,
      tenantId: tenantId,
      subscriptionId: subscriptionId,
      lang: lang,
      timezone: timezone,
      description: `${description} - ER questions`,
      iframeParams: req.body.iframeParams || {}
    };

    // 1. Detectar idioma y traducir a inglés si es necesario
    let englishDescription = description;
    let detectedLanguage = lang;
    try {
      detectedLanguage = await detectLanguageWithRetry(description, lang);
      if (detectedLanguage && detectedLanguage !== 'en') {
        englishDescription = await translateTextWithRetry(description, detectedLanguage);
      }
    } catch (translationError) {
      // ... manejo de error existente ...
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
    let dataRequest = {
      tenantId: tenantId,
      subscriptionId: subscriptionId,
      myuuid: sanitizedData.myuuid
    }
    const aiStartTime = Date.now();
    const diagnoseResponse = await callAiWithFailover(requestBody, sanitizedData.timezone, 'gpt4o', 0, dataRequest);
    let aiEndTime = Date.now();

    // Calcular costos y tokens para la llamada AI
    const usage = diagnoseResponse.data.usage;
    const costData = calculatePrice(usage, 'gpt4o');
    console.log(`💰 generateERQuestions - AI Call: $${formatCost(costData.totalCost)} (${costData.totalTokens} tokens, ${aiEndTime - aiStartTime}ms)`);

    if (!diagnoseResponse.data.choices[0].message.content) {
      insights.error({
        message: "No response from AI",
        requestInfo: requestInfo,
        response: diagnoseResponse,
        operation: 'er-questions',
        tenantId: tenantId,
        subscriptionId: subscriptionId
      });
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
        rawResponse: diagnoseResponse.data.choices[0].message.content,
        tenantId: tenantId,
        subscriptionId: subscriptionId,
        operation: 'generateERQuestions',
        requestInfo: requestInfo
      });

      let infoError = {
        myuuid: sanitizedData.myuuid,
        operation: 'er-questions',
        lang: sanitizedData.lang,
        description: description,
        error: parseError.message,
        rawResponse: diagnoseResponse.data.choices[0].message.content,
        model: 'follow-up',
        tenantId: tenantId,
        subscriptionId: subscriptionId
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

      blobOpenDx29Ctrl.createBlobErrorsDx29(infoError, tenantId, subscriptionId);
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
      model: 'er-questions',
      tenantId: tenantId,
      subscriptionId: subscriptionId
    };

    if (await shouldSaveToBlob({ tenantId, subscriptionId })) {
      blobOpenDx29Ctrl.createBlobQuestions(infoTrack, 'er-questions');
    }

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
    let infoError = {
      body: req.body,
      error: error.message,
      model: 'follow-up',
      myuuid: req.body.myuuid,
      tenantId: tenantId,
      subscriptionId: subscriptionId
    };
    insights.error(infoError);


    blobOpenDx29Ctrl.createBlobErrorsDx29(infoError, tenantId, subscriptionId);

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

function validateProcessFollowUpRequest(data) {
  const errors = [];

  if (!data || typeof data !== 'object') {
    errors.push({ field: 'request', reason: 'Request must be a JSON object' });
    return errors;
  }

  if (!data.description) {
    errors.push({ field: 'description', reason: 'Field is required' });
  } else if (typeof data.description !== 'string') {
    errors.push({ field: 'description', reason: 'Must be a string' });
  } else if (data.description.length < 10) {
    errors.push({ field: 'description', reason: 'Must be at least 10 characters' });
  } else if (data.description.length > 8000) {
    errors.push({ field: 'description', reason: 'Must not exceed 8000 characters' });
  }

  if (!Array.isArray(data.answers) || data.answers.length === 0) {
    errors.push({ field: 'answers', reason: 'Must be a non-empty array' });
  } else {
    data.answers.forEach((answer, idx) => {
      if (!answer || typeof answer !== 'object') {
        errors.push({ field: `answers[${idx}]`, reason: 'Each answer must be an object' });
      } else {
        if (!answer.question || typeof answer.question !== 'string') {
          errors.push({ field: `answers[${idx}].question`, reason: 'Field is required and must be a string' });
        }
        if (!answer.answer || typeof answer.answer !== 'string') {
          errors.push({ field: `answers[${idx}].answer`, reason: 'Field is required and must be a string' });
        }
      }
    });
  }

  if (!data.myuuid) {
    errors.push({ field: 'myuuid', reason: 'Field is required' });
  } else if (typeof data.myuuid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(data.myuuid)) {
    errors.push({ field: 'myuuid', reason: 'Must be a valid UUID v4' });
  }

  if (!data.timezone) {
    errors.push({ field: 'timezone', reason: 'Field is required' });
  } else if (typeof data.timezone !== 'string') {
    errors.push({ field: 'timezone', reason: 'Must be a string' });
  }

  if (data.lang !== undefined) {
    if (typeof data.lang !== 'string' || data.lang.length !== 2) {
      errors.push({ field: 'lang', reason: 'Must be a 2-character language code' });
    }
  }

  // Verificar patrones sospechosos
  const suspiciousPatterns = [
    { pattern: /\{\{[^}]*\}\}/g, reason: 'Contains Handlebars syntax' },
    { pattern: /<script\b[^>]*>[\s\S]*?<\/script>/gi, reason: 'Contains script tags' },
    { pattern: /\$\{[^}]*\}/g, reason: 'Contains template literals' },
    { pattern: /\b(prompt:|system:|assistant:|user:)\b/gi, reason: 'Contains OpenAI keywords' }
  ];

  if (data.description) {
    const normalizedDescription = data.description.replace(/\n/g, ' ');
    for (const { pattern, reason } of suspiciousPatterns) {
      if (pattern.test(normalizedDescription)) {
        errors.push({ field: 'description', reason: `Contains suspicious content: ${reason}` });
        break;
      }
    }
  }
  if (Array.isArray(data.answers)) {
    data.answers.forEach((answer, idx) => {
      if (answer && typeof answer.question === 'string') {
        const normalizedQ = answer.question.replace(/\n/g, ' ');
        for (const { pattern, reason } of suspiciousPatterns) {
          if (pattern.test(normalizedQ)) {
            errors.push({ field: `answers[${idx}].question`, reason: `Contains suspicious content: ${reason}` });
            break;
          }
        }
      }
      if (answer && typeof answer.answer === 'string') {
        const normalizedA = answer.answer.replace(/\n/g, ' ');
        for (const { pattern, reason } of suspiciousPatterns) {
          if (pattern.test(normalizedA)) {
            errors.push({ field: `answers[${idx}].answer`, reason: `Contains suspicious content: ${reason}` });
            break;
          }
        }
      }
    });
  }

  return errors;
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
  const subscriptionId = getHeader(req, 'x-subscription-id');
  const tenantId = getHeader(req, 'X-Tenant-Id');


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
    const validationErrors = validateProcessFollowUpRequest(req.body);
    if (validationErrors.length > 0) {
      insights.error({
        message: "Invalid request format or content for processing follow-up answers",
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

    const sanitizedData = sanitizeProcessFollowUpData(req.body);
    const { description, answers, lang, timezone } = sanitizedData;

    // Variables para cost tracking
    const costTrackingData = {
      myuuid: req.body.myuuid,
      tenantId: tenantId,
      subscriptionId: subscriptionId,
      lang: lang,
      timezone: timezone,
      description: `${description} - Process follow-up answers`,
      iframeParams: req.body.iframeParams || {}
    };

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
      // ... manejo de error existente ...
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
    let dataRequest = {
      tenantId: tenantId,
      subscriptionId: subscriptionId,
      myuuid: sanitizedData.myuuid
    }
    const diagnoseResponse = await callAiWithFailover(requestBody, sanitizedData.timezone, 'gpt4o', 0, dataRequest);

    if (!diagnoseResponse.data.choices[0].message.content) {
      insights.error({
        message: "Empty AI process-follow-up response",
        requestInfo: requestInfo,
        response: diagnoseResponse,
        operation: 'process-follow-up',
        tenantId: tenantId,
        subscriptionId: subscriptionId
      });
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
      model: 'process-follow-up',
      tenantId: tenantId,
      subscriptionId: subscriptionId
    };

    if (await shouldSaveToBlob({ tenantId, subscriptionId })) {
      blobOpenDx29Ctrl.createBlobQuestions(infoTrack, 'process-follow-up');
    }

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

    let infoError = {
      body: req.body,
      error: error.message,
      model: 'process-follow-up',
      myuuid: req.body.myuuid,
      tenantId: tenantId,
      subscriptionId: subscriptionId
    };

    insights.error(infoError);
    blobOpenDx29Ctrl.createBlobErrorsDx29(infoError, tenantId, subscriptionId);

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

function validateSummarizeRequest(data) {
  const errors = [];

  if (!data || typeof data !== 'object') {
    errors.push({ field: 'request', reason: 'Request must be a JSON object' });
    return errors;
  }

  if (!data.description) {
    errors.push({ field: 'description', reason: 'Field is required' });
  } else if (typeof data.description !== 'string') {
    errors.push({ field: 'description', reason: 'Must be a string' });
  } else if (data.description.length < 10) {
    errors.push({ field: 'description', reason: 'Must be at least 10 characters' });
  } else if (data.description.length > 400000) {
    errors.push({ field: 'description', reason: 'Must not exceed 400000 characters' });
  }

  if (!data.myuuid) {
    errors.push({ field: 'myuuid', reason: 'Field is required' });
  } else if (typeof data.myuuid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(data.myuuid)) {
    errors.push({ field: 'myuuid', reason: 'Must be a valid UUID v4' });
  }

  if (!data.timezone) {
    errors.push({ field: 'timezone', reason: 'Field is required' });
  } else if (typeof data.timezone !== 'string') {
    errors.push({ field: 'timezone', reason: 'Must be a string' });
  }

  if (data.lang !== undefined) {
    if (typeof data.lang !== 'string' || data.lang.length !== 2) {
      errors.push({ field: 'lang', reason: 'Must be a 2-character language code' });
    }
  }

  // Verificar patrones sospechosos
  const suspiciousPatterns = [
    { pattern: /\{\{[^}]*\}\}/g, reason: 'Contains Handlebars syntax' },
    { pattern: /<script\b[^>]*>[\s\S]*?<\/script>/gi, reason: 'Contains script tags' },
    { pattern: /\$\{[^}]*\}/g, reason: 'Contains template literals' },
    { pattern: /\b(prompt:|system:|assistant:|user:)\b/gi, reason: 'Contains OpenAI keywords' }
  ];

  if (data.description) {
    const normalizedDescription = data.description.replace(/\n/g, ' ');
    for (const { pattern, reason } of suspiciousPatterns) {
      if (pattern.test(normalizedDescription)) {
        errors.push({ field: 'description', reason: `Contains suspicious content: ${reason}` });
        break;
      }
    }
  }

  return errors;
}

async function summarize(req, res) {
  const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  const origin = req.get('origin');
  const header_language = req.headers['accept-language'];
  const subscriptionId = getHeader(req, 'x-subscription-id');
  const tenantId = getHeader(req, 'X-Tenant-Id');


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
    const validationErrors = validateSummarizeRequest(req.body);
    if (validationErrors.length > 0) {
      insights.error({
        message: "Invalid request format or content for summarization",
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

    const sanitizedData = sanitizeAiData(req.body);
    const { description, lang } = sanitizedData;

    // Variables para cost tracking
    const costTrackingData = {
      myuuid: req.body.myuuid,
      tenantId: tenantId,
      subscriptionId: subscriptionId,
      lang: lang,
      timezone: req.body.timezone,
      description: `${description.substring(0, 100)}... - Summarize`,
      iframeParams: req.body.iframeParams || {}
    };

    // 1. Detectar idioma y traducir a inglés si es necesario
    let englishDescription = description;
    let detectedLanguage = lang;
    try {
      detectedLanguage = await detectLanguageWithRetry(description, lang);
      if (detectedLanguage && detectedLanguage !== 'en') {
        englishDescription = await translateTextWithRetry(description, detectedLanguage);
      }
    } catch (translationError) {
      // ... manejo de error existente ...
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
    let aiStartTime = Date.now();
    let endpoint = `${API_MANAGEMENT_BASE}/eu1/summarize/gpt-4o-mini`;
    const diagnoseResponse = await axios.post(endpoint, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': ApiManagementKey,
      }
    });
    let aiEndTime = Date.now();

    if (!diagnoseResponse.data.choices[0].message.content) {
      insights.error({
        message: "Empty AI summarize response",
        requestInfo: requestInfo,
        response: diagnoseResponse,
        operation: 'summarize',
        tenantId: tenantId,
        subscriptionId: subscriptionId
      });
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

    // 6. Guardar cost tracking solo en caso de éxito
    try {
      const usage = diagnoseResponse.data.usage;
      const costData = calculatePrice(usage, 'gpt4o');
      console.log(`💰 summarize - AI Call: $${formatCost(costData.totalCost)} (${costData.totalTokens} tokens, ${aiEndTime - aiStartTime}ms)`);

      const aiStage = {
        name: 'ai_call',
        cost: costData.totalCost,
        tokens: { input: costData.inputTokens, output: costData.outputTokens, total: costData.totalTokens },
        model: 'gpt4o',
        duration: aiEndTime - aiStartTime,
        success: true
      };
      await CostTrackingService.saveSimpleOperationCost(
        costTrackingData,
        'summarize',
        aiStage,
        'success'
      );
    } catch (costError) {
      console.error('Error guardando cost tracking:', costError);
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

    let infoError = {
      body: req.body,
      error: error.message,
      model: 'summarize',
      myuuid: req.body.myuuid,
      tenantId: tenantId,
      subscriptionId: subscriptionId
    };
    insights.error(infoError);

    blobOpenDx29Ctrl.createBlobErrorsDx29(infoError, tenantId, subscriptionId);

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
    // Mostrar todas las regiones de todos los modelos
    const endpointsStatus = {};

    // Iterar sobre todos los modelos y sus regiones
    for (const [model, regions] of Object.entries(status.models)) {
      endpointsStatus[model] = {};

      for (const [region, regionStatus] of Object.entries(regions)) {
        endpointsStatus[model][region] = {
          capacity: regionStatus.capacity || 'N/A',
          utilizationPercentage: regionStatus.utilizationPercentage || 0,
          activeRequests: regionStatus.activeRequests || 0,
          queuedMessages: regionStatus.queuedMessages || 0,
          status: {
            primary: (regionStatus.activeRequests || 0) > 0 ? 'active' : 'idle',
            backup: 'standby'
          }
        };
      }
    }

    return res.status(200).send({
      result: 'success',
      data: {
        queues: {
          timestamp: status.timestamp,
          models: status.models,
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

function getHeader(req, name) {
  return req.headers[name.toLowerCase()];
}

function validateDiagnoseRequest(data) {
  const errors = [];

  if (!data || typeof data !== 'object') {
    errors.push({ field: 'request', reason: 'Request must be a JSON object' });
    return errors;
  }

  if (!data.description) {
    errors.push({ field: 'description', reason: 'Field is required' });
  } else if (typeof data.description !== 'string') {
    errors.push({ field: 'description', reason: 'Must be a string' });
  } else if (data.description.length < 10) {
    errors.push({ field: 'description', reason: 'Must be at least 10 characters' });
  } else if (data.description.length > 8000) {
    errors.push({ field: 'description', reason: 'Must not exceed 8000 characters' });
  }

  if (!data.myuuid) {
    errors.push({ field: 'myuuid', reason: 'Field is required' });
  } else if (typeof data.myuuid !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(data.myuuid)) {
    errors.push({ field: 'myuuid', reason: 'Must be a valid UUID v4' });
  }

  if (!data.timezone) {
    errors.push({ field: 'timezone', reason: 'Field is required' });
  } else if (typeof data.timezone !== 'string') {
    errors.push({ field: 'timezone', reason: 'Must be a string' });
  }

  if (data.lang !== undefined) {
    if (typeof data.lang !== 'string' || data.lang.length !== 2) {
      errors.push({ field: 'lang', reason: 'Must be a 2-character language code' });
    }
  }

  if (data.diseases_list !== undefined) {
    if (typeof data.diseases_list !== 'string') {
      errors.push({ field: 'diseases_list', reason: 'Must be a string' });
    } else if (data.diseases_list.length > 1000) {
      errors.push({ field: 'diseases_list', reason: 'Must not exceed 1000 characters' });
    }
  }

  // Validar iframeParams opcional
  if (data.iframeParams !== undefined) {
    if (typeof data.iframeParams !== 'object' || data.iframeParams === null) {
      errors.push({ field: 'iframeParams', reason: 'Must be an object' });
    } else {
      // Validar campos específicos de iframeParams
      const validFields = ['centro', 'ambito', 'especialidad', 'medicalText', 'turno', 'servicio', 'id_paciente'];
      
      for (const field in data.iframeParams) {
        if (!validFields.includes(field)) {
          errors.push({ field: `iframeParams.${field}`, reason: 'Invalid field name' });
        } else {
          const value = data.iframeParams[field];
          if (typeof value !== 'string') {
            errors.push({ field: `iframeParams.${field}`, reason: 'Must be a string' });
          } else if (value.length > 500) {
            errors.push({ field: `iframeParams.${field}`, reason: 'Must not exceed 500 characters' });
          }
        }
      }
    }
  }

  // Verificar patrones sospechosos
  const suspiciousPatterns = [
    { pattern: /\{\{[^}]*\}\}/g, reason: 'Contains Handlebars syntax' },
    { pattern: /<script\b[^>]*>[\s\S]*?<\/script>/gi, reason: 'Contains script tags' },
    { pattern: /\$\{[^}]*\}/g, reason: 'Contains template literals' },
    { pattern: /\b(prompt:|system:|assistant:|user:)\b/gi, reason: 'Contains OpenAI keywords' }
  ];

  if (data.description) {
    const normalizedDescription = data.description.replace(/\n/g, ' ');
    for (const { pattern, reason } of suspiciousPatterns) {
      if (pattern.test(normalizedDescription)) {
        errors.push({ field: 'description', reason: `Contains suspicious content: ${reason}` });
        break;
      }
    }
  }

  if (data.diseases_list) {
    const normalizedDiseasesList = data.diseases_list.replace(/\n/g, ' ');
    for (const { pattern, reason } of suspiciousPatterns) {
      if (pattern.test(normalizedDiseasesList)) {
        errors.push({ field: 'diseases_list', reason: `Contains suspicious content: ${reason}` });
        break;
      }
    }
  }

  // Verificar patrones sospechosos en iframeParams
  if (data.iframeParams && typeof data.iframeParams === 'object') {
    for (const [field, value] of Object.entries(data.iframeParams)) {
      if (typeof value === 'string') {
        const normalizedValue = value.replace(/\n/g, ' ');
        for (const { pattern, reason } of suspiciousPatterns) {
          if (pattern.test(normalizedValue)) {
            errors.push({ field: `iframeParams.${field}`, reason: `Contains suspicious content: ${reason}` });
            break;
          }
        }
      }
    }
  }

  return errors;
}

async function diagnose(req, res) {
  const model = req.body.model || 'gpt4o';
  const tenantId = getHeader(req, 'X-Tenant-Id');
  const subscriptionId = getHeader(req, 'x-subscription-id');

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
    const validationErrors = validateDiagnoseRequest(req.body);
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

    const sanitizedData = sanitizeAiData(req.body);
    sanitizedData.tenantId = tenantId;
    sanitizedData.subscriptionId = subscriptionId;

    // 1. Si la petición va a la cola, responde como siempre
    const queueProperties = await queueService.getQueueProperties(sanitizedData.timezone, model);
    if (queueProperties.utilizationPercentage >= config.queueUtilizationThreshold) {
      const queueInfo = await queueService.addToQueue(sanitizedData, requestInfo, model);
      if (!queueInfo || !queueInfo.ticketId) {
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
          model: queueInfo.model,
          utilizationPercentage: queueProperties.utilizationPercentage
        }
      });
    }

    // 2. Si es modelo largo, responde rápido y procesa en background
    const isLongModel = (model === 'o3');
    const { region, model: registeredModel, queueKey } = await queueService.registerActiveRequest(sanitizedData.timezone, model);
    if (isLongModel) {
      res.status(200).send({ result: 'processing' });
      processAIRequest(sanitizedData, requestInfo, model, region)
        .catch(error => {
          console.error('Error in background processing:', error);
        });
      return;
    }

    // 3. Modelos rápidos: espera el resultado y responde por HTTP

    try {
      const result = await processAIRequest(sanitizedData, requestInfo, model, region);
      //await queueService.releaseActiveRequest(region, model);
      return res.status(200).send(result);
    } catch (error) {
      //await queueService.releaseActiveRequest(region, model);
      throw error;
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
      model: model,
      myuuid: req.body.myuuid,
      tenantId: tenantId,
      subscriptionId: subscriptionId,
      iframeParams: req.body.iframeParams || {}
    };

    await blobOpenDx29Ctrl.createBlobErrorsDx29(infoError, tenantId, subscriptionId);

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
  checkHealth,
  // Funciones de cálculo de costos
  calculatePrice,
  calculateTokens,
  formatCost
};
