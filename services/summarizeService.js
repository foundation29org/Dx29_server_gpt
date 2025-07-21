const { detectLanguageWithRetry, translateTextWithRetry, translateInvertWithRetry } = require('./aiUtils');
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

module.exports = {
  summarize
}; 