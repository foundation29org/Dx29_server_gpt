const multer = require('multer');
const config = require('../../config');
const summarizeCtrl = require('../../services/summarizeService');
const blobFiles = require('../../services/blobFiles');
const multimodalAssetService = require('../../services/multimodalAssetService');
const insights = require('../../services/insights');
const serviceEmail = require('../../services/email');
const CostTrackingService = require('../../services/costTrackingService');
const pubsubService = require('../../services/pubsubService');
const createLimitedMemoryStorage = require('../../services/limitedMemoryStorage');
const {
    DEFAULT_AI_MODEL,
    resolveDiagnoseModel
} = require('../../services/aiUtils');
const {
    getSuccessfulSummary,
    validateParsedMultimodalInput,
    validateUploadedFiles
} = require('../../services/multimodalInputValidation');
const {
    resolveImageReferences,
    validateImageReferenceFields
} = require('../../services/multimodalImageResolver');
const {
    extractDocument,
    failedDocumentResult,
    toPublicDocumentResult,
    mapWithConcurrency,
    isRetryableDocumentError
} = require('../../services/documentIntelligenceService');

// Configuración de multer para manejar archivos en memoria
const upload = multer({
    storage: createLimitedMemoryStorage(),
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

const uploadFields = upload.fields([
    { name: 'document', maxCount: 5 },
    { name: 'image', maxCount: 5 }
]);

function parseMultipart(req, res) {
    return new Promise((resolve, reject) => {
        uploadFields(req, res, (error) => {
            if (error) {
                error.phase = 'multipart';
                error.httpStatus = 400;
                reject(error);
                return;
            }
            resolve();
        });
    });
}

function parseAssetIds(value) {
    if (value === undefined || value === null || value === '') {
        return [];
    }
    if (Array.isArray(value)) {
        return value;
    }
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function getHeader(req, name) {
    return req.headers[name.toLowerCase()];
}

const PRODUCT_SUMMARY_MIN_CHARS = 1000;

async function extractUploadedDocument(file, context) {
    try {
        const blobUrl = await blobFiles.createBlobFile(file.buffer, file.originalname, {
            ...context.body,
            tenantId: context.tenantId,
            subscriptionId: context.subscriptionId
        }, file.mimetype);
        return await extractDocument({
            fileBuffer: file.buffer,
            originalName: file.originalname,
            mimeType: file.mimetype,
            blobUrl
        });
    } catch (error) {
        insights.error({
            message: 'Document extraction failed',
            error: error.message,
            code: error.code,
            retryable: isRetryableDocumentError(error),
            originalName: file.originalname,
            tenantId: context.tenantId,
            subscriptionId: context.subscriptionId
        });
        return failedDocumentResult(
            file.originalname,
            file.mimetype,
            'The document could not be processed',
            error.attempts || 1
        );
    }
}

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
        timezone: req.body?.timezone
    };
    try {
        await parseMultipart(req, res);

            // userId está disponible después de que Multer haya procesado el multipart/form-data
            const userId = req.body.myuuid;

            // Actualizar requestInfo con el body parseado y timezone correcto
            requestInfo.body = req.body;
            requestInfo.timezone = req.body.timezone;
            const assetIds = parseAssetIds(req.body.assetIds);
            if (assetIds === null) {
                return res.status(400).json({
                    result: 'error',
                    error: 'Invalid multipart request',
                    details: [{ field: 'assetIds', reason: 'Must be a JSON array' }]
                });
            }
            req.body.assetIds = assetIds;

            // Log para debug - ver qué está llegando
            console.log('Body recibido:', {
                hasText: !!req.body.text,
                hasDocument: !!req.files?.document,
                hasImage: !!req.files?.image,
                bodyKeys: Object.keys(req.body),
                filesKeys: req.files ? Object.keys(req.files) : [],
                contentType: req.headers['content-type']
            });

            const imageReferenceErrors = [];
            validateImageReferenceFields({ assetIds }, imageReferenceErrors);
            const newImageCount = Array.isArray(req.files?.image) ? req.files.image.length : 0;
            if (assetIds.length + newImageCount > 5) {
                imageReferenceErrors.push({
                    field: 'images',
                    reason: 'Existing and newly uploaded images must not exceed 5 items'
                });
            }
            const validationErrors = [
                ...validateParsedMultimodalInput(req.body, req.files),
                ...validateUploadedFiles(req.files),
                ...imageReferenceErrors
            ];
            if (validationErrors.length > 0) {
                return res.status(400).json({
                    result: 'error',
                    error: 'Invalid multipart request',
                    details: validationErrors
                });
            }

            const existingImageAssets = await resolveImageReferences(
                { assetIds },
                {
                    myuuid: req.body.myuuid,
                    tenantId,
                    subscriptionId
                }
            );
            let results = {
                textInput: req.body.text || '',
                documentAnalysis: null,
                imageAnalysis: null,
                imageUrls: existingImageAssets,
                documents: []
            };

            // Procesar documento si existe
            if (req.files && req.files.document) {
                if (userId) {
                    await pubsubService.sendProgress(userId.toString(), 'extract_documents', 'Extracting documents...', 5);
                }
                const documentContext = {
                    body: req.body,
                    tenantId,
                    subscriptionId
                };
                results.documents = await mapWithConcurrency(
                    req.files.document,
                    config.DOCUMENT_INTELLIGENCE_CONCURRENCY || 2,
                    (file) => extractUploadedDocument(file, documentContext)
                );

                const succeededDocuments = results.documents.filter((document) =>
                    document.status === 'succeeded' && document.content
                );
                results.documentAnalysis = results.documents
                    .map((document, index) => (
                        document.status === 'succeeded' && document.content
                            ? `--- Documento ${index + 1}: ${document.name} ---\n${document.content}`
                            : null
                    ))
                    .filter(Boolean)
                    .join('\n\n');

                const totalPagesProcessed = succeededDocuments.reduce(
                    (total, document) => total + (document.pages || 0),
                    0
                );
                const totalDiDurationMs = succeededDocuments.reduce(
                    (total, document) => total + (document.durationMs || 0),
                    0
                );
                if (totalPagesProcessed > 0) {
                    const diCost = (totalPagesProcessed / 1000) * 1.5;
                    const processedDocNames = succeededDocuments.map((document) => document.name);
                    try {
                        const documentIntelligenceCostRecord = {
                            myuuid: req.body.myuuid || 'default-uuid',
                            tenantId: tenantId,
                            subscriptionId: subscriptionId,
                            operation: 'multimodal_extract_document',
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
                            operationData: {
                                totalPages: totalPagesProcessed,
                                documents: processedDocNames,
                                failedDocuments: results.documents
                                    .filter((document) => document.status === 'failed')
                                    .map((document) => document.name)
                            }
                        };
                        void CostTrackingService.saveCostRecordBestEffort(documentIntelligenceCostRecord, {
                            context: 'multimodal document intelligence save'
                        });
                    } catch (ctErr) {
                        console.error('Error guardando coste de Document Intelligence:', ctErr.message);
                        insights.error({
                            message: 'Error guardando coste DI',
                            error: ctErr.message,
                            pages: totalPagesProcessed,
                            tenantId,
                            subscriptionId
                        });
                    }
                }
            }

            // Procesar imagen si existe
            if (req.files && req.files.image) {
                try {
                    let imageAnalyses = [];
                    let imageUrls = [...results.imageUrls];
                    
                    // Procesar cada imagen
                    for (let i = 0; i < req.files.image.length; i++) {
                        const fileBuffer = req.files.image[i].buffer;
                        const originalName = req.files.image[i].originalname;
                        
                        // Subir a Azure Blob
                        const blob = await blobFiles.createBlobFileWithMetadata(fileBuffer, originalName, {
                            ...req.body,
                            tenantId: tenantId,
                            subscriptionId: subscriptionId
                        }, req.files.image[i].mimetype);
                        let imageAsset;
                        try {
                            imageAsset = await multimodalAssetService.registerImageAsset(
                                blob,
                                req.files.image[i],
                                {
                                    myuuid: req.body.myuuid,
                                    tenantId,
                                    subscriptionId
                                }
                            );
                        } catch (registerError) {
                            insights.error({
                                message: 'Image uploaded but asset registry failed; continuing with current request SAS',
                                error: registerError.message,
                                originalName,
                                tenantId,
                                subscriptionId
                            });
                            imageAsset = {
                                name: originalName,
                                url: blob.url,
                                sasExpiresAt: blob.sasExpiresAt
                            };
                        }
                        const blobUrl = imageAsset.url;
                        console.log(`Imagen ${i + 1} subida a Azure Blob:`, originalName);
                        imageAnalyses.push(`Paciente con hallazgos de imagen médica:\n\n--- Imagen ${i + 1}: ${originalName} ---\nHallazgos de imagen que requieren interpretación médica`);

                        imageUrls.push(imageAsset);
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

            const hasPatient = !!results.textInput?.trim();
            const hasDoc = !!results.documentAnalysis?.trim();
            const hasImage = results.imageUrls?.length > 0;
            const publicDocuments = (results.documents || []).map(toPublicDocumentResult);

            if (
                Array.isArray(req.files?.document) &&
                req.files.document.length > 0 &&
                !hasDoc &&
                !hasPatient &&
                !hasImage
            ) {
                return res.status(400).json({
                    result: 'error',
                    error: 'No document could be processed',
                    documents: publicDocuments
                });
            }

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

            let description = '';

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
                const combinedInputLength = combinedInput.trim().length;
                const minLengthForSummary = PRODUCT_SUMMARY_MIN_CHARS;

                if (combinedInputLength > minLengthForSummary) {
                    // Si hay texto/documento largo, resumir primero
                    let summaryResult = null;
                    let summaryStatusCode = null;
                    const captureRes = {
                        status: (code) => ({
                            send: (data) => {
                                summaryStatusCode = code;
                                summaryResult = data;
                            }
                        })
                    };
                    if (userId) {
                        await pubsubService.sendProgress(userId.toString(), 'summarize_input', 'Summarizing input...', 10);
                    }
                    await summarizeCtrl.summarize(mockReq, captureRes);
                    description = getSuccessfulSummary(summaryResult, summaryStatusCode);
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
            
            const summarized = (hasPatient || hasDoc) && combinedInput.trim().length > PRODUCT_SUMMARY_MIN_CHARS;
            const model = resolveDiagnoseModel(req.body.model);

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
                assetIds: (results.imageUrls || [])
                    .map((image) => image.assetId)
                    .filter(Boolean),
                isImageOnly: isImageOnly
            };
            await callDiagnoses(diagnoseData, requestInfo);
            res.status(200).send({
                result: 'processing',
                description: description,
                imageUrls: results.imageUrls || [],
                documents: publicDocuments,
                isImageOnly: isImageOnly,
                summarized: summarized,
                model: model
            });
            // Devolver resultado de diagnose
            /*return res.status(200).send({
                result: 'success',
                data: diagnoseResult.data,
                imageUrls: results.imageUrls || [],
                isImageOnly: isImageOnly,
                details: results,
                detectedLang: req.body.lang || 'en'
            });*/
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
        
        const statusCode = error.httpStatus === 400 ? 400 : 500;
        let infoError = {
            error: error.message,
            myuuid: req.body?.myuuid
        };
        
        if (statusCode === 500) {
            try {
                let lang = req.body?.lang ? req.body.lang : 'en';
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
        }
        
        if (!res.headersSent) {
            return res.status(statusCode).json({
                result: 'error',
                error: statusCode === 400
                    ? error.message
                    : 'Error procesando la entrada multimodal',
                message: statusCode === 400
                    ? error.message
                    : 'Error procesando la entrada multimodal',
                code: error.code
            });
        }
        return undefined;
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
            model: data.model || DEFAULT_AI_MODEL,
            iframeParams: data.iframeParams || {},
            imageUrls: data.imageUrls || [],
            assetIds: data.assetIds || []
        },
        headers: requestInfo.headers,
        get: (header) => requestInfo.headers[header.toLowerCase()],
        connection: { remoteAddress: requestInfo.ip },
        params: requestInfo.params,
        query: requestInfo.query
    };

    // Crear un mock response para capturar el resultado
    let diagnoseResult = null;
    let diagnoseStatusCode = null;
    const mockRes = {
        status: (code) => ({
            send: (data) => {
                diagnoseStatusCode = code;
                diagnoseResult = data;
            }
        })
    };

    await diagnose(mockReq, mockRes);
    if (diagnoseStatusCode !== 200) {
        const error = new Error('The diagnosis request could not be started');
        error.phase = 'diagnose';
        throw error;
    }
    return diagnoseResult;
}

module.exports = {
    processMultimodalInput
}; 