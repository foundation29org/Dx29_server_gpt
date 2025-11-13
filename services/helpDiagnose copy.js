const config = require('../config')
const insights = require('../services/insights')
const { anonymizeText } = require('./anonymizeService');
const blobOpenDx29Ctrl = require('../services/blobOpenDx29')
const serviceEmail = require('../services/email')
const PROMPTS = require('../assets/prompts');
const queueService = require('./queueService');
const { shouldSaveToBlob } = require('../utils/blobPolicy');
const CostTrackingService = require('./costTrackingService');
const DiagnoseSessionService = require('../services/diagnoseSessionService');
const pubsubService = require('./pubsubService');
const PerplexityApiKey = config.PERPLEXITY_API_KEY;
const {
  callAiWithFailover,
  detectLanguageWithRetry,
  translateTextWithRetry,
  translateInvertWithRetry,
  sanitizeInput,
  sanitizeAiData
} = require('./aiUtils');
const { detectLanguageSmart } = require('./languageDetect');
const { calculatePrice, formatCost } = require('./costUtils');

const defaultModel = 'gpt5mini';
const modelIntencion = 'gpt5mini'; //'gpt4o';
const modelQuestions = 'sonar-pro' // Cambiar: 'sonar', 'gpt4o', 'gpt5nano', 'gpt5mini', 'sonar-reasoning-pro, 'sonar-pro'
const modelAnonymization = 'gpt5mini';

// Función para llamar a Sonar (Perplexity API)
async function callSonarAPI(prompt, timezone, modelType) {
  const axios = require('axios');
  
  const perplexityPrompt = `${prompt}

  IMPORTANT: Use your web search capabilities to find current, accurate medical information.
  
  Search for recent medical information, studies, and official sources to provide the most up-to-date and accurate response.

  Prioritice medical guidelines references.
  
  Include a references section with real, working links that you found through web search.`;

let reasoning_effort = "low";
  if (modelType === 'sonar-reasoning-pro' || modelType === 'sonar-pro') {
    reasoning_effort = "medium";
  }

  const perplexityResponse = await axios.post('https://api.perplexity.ai/chat/completions', {
    model: modelType,
    messages: [{ role: "user", content: perplexityPrompt }],
    search_mode: "academic",
    web_search_options: {search_context_size: reasoning_effort}
  }, {
    headers: {
      'Authorization': `Bearer ${PerplexityApiKey}`,
      'Content-Type': 'application/json'
    }
  });

  return perplexityResponse;
}

// Función para llamar a modelos GPT
async function callGPTAPI(prompt, timezone, dataRequest, model = defaultModel) {
  
    let requestBody = {
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0
    };

  if (model === 'gpt5nano') {

     requestBody = {
        model: "gpt-5-nano",
        messages: [{ role: "user", content: prompt }],
        reasoning_effort: "low" //minimal, low, medium, high
      };
  } else if (model === 'gpt5mini') {

    requestBody = {
      model: "gpt-5-mini",
      messages: [{ role: "user", content: prompt }],
      reasoning_effort: "low" //minimal, low, medium, high
    };
  }

  return await callAiWithFailover(requestBody, timezone, model, 0, dataRequest);
}

// Función para procesar respuesta de Sonar
function processSonarResponse(perplexityResponse) {
  // Simular la estructura de respuesta de OpenAI para compatibilidad
  const generalMedicalResponse = {
    data: {
      choices: [{
        message: {
          content: perplexityResponse.data.choices[0].message.content
        }
      }], 
      usage: perplexityResponse.data.usage
    }
  };

  let medicalAnswer = generalMedicalResponse.data.choices[0].message.content.trim();
  
  // Eliminar secciones de razonamiento redactado si están presentes
  // Esto maneja <think>...</think> que puede aparecer en modelos reasoning
  // Formato según Perplexity: <think>...</think>
  medicalAnswer = medicalAnswer.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  medicalAnswer = medicalAnswer.replace(/<think>[\s\S]*?<\/redacted_reasoning>/gi, '').trim();
  
  // Limpiar marcadores de código markdown si están presentes
  if (medicalAnswer.startsWith('```html') && medicalAnswer.endsWith('```')) {
    medicalAnswer = medicalAnswer.slice(7, -3).trim();
  } else if (medicalAnswer.startsWith('```') && medicalAnswer.endsWith('```')) {
    medicalAnswer = medicalAnswer.slice(3, -3).trim();
  }

  return {
    medicalAnswer,
    sonarData: perplexityResponse.data.citations && perplexityResponse.data.citations.length > 0 ? {
      citations: perplexityResponse.data.citations,
      searchResults: perplexityResponse.data.search_results,
      hasCitations: true
    } : null
  };
}

// Función para procesar respuesta de GPT-4o
function processGPTResponse(generalMedicalResponse) {
  let medicalAnswer = generalMedicalResponse.data.choices[0].message.content.trim();
  
  // Limpiar marcadores de código markdown si están presentes
  if (medicalAnswer.startsWith('```html') && medicalAnswer.endsWith('```')) {
    medicalAnswer = medicalAnswer.slice(7, -3).trim();
  } else if (medicalAnswer.startsWith('```') && medicalAnswer.endsWith('```')) {
    medicalAnswer = medicalAnswer.slice(3, -3).trim();
  }

  return {
    medicalAnswer,
    sonarData: null // GPT-4o no tiene citas web
  };
}

// Función unificada para manejar todos los modelos
async function getMedicalResponse(prompt, timezone, dataRequest, modelType = defaultModel) {
  let response, model;
  
  switch (modelType) {
    case 'sonar':
      response = await callSonarAPI(prompt, timezone, modelType);
      model = 'sonar';
      break;
    case 'sonar-reasoning-pro':
      response = await callSonarAPI(prompt, timezone, modelType);
      model = 'sonar-reasoning-pro';
      break;
    case 'sonar-pro':
      response = await callSonarAPI(prompt, timezone, modelType);
      model = 'sonar-pro';
      break;
    case 'gpt5nano':
      response = await callGPTAPI(prompt, timezone, dataRequest, 'gpt5nano');
      model = 'gpt5nano';
      break;
    case 'gpt5mini':
      response = await callGPTAPI(prompt, timezone, dataRequest, 'gpt5mini');
      model = 'gpt5mini';
      break;
    case 'gpt4o':
    default:
      response = await callGPTAPI(prompt, timezone, dataRequest, 'gpt4o');
      model = 'gpt4o';
      break;
  }
  
  return { response, model };
}

// Función unificada para procesar cualquier respuesta
function processMedicalResponse(response, model) {
  let medicalAnswer, sonarData;
  
  if (model === 'sonar' || model === 'sonar-reasoning-pro' || model === 'sonar-pro') {
    const processedResponse = processSonarResponse(response);
    medicalAnswer = processedResponse.medicalAnswer;
    sonarData = processedResponse.sonarData;
  } else {
    // Para GPT-4o, gpt-5-nano y otros modelos GPT
    const processedResponse = processGPTResponse(response);
    medicalAnswer = processedResponse.medicalAnswer;
    sonarData = processedResponse.sonarData;
  }
  
  return { medicalAnswer, sonarData };
}





// Función para sanitizar parámetros del iframe que pueden incluir información adicional
// para tenants específicos como centro médico, ámbito, especialidad, etc.

// Extraer la lógica principal a una función reutilizable
async function processAIRequest(data, requestInfo = null, model = defaultModel, region = null) {
  // Si es un modelo largo, usar WebPubSub con progreso
  //const isLongModel = (model === 'o3');
  const isLongModel = true;
  const userId = data.myuuid;

  if (isLongModel) {
    console.log(`Processing long model ${model} for user ${userId} via WebPubSub`);

    try {
      // Enviar progreso inicial
      await pubsubService.sendProgress(userId, 'translation', 'Translating description...', 20);

      // Continuar con el procesamiento normal pero enviando progreso
      const result = await processAIRequestInternal(data, requestInfo, model, userId, region);

      // Enviar resultado final via WebPubSub
      await pubsubService.sendResult(userId, result);

      // Devolver resultado simple para la cola
      return { result: 'success', message: 'Sent via WebPubSub' };

    } catch (error) {
      // Enviar error via WebPubSub
      try {
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
async function processAIRequestInternal(data, requestInfo = null, model = defaultModel, userId = null, region = null) {
  const startTime = Date.now(); // Iniciar cronómetro para medir tiempo de procesamiento

  // Inicializar objeto para rastrear costos de cada etapa
  const costTracking = {
    etapa0_clinical_check: { cost: 0, tokens: { input: 0, output: 0, total: 0 } },
    etapa0__medical_check: { cost: 0, tokens: { input: 0, output: 0, total: 0 } },
    detect_language: { cost: 0, tokens: { input: 0, output: 0, total: 0 } },
    translation: { cost: 0, tokens: { input: 0, output: 0, total: 0 } },
    reverse_translation: { cost: 0, tokens: { input: 0, output: 0, total: 0 } },
    reverse_diseases: { cost: 0, tokens: { input: 0, output: 0, total: 0 } },
    etapa1_medical_response: { cost: 0, tokens: { input: 0, output: 0, total: 0 } },
    etapa1_diagnosticos: { cost: 0, tokens: { input: 0, output: 0, total: 0 } },
    etapa2_anonimizacion: { cost: 0, tokens: { input: 0, output: 0, total: 0 } },
    total: { cost: 0, tokens: { input: 0, output: 0, total: 0 } }
  };

  // Seguimiento de caracteres para costes de traducción (Azure Translator: $10/M chars)
  let translationChars = 0; // solo traducción a inglés (Azure)
  let detectChars = 0; // detección de idioma (Azure)
  let reverseTranslationChars = 0; // traducción inversa al idioma original

  // Definir tenants especiales que requieren verificación de tipo de consulta
  const specialTenants = ['salud-gpt-dev', 'salud-gpt-prod', 'salud-gpt-local', 'sermas-gpt-dev', 'sermas-gpt-prod', 'sermas-gpt-local', 'dxgpt-dev', 'dxgpt-prod', 'dxgpt-local'];
  const isDxgptTenant = !!data.tenantId && data.tenantId.startsWith('dxgpt-');

  console.log(`🚀 Iniciando processAIRequestInternal con modelo: ${model}`);

  try {
    // 1. Detectar idioma y traducir a inglés si es necesario
    //console.log('data.description', data.description)
    let englishDescription = data.description;
    let detectedLanguage = data.lang;
    let englishDiseasesList = data.diseases_list;

    try {
      // Detección de idioma: estrategia inteligente por longitud (LLM/Azure)
      const det = await detectLanguageSmart(
        data.description || '',
        data.lang,
        data.timezone,
        data.tenantId,
        data.subscriptionId,
        data.myuuid
      );
      detectedLanguage = det.lang;
      if (det.azureCharsBilled && det.azureCharsBilled > 0) {
        detectChars += det.azureCharsBilled;
      }
      // Si la detección usó LLM, acumular coste en detect_language (no mezclar con traducción)
      if (det.usage && (det.modelUsed === 'gpt5mini' || det.modelUsed === 'gpt5nano')) {
        const dCost = calculatePrice(det.usage, det.modelUsed);
        const prev = costTracking.detect_language;
        const sumCost = (prev?.cost || 0) + dCost.totalCost;
        const sumInput = (prev?.tokens?.input || 0) + dCost.inputTokens;
        const sumOutput = (prev?.tokens?.output || 0) + dCost.outputTokens;
        const sumTotal = (prev?.tokens?.total || 0) + dCost.totalTokens;
        costTracking.detect_language = {
          cost: sumCost,
          tokens: { input: sumInput, output: sumOutput, total: sumTotal },
          model: det.modelUsed,
          duration: (prev?.duration || 0) + (det.durationMs || 0),
          success: true
        };
        costTracking.total.cost += dCost.totalCost;
        costTracking.total.tokens.input += dCost.inputTokens;
        costTracking.total.tokens.output += dCost.outputTokens;
        costTracking.total.tokens.total += dCost.totalTokens;
      }
      if (detectedLanguage && detectedLanguage !== 'en') {
        // Intentar traducción a inglés con LLM (gpt5mini); fallback Azure
        let forwardStart = 0, forwardEnd = 0;
        let forwardTotalCost = 0;
        let forwardInputTokens = 0;
        let forwardOutputTokens = 0;
        try {
          // description → en
          forwardStart = Date.now();
          const translatePromptIn = `Translate the following text into English. Return ONLY the translated text.`;
          const requestBodyLLMIn = {
            model: "gpt-5-mini",
            messages: [
              { role: "user", content: translatePromptIn },
              { role: "user", content: data.description }
            ],
            reasoning_effort: "low"
          };
          const dataReqIn = { tenantId: data.tenantId, subscriptionId: data.subscriptionId, myuuid: data.myuuid };
          const llmInResp = await callAiWithFailover(requestBodyLLMIn, data.timezone, 'gpt5mini', 0, dataReqIn);
          if (!llmInResp.data.choices?.[0]?.message?.content) {
            throw new Error('Empty LLM forward translation response');
          }
          englishDescription = llmInResp.data.choices[0].message.content.trim();
          forwardEnd = Date.now();
          if (llmInResp.data.usage) {
            const fCost = calculatePrice(llmInResp.data.usage, 'gpt5mini');
            forwardTotalCost += fCost.totalCost;
            forwardInputTokens += fCost.inputTokens;
            forwardOutputTokens += fCost.outputTokens;
          }
          // diseases_list → en (si existe)
          if (englishDiseasesList) {
            const requestBodyLLMIn2 = {
              model: "gpt-5-mini",
              messages: [
                { role: "user", content: translatePromptIn },
                { role: "user", content: data.diseases_list }
              ],
              reasoning_effort: "low"
            };
            const llmInResp2 = await callAiWithFailover(requestBodyLLMIn2, data.timezone, 'gpt5mini', 0, dataReqIn);
            if (!llmInResp2.data.choices?.[0]?.message?.content) {
              throw new Error('Empty LLM forward translation response (diseases)');
            }
            englishDiseasesList = llmInResp2.data.choices[0].message.content.trim();
            if (llmInResp2.data.usage) {
              const fCost2 = calculatePrice(llmInResp2.data.usage, 'gpt5mini');
              forwardTotalCost += fCost2.totalCost;
              forwardInputTokens += fCost2.inputTokens;
              forwardOutputTokens += fCost2.outputTokens;
            }
          }
          // Registrar coste en costTracking.translation (LLM - forward)
          if (forwardTotalCost > 0) {
            costTracking.translation = {
              cost: forwardTotalCost,
              tokens: { input: forwardInputTokens, output: forwardOutputTokens, total: (forwardInputTokens + forwardOutputTokens) },
              model: 'gpt5mini',
              duration: forwardEnd - forwardStart,
              success: true
            };
            costTracking.total.cost += forwardTotalCost;
            costTracking.total.tokens.input += forwardInputTokens;
            costTracking.total.tokens.output += forwardOutputTokens;
            costTracking.total.tokens.total += (forwardInputTokens + forwardOutputTokens);
          }
        } catch (llmForwardError) {
          // Fallback Azure translate to English (se cobra por carácter)
          translationChars += (data.description ? data.description.length : 0);
          englishDescription = await translateTextWithRetry(data.description, detectedLanguage);
          if (englishDiseasesList) {
            translationChars += (data.diseases_list ? data.diseases_list.length : 0);
            englishDiseasesList = await translateTextWithRetry(data.diseases_list, detectedLanguage);
          }
        }
      }

      // Progreso: traducción completada
      if (userId) {
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

    // 1.5. Verificar si el input es un escenario clínico antes de continuar
    //console.log('englishDescription', englishDescription)
    const clinicalScenarioPrompt = PROMPTS.diagnosis.clinicalScenarioCheck.replace("{{description}}", englishDescription);
    let clinicalScenarioRequest;
    if (modelIntencion === 'gpt5mini') {
      clinicalScenarioRequest = {
        model: "gpt-5-mini",
        messages: [{ role: "user", content: clinicalScenarioPrompt }],
        reasoning_effort: "low"
      };
    } else if (modelIntencion === 'gpt5nano') {
      clinicalScenarioRequest = {
        model: "gpt-5-nano",
        messages: [{ role: "user", content: clinicalScenarioPrompt }],
        reasoning_effort: "low"
      };
    } else {
      clinicalScenarioRequest = {
        messages: [{ role: "user", content: clinicalScenarioPrompt }],
        temperature: 0,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0,
      };
    }
    let dataRequest = {
      tenantId: data.tenantId,
      subscriptionId: data.subscriptionId,
      myuuid: data.myuuid
    };
    let clinicalScenarioResponse = null;
    let clinicalScenarioResult = '';
    let clinicalScenarioCost = null;
    const clinicalStartMs = Date.now();
    

    let medicalQuestionResponse = null;
    let medicalQuestionResult = '';
    let medicalQuestionCost = null;
    try {
      clinicalScenarioResponse = await callAiWithFailover(clinicalScenarioRequest, data.timezone, modelIntencion, 0, dataRequest);
      const clinicalElapsedMs = Date.now() - clinicalStartMs;
      console.log(`⏱ clinicalScenarioCheck (${modelIntencion}) ${clinicalElapsedMs}ms`);
      if (clinicalScenarioResponse.data.choices && clinicalScenarioResponse.data.choices[0].message.content) {
        clinicalScenarioResult = clinicalScenarioResponse.data.choices[0].message.content.trim().toLowerCase();
        clinicalScenarioCost = clinicalScenarioResponse.data.usage ? calculatePrice(clinicalScenarioResponse.data.usage, modelIntencion) : null;
        if (clinicalScenarioCost) {
          costTracking.etapa0_clinical_check = {
            cost: clinicalScenarioCost.totalCost,
            tokens: {
              input: clinicalScenarioCost.inputTokens,
              output: clinicalScenarioCost.outputTokens,
              total: clinicalScenarioCost.totalTokens
            }
          };
          costTracking.total.cost += clinicalScenarioCost.totalCost;
          costTracking.total.tokens.input += clinicalScenarioCost.inputTokens;
          costTracking.total.tokens.output += clinicalScenarioCost.outputTokens;
          costTracking.total.tokens.total += clinicalScenarioCost.totalTokens;
        }
      }
    } catch (error) {
      const clinicalElapsedMs = Date.now() - clinicalStartMs;
      console.log(`⏱ clinicalScenarioCheck ERROR (${modelIntencion}) ${clinicalElapsedMs}ms`);
      // Si es un error 400 o ERR_BAD_REQUEST, asumir que es un escenario clínico válido y continuar
      if ((error.code && error.code === 'ERR_BAD_REQUEST') || (error.response && error.response.status === 400)) {
        console.error('Clinical scenario check skipped due to ERR_BAD_REQUEST:', error.message);
        insights.error({
          message: 'Clinical scenario check skipped due to ERR_BAD_REQUEST',
          error: error.message,
          requestData: data.description,
          model: model,
          operation: 'clinical-scenario-check',
          myuuid: data.myuuid,
          tenantId: data.tenantId,
          subscriptionId: data.subscriptionId
        });

        let infoErrorClinicalScenario = {
          body: data,
          error: error.message,
          type: 'Clinical scenario check skipped due to ERR_BAD_REQUEST',
          detectedLanguage: detectedLanguage || 'unknown',
          model: model,
          myuuid: data.myuuid,
          tenantId: data.tenantId,
          subscriptionId: data.subscriptionId
        };
        await blobOpenDx29Ctrl.createBlobErrorsDx29(infoErrorClinicalScenario, data.tenantId, data.subscriptionId);
        try {
          serviceEmail.sendMailErrorGPTIP(
            data.lang,
            data.description,
            infoErrorClinicalScenario,
            requestInfo
          );
        } catch (emailError) {
          console.log('Fail sending email');
          insights.error(emailError);
        }
        clinicalScenarioResult = 'true';
      } else {
        throw error;
      }
    }

    // Determinar el tipo de consulta basado en el resultado del clinical scenario check
    let queryType = 'other';
    if (clinicalScenarioResult === 'true') {
      queryType = 'diagnostic';
    } else {
      // Si no es diagnóstico y es un tenant especial,
      // en dxgpt solo habilitar en página beta (betaPage === true)
      if (specialTenants.includes(data.tenantId) && (!isDxgptTenant || data.betaPage === true)) {
        console.log('Non-diagnostic query for special tenant, checking if it\'s a medical question');
        
        const medicalQuestionPrompt = PROMPTS.diagnosis.medicalQuestionCheck.replace("{{description}}", englishDescription);
        let medicalQuestionRequest;
        if (modelIntencion === 'gpt5mini') {
          medicalQuestionRequest = {
            model: "gpt-5-mini",
            messages: [{ role: "user", content: medicalQuestionPrompt }],
            reasoning_effort: "low"
          };
        } else if (modelIntencion === 'gpt5nano') {
          medicalQuestionRequest = {
            model: "gpt-5-nano",
            messages: [{ role: "user", content: medicalQuestionPrompt }],
            reasoning_effort: "low"
          };
        } else {
          medicalQuestionRequest = {
            messages: [{ role: "user", content: medicalQuestionPrompt }],
            temperature: 0,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0,
          };
        }
        
        const medicalStartMs = Date.now();
        try {
          const medicalQuestionResponse = await callAiWithFailover(medicalQuestionRequest, data.timezone, modelIntencion, 0, dataRequest);
          const medicalElapsedMs = Date.now() - medicalStartMs;
          console.log(`⏱ medicalQuestionCheck (${modelIntencion}) ${medicalElapsedMs}ms`);
          if (medicalQuestionResponse.data.choices && medicalQuestionResponse.data.choices[0].message.content) {
            medicalQuestionResult = medicalQuestionResponse.data.choices[0].message.content.trim().toLowerCase();
            medicalQuestionCost = medicalQuestionResponse.data.usage ? calculatePrice(medicalQuestionResponse.data.usage, modelIntencion) : null;
            if (medicalQuestionCost) {
              costTracking.etapa0__medical_check = {
                cost: medicalQuestionCost.totalCost,
                tokens: {
                  input: medicalQuestionCost.inputTokens,
                  output: medicalQuestionCost.outputTokens,
                  total: medicalQuestionCost.totalTokens
                }
              };
              costTracking.total.cost += medicalQuestionCost.totalCost;
              costTracking.total.tokens.input += medicalQuestionCost.inputTokens;
              costTracking.total.tokens.output += medicalQuestionCost.outputTokens;
              costTracking.total.tokens.total += medicalQuestionCost.totalTokens;
            }
            if (medicalQuestionResult === 'medical') {
              queryType = 'general';
            } else {
              queryType = 'other';
            }
            
            //console.log('Medical question check result:', medicalQuestionResult, 'Query type:', queryType);
          }
        } catch (medicalError) {
          const medicalElapsedMs = Date.now() - medicalStartMs;
          console.log(`⏱ medicalQuestionCheck ERROR (${modelIntencion}) ${medicalElapsedMs}ms`);
          console.error('Error in medical question check:', medicalError);
          // En caso de error, asumir que no es médico
          queryType = 'other';
        }
      } else {
        queryType = 'other';
      }
    }

    console.log('Query type detected:', queryType);

    // Si es una consulta general para tenants especiales
    // en dxgpt solo habilitar en página beta (betaPage === true)
    if (specialTenants.includes(data.tenantId) && (!isDxgptTenant || data.betaPage === true) && queryType === 'general') {

                  await pubsubService.sendProgress(userId, 'medical_question', 'Generating educational response...', 50);
                  console.log('General medical question detected for special tenant, generating educational response');

                  // Llamar al modelo para contestar la pregunta médica general
                  let generalMedicalPrompt = `You are a medical educator. Answer the following medical question in a clear, educational manner using markdown formatting.

                  Guidelines:
                  - Provide accurate, evidence-based information
                  - Use clear, understandable language
                  - Include relevant medical context when appropriate
                  - Focus on educational value
                  - Keep the response concise but comprehensive
                  
                  Medical Question: ${data.description}
                  
                  Answer in the same language as the question using proper markdown formatting.`;

                 const modelType = modelQuestions;
                  try {
                    // Obtener respuesta del modelo seleccionado
                    const { response: generalMedicalResponse, model: selectedModel } = await getMedicalResponse(
                      generalMedicalPrompt, 
                      data.timezone, 
                      dataRequest, 
                      modelType
                    );
                    data.model = selectedModel;
                    
                    // Procesar respuesta
                    const { medicalAnswer, sonarData } = processMedicalResponse(generalMedicalResponse, selectedModel);

                    const result = {
                      result: 'success',
                      data: [], // Sin diagnósticos para consultas generales
                      medicalAnswer: medicalAnswer, // Respuesta educativa generada
                      sonarData: sonarData, // Información de citas (solo disponible con Sonar)
                      anonymization: {
                        hasPersonalInfo: false,
                        anonymizedText: '',
                        anonymizedTextHtml: ''
                      },
                      detectedLang: detectedLanguage,
                      model: modelType,
                      queryType: queryType,
                      question: data.description
                    };

                    // Guardar costos del clinical check y la respuesta médica
                    const stages = [];
                    if (costTracking.etapa0_clinical_check && costTracking.etapa0_clinical_check.cost > 0) {
                      stages.push({
                        name: 'clinical_check',
                        cost: costTracking.etapa0_clinical_check.cost,
                        tokens: costTracking.etapa0_clinical_check.tokens,
                        model: modelIntencion,
                        duration: 0,
                        success: true
                      });
                    }

                    if (costTracking.etapa0__medical_check && costTracking.etapa0__medical_check.cost > 0) {
                      stages.push({
                        name: 'medical_question_check',
                        cost: costTracking.etapa0__medical_check.cost,
                        tokens: costTracking.etapa0__medical_check.tokens,
                        model: modelIntencion,
                        duration: 0,
                        success: true
                      });
                    }
                    let etapa1Cost = null;
                    // Agregar costos de la respuesta médica general
                    if (generalMedicalResponse && generalMedicalResponse.data && generalMedicalResponse.data.usage) {
                      const usage = generalMedicalResponse.data.usage;
                      console.log('usage', usage)
                      console.log('selectedModel', selectedModel)
                      etapa1Cost = calculatePrice(usage, selectedModel);
                      costTracking.etapa1_medical_response = {
                        cost: etapa1Cost.totalCost,
                        tokens: etapa1Cost.totalTokens,
                        model: selectedModel,
                        duration: 0,
                        success: true
                      };
                      costTracking.total.cost += etapa1Cost.totalCost;
                      costTracking.total.tokens.input += etapa1Cost.inputTokens;
                      costTracking.total.tokens.output += etapa1Cost.outputTokens;
                      costTracking.total.tokens.total += etapa1Cost.totalTokens;
                      console.log(`   Etapa 1 - General Medical Response: ${formatCost(etapa1Cost.totalCost)}`);

                      stages.push({
                        name: 'general_medical_response',
                        cost: etapa1Cost.totalCost,
                        tokens: etapa1Cost.totalTokens,
                        model: selectedModel,
                        duration: 0,
                        success: true
                      });
                    }

                    // Añadir costes de traducción (detección + traducción a inglés)
                    // Añadir coste LLM de detección si existe
                    if (costTracking.detect_language && costTracking.detect_language.cost > 0) {
                      stages.push({
                        name: 'detect_language',
                        cost: costTracking.detect_language.cost,
                        tokens: costTracking.detect_language.tokens,
                        model: costTracking.detect_language.model,
                        duration: costTracking.detect_language.duration || 0,
                        success: true
                      });
                    }
                    // Añadir coste LLM de traducción a inglés si existe
                    if (costTracking.translation && costTracking.translation.cost > 0 && (costTracking.translation.model === 'gpt5mini' || costTracking.translation.model === 'gpt5nano')) {
                      stages.push({
                        name: 'translation',
                        cost: costTracking.translation.cost,
                        tokens: costTracking.translation.tokens,
                        model: costTracking.translation.model,
                        duration: costTracking.translation.duration || 0,
                        success: true
                      });
                    }
                    // Coste Azure de detección
                    if (detectChars > 0) {
                      const detectCost = (detectChars / 1000000) * 10;
                      stages.push({
                        name: 'detect_language',
                        cost: detectCost,
                        tokens: { input: detectChars, output: detectChars, total: detectChars },
                        model: 'translation_service',
                        duration: 0,
                        success: true
                      });
                      costTracking.total.cost += detectCost;
                    }
        if (translationChars > 0) {
                      const translationCost = (translationChars / 1000000) * 10;
                      costTracking.translation = {
                        cost: translationCost,
                        tokens: { input: translationChars, output: translationChars, total: translationChars },
                        model: 'translation_service',
                        duration: 0,
                        success: true
                      };
                      costTracking.total.cost += translationCost;
                      stages.push({
                        name: 'translation',
                        cost: translationCost,
                        tokens: { input: translationChars, output: translationChars, total: translationChars },
                        model: 'translation_service',
                        duration: 0,
                        success: true
                      });
                    }
        if (costTracking.reverse_anonymization && costTracking.reverse_anonymization.cost > 0) {
          stages.push({
            name: 'reverse_anonymization',
            cost: costTracking.reverse_anonymization.cost,
            tokens: costTracking.reverse_anonymization.tokens,
            model: costTracking.reverse_anonymization.model || 'gpt5mini',
            duration: costTracking.reverse_anonymization.duration || 0,
            success: true
          });
        }
                    // Añadir costes de traducción inversa
     if (reverseTranslationChars > 0) {
                      const reverseCost = (reverseTranslationChars / 1000000) * 10;
                      costTracking.reverse_translation = {
                        cost: reverseCost,
                        tokens: { input: reverseTranslationChars, output: reverseTranslationChars, total: reverseTranslationChars },
                        model: 'translation_service',
                        duration: 0,
                        success: true
                      };
                      costTracking.total.cost += reverseCost;
                      stages.push({
                        name: 'reverse_translation',
                        cost: reverseCost,
                        tokens: { input: 0, output: 0, total: 0 },
                        model: 'translation_service',
                        duration: 0,
                        success: true
                      });
                    }
     
                    // Reverse anonymization (LLM) si existe
                    if (costTracking.reverse_anonymization && costTracking.reverse_anonymization.cost > 0) {
                      stages.push({
                        name: 'reverse_anonymization',
                        cost: costTracking.reverse_anonymization.cost,
                        tokens: costTracking.reverse_anonymization.tokens,
                        model: costTracking.reverse_anonymization.model || 'gpt5mini',
                        duration: costTracking.reverse_anonymization.duration || 0,
                        success: true
                      });
                    }

                    console.log(`\n💰 RESUMEN DE COSTOS:`);
                    if (costTracking.detect_language && costTracking.detect_language.cost > 0) {
                      console.log(`   Etapa 0 - Detect Language: ${formatCost(costTracking.detect_language.cost)}`);
                    }
                    if (costTracking.etapa0_clinical_check.cost > 0) {
                      console.log(`   Etapa 0 - Clinical Check: ${formatCost(costTracking.etapa0_clinical_check.cost)}`);
                    }
                    if (costTracking.etapa0__medical_check && costTracking.etapa0__medical_check.cost > 0) {
                      console.log(`   Etapa 0 - Medical Question Check: ${formatCost(costTracking.etapa0__medical_check.cost)}`);
                    }
                    if (costTracking.translation && costTracking.translation.cost > 0) {
                      console.log(`   Etapa 1 - Translation: ${formatCost(costTracking.translation.cost)}`);
                    }
                    if (costTracking.reverse_translation && costTracking.reverse_translation.cost > 0) {
                      console.log(`   Etapa 1 - Reverse Translation: ${formatCost(costTracking.reverse_translation.cost)}`);
                    }
                    if (costTracking.reverse_diseases && costTracking.reverse_diseases.cost > 0) {
                      console.log(`   Etapa 1 - Reverse Diseases: ${formatCost(costTracking.reverse_diseases.cost)}`);
                    }
                    if (costTracking.reverse_anonymization && costTracking.reverse_anonymization.cost > 0) {
                      console.log(`   Etapa 2 - Reverse Anonymization: ${formatCost(costTracking.reverse_anonymization.cost)}`);
                    }

                    if (generalMedicalResponse && generalMedicalResponse.data && generalMedicalResponse.data.usage) {
                      console.log(`   Etapa 1 - General Medical Response: ${formatCost(etapa1Cost.totalCost)}`);
                    }
                    console.log(`   ──────────────────────────`);
                    console.log(`   TOTAL: ${formatCost(costTracking.total.cost)} (${costTracking.total.tokens.total} tokens)\n`);
                    console.log(`   ──────────────────────────`);
                    try {
                      await CostTrackingService.saveDiagnoseCost(data, stages, 'success', null, {
                        intent: 'medical_question',
                        queryType: queryType
                      });
                      console.log('✅ Costos de consulta médica general guardados en la base de datos');
                    } catch (costError) {
                      console.error('❌ Error guardando costos de consulta médica general:', costError.message);
                    }

                    // Guardar sesión de diagnóstico en la base de datos
                    try {
                      const questionData = {
                        myuuid: data.myuuid,
                        tenantId: data.tenantId,
                        subscriptionId: data.subscriptionId,
                        iframeParams: data.iframeParams || {},
                        question: {
                          originalText: data.description,
                          detectedLanguage: detectedLanguage,
                          translatedText: englishDescription
                        },
                        answer: {
                          medicalAnswer : medicalAnswer,
                          queryType: queryType,
                          model: modelType
                        },
                        timezone: data.timezone,
                        lang: data.lang || 'en',
                        processingTime: Date.now() - startTime,
                        status: 'success'
                      };

                      await DiagnoseSessionService.saveQuestion(questionData);
                      console.log('✅ Sesión de diagnóstico guardada exitosamente');
                    } catch (sessionError) {
                      console.error('❌ Error guardando sesión de diagnóstico:', sessionError.message);
                      insights.error({
                        message: 'Error guardando sesión de diagnóstico',
                        error: sessionError.message,
                        myuuid: data.myuuid,
                        tenantId: data.tenantId,
                        subscriptionId: data.subscriptionId
                      });
                      // No lanzamos el error para no afectar la respuesta al usuario
                    }
                    // Enviar progreso inicial
                    await pubsubService.sendProgress(userId, 'finalizing', 'Finalizing response...', 90);
                    // Enviar resultado final via WebPubSub
                    await pubsubService.sendResult(userId, result);
                    console.log('✅ Resultado final enviado via WebPubSub');
                    return { result: 'success', message: 'Sent via WebPubSub' };
                    //return result;
                  } catch (generalMedicalError) {
                    console.error('Error generating general medical response:', generalMedicalError);
                    insights.error({
                      message: 'Error generating general medical response',
                      error: generalMedicalError.message,
                      myuuid: data.myuuid,
                      tenantId: data.tenantId,
                      subscriptionId: data.subscriptionId
                    });
                    const questionData = {
                      myuuid: data.myuuid,
                      tenantId: data.tenantId,
                      subscriptionId: data.subscriptionId,
                      iframeParams: data.iframeParams || {},
                      question: {
                        originalText: data.description,
                        detectedLanguage: detectedLanguage,
                        translatedText: englishDescription
                      },
                      answer: {
                        medicalAnswer : '',
                        queryType: queryType,
                        model: modelType
                      },
                      timezone: data.timezone,
                      lang: data.lang || 'en',
                      processingTime: Date.now() - startTime,
                      status: 'error'
                    };
                    await DiagnoseSessionService.saveQuestion(questionData);
                    throw generalMedicalError;
                  }
    }else{
      const questionData = {
        myuuid: data.myuuid,
        tenantId: data.tenantId,
        subscriptionId: data.subscriptionId,
        iframeParams: data.iframeParams || {},
        question: {
          originalText: data.description,
          detectedLanguage: detectedLanguage,
          translatedText: englishDescription
        },
        answer: {
          medicalAnswer : '',
          queryType: queryType,
          model: model
        },
        timezone: data.timezone,
        lang: data.lang || 'en',
        processingTime: Date.now() - startTime,
        status: 'unknown'
      };
      DiagnoseSessionService.saveQuestion(questionData);
    }

    // Si no es una consulta diagnóstica, devolver respuesta vacía
    if (queryType !== 'diagnostic') {
      insights.trackEvent('NonDiagnosticQueryDetected', {
        message: 'Non-diagnostic query detected',
        requestData: data.description,
        model: model,
        response: clinicalScenarioResponse.data.choices,
        operation: 'clinical-scenario-check',
        myuuid: data.myuuid,
        tenantId: data.tenantId,
        subscriptionId: data.subscriptionId
      });
      let infoErrorClinicalScenario = {
        body: data,
        error: clinicalScenarioResult,
        type: 'NON_DIAGNOSTIC_QUERY',
        detectedLanguage: detectedLanguage || 'unknown',
        model: model,
        myuuid: data.myuuid,
        tenantId: data.tenantId,
        subscriptionId: data.subscriptionId
      };
      await blobOpenDx29Ctrl.createBlobErrorsDx29(infoErrorClinicalScenario, data.tenantId, data.subscriptionId);
      /*try {
        serviceEmail.sendMailErrorGPTIP(
          data.lang,
          data.description,
          infoErrorClinicalScenario,
          requestInfo
        );
      } catch (emailError) {
        console.log('Fail sending email');
        insights.error(emailError);
      }*/

      // Guardar costos si corresponde
      const stages = [];
      if (costTracking.etapa0_clinical_check && costTracking.etapa0_clinical_check.cost > 0) {
        stages.push({
          name: 'clinical_check',
          cost: costTracking.etapa0_clinical_check.cost,
          tokens: costTracking.etapa0_clinical_check.tokens,
          model: modelIntencion,
          duration: 0,
          success: true
        });
      }
      if (costTracking.etapa0__medical_check && costTracking.etapa0__medical_check.cost > 0) {
        stages.push({
          name: 'medical_question_check',
          cost: costTracking.etapa0__medical_check.cost,
          tokens: costTracking.etapa0__medical_check.tokens,
          model: modelIntencion,
          duration: 0,
          success: true
        });
      }
      // Detección (LLM)
      if (costTracking.detect_language && costTracking.detect_language.cost > 0) {
        stages.push({
          name: 'detect_language',
          cost: costTracking.detect_language.cost,
          tokens: costTracking.detect_language.tokens,
          model: costTracking.detect_language.model,
          duration: costTracking.detect_language.duration || 0,
          success: true
        });
      }
      // Traducción a inglés (LLM)
      if (costTracking.translation && costTracking.translation.cost > 0 && (costTracking.translation.model === 'gpt5mini' || costTracking.translation.model === 'gpt5nano')) {
        stages.push({
          name: 'translation',
          cost: costTracking.translation.cost,
          tokens: costTracking.translation.tokens,
          model: costTracking.translation.model,
          duration: costTracking.translation.duration || 0,
          success: true
        });
      }
      // Detección (Azure)
      if (detectChars > 0) {
        const detectCost = (detectChars / 1000000) * 10;
        costTracking.total.cost += detectCost;
        stages.push({
          name: 'detect_language',
          cost: detectCost,
          tokens: { input: detectChars, output: detectChars, total: detectChars },
          model: 'translation_service',
          duration: 0,
          success: true
        });
      }
      if (translationChars > 0) {
        const translationCost = (translationChars / 1000000) * 10;
        costTracking.translation = {
          cost: translationCost,
          tokens: { input: translationChars, output: translationChars, total: translationChars },
          model: 'translation_service',
          duration: 0,
          success: true
        };
        costTracking.total.cost += translationCost;
        stages.push({
          name: 'translation',
          cost: translationCost,
          tokens: { input: 0, output: 0, total: 0 },
          model: 'translation_service',
          duration: 0,
          success: true
        });
      }
      try {
        await CostTrackingService.saveDiagnoseCost(data, stages, 'success', null, {
          intent: 'non_diagnostic',
          queryType: queryType
        });
      } catch (costError) {
        console.error('❌ Error guardando costos en DB:', costError.message);
        insights.error({
          message: 'Error guardando costos en DB',
          error: costError.message,
          myuuid: data.myuuid,
          tenantId: data.tenantId,
          subscriptionId: data.subscriptionId
        });
      }
      return {
        result: 'success',
        data: [],
        anonymization: {
          hasPersonalInfo: false,
          anonymizedText: '',
          anonymizedTextHtml: ''
        },
        detectedLang: detectedLanguage,
        model: model,
        queryType: queryType,
        costTracking: costTracking
      };
    }

    // 2. FASE ÚNICA: Obtener diagnósticos completos en una sola llamada
    
    let helpDiagnosePrompt = englishDiseasesList ?
      PROMPTS.diagnosis.withDiseases
        .replace("{{description}}", englishDescription)
        .replace("{{previous_diagnoses}}", englishDiseasesList) :
      PROMPTS.diagnosis.withoutDiseases
        .replace("{{description}}", englishDescription);
    console.log('Calling IA for full diagnoses');
    let requestBody;
    if (model === 'o3') {
      requestBody = {
        model: "o3-dxgpt",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: helpDiagnosePrompt }
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
    } else if (model === 'gpt5nano') {
      requestBody = {
        model: "gpt-5-nano",
        messages: [{ role: "user", content: helpDiagnosePrompt }],
        reasoning_effort: "low" //minimal, low, medium, high
      };
    } else if (model === 'gpt5mini') {
      requestBody = {
        model: "gpt-5-mini",
        messages: [{ role: "user", content: helpDiagnosePrompt }],
        reasoning_effort: "low" //minimal, low, medium, high
      };
    }else if (model === 'gpt5') {
      requestBody = {
        model: "gpt-5",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: helpDiagnosePrompt
              }
            ]
          }
        ],
        reasoning_effort: "low"
      };

      if (data.imageUrls && data.imageUrls.length > 0) {
        const imagePrompts = data.imageUrls.map((image, index) => 
          { 
            return {
              type: "image_url",
              image_url: {
                url: image.url
              }
            }
          }
        );
        requestBody.messages[0].content.push(...imagePrompts);
        //console.log('imagePrompts', imagePrompts);
      }
    } else {
      const messages = [{ role: "user", content: helpDiagnosePrompt }];
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

    const aiResponse = await callAiWithFailover(requestBody, data.timezone, model, 0, dataRequest);
    let usage = null;

    // Progreso: IA completada
          if (userId) {
        await pubsubService.sendProgress(userId, 'anonymization', 'Anonymizing personal information...', 80);
      }

    // Procesar la respuesta según el modelo
    let aiResponseText;
    if (model === 'o3') {
      usage = aiResponse.data.usage;
      aiResponseText = aiResponse.data.output.find(el => el.type === "message")?.content?.[0]?.text?.trim();
    } else {
      usage = aiResponse.data.usage;
      aiResponseText = aiResponse.data.choices[0].message.content;
    }

    console.log('usage', aiResponse.data.usage);
    //console.log('aiResponseText', aiResponseText);

    // Calcular costos de la Etapa 1: Diagnósticos completos
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

    if (!aiResponseText) {
      insights.error({
        message: "No response from AI for diagnoses",
        requestData: data,
        model: model,
        response: aiResponse,
        operation: 'diagnosis-full',
        myuuid: data.myuuid,
        tenantId: data.tenantId,
        subscriptionId: data.subscriptionId
      });
      throw new Error("No response from AI for diagnoses");
    }

    // Parsear la respuesta de diagnósticos completos
    let parsedResponse = [];
    let parsedResponseEnglish;
    try {
      // Limpiar la respuesta para asegurar que es un JSON válido
      let cleanResponse = aiResponseText.trim().replace(/^```json\s*|\s*```$/g, '');
      cleanResponse = cleanResponse.replace(/^```\s*|\s*```$/g, '');
      
      // Fix quirúrgico para paréntesis sobrantes después de comillas de cierre
      // Solo aplicamos el fix si el JSON inicial es inválido
      try {
        parsedResponse = JSON.parse(cleanResponse);
      } catch (initialError) {
        // Solo si falla el parseo inicial, aplicamos el fix específico
        if (initialError.message.includes('Unexpected token )')) {
          cleanResponse = cleanResponse.replace(/\"\)\s*\",\s*/g, '",');
        }
        parsedResponse = JSON.parse(cleanResponse);
      }
      parsedResponseEnglish = parsedResponse;
      if (!Array.isArray(parsedResponse)) {
        throw new Error('Response is not an array');
      }
      // Validar que todos los elementos tienen los campos requeridos
      const requiredFields = ['diagnosis', 'description', 'symptoms_in_common', 'symptoms_not_in_common'];
      for (let i = 0; i < parsedResponse.length; i++) {
        const item = parsedResponse[i];
        if (!item || typeof item !== 'object') {
          throw new Error(`Item at index ${i} is not an object`);
        }
        for (const field of requiredFields) {
          if (!item.hasOwnProperty(field)) {
            throw new Error(`Missing required field '${field}' in item at index ${i}`);
          }
        }
        if (!Array.isArray(item.symptoms_in_common)) {
          throw new Error(`'symptoms_in_common' in item at index ${i} is not an array`);
        }
        if (!Array.isArray(item.symptoms_not_in_common)) {
          throw new Error(`'symptoms_not_in_common' in item at index ${i} is not an array`);
        }
        if (typeof item.diagnosis !== 'string' || item.diagnosis.trim() === '') {
          throw new Error(`'diagnosis' in item at index ${i} is not a valid string`);
        }
        if (typeof item.description !== 'string' || item.description.trim() === '') {
          throw new Error(`'description' in item at index ${i} is not a valid string`);
        }
      }
    } catch (parseError) {
      insights.error({
        message: "Failed to parse diagnosis output",
        error: parseError.message,
        rawResponse: aiResponseText,
        phase: 'parsing',
        model: model,
        requestData: data
      });
      parsedResponse = [];
      if (requestInfo) {
        let infoError = {
          myuuid: data.myuuid,
          operation: 'diagnosis-full',
          lang: data.lang,
          description: data.description,
          error: parseError,
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
      //throw parseError;
      return {
        result: 'success',
        data: [],
        anonymization: {
          hasPersonalInfo: false,
          anonymizedText: '',
          anonymizedTextHtml: ''
        },
        detectedLang: detectedLanguage,
        model: model,
        costTracking: costTracking
      };
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

    if (parsedResponse.length > 0) {
      anonymizedResult = await anonymizeText(englishDescription, data.timezone, data.tenantId, data.subscriptionId, data.myuuid, modelAnonymization);
      anonymizedDescription = anonymizedResult.anonymizedText;
      anonymizedDescriptionEnglish = anonymizedDescription;
      hasPersonalInfo = anonymizedResult.hasPersonalInfo;
      if (anonymizedResult.usage) {
        const etapa3Cost = calculatePrice(anonymizedResult.usage, modelAnonymization);
        costTracking.etapa2_anonimizacion = {
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
        console.log(`💰 Etapa 2 - Anonimización: ${formatCost(etapa3Cost.totalCost)} (${etapa3Cost.totalTokens} tokens)`);
      }
      console.log('hasPersonalInfo', hasPersonalInfo);
      if (hasPersonalInfo && detectedLanguage !== 'en') {
        // Intentar con LLM (gpt5mini) y fallback Azure
        try {
          const anonTranslatePrompt = `Translate the following text into ${detectedLanguage}. Preserve tokens like [ANON-n] exactly as they are. Return ONLY the translated text.`;
          const anonRequest = {
            model: "gpt-5-mini",
            messages: [
              { role: "user", content: anonTranslatePrompt },
              { role: "user", content: anonymizedDescription }
            ],
            reasoning_effort: "low"
          };
          const dataReqAnon = { tenantId: data.tenantId, subscriptionId: data.subscriptionId, myuuid: data.myuuid };
          const anonStart = Date.now();
          const anonResp = await callAiWithFailover(anonRequest, data.timezone, 'gpt5mini', 0, dataReqAnon);
          const anonEnd = Date.now();
          if (!anonResp.data.choices?.[0]?.message?.content) {
            throw new Error('Empty LLM anonymization translation response');
          }
          anonymizedDescription = anonResp.data.choices[0].message.content.trim();
          if (anonResp.data.usage) {
            const aCost = calculatePrice(anonResp.data.usage, 'gpt5mini');
            costTracking.reverse_anonymization = {
              cost: aCost.totalCost,
              tokens: { input: aCost.inputTokens, output: aCost.outputTokens, total: aCost.totalTokens },
              model: 'gpt5mini',
              duration: anonEnd - anonStart,
              success: true
            };
            costTracking.total.cost += aCost.totalCost;
            costTracking.total.tokens.input += aCost.inputTokens;
            costTracking.total.tokens.output += aCost.outputTokens;
            costTracking.total.tokens.total += aCost.totalTokens;
          }
        } catch (translationErrorLLM) {
          try {
            reverseTranslationChars += (anonymizedDescription ? anonymizedDescription.length : 0);
            anonymizedDescription = await translateInvertWithRetry(anonymizedDescription, detectedLanguage);
          } catch (translationErrorAzure) {
            console.error('Error en la traducción inversa (LLM+Azure):', translationErrorAzure.message);
            insights.error({ message: translationErrorAzure.message, phase: 'translation', detectedLanguage });
            throw translationErrorAzure;
          }
        }
        // Regenerar HTML desde el texto traducido
        const toAnonymizedHtml = (txt) => {
          if (!txt || typeof txt !== 'string') return '';
          return txt
            .replace(/\[ANON-(\d+)\]/g, (m, p1) => `<span style="background-color: black; display: inline-block; width:${parseInt(p1)}em;">&nbsp;</span>`)
            .replace(/\n/g, '<br>');
        };
        anonymizedResult.htmlText = toAnonymizedHtml(anonymizedDescription);
      }
    }

    // Traducir la respuesta si es necesario
    if (detectedLanguage !== 'en' && parsedResponse.length > 0) {
      try {
        // LLM (gpt5mini) para traducir el JSON completo preservando estructura
        const translationPrompt = `You are a bilingual medical translator. Translate the following JSON array into ${detectedLanguage}. Preserve the exact JSON structure and keys. Only translate string values. Return ONLY the JSON array, with no extra text.`;
        const inputJson = JSON.stringify(parsedResponse);
        const translateRequest = {
          model: "gpt-5-mini",
          messages: [
            { role: "user", content: translationPrompt },
            { role: "user", content: inputJson }
          ],
          reasoning_effort: "low"
        };
        const dataRequestTranslate = {
          tenantId: data.tenantId,
          subscriptionId: data.subscriptionId,
          myuuid: data.myuuid
        };
        const translateStart = Date.now();
        const translateResponse = await callAiWithFailover(translateRequest, data.timezone, 'gpt5mini', 0, dataRequestTranslate);
        const translateEnd = Date.now();
        if (!translateResponse.data.choices?.[0]?.message?.content) {
          throw new Error('Empty LLM translation response');
        }
        let translatedContent = translateResponse.data.choices[0].message.content.trim();
        translatedContent = translatedContent.replace(/^```json\s*|\s*```$/g, '').replace(/^```\s*|\s*```$/g, '');
        parsedResponse = JSON.parse(translatedContent);
        // Validar estructura del JSON traducido (igual que validación original)
        const requiredFields = ['diagnosis', 'description', 'symptoms_in_common', 'symptoms_not_in_common'];
        if (!Array.isArray(parsedResponse)) {
          throw new Error('Translated content is not an array');
        }
        for (let i = 0; i < parsedResponse.length; i++) {
          const item = parsedResponse[i];
          if (!item || typeof item !== 'object') {
            throw new Error(`Translated item at index ${i} is not an object`);
          }
          for (const field of requiredFields) {
            if (!Object.prototype.hasOwnProperty.call(item, field)) {
              throw new Error(`Missing required field '${field}' in translated item at index ${i}`);
            }
          }
          if (!Array.isArray(item.symptoms_in_common)) {
            throw new Error(`'symptoms_in_common' at index ${i} is not an array`);
          }
          if (!Array.isArray(item.symptoms_not_in_common)) {
            throw new Error(`'symptoms_not_in_common' at index ${i} is not an array`);
          }
          if (typeof item.diagnosis !== 'string' || item.diagnosis.trim() === '') {
            throw new Error(`'diagnosis' at index ${i} is not a valid string`);
          }
          if (typeof item.description !== 'string' || item.description.trim() === '') {
            throw new Error(`'description' at index ${i} is not a valid string`);
          }
        }
        // Log coste LLM (si usage disponible)
        if (translateResponse.data.usage) {
          const tCost = calculatePrice(translateResponse.data.usage, 'gpt5mini');
          console.log(`   Reverse Translation via LLM: $${formatCost(tCost.totalCost)} (${tCost.totalTokens} tokens, ${translateEnd - translateStart}ms)`);
          // Registrar coste en costTracking (LLM)
          costTracking.reverse_diseases = {
            cost: tCost.totalCost,
            tokens: { input: tCost.inputTokens, output: tCost.outputTokens, total: tCost.totalTokens },
            model: 'gpt5mini',
            duration: translateEnd - translateStart,
            success: true
          };
          costTracking.total.cost += tCost.totalCost;
          costTracking.total.tokens.input += tCost.inputTokens;
          costTracking.total.tokens.output += tCost.outputTokens;
          costTracking.total.tokens.total += tCost.totalTokens;
        }
      } catch (translationError) {
        console.error('Error en la traducción inversa (LLM), aplicando fallback Azure:', translationError.message);
        insights.error({
          message: 'Fallback to Azure Translator for reverse translation',
          llmError: translationError.message,
          detectedLanguage: detectedLanguage,
          requestData: data,
          model: model
        });
        // Fallback: Azure Translator por campos
        try {
          let reverseInChars = 0;
          for (const diagnosis of parsedResponse) {
            reverseInChars += (diagnosis.diagnosis ? diagnosis.diagnosis.length : 0);
            reverseInChars += (diagnosis.description ? diagnosis.description.length : 0);
            if (Array.isArray(diagnosis.symptoms_in_common)) {
              for (const s of diagnosis.symptoms_in_common) reverseInChars += (s ? s.length : 0);
            }
            if (Array.isArray(diagnosis.symptoms_not_in_common)) {
              for (const s of diagnosis.symptoms_not_in_common) reverseInChars += (s ? s.length : 0);
            }
          }
          reverseTranslationChars += reverseInChars;
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
        } catch (fallbackError) {
          console.error('Fallback Azure Translator error:', fallbackError.message);
          insights.error({
            message: 'Azure Translator fallback failed',
            error: fallbackError.message,
            detectedLanguage: detectedLanguage
          });
          throw fallbackError;
        }
      }
    }

    // Guardar información de seguimiento si es una llamada directa
    if (requestInfo) {
      let infoTrack = {
        value: anonymizedDescription || data.description || '',
        valueEnglish: anonymizedDescriptionEnglish || englishDescription || '',
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
        if (parsedResponse.length == 0) {
          await blobOpenDx29Ctrl.createBlobErrorsDx29(infoTrack, data.tenantId, data.subscriptionId);
        } else {
          if (model == 'gpt4o') {
            await blobOpenDx29Ctrl.createBlobOpenDx29(infoTrack, 'v1');
          } else if (model == 'o3') {
            await blobOpenDx29Ctrl.createBlobOpenDx29(infoTrack, 'v3');
          }else if (model == 'gpt5') {
            await blobOpenDx29Ctrl.createBlobOpenDx29(infoTrack, 'gpt5');
          }else if (model == 'gpt5mini'){
            await blobOpenDx29Ctrl.createBlobOpenDx29(infoTrack, 'gpt5mini');
          }else if (model == 'gpt5nano'){
            await blobOpenDx29Ctrl.createBlobOpenDx29(infoTrack, 'gpt5nano');
          }
        }
      }
    }

    // Convertir costTracking a array de etapas para guardar en DB
    const stages = [];
    if (costTracking.etapa0_clinical_check && costTracking.etapa0_clinical_check.cost > 0) {
      stages.push({
        name: 'clinical_check',
        cost: costTracking.etapa0_clinical_check.cost,
        tokens: costTracking.etapa0_clinical_check.tokens,
        model: modelIntencion,
        duration: 0,
        success: true
      });
    }
    if (costTracking.etapa0__medical_check && costTracking.etapa0__medical_check.cost > 0) {
      stages.push({
        name: 'medical_question_check',
        cost: costTracking.etapa0__medical_check.cost,
        tokens: costTracking.etapa0__medical_check.tokens,
        model: modelIntencion,
        duration: 0,
        success: true
      });
    }
    if (costTracking.etapa1_diagnosticos.cost > 0) {
      stages.push({
        name: 'ai_call',
        cost: costTracking.etapa1_diagnosticos.cost,
        tokens: costTracking.etapa1_diagnosticos.tokens,
        model: model,
        duration: 0,
        success: true
      });
    }
    if (costTracking.etapa2_anonimizacion.cost > 0) {
      stages.push({
        name: 'anonymization',
        cost: costTracking.etapa2_anonimizacion.cost,
        tokens: costTracking.etapa2_anonimizacion.tokens,
        model: model,
        duration: 0,
        success: true
      });
    }
    // Añadir etapas de traducción (texto -> inglés) y traducción inversa (inglés -> idioma original)
    // Detección (LLM)
    if (costTracking.detect_language && costTracking.detect_language.cost > 0) {
      stages.push({
        name: 'detect_language',
        cost: costTracking.detect_language.cost,
        tokens: costTracking.detect_language.tokens,
        model: costTracking.detect_language.model,
        duration: costTracking.detect_language.duration || 0,
        success: true
      });
    }
    // Traducción a inglés (LLM)
    if (costTracking.translation && costTracking.translation.cost > 0 && (costTracking.translation.model === 'gpt5mini' || costTracking.translation.model === 'gpt5nano')) {
      stages.push({
        name: 'translation',
        cost: costTracking.translation.cost,
        tokens: costTracking.translation.tokens,
        model: costTracking.translation.model,
        duration: costTracking.translation.duration || 0,
        success: true
      });
    }
    // Detección (Azure)
    if (detectChars > 0) {
      const detectCost = (detectChars / 1000000) * 10;
      costTracking.total.cost += detectCost;
      stages.push({
        name: 'detect_language',
        cost: detectCost,
        tokens: { input: detectChars, output: detectChars, total: detectChars },
        model: 'translation_service',
        duration: 0,
        success: true
      });
    }
    if (translationChars > 0) {
      const translationCost = (translationChars / 1000000) * 10;
      costTracking.translation = {
        cost: translationCost,
        tokens: { input: translationChars, output: translationChars, total: translationChars },
        model: 'translation_service',
        duration: 0,
        success: true
      };
      costTracking.total.cost += translationCost;
      stages.push({
        name: 'translation',
        cost: translationCost,
        tokens: { input: translationChars, output: translationChars, total: translationChars },
        model: 'translation_service',
        duration: 0,
        success: true
      });
    }
    if (reverseTranslationChars > 0) {
      const reverseCost = (reverseTranslationChars / 1000000) * 10;
      costTracking.reverse_translation = {
        cost: reverseCost,
        tokens: { input: reverseTranslationChars, output: reverseTranslationChars, total: reverseTranslationChars },
        model: 'translation_service',
        duration: 0,
        success: true
      };
      costTracking.total.cost += reverseCost;
      stages.push({
        name: 'reverse_translation',
        cost: reverseCost,
        tokens: { input: reverseTranslationChars, output: reverseTranslationChars, total: reverseTranslationChars },
        model: 'translation_service',
        duration: 0,
        success: true
      });
    }
    if (costTracking.reverse_diseases && costTracking.reverse_diseases.cost > 0) {
      stages.push({
        name: 'reverse_diseases',
        cost: costTracking.reverse_diseases.cost,
        tokens: costTracking.reverse_diseases.tokens,
        model: costTracking.reverse_diseases.model || 'gpt5mini',
        duration: costTracking.reverse_diseases.duration || 0,
        success: true
      });
    }
    if (costTracking.reverse_anonymization && costTracking.reverse_anonymization.cost > 0) {
      stages.push({
        name: 'reverse_anonymization',
        cost: costTracking.reverse_anonymization.cost,
        tokens: costTracking.reverse_anonymization.tokens,
        model: costTracking.reverse_anonymization.model || 'gpt5mini',
        duration: costTracking.reverse_anonymization.duration || 0,
        success: true
      });
    }
     // Mostrar resumen final de costos
     console.log(`\n💰 RESUMEN DE COSTOS:`);
     if (costTracking.detect_language && costTracking.detect_language.cost > 0) {
       console.log(`   Etapa 0 - Detect Language: ${formatCost(costTracking.detect_language.cost)}`);
     }
     if (costTracking.etapa0_clinical_check.cost > 0) {
       console.log(`   Etapa 0 - Clinical Check: ${formatCost(costTracking.etapa0_clinical_check.cost)}`);
     }
     if (costTracking.etapa0__medical_check && costTracking.etapa0__medical_check.cost > 0) {
       console.log(`   Etapa 0 - Medical Question Check: ${formatCost(costTracking.etapa0__medical_check.cost)}`);
     }
     console.log(`   Etapa 1 - Diagnósticos: ${formatCost(costTracking.etapa1_diagnosticos.cost)}`);
     console.log(`   Etapa 2 - Anonimización: ${formatCost(costTracking.etapa2_anonimizacion.cost)}`);
     if (costTracking.translation && costTracking.translation.cost > 0) {
       console.log(`   Etapa 1 - Translation: ${formatCost(costTracking.translation.cost)}`);
     }
     if (costTracking.reverse_translation && costTracking.reverse_translation.cost > 0) {
       console.log(`   Etapa 1 - Reverse Translation: ${formatCost(costTracking.reverse_translation.cost)}`);
     }
     if (costTracking.reverse_diseases && costTracking.reverse_diseases.cost > 0) {
       console.log(`   Etapa 1 - Reverse Diseases: ${formatCost(costTracking.reverse_diseases.cost)}`);
     }
     console.log(`   ──────────────────────────`);
     console.log(`   TOTAL: ${formatCost(costTracking.total.cost)} (${costTracking.total.tokens.total} tokens)\n`);
    try {
      await CostTrackingService.saveDiagnoseCost(data, stages, 'success', null, {
        intent: 'diagnostic',
        queryType: queryType
      });
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
    }
          if (userId) {
        await pubsubService.sendProgress(userId, 'finalizing', 'Finalizing diagnosis...', 95);
      }
    let diseasesList = [];
    if (parsedResponse.length > 0) {
      diseasesList = parsedResponse;
    }
    if(!hasPersonalInfo){
      anonymizedDescription = '';
      anonymizedResult.htmlText = '';
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
      queryType: queryType, // Agregar el tipo de consulta detectado
      //costTracking: costTracking
    };
    return result;
  } catch (error) {
    // Guardar costos en caso de error (si hay costos calculados)
    if (costTracking && costTracking.total.cost > 0) {
      try {
        // Convertir costTracking a array de etapas para guardar en DB
        const stages = [];

        if (costTracking.etapa0_clinical_check && costTracking.etapa0_clinical_check.cost > 0) {
          stages.push({
            name: 'clinical_check',
            cost: costTracking.etapa0_clinical_check.cost,
            tokens: costTracking.etapa0_clinical_check.tokens,
            model: modelIntencion,
            duration: 0,
            success: false
          });
        }

        if (costTracking.etapa0__medical_check && costTracking.etapa0__medical_check.cost > 0) {
          stages.push({
            name: 'medical_question_check',
            cost: costTracking.etapa0__medical_check.cost,
            tokens: costTracking.etapa0__medical_check.tokens,
            model: modelIntencion,
            duration: 0,
            success: false
          });
        }
        //etapa0__medical_check
        if(costTracking.etapa0__medical_check && costTracking.etapa0__medical_check.cost > 0) {
          stages.push({
            name: 'medical_question_check',
            cost: costTracking.etapa0__medical_check.cost,
            tokens: costTracking.etapa0__medical_check.tokens,
            model: modelIntencion,
            duration: 0,
            success: false
          });
        }

        // Etapa 1: Diagnósticos
        if (costTracking.etapa1_diagnosticos && costTracking.etapa1_diagnosticos.cost > 0) {
          stages.push({
            name: 'ai_call',
            cost: costTracking.etapa1_diagnosticos.cost,
            tokens: costTracking.etapa1_diagnosticos.tokens,
            model: model,
            duration: 0,
            success: false
          });
        }
        // Etapa 2: Anonimización
        if (costTracking.etapa2_anonimizacion && costTracking.etapa2_anonimizacion.cost > 0) {
          stages.push({
            name: 'anonymization',
            cost: costTracking.etapa2_anonimizacion.cost,
            tokens: costTracking.etapa2_anonimizacion.tokens,
            model: model,
            duration: 0,
            success: false
          });
        }

        // Etapas de traducción en caso de error
        if (translationChars > 0) {
          const translationCost = (translationChars / 1000000) * 10;
          costTracking.translation = {
            cost: translationCost,
            tokens: { input: translationChars, output: translationChars, total: translationChars },
            model: 'translation_service',
            duration: 0,
            success: false
          };
          costTracking.total.cost += translationCost;
          stages.push({
            name: 'translation',
            cost: translationCost,
            tokens: { input: 0, output: 0, total: 0 },
            model: 'translation_service',
            duration: 0,
            success: false
          });
        }
        if (reverseTranslationChars > 0) {
          const reverseCost = (reverseTranslationChars / 1000000) * 10;
          costTracking.reverse_translation = {
            cost: reverseCost,
            tokens: { input: reverseTranslationChars, output: reverseTranslationChars, total: reverseTranslationChars },
            model: 'translation_service',
            duration: 0,
            success: false
          };
          costTracking.total.cost += reverseCost;
          stages.push({
            name: 'reverse_translation',
            cost: reverseCost,
            tokens: { input: 0, output: 0, total: 0 },
            model: 'translation_service',
            duration: 0,
            success: false
          });
        }

        await CostTrackingService.saveDiagnoseCost(data, stages, 'error', {
          message: error.message,
          code: error.code || 'UNKNOWN_ERROR',
          phase: error.phase || 'unknown',
          queryType: queryType
        }, {
          intent: queryType || 'unknown',
          queryType: queryType
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
    if (typeof data.lang !== 'string' || data.lang.length < 2 || data.lang.length > 8) {
      errors.push({ field: 'lang', reason: 'Must be a valid language code (2-8 characters)' });
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
      const validFields = ['centro', 'ambito', 'especialidad', 'turno', 'servicio', 'id_paciente'];

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

  // Validar flag opcional para habilitar funcionalidades beta en dxgpt
  if (data.betaPage !== undefined && typeof data.betaPage !== 'boolean') {
    errors.push({ field: 'betaPage', reason: 'Must be a boolean' });
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
  const model = req.body.model || 'gpt5mini';
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
    const isLongModel = (model === 'o3' || model === 'gpt5nano' || model === 'gpt5mini' || model === 'gpt5');
    const { region, model: registeredModel, queueKey } = await queueService.registerActiveRequest(sanitizedData.timezone, model);
    
    // Si response_mode es 'direct', procesar síncronamente incluso para modelos largos
    if (sanitizedData.response_mode === 'direct') {
      try {
        const result = await processAIRequestInternal(sanitizedData, requestInfo, model, null, region);
        return res.status(200).send(result);
      } catch (error) {
        throw error;
      }
    }
    
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
  processAIRequest,
  processAIRequestInternal
};
