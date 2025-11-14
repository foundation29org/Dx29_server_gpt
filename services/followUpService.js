const { detectLanguageWithRetry, translateTextWithRetry, translateInvertWithRetry, sanitizeInput, callAiWithFailover, parseJsonWithFixes } = require('./aiUtils');
const { calculatePrice, formatCost } = require('./costUtils');
const CostTrackingService = require('./costTrackingService');
const serviceEmail = require('./email');
const blobOpenDx29Ctrl = require('./blobOpenDx29');
const insights = require('./insights');
const { shouldSaveToBlob } = require('../utils/blobPolicy');

function getHeader(req, name) {
  return req.headers[name.toLowerCase()];
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
      lang: lang,
      timezone: timezone,
      description: `${description} - Follow-up questions`,
      iframeParams: req.body.iframeParams || {}
    };
  let translationChars = 0;
  let reverseTranslationChars = 0;
  let detectChars = 0;
  let detectDurationMs = 0;
  let forwardDurationMs = 0;
  let reverseDurationMs = 0;

    // 1. Detectar idioma y traducir a inglés si es necesario
    let englishDescription = description;
    let detectedLanguage = lang;
    let englishDiseases = diseases;

    try {
      // Si viene detectado previamente, evitar re-detectar
      const detectedHint = req.body.detectedLanguage || req.body.detectedLang;
      if (detectedHint && typeof detectedHint === 'string') {
        detectedLanguage = detectedHint.toLowerCase();
      } else {
        // Detección (Azure) — contar caracteres aparte
        detectChars += (description ? description.length : 0);
        const detStart = Date.now();
        detectedLanguage = await detectLanguageWithRetry(description, lang);
        detectDurationMs = Date.now() - detStart;
      }
      if (detectedLanguage && detectedLanguage !== 'en') {
        // Traducción de descripción y lista de enfermedades
        translationChars += (description ? description.length : 0);
        const fwdStart1 = Date.now();
        englishDescription = await translateTextWithRetry(description, detectedLanguage);
        forwardDurationMs += (Date.now() - fwdStart1);
        if (englishDiseases) {
          translationChars += (diseases ? diseases.length : 0);
          const fwdStart2 = Date.now();
          englishDiseases = await translateTextWithRetry(diseases, detectedLanguage);
          forwardDurationMs += (Date.now() - fwdStart2);
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
    let requestBody = {
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
    let model = 'gpt5mini';
    if(model == 'gpt5mini'){
      requestBody = {
        model: "gpt-5-mini",
        messages: [{ role: "user", content: prompt }],
        reasoning_effort: "low" //minimal, low, medium, high
      };
    } 
    const diagnoseResponse = await callAiWithFailover(requestBody, sanitizedData.timezone, model, 0, dataRequest);
    const aiEndTime = Date.now();

    // Calcular costos y tokens para la llamada AI
    const usage = diagnoseResponse.data.usage;
    const costData = calculatePrice(usage, model);

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
      const content = diagnoseResponse.data.choices[0].message.content;
      questions = parseJsonWithFixes(content);

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
        // Contabilizar caracteres previos a la traducción inversa
        reverseTranslationChars += questions.reduce((sum, q) => sum + (q ? q.length : 0), 0);
        const revStart = Date.now();
        questions = await Promise.all(
          questions.map(question => translateInvertWithRetry(question, detectedLanguage))
        );
        reverseDurationMs = Date.now() - revStart;
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

    // Guardar cost tracking multi-etapa
    try {
      const stages = [];
      if (detectChars > 0) {
        const detectCost = (detectChars / 1000000) * 10;
        stages.push({
          name: 'detect_language',
          cost: detectCost,
          tokens: { input: detectChars, output: detectChars, total: detectChars },
          model: 'translation_service',
          duration: detectDurationMs,
          success: true
        });
      }
      if (translationChars > 0) {
        const translationCost = (translationChars / 1000000) * 10;
        stages.push({
          name: 'translation',
          cost: translationCost,
          tokens: { input: translationChars, output: translationChars, total: translationChars },
          model: 'translation_service',
          duration: forwardDurationMs,
          success: true
        });
      }
      stages.push({
        name: 'ai_call',
        cost: costData.totalCost,
        tokens: { input: costData.inputTokens, output: costData.outputTokens, total: costData.totalTokens },
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
          duration: reverseDurationMs,
          success: true
        });
      }
      const totalCost = stages.reduce((s, st) => s + (st.cost || 0), 0);
      const totalTokens = {
        input: stages.reduce((s, st) => s + (st.tokens?.input || 0), 0),
        output: stages.reduce((s, st) => s + (st.tokens?.output || 0), 0),
        total: stages.reduce((s, st) => s + (st.tokens?.total || 0), 0)
      };
      await CostTrackingService.saveCostRecord({
        myuuid: costTrackingData.myuuid,
        tenantId: costTrackingData.tenantId,
        subscriptionId: costTrackingData.subscriptionId,
        operation: 'follow_up_questions',
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
      // Resumen de costes
      const sumBy = (arr, key) => arr.reduce((s, x) => s + (x?.[key] || 0), 0);
      const group = (name, modelFilter) => stages.filter(s => s.name === name && (!modelFilter || modelFilter(s.model)));
      const toSummary = (arr) => ({
        cost: sumBy(arr, 'cost'),
        tokens: arr.reduce((s, x) => s + (x?.tokens?.total || 0), 0),
        duration: sumBy(arr, 'duration')
      });
      const detectAzure = toSummary(group('detect_language', m => m === 'translation_service'));
      const transAzure = toSummary(group('translation', m => m === 'translation_service'));
      const revAzure = toSummary(group('reverse_translation', m => m === 'translation_service'));
      const aiCall = toSummary(group('ai_call'));
      console.log(`\n💰 RESUMEN DE COSTOS generateFollowUpQuestions:`);
      console.log(`   Detect language (Azure): $${formatCost(detectAzure.cost)} (${detectAzure.tokens} chars)`);
      console.log(`   Translation (Azure): $${formatCost(transAzure.cost)} (${transAzure.tokens} chars)`);
      console.log(`   AI Call: $${formatCost(aiCall.cost)} (${aiCall.tokens} tokens, ${aiCall.duration}ms)`);
      console.log(`   Reverse Translation (Azure): $${formatCost(revAzure.cost)} (${revAzure.tokens} chars)`);
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
  let translationChars = 0;
  let reverseTranslationChars = 0;
  let detectChars = 0;
  let detectDurationMs = 0;
  let forwardDurationMs = 0;
  let reverseDurationMs = 0;

    // 1. Detectar idioma y traducir a inglés si es necesario
    let englishDescription = description;
    let detectedLanguage = lang;
    let englishAnswers = answers;
    try {
      // Si viene detectado previamente, evitar re-detectar
      const detectedHint = req.body.detectedLanguage || req.body.detectedLang;
      if (detectedHint && typeof detectedHint === 'string') {
        detectedLanguage = detectedHint.toLowerCase();
      } else {
        // Detección (Azure) — contar caracteres aparte
        detectChars += (description ? description.length : 0);
        const detStart = Date.now();
        detectedLanguage = await detectLanguageWithRetry(description, lang);
        detectDurationMs = Date.now() - detStart;
      }
      if (detectedLanguage && detectedLanguage !== 'en') {
        // Traducción de descripción y Q/A
        translationChars += (description ? description.length : 0);
        const fwdStart1 = Date.now();
        englishDescription = await translateTextWithRetry(description, detectedLanguage);
        forwardDurationMs += (Date.now() - fwdStart1);
        let qaChars = 0;
        const fwdStart2 = Date.now();
        englishAnswers = await Promise.all(
          answers.map(async (item) => {
            qaChars += (item.question ? item.question.length : 0);
            qaChars += (item.answer ? item.answer.length : 0);
            return {
              question: await translateTextWithRetry(item.question, detectedLanguage),
              answer: await translateTextWithRetry(item.answer, detectedLanguage)
            };
          })
        );
        forwardDurationMs += (Date.now() - fwdStart2);
        translationChars += qaChars;
      }
    } catch (translationError) {
      console.error('Translation error:', translationError.message);
      let infoErrorlang = {
        body: req.body,
        error: translationError.message,
        type: translationError.code || 'TRANSLATION_ERROR',
        detectedLanguage: detectedLanguage || 'unknown',
        model: 'process-follow-up',
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
          operation: 'process-follow-up',
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
        operation: 'process-follow-up',
        requestInfo: requestInfo
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
    let requestBody = {
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
    let model = 'gpt5mini';
    if(model == 'gpt5mini'){
      requestBody = {
        model: "gpt-5-mini",
        messages: [{ role: "user", content: prompt }],
        reasoning_effort: "low" //minimal, low, medium, high
      };
    } 
    const aiStartTime = Date.now();
    const diagnoseResponse = await callAiWithFailover(requestBody, sanitizedData.timezone, model, 0, dataRequest);
    const aiEndTime = Date.now();
    
    // Guardar cost tracking solo en caso de éxito
    const usage = diagnoseResponse.data.usage;
    const costData = calculatePrice(usage, model);
    

    console.log(`💰 processFollowUpAnswers - AI Call: $${formatCost(costData.totalCost)} (${costData.totalTokens} tokens, ${aiEndTime - aiStartTime}ms)`);

    try {
      const stages = [];
      if (detectChars > 0) {
        const detectCost = (detectChars / 1000000) * 10;
        stages.push({
          name: 'detect_language',
          cost: detectCost,
          tokens: { input: detectChars, output: detectChars, total: detectChars },
          model: 'translation_service',
          duration: detectDurationMs,
          success: true
        });
      }
      if (translationChars > 0) {
        const translationCost = (translationChars / 1000000) * 10;
        stages.push({
          name: 'translation',
          cost: translationCost,
          tokens: { input: translationChars, output: translationChars, total: translationChars },
          model: 'translation_service',
          duration: forwardDurationMs,
          success: true
        });
      }
      stages.push({
        name: 'ai_call',
        cost: costData.totalCost,
        tokens: { 
          input: costData.inputTokens, 
          output: costData.outputTokens, 
          total: costData.totalTokens 
        },
        model: model,
        duration: aiEndTime - aiStartTime,
        success: true
      });
      // reverseTranslationChars se calculará más abajo cuando tengamos updatedDescription
      // (añadimos el stage después del cálculo)
      const totalCostBase = stages.reduce((s, st) => s + (st.cost || 0), 0);
      let totalCost = totalCostBase;
      let totalTokens = {
        input: stages.reduce((s, st) => s + (st.tokens?.input || 0), 0),
        output: stages.reduce((s, st) => s + (st.tokens?.output || 0), 0),
        total: stages.reduce((s, st) => s + (st.tokens?.total || 0), 0)
      };

      // Guardaremos al final tras calcular reverseTranslationChars
      var followUpStages = stages;
    } catch (costError) {
      console.error('Error saving cost tracking (pre-reverse):', costError);
    }
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
        reverseTranslationChars = (updatedDescription ? updatedDescription.length : 0);
        const revStart = Date.now();
        updatedDescription = await translateInvertWithRetry(updatedDescription, detectedLanguage);
        reverseDurationMs = Date.now() - revStart;
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

    // Añadir stage de reverse_translation y guardar definitivamente el cost tracking
    try {
      if (reverseTranslationChars > 0) {
        const reverseCost = (reverseTranslationChars / 1000000) * 10;
        followUpStages.push({
          name: 'reverse_translation',
          cost: reverseCost,
          tokens: { input: reverseTranslationChars, output: reverseTranslationChars, total: reverseTranslationChars },
          model: 'translation_service',
          duration: reverseDurationMs || 0,
          success: true
        });
      }
      const totalCost = followUpStages.reduce((s, st) => s + (st.cost || 0), 0);
      const totalTokens = {
        input: followUpStages.reduce((s, st) => s + (st.tokens?.input || 0), 0),
        output: followUpStages.reduce((s, st) => s + (st.tokens?.output || 0), 0),
        total: followUpStages.reduce((s, st) => s + (st.tokens?.total || 0), 0)
      };
      await CostTrackingService.saveCostRecord({
        myuuid: costTrackingData.myuuid,
        tenantId: costTrackingData.tenantId,
        subscriptionId: costTrackingData.subscriptionId,
        operation: 'process-follow-up',
        model: model,
        lang: costTrackingData.lang,
        timezone: costTrackingData.timezone,
        stages: followUpStages,
        totalCost,
        totalTokens,
        description: costTrackingData.description,
        status: 'success',
        iframeParams: costTrackingData.iframeParams,
        operationData: { detectedLanguage }
      });
      // Resumen de costes
      const sumBy = (arr, key) => arr.reduce((s, x) => s + (x?.[key] || 0), 0);
      const group = (name, modelFilter) => followUpStages.filter(s => s.name === name && (!modelFilter || modelFilter(s.model)));
      const toSummary = (arr) => ({
        cost: sumBy(arr, 'cost'),
        tokens: arr.reduce((s, x) => s + (x?.tokens?.total || 0), 0),
        duration: sumBy(arr, 'duration')
      });
      const detectAzure = toSummary(group('detect_language', m => m === 'translation_service'));
      const transAzure = toSummary(group('translation', m => m === 'translation_service'));
      const revAzure = toSummary(group('reverse_translation', m => m === 'translation_service'));
      const aiCall = toSummary(group('ai_call'));
      console.log(`\n💰 RESUMEN DE COSTOS processFollowUpAnswers:`);
      console.log(`   Detect language (Azure): $${formatCost(detectAzure.cost)} (${detectAzure.tokens} chars)`);
      console.log(`   Translation (Azure): $${formatCost(transAzure.cost)} (${transAzure.tokens} chars)`);
      console.log(`   AI Call: $${formatCost(aiCall.cost)} (${aiCall.tokens} tokens, ${aiCall.duration}ms)`);
      console.log(`   Reverse Translation (Azure): $${formatCost(revAzure.cost)} (${revAzure.tokens} chars)`);
    } catch (costError) {
      console.error('Error saving final cost tracking:', costError);
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
  let translationChars = 0;
  let reverseTranslationChars = 0;
  let detectChars = 0;
  let detectDurationMs = 0;
  let forwardDurationMs = 0;
  let reverseDurationMs = 0;

  

    // 1. Detectar idioma y traducir a inglés si es necesario
    let englishDescription = description;
    let detectedLanguage = lang;
    try {
      // Detección (Azure) — contar caracteres aparte
      detectChars += (description ? description.length : 0);
      const detStart = Date.now();
      detectedLanguage = await detectLanguageWithRetry(description, lang);
      detectDurationMs = Date.now() - detStart;
      if (detectedLanguage && detectedLanguage !== 'en') {
      // Traducción a inglés
      translationChars += (description ? description.length : 0);
      const fwdStart = Date.now();
      englishDescription = await translateTextWithRetry(description, detectedLanguage);
      forwardDurationMs = Date.now() - fwdStart;
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
    let requestBody = {
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
    let model = 'gpt5mini';
    if(model == 'gpt5mini'){
      requestBody = {
        model: "gpt-5-mini",
        messages: [{ role: "user", content: prompt }],
        reasoning_effort: "low" //minimal, low, medium, high
      };
    } 
    const diagnoseResponse = await callAiWithFailover(requestBody, sanitizedData.timezone, model, 0, dataRequest);
    let aiEndTime = Date.now();

    // Calcular costos y tokens para la llamada AI
    const usage = diagnoseResponse.data.usage;
    const costData = calculatePrice(usage, model);
    console.log(`💰 generateERQuestions - AI Call: $${formatCost(costData.totalCost)} (${costData.totalTokens} tokens, ${aiEndTime - aiStartTime}ms)`);
    // Guardar cost tracking multi-etapa
    try {
      const stages = [];
      if (detectChars > 0) {
        const detectCost = (detectChars / 1000000) * 10;
        stages.push({
          name: 'detect_language',
          cost: detectCost,
          tokens: { input: detectChars, output: detectChars, total: detectChars },
          model: 'translation_service',
          duration: detectDurationMs,
          success: true
        });
      }
      if (translationChars > 0) {
        const translationCost = (translationChars / 1000000) * 10;
        stages.push({
          name: 'translation',
          cost: translationCost,
          tokens: { input: translationChars, output: translationChars, total: translationChars },
          model: 'translation_service',
          duration: forwardDurationMs,
          success: true
        });
      }
      stages.push({
        name: 'ai_call',
        cost: costData.totalCost,
        tokens: { input: costData.inputTokens, output: costData.outputTokens, total: costData.totalTokens },
        model: model,
        duration: aiEndTime - aiStartTime,
        success: true
      });
      // reverseTranslationChars se calculará tras traducir preguntas
      var erStages = stages;
    } catch (costError) {
      console.error('Error guardando cost tracking (pre-reverse):', costError);
    }

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
      const content = diagnoseResponse.data.choices[0].message.content;
      questions = parseJsonWithFixes(content);

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
        reverseTranslationChars = questions.reduce((sum, q) => sum + (q ? q.length : 0), 0);
        const revStart = Date.now();
        questions = await Promise.all(
          questions.map(question => translateInvertWithRetry(question, detectedLanguage))
        );
        reverseDurationMs = Date.now() - revStart;
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

    // Añadir reverse_translation y guardar definitivamente
    try {
      if (reverseTranslationChars > 0) {
        const reverseCost = (reverseTranslationChars / 1000000) * 10;
        erStages.push({
          name: 'reverse_translation',
          cost: reverseCost,
          tokens: { input: reverseTranslationChars, output: reverseTranslationChars, total: reverseTranslationChars },
          model: 'translation_service',
          duration: reverseDurationMs,
          success: true
        });
      }
      const totalCost = erStages.reduce((s, st) => s + (st.cost || 0), 0);
      const totalTokens = {
        input: erStages.reduce((s, st) => s + (st.tokens?.input || 0), 0),
        output: erStages.reduce((s, st) => s + (st.tokens?.output || 0), 0),
        total: erStages.reduce((s, st) => s + (st.tokens?.total || 0), 0)
      };
      await CostTrackingService.saveCostRecord({
        myuuid: costTrackingData.myuuid,
        tenantId: costTrackingData.tenantId,
        subscriptionId: costTrackingData.subscriptionId,
        operation: 'emergency_questions',
        model: model,
        lang: costTrackingData.lang,
        timezone: costTrackingData.timezone,
        stages: erStages,
        totalCost,
        totalTokens,
        description: costTrackingData.description,
        status: 'success',
        iframeParams: costTrackingData.iframeParams,
        operationData: { }
      });
      // Resumen de costes
      const sumBy = (arr, key) => arr.reduce((s, x) => s + (x?.[key] || 0), 0);
      const group = (name, modelFilter) => erStages.filter(s => s.name === name && (!modelFilter || modelFilter(s.model)));
      const toSummary = (arr) => ({
        cost: sumBy(arr, 'cost'),
        tokens: arr.reduce((s, x) => s + (x?.tokens?.total || 0), 0),
        duration: sumBy(arr, 'duration')
      });
      const detectAzure = toSummary(group('detect_language', m => m === 'translation_service'));
      const transAzure = toSummary(group('translation', m => m === 'translation_service'));
      const revAzure = toSummary(group('reverse_translation', m => m === 'translation_service'));
      const aiCall = toSummary(group('ai_call'));
      console.log(`\n💰 RESUMEN DE COSTOS generateERQuestions:`);
      console.log(`   Detect language (Azure): $${formatCost(detectAzure.cost)} (${detectAzure.tokens} chars)`);
      console.log(`   Translation (Azure): $${formatCost(transAzure.cost)} (${transAzure.tokens} chars)`);
      console.log(`   AI Call: $${formatCost(aiCall.cost)} (${aiCall.tokens} tokens, ${aiCall.duration}ms)`);
      console.log(`   Reverse Translation (Azure): $${formatCost(revAzure.cost)} (${revAzure.tokens} chars)`);
    } catch (costError) {
      console.error('Error guardando cost tracking (final):', costError);
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

module.exports = {
  generateFollowUpQuestions,
  processFollowUpAnswers,
  generateERQuestions
}; 