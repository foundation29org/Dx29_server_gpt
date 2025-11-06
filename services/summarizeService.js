const { translateTextWithRetry, translateInvertWithRetry, callAiWithFailover, sanitizeAiData } = require('./aiUtils');
const { detectLanguageSmart } = require('./languageDetect');
const CostTrackingService = require('./costTrackingService');
const serviceEmail = require('./email');
const blobOpenDx29Ctrl = require('./blobOpenDx29');
const insights = require('./insights');
const { calculatePrice, formatCost } = require('./costUtils');

function getHeader(req, name) {
  return req.headers[name.toLowerCase()];
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
      if (typeof data.lang !== 'string' || data.lang.length < 2 || data.lang.length > 8) {
        errors.push({ field: 'lang', reason: 'Must be a valid language code (2-8 characters)' });
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
  let translationChars = 0;
  let reverseTranslationChars = 0;
  let detectChars = 0;

    // 1. Detectar idioma (smart) y traducir a inglés si es necesario (LLM primero, fallback Azure)
    let englishDescription = description;
    let detectedLanguage = lang;
    let forwardLLMUsed = false;
    let forwardLLMCost = null;
    let forwardStart = 0, forwardEnd = 0;
    let detectLLMUsed = false;
    let detectLLMCost = null;
    let detectModel = null;
    let detectDuration = 0;
  let detectAzureDuration = 0;
  let forwardAzureDuration = 0;
    try {
      // Detección inteligente: Azure (<500 chars), LLM (>=500 chars)
      const det = await detectLanguageSmart(description || '', lang, req.body.timezone, tenantId, subscriptionId, req.body.myuuid);
      detectedLanguage = det.lang;
      if (det.azureCharsBilled && det.azureCharsBilled > 0) {
        detectChars += det.azureCharsBilled;
        detectAzureDuration = det.durationMs || 0;
      }
      if (det.usage && (det.modelUsed === 'gpt5mini' || det.modelUsed === 'gpt5nano')) {
        detectLLMCost = calculatePrice(det.usage, det.modelUsed);
        detectLLMUsed = true;
        detectModel = det.modelUsed;
        detectDuration = det.durationMs || 0;
      }
      if (detectedLanguage && detectedLanguage !== 'en') {
        // Intentar traducción a inglés con LLM (gpt-5-nano)
        try {
          forwardStart = Date.now();
          const translatePromptIn = `Translate the following text into English. Return ONLY the translated text.`;
          const requestBodyLLMIn = {
            model: "gpt-5-mini",
            messages: [
              { role: "user", content: translatePromptIn },
              { role: "user", content: description }
            ],
            reasoning_effort: "low"
          };
          const dataReqIn = {
            tenantId: req.body.tenantId,
            subscriptionId: req.body.subscriptionId,
            myuuid: req.body.myuuid
          };
          const llmInResp = await callAiWithFailover(requestBodyLLMIn, req.body.timezone, 'gpt5mini', 0, dataReqIn);
          forwardEnd = Date.now();
          if (!llmInResp.data.choices?.[0]?.message?.content) {
            throw new Error('Empty LLM forward translation response');
          }
          englishDescription = llmInResp.data.choices[0].message.content.trim();
          if (llmInResp.data.usage) {
            forwardLLMCost = calculatePrice(llmInResp.data.usage, 'gpt5mini');
            forwardLLMUsed = true;
          }
        } catch (llmForwardError) {
          // Fallback Azure translate to English
          translationChars += (description ? description.length : 0);
          const fwdAzStart = Date.now();
          englishDescription = await translateTextWithRetry(description, detectedLanguage);
          forwardAzureDuration = Date.now() - fwdAzStart;
        }
      }
    } catch (translationError) {
      // Manejo en caso de fallo de detección/traducción de ida: continuar sin traducir
      console.error('Language detect/forward translation error:', translationError.message);
      try {
        insights.error({
          type: 'TRANSLATION_FORWARD_ERROR',
          message: translationError.message,
          operation: 'summarize',
          tenantId: tenantId,
          subscriptionId: subscriptionId
        });
      } catch (_) {}
      // Mantener el texto original para el resumen
      detectedLanguage = lang || 'en';
      englishDescription = description;
    }

    // 2. Construir el prompt para el resumen (único prompt genérico)
    const prompt = `
    Summarize the following patient's medical description, keeping only relevant clinical information such as symptoms, evolution time, important medical history, and physical signs. Do not include irrelevant details or repeat phrases. The result should be shorter, clearer, and maintain the medical essence. Do not infer diagnoses or add medical interpretation.
    
    "${englishDescription}"
    
    Return ONLY the summarized description, with no additional commentary or explanation.`;

    const messages = [{ role: "user", content: prompt }];
    let requestBody = {
      messages,
      temperature: 0, // Cambiado a 0 para máxima precisión
      max_tokens: 1000,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    };

    // 3. Llamar a AI con failover
    let aiStartTime = Date.now();
    const dataRequest = {
      tenantId: req.body.tenantId,
      subscriptionId: req.body.subscriptionId,
      myuuid: req.body.myuuid
    };

    let model = 'gpt5mini';//'gpt4o';
    if(model == 'gpt5nano'){
      requestBody = {
        model: "gpt-5-nano",
        messages: [{ role: "user", content: prompt }],
        reasoning_effort: "low" //minimal, low, medium, high
      };
    } else if(model == 'gpt5mini'){
      requestBody = {
        model: "gpt-5-mini",
        messages: [{ role: "user", content: prompt }],
        reasoning_effort: "low" //minimal, low, medium, high
      };
    }
    const summarizeResponse = await callAiWithFailover(requestBody, req.body.timezone, model, 0, dataRequest);
    let aiEndTime = Date.now();

    if (!summarizeResponse.data.choices[0].message.content) {
      insights.error({
        message: "Empty AI summarize response",
        requestInfo: requestInfo,
        response: summarizeResponse,
        operation: 'summarize',
        tenantId: tenantId,
        subscriptionId: subscriptionId
      });
      throw new Error('Empty AI summarize response');
    }

    // 4. Obtener el resumen
    let summary = summarizeResponse.data.choices[0].message.content.trim();
    let summaryEnglish = summary;

    // 5. Traducir el resumen al idioma original si es necesario (LLM primero, fallback Azure)
    let reverseLLMUsed = false;
    let reverseLLMCost = null;
    let reverseStart = 0, reverseEnd = 0;
    if (detectedLanguage !== 'en') {
      try {
        reverseStart = Date.now();
        const translatePrompt = `Translate the following text into ${detectedLanguage}. Return ONLY the translated text.`;
        const requestBodyLLM = {
          model: "gpt-5-mini",
          messages: [
            { role: "user", content: translatePrompt },
            { role: "user", content: summary }
          ],
          reasoning_effort: "low"
        };
        const dataReq = {
          tenantId: req.body.tenantId,
          subscriptionId: req.body.subscriptionId,
          myuuid: req.body.myuuid
        };
        const llmResp = await callAiWithFailover(requestBodyLLM, req.body.timezone, 'gpt5mini', 0, dataReq);
        reverseEnd = Date.now();
        if (!llmResp.data.choices?.[0]?.message?.content) {
          throw new Error('Empty LLM translation response');
        }
        const translated = llmResp.data.choices[0].message.content.trim();
        summary = translated;
        if (llmResp.data.usage) {
          reverseLLMCost = calculatePrice(llmResp.data.usage, 'gpt5mini');
          reverseLLMUsed = true;
        }
      } catch (translationError) {
        // Fallback Azure
        try {
          reverseTranslationChars += (summary ? summary.length : 0);
          const revAzStart = Date.now();
          summary = await translateInvertWithRetry(summary, detectedLanguage);
          var reverseAzureDuration = Date.now() - revAzStart;
        } catch (translationError2) {
          console.error('Translation error (LLM+Azure):', translationError2);
          throw translationError2;
        }
      }
    }

    // 6. Guardar cost tracking solo en caso de éxito
    try {
      const usage = summarizeResponse.data.usage;
      const aiCost = calculatePrice(usage, model);
      console.log(`💰 summarize - AI Call: $${formatCost(aiCost.totalCost)} (${aiCost.totalTokens} tokens, ${aiEndTime - aiStartTime}ms)`);

      const stages = [];

      if (detectLLMUsed && detectLLMCost) {
        stages.push({
          name: 'detect_language',
          cost: detectLLMCost.totalCost,
          tokens: { input: detectLLMCost.inputTokens, output: detectLLMCost.outputTokens, total: detectLLMCost.totalTokens },
          model: detectModel === 'gpt5mini' ? 'gpt5mini' : 'gpt5nano',
          duration: detectDuration,
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
          duration: detectAzureDuration || 0,
          success: true
        });
      }

      // Coste LLM de traducción de ida (a inglés)
      if (forwardLLMUsed && forwardLLMCost) {
        stages.push({
          name: 'translation',
          cost: forwardLLMCost.totalCost,
          tokens: { input: forwardLLMCost.inputTokens, output: forwardLLMCost.outputTokens, total: forwardLLMCost.totalTokens },
          model: 'gpt5mini',
          duration: forwardEnd - forwardStart,
          success: true
        });
      }

      if (translationChars > 0) {
        console.log('translationChars:', translationChars);
        const translationCost = (translationChars / 1000000) * 10;
        stages.push({
          name: 'translation',
          cost: translationCost,
          tokens: { input: translationChars, output: translationChars, total: translationChars },
          model: 'translation_service',
          duration: forwardAzureDuration || 0,
          success: true
        });
      }

      stages.push({
        name: 'ai_call',
        cost: aiCost.totalCost,
        tokens: { input: aiCost.inputTokens, output: aiCost.outputTokens, total: aiCost.totalTokens },
        model: model,
        duration: aiEndTime - aiStartTime,
        success: true
      });

      if (reverseLLMUsed && reverseLLMCost) {
        stages.push({
          name: 'reverse_translation',
          cost: reverseLLMCost.totalCost,
          tokens: { input: reverseLLMCost.inputTokens, output: reverseLLMCost.outputTokens, total: reverseLLMCost.totalTokens },
          model: 'gpt5mini',
          duration: reverseEnd - reverseStart,
          success: true
        });
      } 
      if (reverseTranslationChars > 0) {
        console.log('reverseTranslationChars:', reverseTranslationChars);
        const reverseCost = (reverseTranslationChars / 1000000) * 10;
        stages.push({
          name: 'reverse_translation',
          cost: reverseCost,
          tokens: { input: reverseTranslationChars, output: reverseTranslationChars, total: reverseTranslationChars },
          model: 'translation_service',
          duration: reverseAzureDuration || 0,
          success: true
        });
      }

      // Desglose de costes por tipo
      const sumBy = (arr, key) => arr.reduce((s, x) => s + (x?.[key] || 0), 0);
      const group = (name, modelFilter) => stages.filter(s => s.name === name && (!modelFilter || modelFilter(s.model)));
      const toSummary = (arr) => ({
        cost: sumBy(arr, 'cost'),
        tokens: arr.reduce((s, x) => s + (x?.tokens?.total || 0), 0),
        duration: sumBy(arr, 'duration')
      });

      const detectLLMSum = toSummary(group('detect_language', m => m !== 'translation_service'));
      const detectAzure = toSummary(group('detect_language', m => m === 'translation_service'));
      const transLLM = toSummary(group('translation', m => m !== 'translation_service'));
      const transAzure = toSummary(group('translation', m => m === 'translation_service'));
      const revLLM = toSummary(group('reverse_translation', m => m !== 'translation_service'));
      const revAzure = toSummary(group('reverse_translation', m => m === 'translation_service'));

      console.log(`\n💰 RESUMEN DE COSTOS summarize:`);
      console.log(`   Detect language (LLM): $${formatCost(detectLLMSum.cost)} (${detectLLMSum.tokens} tokens, ${detectLLMSum.duration}ms)`);
      console.log(`   Detect language (Azure): $${formatCost(detectAzure.cost)} (${detectAzure.tokens} chars)`);
      console.log(`   Translation (LLM): $${formatCost(transLLM.cost)} (${transLLM.tokens} tokens, ${transLLM.duration}ms)`);
      console.log(`   Translation (Azure): $${formatCost(transAzure.cost)} (${transAzure.tokens} chars)`);
      console.log(`   AI Call: $${formatCost(aiCost.totalCost)} (${aiCost.totalTokens} tokens, ${aiEndTime - aiStartTime}ms)`);
      console.log(`   Reverse Translation (LLM): $${formatCost(revLLM.cost)} (${revLLM.tokens} tokens, ${revLLM.duration}ms)`);
      console.log(`   Reverse Translation (Azure): $${formatCost(revAzure.cost)} (${revAzure.tokens} chars)`);

      const totalCost = stages.reduce((sum, s) => sum + (s.cost || 0), 0);
      const totalTokens = {
        input: stages.reduce((sum, s) => sum + (s.tokens?.input || 0), 0),
        output: stages.reduce((sum, s) => sum + (s.tokens?.output || 0), 0),
        total: stages.reduce((sum, s) => sum + (s.tokens?.total || 0), 0)
      };

      await CostTrackingService.saveCostRecord({
        myuuid: costTrackingData.myuuid,
        tenantId: costTrackingData.tenantId,
        subscriptionId: costTrackingData.subscriptionId,
        operation: 'summarize',
        model: model,
        lang: costTrackingData.lang,
        timezone: costTrackingData.timezone,
        stages,
        totalCost,
        totalTokens,
        description: costTrackingData.description,
        status: 'success',
        iframeParams: costTrackingData.iframeParams,
        operationData: { detectedLanguage }
      });
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

module.exports = {
  summarize
}; 