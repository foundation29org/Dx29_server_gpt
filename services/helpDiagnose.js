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
  sanitizeInput,
  sanitizeAiData
} = require('./aiUtils');
const { calculatePrice, formatCost } = require('./costUtils');





// Función para sanitizar parámetros del iframe que pueden incluir información adicional
// para tenants específicos como centro médico, ámbito, especialidad, etc.

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
    etapa0_clinical_check: { cost: 0, tokens: { input: 0, output: 0, total: 0 } },
    etapa1_diagnosticos: { cost: 0, tokens: { input: 0, output: 0, total: 0 } },
    etapa2_anonimizacion: { cost: 0, tokens: { input: 0, output: 0, total: 0 } },
    total: { cost: 0, tokens: { input: 0, output: 0, total: 0 } }
  };

  console.log(`🚀 Iniciando processAIRequestInternal con modelo: ${model}`);

  try {
    // 1. Detectar idioma y traducir a inglés si es necesario
    console.log('data.description', data.description)
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

    // 1.5. Verificar si el input es un escenario clínico antes de continuar
    const clinicalScenarioPrompt = PROMPTS.diagnosis.clinicalScenarioCheck.replace("{{description}}", englishDescription);
    const clinicalScenarioRequest = {
      messages: [{ role: "user", content: clinicalScenarioPrompt }],
      temperature: 0,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    };
    let dataRequest = {
      tenantId: data.tenantId,
      subscriptionId: data.subscriptionId,
      myuuid: data.myuuid
    };
    const clinicalScenarioResponse = await callAiWithFailover(clinicalScenarioRequest, data.timezone, 'gpt4omini', 0, dataRequest);
    let clinicalScenarioCost = null;
    let clinicalScenarioResult = '';
    if (clinicalScenarioResponse.data.choices && clinicalScenarioResponse.data.choices[0].message.content) {
      clinicalScenarioResult = clinicalScenarioResponse.data.choices[0].message.content.trim().toLowerCase();
      clinicalScenarioCost = clinicalScenarioResponse.data.usage ? calculatePrice(clinicalScenarioResponse.data.usage, 'gpt-4o-mini') : null;
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
    if (clinicalScenarioResult !== 'true') {
      insights.error({
        message: 'Clinical scenario check failed',
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
        type: 'CLINICAL_SCENARIO_CHECK_FAILED',
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

      // Guardar costos si corresponde
      const stages = [];
      if (costTracking.etapa0_clinical_check && costTracking.etapa0_clinical_check.cost > 0) {
        stages.push({
          name: 'clinical_check',
          cost: costTracking.etapa0_clinical_check.cost,
          tokens: costTracking.etapa0_clinical_check.tokens,
          model: 'gpt-4o-mini',
          duration: 0,
          success: true
        });
      }
      try {
        await CostTrackingService.saveDiagnoseCost(data, stages, 'success');
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
        costTracking: costTracking
      };
    }

    // 2. FASE ÚNICA: Obtener diagnósticos completos en una sola llamada
    
    const helpDiagnosePrompt = englishDiseasesList ?
      PROMPTS.diagnosis.withDiseases
        .replace("{{description}}", englishDescription)
        .replace("{{previous_diagnoses}}", englishDiseasesList) :
      PROMPTS.diagnosis.withoutDiseases
        .replace("{{description}}", englishDescription);
    console.log('Calling IA for full diagnoses')
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
    if (pubsubService) {
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
    console.log('aiResponseText', aiResponseText);

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
      parsedResponse = JSON.parse(cleanResponse);
      parsedResponseEnglish = JSON.parse(cleanResponse);
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
      anonymizedResult = await anonymizeText(englishDescription, data.timezone, data.tenantId, data.subscriptionId, data.myuuid);
      anonymizedDescription = anonymizedResult.anonymizedText;
      anonymizedDescriptionEnglish = anonymizedDescription;
      hasPersonalInfo = anonymizedResult.hasPersonalInfo;
      if (anonymizedResult.usage) {
        const etapa3Cost = calculatePrice(anonymizedResult.usage, 'gpt4o');
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

    // Traducir la respuesta si es necesario
    if (detectedLanguage !== 'en' && parsedResponse.length > 0) {
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

    // Guardar información de seguimiento si es una llamada directa
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

    // Mostrar resumen final de costos
    console.log(`\n💰 RESUMEN DE COSTOS:`);
    if (costTracking.etapa0_clinical_check.cost > 0) {
      console.log(`   Etapa 0 - Clinical Check: ${formatCost(costTracking.etapa0_clinical_check.cost)}`);
    }
    console.log(`   Etapa 1 - Diagnósticos: ${formatCost(costTracking.etapa1_diagnosticos.cost)}`);
    console.log(`   Etapa 2 - Anonimización: ${formatCost(costTracking.etapa2_anonimizacion.cost)}`);
    console.log(`   ──────────────────────────`);
    console.log(`   TOTAL: ${formatCost(costTracking.total.cost)} (${costTracking.total.tokens.total} tokens)\n`);

    // Convertir costTracking a array de etapas para guardar en DB
    const stages = [];
    if (costTracking.etapa0_clinical_check && costTracking.etapa0_clinical_check.cost > 0) {
      stages.push({
        name: 'clinical_check',
        cost: costTracking.etapa0_clinical_check.cost,
        tokens: costTracking.etapa0_clinical_check.tokens,
        model: 'gpt-4o-mini',
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
    }
    if (pubsubService) {
      await pubsubService.sendProgress(userId, 'finalizing', 'Finalizing diagnosis...', 95);
    }
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
      //costTracking: costTracking
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
        // Etapa 2: Anonimización
        if (costTracking.etapa2_anonimizacion.cost > 0) {
          stages.push({
            name: 'anonymization',
            cost: costTracking.etapa2_anonimizacion.cost,
            tokens: costTracking.etapa2_anonimizacion.tokens,
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
  processAIRequest,
  processAIRequestInternal
};
