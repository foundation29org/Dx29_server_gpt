const multer = require('multer');
const { default: createDocumentIntelligenceClient, getLongRunningPoller, isUnexpected } = require("@azure-rest/ai-document-intelligence");
const config = require('../../config');
const axios = require('axios');
const summarizeCtrl = require('../../services/summarizeService')
const blobFiles = require('../../services/blobFiles');
const insights = require('../../services/insights');
const serviceEmail = require('../../services/email');
const CostTrackingService = require('../../services/costTrackingService');
const { calculatePrice, formatCost } = require('../../services/costUtils');
const pubsubService = require('../../services/pubsubService');

// Configuración de multer para manejar archivos en memoria
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 20 * 1024 * 1024 // límite de 20MB
    },
    fileFilter: function (req, file, cb) {
        const allowedTypes = [
            // Documentos
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'text/plain',
            // Imágenes
            'image/jpeg',
            'image/png',
            'image/tiff',
            'image/bmp',
            'image/webp'
        ];
        
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error(`Tipo de archivo no soportado. Tipos permitidos: PDF, Word, Excel, TXT, JPG, PNG, TIFF, BMP, WEBP`));
        }
    }
});

function getHeader(req, name) {
    return req.headers[name.toLowerCase()];
}

const processDocument = async (fileBuffer, originalName, blobUrl) => {
    try {
        console.log('Iniciando procesamiento de documento:', originalName);
        console.log('Tamaño del archivo:', fileBuffer.length, 'bytes');
        console.log('URL del blob:', blobUrl);
        
        // Verificar si es un archivo de texto (.txt)
        const fileExtension = originalName.toLowerCase().split('.').pop();
        if (fileExtension === 'txt') {
            const textContent = fileBuffer.toString('utf-8');
            // Texto plano no usa Document Intelligence → 0 páginas cobrables
            return { content: textContent, pages: 0, duration: 0 };
        }
        
        // Para otros tipos de archivo, usar Azure Document Intelligence
        console.log('Usando Azure Document Intelligence para archivo:', fileExtension);
        const modelId = "prebuilt-layout";

        // Crear el cliente dentro de la función, igual que en el otro proyecto
        const clientIntelligence = createDocumentIntelligenceClient(
            config.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT,
            { key: config.AZURE_DOCUMENT_INTELLIGENCE_KEY }
        );

        console.log('Enviando solicitud a Azure Document Intelligence...');
        const startDi = Date.now();
        const initialResponse = await clientIntelligence
            .path("/documentModels/{modelId}:analyze", modelId)
            .post({
                contentType: "application/json",
                body: { urlSource: blobUrl },
                queryParameters: { outputContentFormat: "markdown" }
            });

        console.log('Respuesta inicial recibida:', initialResponse.status);

        if (isUnexpected(initialResponse)) {
            throw initialResponse.body.error;
        }

        console.log('Iniciando polling...');
        const poller = await getLongRunningPoller(clientIntelligence, initialResponse);
        console.log('Poller creado, esperando resultado...');
        
        const result = (await poller.pollUntilDone()).body;
        const duration = Date.now() - startDi;
        console.log('Análisis completado');

        if (result.status === 'failed') {
            console.error('Error in analyzing document:', result.error);
            throw new Error('Error processing the document after multiple attempts. Please try again with other document.');
        } else {
            console.log('Documento procesado exitosamente');
            const pages = Array.isArray(result?.analyzeResult?.pages) ? result.analyzeResult.pages.length : 1;
            return { content: result.analyzeResult.content, pages, duration };
        }
    } catch (error) {
        console.error('Error detallado procesando documento:', {
            message: error.message,
            code: error.code,
            innererror: error.innererror,
            stack: error.stack
        });
        throw new Error(`Error al procesar el documento: ${error.message}`);
    }
};

const processMultimodalInput = async (req, res) => {
    const subscriptionId = getHeader(req, 'x-subscription-id');
    const tenantId = getHeader(req, 'X-Tenant-Id');

    // Validar que al menos uno de los dos headers esté presente
    // APIM convierte Ocp-Apim-Subscription-Key a x-subscription-id, tenants envían X-Tenant-Id
    if (!tenantId && !subscriptionId) {
        insights.error({
            message: "Missing required headers: at least one of X-Tenant-Id or Ocp-Apim-Subscription-Key is required",
            headers: req.headers,
            endpoint: 'processMultimodalInput'
        });
        return res.status(400).send({
            result: "error",
            message: "Missing required headers: at least one of X-Tenant-Id or Ocp-Apim-Subscription-Key is required"
        });
    }
    
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
        // Configurar los campos específicos para Multer 2.x
        const uploadFields = upload.fields([
            { name: 'document', maxCount: 5 },  // Permitir hasta 5 documentos
            { name: 'image', maxCount: 5 }      // Permitir hasta 5 imágenes
        ]);

        uploadFields(req, res, async function(err) {
            if (err) {
                insights.error({
                    message: "Error en multer",
                    error: err.message,
                    tenantId: tenantId,
                    subscriptionId: subscriptionId,
                    requestInfo: requestInfo
                });
                return res.status(400).json({ error: err.message });
            }

            // userId está disponible después de que Multer haya procesado el multipart/form-data
            const userId = req.body.myuuid;

            // Actualizar requestInfo con el body parseado y timezone correcto
            requestInfo.body = req.body;
            requestInfo.timezone = req.body.timezone;

            // Log para debug - ver qué está llegando
            console.log('Body recibido:', {
                hasText: !!req.body.text,
                hasDocument: !!req.files?.document,
                hasImage: !!req.files?.image,
                bodyKeys: Object.keys(req.body),
                filesKeys: req.files ? Object.keys(req.files) : [],
                contentType: req.headers['content-type']
            });

            // Validar que al menos uno de los campos requeridos esté presente
            if (!req.body.text && !req.files?.document && !req.files?.image) {
                return res.status(400).json({ 
                    error: 'Se requiere al menos uno de los siguientes campos: text, document, o image' 
                });
            }

            let results = {
                textInput: req.body.text || '',
                documentAnalysis: null,
                imageAnalysis: null
            };

            // Procesar documento si existe
            if (req.files && req.files.document) {
                try {
                    let documentTexts = [];
                    let totalPagesProcessed = 0;
                    let totalDiDurationMs = 0;
                    let processedDocNames = [];
                    
                    // Procesar cada documento
                    for (let i = 0; i < req.files.document.length; i++) {
                        const fileBuffer = req.files.document[i].buffer;
                        const originalName = req.files.document[i].originalname;
                        
                        // Subir a Azure Blob
                        const blobUrl = await blobFiles.createBlobFile(fileBuffer, originalName, {
                            ...req.body,
                            tenantId: tenantId,
                            subscriptionId: subscriptionId
                        });
                        console.log(`Documento ${i + 1} subido a Azure Blob:`, blobUrl);
                        
                        // Procesar el documento
                        if (userId) {
                            await pubsubService.sendProgress(userId.toString(), 'extract_documents', 'Extracting documents...', 5);
                        }
                        const { content: documentText, pages, duration } = await processDocument(fileBuffer, originalName, blobUrl);
                        documentTexts.push(`--- Documento ${i + 1}: ${originalName} ---\n${documentText}`);
                        totalPagesProcessed += (pages || 0);
                        totalDiDurationMs += (duration || 0);
                        processedDocNames.push(originalName);
                    }
                    
                    // Combinar todos los documentos
                    results.documentAnalysis = documentTexts.join('\n\n');

                    // Guardar coste de Azure Document Intelligence (Layout)
                    if (totalPagesProcessed > 0) {
                        console.log('Pages processed:', totalPagesProcessed);
                        // Tarifa S0 Web/Contenedor Lectura: $1.50 por 1000 páginas (<1M)
                        const diCost = (totalPagesProcessed / 1000) * 1.5;
                        try {
                            await CostTrackingService.saveCostRecord({
                                myuuid: req.body.myuuid || 'default-uuid',
                                tenantId: tenantId,
                                subscriptionId: subscriptionId,
                                operation: 'multimodal_process_image',
                                model: 'document_intelligence',
                                lang: req.body.lang || 'en',
                                timezone: req.body.timezone || 'UTC',
                                stages: [{
                                    name: 'document_intelligence',
                                    cost: diCost,
                                    tokens: { input: 0, output: 0, total: 0 },
                                    model: 'document_intelligence',
                                    duration: totalDiDurationMs,
                                    success: true
                                }],
                                totalCost: diCost,
                                totalTokens: { input: 0, output: 0, total: 0 },
                                description: `Azure Document Intelligence: ${totalPagesProcessed} páginas — ${processedDocNames.join(', ')}`,
                                status: 'success',
                                iframeParams: req.body.iframeParams || {},
                                operationData: { totalPages: totalPagesProcessed, documents: processedDocNames }
                            });
                        } catch (ctErr) {
                            console.error('Error guardando coste de Document Intelligence:', ctErr.message);
                            insights.error({ message: 'Error guardando coste DI', error: ctErr.message, pages: totalPagesProcessed, tenantId, subscriptionId });
                        }
                    }
                } catch (error) {
                    let originalNames = '';
                    for (let i = 0; i < req.files.document.length; i++) {
                        originalNames += req.files.document[i].originalname + ', ';
                    }
                    insights.error({
                        message: "Error procesando documentos",
                        error: error.message,
                        originalName: originalNames,
                        tenantId: tenantId,
                        subscriptionId: subscriptionId,
                        requestInfo: requestInfo
                    });
                    throw error;
                }
            }

            // Procesar imagen si existe
            if (req.files && req.files.image) {
                try {
                    let imageAnalyses = [];
                    let imageUrls = [];
                    
                    // Procesar cada imagen
                    for (let i = 0; i < req.files.image.length; i++) {
                        const fileBuffer = req.files.image[i].buffer;
                        const originalName = req.files.image[i].originalname;
                        
                        // Subir a Azure Blob
                        const blobUrl = await blobFiles.createBlobFile(fileBuffer, originalName, {
                            ...req.body,
                            tenantId: tenantId,
                            subscriptionId: subscriptionId
                        });
                        console.log(`Imagen ${i + 1} subida a Azure Blob:`, blobUrl);
                        imageAnalyses.push(`Paciente con hallazgos de imagen médica:\n\n--- Imagen ${i + 1}: ${originalName} (${blobUrl}) ---\nHallazgos de imagen que requieren interpretación médica`);

                        imageUrls.push({name: originalName, url: blobUrl});
                    }
                    
                    // Combinar análisis de imágenes
                    results.imageAnalysis = imageAnalyses.join('\n\n');
                    results.imageUrls = imageUrls; // Guardar URLs para el frontend
                } catch (error) {
                    insights.error({
                        message: "Error procesando imagen",
                        error: error.message,
                        originalName: req.files.image[0].originalname,
                        tenantId: tenantId,
                        subscriptionId: subscriptionId,
                        requestInfo: requestInfo
                    });
                    throw error;
                }
            }

            // Combinar todos los inputs para el resumen
            // Usar:
            let combinedInput = '';
            if (results.textInput?.trim()) {
                combinedInput += `${results.textInput.trim()}\n\n`;
            }
            if (results.documentAnalysis?.trim()) {
                combinedInput += `${results.documentAnalysis.trim()}`;
            }
            if (!combinedInput.trim()) {
                combinedInput = 'No content was provided to analyze.';
            }

            // Crear un objeto request simulado para el servicio de summarize
            const mockReq = {
                body: {
                    description: combinedInput,
                    lang: req.body.lang || 'en',
                    myuuid: req.body.myuuid || 'default-uuid',
                    timezone: req.body.timezone || 'UTC'
                },
                headers: req.headers,
                get: (header) => req.headers[header],
                connection: { remoteAddress: req.ip },
                params: req.params,
                query: req.query
            };

            // Usar:
            let description = '';

            const hasPatient = !!results.textInput?.trim();
            const hasDoc = !!results.documentAnalysis?.trim();
            const hasImage = results.imageUrls?.length > 0;

            let descriptionImage = '';
            if(hasImage){
                const translateText = require('../../services/translation');
                const baseText = 'Patient with medical imaging findings that require diagnostic interpretation';
                try {
                    let endpoint =  {
                        name: 'westeurope',
                        url: 'https://api.cognitive.microsofttranslator.com',
                        key: config.translationKey, // West Europe
                        region: 'westeurope'
                      };
                    descriptionImage = await translateText.translateInvert(baseText, req.body.lang || 'en', endpoint);
                } catch (error) {
                    console.error('Error en translateInvert:', error);
                    // Fallback al texto original si falla la traducción
                    descriptionImage = baseText;
                }
            }

            if (hasPatient || hasDoc) {
                // Verificar si el combinedInput es lo suficientemente largo para justificar un resumen
                const combinedInputLength = combinedInput.trim().length;
                const minLengthForSummary = 1000; // Ajusta según necesites
                
                if (combinedInputLength > minLengthForSummary) {
                    // Si hay texto/documento largo, resumir primero
                    let summaryResult = null;
                    const captureRes = {
                        status: (code) => ({
                            send: (data) => {
                                if (code === 200) {
                                    summaryResult = data;
                                }
                            }
                        })
                    };
                    if (userId) {
                        await pubsubService.sendProgress(userId.toString(), 'summarize_input', 'Summarizing input...', 10);
                    }
                    await summarizeCtrl.summarize(mockReq, captureRes);
                    description = summaryResult.data.summary;
                } else {
                    // Si es corto, usar directamente el combinedInput
                    description = combinedInput;
                }
                
                // Si también hay imagen, añadirla
                if (hasImage) {
                    //description += '\n\n' + results.imageAnalysis;
                    description += '\n\n' + descriptionImage;
                }
            } else if (hasImage) {
                // Si solo hay imagen, usar análisis de imagen
                //description = results.imageAnalysis;
                description = descriptionImage;
            }
            
            // Llamar a diagnose con la descripción y URLs de imagen
            let model = 'gpt5mini';
            if(hasImage){
                model = 'gpt5';
            }

            let isImageOnly = false;
            if(!hasDoc && !hasPatient && hasImage){
                isImageOnly = true;
            }
            const diagnoseData = {
                description: description,
                diseases_list: "",
                myuuid: req.body.myuuid || 'default-uuid',
                lang: req.body.lang || 'en',
                timezone: req.body.timezone || 'UTC',
                model: model,
                iframeParams: req.body.iframeParams || {},
                imageUrls: results.imageUrls || [],
                isImageOnly: isImageOnly
            };
            const diagnoseResult = await callDiagnoses(diagnoseData, requestInfo);
            res.status(200).send({ result: 'processing', description: description, imageUrls: results.imageUrls || [], isImageOnly: isImageOnly });
            // Devolver resultado de diagnose
            /*return res.status(200).send({
                result: 'success',
                data: diagnoseResult.data,
                imageUrls: results.imageUrls || [],
                isImageOnly: isImageOnly,
                details: results,
                detectedLang: req.body.lang || 'en'
            });*/
            
        });
    } catch (error) {
        console.error('Error en processMultimodalInput:', error);
        
        insights.error({
            message: error.message || 'Unknown error in processMultimodalInput',
            stack: error.stack,
            code: error.code,
            timestamp: new Date().toISOString(),
            endpoint: 'processMultimodalInput',
            phase: error.phase || 'unknown',
            requestInfo: requestInfo,
            requestData: req.body,
            tenantId: tenantId,
            subscriptionId: subscriptionId
        });
        
        let infoError = {
            error: error.message,
            myuuid: req.body.myuuid
        };
        
        try {
            let lang = req.body.lang ? req.body.lang : 'en';
            await serviceEmail.sendMailErrorGPTIP(
                lang,
                'Multimodal input error',
                infoError,
                tenantId,
                subscriptionId
            );
        } catch (emailError) {
            console.error('Error sending error email:', emailError);
        }
        
        res.status(500).json({ error: 'Error procesando la entrada multimodal' });
    }
};

async function callDiagnoses(data, requestInfo) {
    const { diagnose } = require('../../services/helpDiagnose');
    
    // Crear un mock request para diagnose
    const mockReq = {
        body: {
            description: data.description,
            diseases_list: data.diseases_list || "",
            myuuid: data.myuuid,
            lang: data.lang,
            timezone: data.timezone || 'UTC',
            model: data.model || 'gpt5mini',
            iframeParams: data.iframeParams || {},
            imageUrls: data.imageUrls || []
        },
        headers: requestInfo.headers,
        get: (header) => requestInfo.headers[header.toLowerCase()],
        connection: { remoteAddress: requestInfo.ip },
        params: requestInfo.params,
        query: requestInfo.query
    };

    // Crear un mock response para capturar el resultado
    let diagnoseResult = null;
    const mockRes = {
        status: (code) => ({
            send: (data) => {
                if (code === 200) {
                    diagnoseResult = data;
                }
            }
        })
    };

    await diagnose(mockReq, mockRes);
    return diagnoseResult;
}

module.exports = {
    processMultimodalInput
}; 