const { detectLanguageWithRetry, translateTextWithRetry, translateInvertWithRetry, callAiWithFailover, sanitizeAiData } = require('./aiUtils');
const CostTrackingService = require('./costTrackingService');
const serviceEmail = require('./email');
const blobOpenDx29Ctrl = require('./blobOpenDx29');
const insights = require('./insights');
const config = require('../config');
const API_MANAGEMENT_BASE = config.API_MANAGEMENT_BASE;
const ApiManagementKey = config.API_MANAGEMENT_KEY;
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

    // 1. Detectar idioma y traducir a inglés si es necesario
    let englishDescription = description;
    let detectedLanguage = lang;
    try {
      // Detección (se cobra por carácter)
      translationChars += (description ? description.length : 0);
      detectedLanguage = await detectLanguageWithRetry(description, lang);
      if (detectedLanguage && detectedLanguage !== 'en') {
        // Traducción a inglés (se cobra por carácter)
        translationChars += (description ? description.length : 0);
        englishDescription = await translateTextWithRetry(description, detectedLanguage);
      }
    } catch (translationError) {
      // ... manejo de error existente ...
    }

    // 2. Construir el prompt para el resumen
    let prompt;
    let hasParts = hasAnalysis(englishDescription);
    if (hasParts) {
      // Prompt seguro para casos con imagen
      prompt = `
    You are a clinical editor.
    
    You will receive up to three sections, delimited by XML-like tags:
    <PATIENT_TEXT> … </PATIENT_TEXT>
    <DOCUMENT_TEXT> … </DOCUMENT_TEXT>
    <IMAGE_REPORT> … </IMAGE_REPORT>  ← already formatted radiology/ECG/US report
    
    TASK
    1) Create a concise clinical summary ONLY from PATIENT_TEXT and DOCUMENT_TEXT.
       - Keep symptoms, onset/evolution, key PMH, meds, relevant exam.
       - Max 6 lines. No repetition. No diagnoses not stated.
    2) REPRODUCE the IMAGE_REPORT VERBATIM (do not rewrite, shorten, or translate).
    3) Output exactly these two sections, in Spanish if input is Spanish:
    
    Resumen clínico
    <your summary from patient/document text>
    
    Hallazgos de imagen (no modificar)
    <the IMAGE_REPORT text verbatim>
    
    If a section is missing, omit it. Do not add other headings or commentary.
    
    Content to analyze:
    "${englishDescription}"`;
    } else {
      // Prompt genérico actual
      prompt = `
    Summarize the following patient's medical description, keeping only relevant clinical information such as symptoms, evolution time, important medical history, and physical signs. Do not include irrelevant details or repeat phrases. The result should be shorter, clearer, and maintain the medical essence. Do not infer diagnoses or add medical interpretation.
    
    "${englishDescription}"
    
    Return ONLY the summarized description, with no additional commentary or explanation.`;
    }

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
    const diagnoseResponse = await callAiWithFailover(requestBody, req.body.timezone, model, 0, dataRequest);
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
        // Traducción inversa del resultado (se cobra por carácter)
        reverseTranslationChars += (summary ? summary.length : 0);
        summary = await translateInvertWithRetry(summary, detectedLanguage);
      } catch (translationError) {
        console.error('Translation error:', translationError);
        throw translationError;
      }
    }

    // 6. Guardar cost tracking solo en caso de éxito
    try {
      const usage = diagnoseResponse.data.usage;
      const aiCost = calculatePrice(usage, model);
      console.log(`💰 summarize - AI Call: $${formatCost(aiCost.totalCost)} (${aiCost.totalTokens} tokens, ${aiEndTime - aiStartTime}ms)`);

      const stages = [];

      if (translationChars > 0) {
        const translationCost = (translationChars / 1000000) * 10;
        stages.push({
          name: 'translation',
          cost: translationCost,
          tokens: { input: translationChars, output: translationChars, total: translationChars },
          model: 'translation_service',
          duration: 0,
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

      if (reverseTranslationChars > 0) {
        const reverseCost = (reverseTranslationChars / 1000000) * 10;
        stages.push({
          name: 'reverse_translation',
          cost: reverseCost,
          tokens: { input: reverseTranslationChars, output: reverseTranslationChars, total: reverseTranslationChars },
          model: 'translation_service',
          duration: 0,
          success: true
        });
      }

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

function hasAnalysis(description) {
  return description.includes('<PATIENT_TEXT>') || 
         description.includes('<DOCUMENT_TEXT>') ||
         description.includes('<IMAGE_REPORT>');
}

module.exports = {
  summarize
}; 