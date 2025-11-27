const { translateInvertWithRetry, sanitizeInput, callAiWithFailover } = require('./aiUtils');
const { calculatePrice, formatCost, calculateAzureAIStudioCost } = require('./costUtils');
const CostTrackingService = require('./costTrackingService');
const serviceEmail = require('./email');
const blobOpenDx29Ctrl = require('./blobOpenDx29');
const insights = require('./insights');
const azureAIGenomicService = require('./azureAIGenomicService');
const { encodingForModel } = require("js-tiktoken");

// Asegúrate de copiar la función getHeader si es necesaria
function getHeader(req, name) {
  return req.headers[name.toLowerCase()];
}

function extractContent(tag, text) {
    const regex = new RegExp(`<${tag}>(.*?)</${tag}>`, 's');
    const match = text.match(regex);
    return match ? match[1].trim() : '';
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
    } else if (data.disease.length > 200) {
      errors.push({ field: 'disease', reason: 'Must not exceed 200 characters' });
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
  
    if (data.detectedLang !== undefined && (typeof data.detectedLang !== 'string' || data.detectedLang.length < 2 || data.detectedLang.length > 8)) {
      errors.push({ field: 'detectedLang', reason: 'Must be a valid language code (2-8 characters)' });
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
    let reverseTranslationChars = 0;
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
  
      const answerFormat = 'Return ONLY the HTML content without any introductory text, explanations, or markdown formatting. Use only <p>, <li>, </ul>, and <span> tags. Use <strong> for titles. Do not include any text before or after the HTML.';
  
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
                    const labelsChars = labelsToTranslate.reduce((sum, s) => sum + (s ? s.length : 0), 0);
                    reverseTranslationChars += labelsChars;
                    const translatedLabels = await Promise.all(
                      labelsToTranslate.map(label => translateInvertWithRetry(label, sanitizedData.detectedLang))
                    );
                    reverseTranslationEndTime = Date.now();
                    
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
              processedContent += `<p style="margin-top: 15px; padding: 10px; background-color: #f8f9fa; border-left: 4px solid #007bff; font-style: italic;">${disclaimerMessage}</p>`;
              
              // Traducir todo el contenido de una vez si es necesario
              if (sanitizedData.detectedLang !== 'en') {
                try {
                  reverseTranslationStartTime = Date.now();
                  reverseTranslationChars += (processedContent ? processedContent.length : 0);
                  processedContent = await translateInvertWithRetry(processedContent, sanitizedData.detectedLang);
                  reverseTranslationEndTime = Date.now();
                } catch (translationError) {
                  console.error('Translation error for processed content:', translationError);
                  insights.error({
                    message: 'Error traduciendo contenido procesado',
                    error: translationError.message,
                    disease: sanitizedData.disease,
                    tenantId: tenantId,
                    subscriptionId: subscriptionId
                  });
                }
              }
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
  
            // Guardar cost tracking (multi-etapa)
            try {
              // Añadir etapa de traducción inversa agregada si aplica
              if (reverseTranslationChars > 0) {
                const reverseCost = (reverseTranslationChars / 1000000) * 10;
                stages.push({
                  name: 'reverse_translation',
                  cost: reverseCost,
                  tokens: { input: reverseTranslationChars, output: reverseTranslationChars, total: reverseTranslationChars },
                  model: 'translation_service',
                  duration: (reverseTranslationEndTime && reverseTranslationStartTime) ? (reverseTranslationEndTime - reverseTranslationStartTime) : 0,
                  success: true
                });
              }
              const totalCost = stages.reduce((sum, st) => sum + (st.cost || 0), 0);
              const totalTokens = {
                input: stages.reduce((sum, st) => sum + (st.tokens?.input || 0), 0),
                output: stages.reduce((sum, st) => sum + (st.tokens?.output || 0), 0),
                total: stages.reduce((sum, st) => sum + (st.tokens?.total || 0), 0)
              };
              await CostTrackingService.saveCostRecord({
                myuuid: costTrackingData.myuuid,
                tenantId: costTrackingData.tenantId,
                subscriptionId: costTrackingData.subscriptionId,
                operation: 'info_disease',
                model: stages[0]?.model || 'azure_ai_studio',
                lang: costTrackingData.lang,
                timezone: costTrackingData.timezone,
                stages,
                totalCost,
                totalTokens,
                description: costTrackingData.description,
                status: 'success',
                iframeParams: costTrackingData.iframeParams,
                operationData: { detectedLanguage: costTrackingData.lang }
              });
              // Desglose de costos en consola
              console.log(`\n💰 RESUMEN DE COSTOS callInfoDisease (NHS Genomic):`);
              stages.forEach((stage, index) => {
                console.log(`   Etapa ${index + 1} - ${stage.name}: $${formatCost(stage.cost)} (${stage.tokens?.total || 0} tokens, ${stage.duration}ms, model=${stage.model})`);
              });
              console.log(`   ──────────────────────────`);
              console.log(`   TOTAL: $${formatCost(totalCost)} (${totalTokens.total} tokens)`);
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
      let requestBody = {
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
      
    let model = 'gpt4o';
    if(sanitizedData.imageUrls && sanitizedData.imageUrls.length > 0){
      model = 'gpt5';

      requestBody = {
        model: "gpt-5",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: prompt
              }
            ]
          }
        ],
        reasoning_effort: "low"
      };
      if (sanitizedData.imageUrls && sanitizedData.imageUrls.length > 0) {
        const imagePrompts = sanitizedData.imageUrls.map((image, index) => 
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
      }
    }

      aiStartTime = Date.now();
      const result = await callAiWithFailover(requestBody, sanitizedData.timezone, model, 0, dataRequest);
      aiEndTime = Date.now();
      // Calcular costos y tokens para la llamada AI
      const usage = result.data.usage;
      const costData = calculatePrice(usage, model);
      
      // Agregar etapa de IA
      stages.push({
        name: 'ai_call',
        cost: costData.totalCost,
        tokens: { input: costData.inputTokens, output: costData.outputTokens, total: costData.totalTokens },
        model: model,
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
  
      // Guardar cost tracking multi-etapa (AI + reverse_translation si aplica)
      try {
        if (sanitizedData.detectedLang !== 'en') {
          reverseTranslationStartTime = Date.now();
          const origLen = processedContent ? processedContent.length : 0;
          // Ya traducido arriba ➔ solo contamos caracteres
          reverseTranslationEndTime = Date.now();
          const reverseCost = (origLen / 1000000) * 10;
          if (origLen > 0) {
            stages.push({
              name: 'reverse_translation',
              cost: reverseCost,
              tokens: { input: origLen, output: origLen, total: origLen },
              model: 'translation_service',
              duration: reverseTranslationEndTime - reverseTranslationStartTime,
              success: true
            });
          }
        }
        const totalCost = stages.reduce((sum, st) => sum + (st.cost || 0), 0);
        const totalTokens = {
          input: stages.reduce((sum, st) => sum + (st.tokens?.input || 0), 0),
          output: stages.reduce((sum, st) => sum + (st.tokens?.output || 0), 0),
          total: stages.reduce((sum, st) => sum + (st.tokens?.total || 0), 0)
        };
        await CostTrackingService.saveCostRecord({
          myuuid: costTrackingData.myuuid,
          tenantId: costTrackingData.tenantId,
          subscriptionId: costTrackingData.subscriptionId,
          operation: 'info_disease',
          model: stages.find(s => s.name === 'ai_call')?.model || 'gpt4o',
          lang: costTrackingData.lang,
          timezone: costTrackingData.timezone,
          stages,
          totalCost,
          totalTokens,
          description: costTrackingData.description,
          status: 'success',
          iframeParams: costTrackingData.iframeParams,
          operationData: { detectedLanguage: costTrackingData.lang }
        });
        // Desglose de costos en consola
        console.log(`\n💰 RESUMEN DE COSTOS callInfoDisease (Differential):`);
        stages.forEach((stage, index) => {
          console.log(`   Etapa ${index + 1} - ${stage.name}: $${formatCost(stage.cost)} (${stage.tokens?.total || 0} tokens, ${stage.duration}ms, model=${stage.model})`);
        });
        console.log(`   ──────────────────────────`);
        console.log(`   TOTAL: $${formatCost(totalCost)} (${totalTokens.total} tokens)`);
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
          // Desglose de costos en consola (general)
          const totalCost = stages.reduce((sum, stage) => sum + (stage.cost || 0), 0);
          const totalTokens = stages.reduce((sum, stage) => sum + (stage.tokens?.total || 0), 0);
          console.log(`\n💰 RESUMEN DE COSTOS callInfoDisease (General):`);
          stages.forEach((stage, index) => {
            console.log(`   Etapa ${index + 1} - ${stage.name}: $${formatCost(stage.cost)} (${stage.tokens?.total || 0} tokens, ${stage.duration || 0}ms, model=${stage.model})`);
          });
          console.log(`   ──────────────────────────`);
          console.log(`   TOTAL: $${formatCost(totalCost)} (${totalTokens} tokens)`);
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

module.exports = {
  callInfoDisease
}; 