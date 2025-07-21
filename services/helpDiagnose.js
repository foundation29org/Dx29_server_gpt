const config = require('../config')
const insights = require('../services/insights')
const { anonymizeText } = require('./anonymizeService');
const blobOpenDx29Ctrl = require('../services/blobOpenDx29')
const serviceEmail = require('../services/email')
const PROMPTS = require('../assets/prompts');
const queueService = require('./queueService');
const { shouldSaveToBlob } = require('../utils/blobPolicy');
const CostTrackingService = require('./costTrackingService');
const {
  callAiWithFailover,
  detectLanguageWithRetry,
  translateTextWithRetry,
  translateInvertWithRetry,
  sanitizeInput
} = require('./aiUtils');
const { calculatePrice, formatCost } = require('./costUtils');





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
  processAIRequest
};
