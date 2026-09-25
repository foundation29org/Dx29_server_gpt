const multer = require('multer');
const summarizeCtrl = require('../../services/summarizeService');
const insights = require('../../services/insights');
const serviceEmail = require('../../services/email');
const pubsubService = require('../../services/pubsubService');
const createLimitedMemoryStorage = require('../../services/limitedMemoryStorage');
const {
    DEFAULT_AI_MODEL,
    resolveDiagnoseModel
} = require('../../services/aiUtils');
const {
    MAX_DOCUMENT_FILES,
    MAX_FIELD_SIZE_BYTES,
    MAX_IMAGE_FILES,
    MAX_MULTIPART_PARTS,
    MAX_NON_FILE_FIELDS,
    MAX_TOTAL_UPLOAD_BYTES,
    SUPPORTED_DOCUMENT_TYPES,
    SUPPORTED_IMAGE_TYPES,
    UUID_PATTERN,
    getSuccessfulSummary,
    validateParsedMultimodalInput,
    validateUploadedFiles
} = require('../../services/multimodalInputValidation');
const {
    deleteUpload: deleteUploadImages,
    isValidUploadId,
    validateUploadReferenceFields
} = require('../../services/multimodalUploadService');
const {
    extractDocument,
    failedDocumentResult,
    toPublicDocumentResult,
    mapWithConcurrency,
    isRetryableDocumentError,
    LEGACY_WORD_MIME_TYPE,
    DEFAULT_CONCURRENCY
} = require('../../services/documentIntelligenceService');
const {
    processUploadedImages,
    saveDocumentExtractionCost
} = require('../../services/multimodalImageRoutingService');
const {
    CORRELATION_HEADER,
    ensureCorrelationId
} = require('../../services/requestCorrelation');

// Configuración de multer para manejar archivos en memoria
const upload = multer({
    storage: createLimitedMemoryStorage(),
    limits: {
        // Tope por archivo; el total combinado lo impone LimitedMemoryStorage.
        fileSize: MAX_TOTAL_UPLOAD_BYTES,
        fields: MAX_NON_FILE_FIELDS,
        fieldSize: MAX_FIELD_SIZE_BYTES,
        parts: MAX_MULTIPART_PARTS
    },
    fileFilter: function (req, file, cb) {
        const allowedTypes = [
            ...SUPPORTED_DOCUMENT_TYPES,
            ...SUPPORTED_IMAGE_TYPES
        ];
        
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error(`Tipo de archivo no soportado. Tipos permitidos: PDF, Word, Excel, TXT, JPG, PNG, WEBP`));
        }
    }
});

const uploadFields = upload.fields([
    { name: 'document', maxCount: MAX_DOCUMENT_FILES },
    { name: 'image', maxCount: MAX_IMAGE_FILES }
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

function getHeader(req, name) {
    return req.headers[name.toLowerCase()];
}

const PRODUCT_SUMMARY_MIN_CHARS = 1000;

// No corta el análisis: solo avisa. Document Intelligence no tiene timeout y
// el clasificador puede tardar ~6 min en el peor caso; sin datos reales de
// duración no se puede fijar un límite sin provocar falsos fallos.
const SLOW_ANALYSIS_ALERT_MS = 90000;

function startSlowAnalysisWatch(context) {
    const timer = setTimeout(() => {
        const upload = getUploadObservability(context.files);
        const elapsedMs = Date.now() - context.startedAt;
        insights.trackEvent('MultimodalAnalysisSlow', {
            correlationId: context.correlationId,
            tenantId: context.tenantId || '',
            subscriptionId: context.subscriptionId || '',
            ...upload.properties
        }, {
            elapsedMs,
            ...upload.measurements
        });
        Promise.resolve(serviceEmail.sendMailErrorGPTIP(
            context.lang || 'en',
            'Multimodal analysis still running after 90 s',
            {
                correlationId: context.correlationId,
                elapsedMs,
                ...upload.properties,
                ...upload.measurements
            },
            context.tenantId,
            context.subscriptionId
        )).catch((error) => {
            console.error('Error sending slow multimodal analysis email:', error);
        });
    }, SLOW_ANALYSIS_ALERT_MS);
    return () => clearTimeout(timer);
}

const REJECTION_FIELD_BY_CODE = Object.freeze({
    INVALID_UPLOAD_OWNER: 'myuuid'
});

// Cada análisis es un caso nuevo y crea su propio uploadId; las referencias
// a subidas anteriores solo tienen sentido en /diagnose y /disease/info.
function validateAnalyzeImageReferences(body) {
    const errors = [];
    if (body.uploadId !== undefined) {
        errors.push({
            field: 'uploadId',
            reason: 'Not accepted here: every analysis creates a new upload'
        });
    }
    validateUploadReferenceFields(body, errors);
    return errors;
}

function getUploadObservability(files = {}) {
    const documents = Array.isArray(files.document) ? files.document : [];
    const images = Array.isArray(files.image) ? files.image : [];
    const uploadedFiles = [...documents, ...images];
    const mimeTypes = uploadedFiles.reduce((counts, file) => {
        const mimeType = file.mimetype || 'unknown';
        counts[mimeType] = (counts[mimeType] || 0) + 1;
        return counts;
    }, {});
    return {
        properties: {
            uploadedMimeTypes: JSON.stringify(mimeTypes)
        },
        measurements: {
            uploadedBytes: uploadedFiles.reduce(
                (total, file) => total + (file.size || 0),
                0
            ),
            uploadedDocuments: documents.length,
            uploadedImages: images.length
        }
    };
}

function trackMultimodalInputRejected({
    correlationId,
    tenantId,
    subscriptionId,
    requestStartedAt,
    files,
    validationFields = [],
    phase = 'validation',
    code = ''
}) {
    const upload = getUploadObservability(files);
    insights.trackEvent('MultimodalInputRejected', {
        correlationId,
        tenantId: tenantId || '',
        subscriptionId: subscriptionId || '',
        validationFields: JSON.stringify(validationFields),
        phase,
        code,
        ...upload.properties
    }, {
        durationMs: Date.now() - requestStartedAt,
        validationErrors: validationFields.length,
        ...upload.measurements
    });
}

// Mide cuánto se usa el .doc antiguo para decidir si se deja de aceptar.
function trackLegacyWordDocument(file, context, startedAt, error) {
    if (file.mimetype !== LEGACY_WORD_MIME_TYPE) {
        return;
    }
    insights.trackEvent('LegacyWordDocumentProcessed', {
        correlationId: context.correlationId,
        tenantId: context.tenantId || '',
        subscriptionId: context.subscriptionId || '',
        status: error ? 'failed' : 'succeeded',
        errorCode: error?.code || ''
    }, {
        durationMs: Date.now() - startedAt,
        uploadedBytes: file.size || 0
    });
}

// Los documentos se procesan solo en memoria: nada los vuelve a leer después
// de extraer su texto, así que no se guardan en blob.
async function extractUploadedDocument(file, context) {
    const startedAt = Date.now();
    try {
        const result = await extractDocument({
            fileBuffer: file.buffer,
            originalName: file.originalname,
            mimeType: file.mimetype,
            size: file.size
        });
        trackLegacyWordDocument(file, context, startedAt);
        return result;
    } catch (error) {
        trackLegacyWordDocument(file, context, startedAt, error);
        insights.error({
            message: 'Document extraction failed',
            error: error.message,
            code: error.code,
            retryable: isRetryableDocumentError(error),
            mimeType: file.mimetype,
            correlationId: context.correlationId,
            tenantId: context.tenantId,
            subscriptionId: context.subscriptionId
        });
        return failedDocumentResult(
            file.originalname,
            file.mimetype,
            'The document could not be processed',
            error.attempts || 1,
            file.size
        );
    }
}

const processMultimodalInput = async (req, res) => {
    const requestStartedAt = Date.now();
    const correlationId = ensureCorrelationId(req, res);
    const subscriptionId = getHeader(req, 'x-subscription-id');
    const tenantId = getHeader(req, 'X-Tenant-Id');

    // Validar que al menos uno de los dos headers esté presente
    // APIM convierte Ocp-Apim-Subscription-Key a x-subscription-id, tenants envían X-Tenant-Id
    if (!tenantId && !subscriptionId) {
        trackMultimodalInputRejected({
            correlationId,
            tenantId,
            subscriptionId,
            requestStartedAt,
            files: req.files,
            validationFields: ['headers'],
            phase: 'headers',
            code: 'MISSING_AUTH_CONTEXT'
        });
        insights.error({
            message: "Missing required headers: at least one of X-Tenant-Id or Ocp-Apim-Subscription-Key is required",
            endpoint: 'processMultimodalInput',
            correlationId
        });
        return res.status(400).send({
            result: "error",
            message: "Missing required headers: at least one of X-Tenant-Id or Ocp-Apim-Subscription-Key is required",
            correlationId
        });
    }
    
    const requestInfo = {
        method: req.method,
        url: req.url,
        headers: {
            ...req.headers,
            [CORRELATION_HEADER]: correlationId
        },
        ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress,
        params: req.params,
        query: req.query
    };
    const safeRequestInfo = {
        method: req.method,
        url: req.url,
        origin: req.get('origin'),
        contentType: req.headers['content-type'],
        userAgent: req.headers['user-agent'],
        header_language: req.headers['accept-language'],
        correlationId
    };
    let stopSlowWatch = null;
    try {
        await parseMultipart(req, res);

            // userId está disponible después de que Multer haya procesado el multipart/form-data
            const userId = req.body.myuuid;

            // Actualizar requestInfo con el body parseado y timezone correcto
            safeRequestInfo.timezone = req.body.timezone;

            // Log para debug - ver qué está llegando
            console.log('Body recibido:', {
                hasText: !!req.body.text,
                hasDocument: !!req.files?.document,
                hasImage: !!req.files?.image,
                bodyKeys: Object.keys(req.body),
                filesKeys: req.files ? Object.keys(req.files) : [],
                contentType: req.headers['content-type']
            });

            const validationErrors = [
                ...validateParsedMultimodalInput(req.body, req.files),
                ...validateUploadedFiles(req.files),
                ...validateAnalyzeImageReferences(req.body)
            ];
            if (validationErrors.length > 0) {
                trackMultimodalInputRejected({
                    correlationId,
                    tenantId,
                    subscriptionId,
                    requestStartedAt,
                    files: req.files,
                    validationFields: validationErrors.map(
                        (error) => error.field
                    )
                });
                return res.status(400).json({
                    result: 'error',
                    error: 'Invalid multipart request',
                    details: validationErrors,
                    correlationId
                });
            }

            // SWA corta el POST de la web a los ~45 s. Validado el multipart,
            // se responde ya y el resultado (o el error) llega por Web PubSub,
            // igual que el diagnóstico.
            res.status(200).send({ result: 'processing', correlationId });
            stopSlowWatch = startSlowAnalysisWatch({
                correlationId,
                tenantId,
                subscriptionId,
                lang: req.body.lang,
                files: req.files,
                startedAt: requestStartedAt
            });

            let results = {
                textInput: req.body.text || '',
                documentAnalysis: null,
                imageDocumentAnalysis: null,
                uploadId: null,
                visionImages: [],
                imageRouting: [],
                publicImages: [],
                documents: []
            };

            // Extraer documentos tradicionales (PDF, DOC, DOCX, XLSX y TXT).
            if (req.files && req.files.document) {
                if (userId) {
                    await pubsubService.sendProgress(userId.toString(), 'extract_documents', 'Extracting documents...', 5);
                }
                const documentContext = {
                    body: req.body,
                    tenantId,
                    subscriptionId,
                    correlationId
                };
                results.documents = await mapWithConcurrency(
                    req.files.document,
                    DEFAULT_CONCURRENCY,
                    (file) => extractUploadedDocument(file, documentContext)
                );

                results.documentAnalysis = results.documents
                    .map((document, index) => (
                        document.status === 'succeeded' && document.content
                            ? `--- Documento ${index + 1}: ${document.name} ---\n${document.content}`
                            : null
                    ))
                    .filter(Boolean)
                    .join('\n\n');

                void saveDocumentExtractionCost(results.documents, {
                    myuuid: req.body.myuuid,
                    tenantId,
                    subscriptionId,
                    lang: req.body.lang,
                    timezone: req.body.timezone,
                    iframeParams: req.body.iframeParams,
                    correlationId
                }, 'uploaded_document').catch((error) => {
                    insights.error({
                        message: 'Error saving uploaded document extraction cost',
                        error: error.message,
                        tenantId,
                        subscriptionId,
                        correlationId
                    });
                });
            }

            // Documento puro -> OCR sin imagen. Imagen mixta -> OCR + imagen.
            // Imagen médica pura, desconocida o con OCR fallido -> visión.
            if ((req.files?.image || []).length > 0) {
                if (userId) {
                    await pubsubService.sendProgress(
                        userId.toString(),
                        'classify_images',
                        'Classifying images...',
                        7
                    );
                }
                const processedImages = await processUploadedImages({
                    files: req.files.image,
                    body: req.body,
                    tenantId,
                    subscriptionId,
                    correlationId
                });
                results = {
                    ...results,
                    ...processedImages
                };
            }

            // Combinar todos los inputs para el resumen
            const combinedInput = [
                results.textInput,
                results.documentAnalysis,
                results.imageDocumentAnalysis
            ]
                .map((value) => value?.trim())
                .filter(Boolean)
                .join('\n\n');

            const hasPatient = !!results.textInput?.trim();
            const hasDoc = !!(
                results.documentAnalysis?.trim() ||
                results.imageDocumentAnalysis?.trim()
            );
            const hasImage = results.visionImages.length > 0;
            const publicDocuments = (results.documents || []).map(toPublicDocumentResult);
            const publicImageRouting = results.imageRouting;
            const publicImages = results.publicImages;

            if (
                Array.isArray(req.files?.document) &&
                req.files.document.length > 0 &&
                !hasDoc &&
                !hasPatient &&
                !hasImage
            ) {
                const failedUpload = getUploadObservability(req.files);
                insights.trackEvent('MultimodalAnalysisFailed', {
                    correlationId,
                    tenantId: tenantId || '',
                    subscriptionId: subscriptionId || '',
                    phase: 'extract_documents',
                    statusCode: 400,
                    ...failedUpload.properties
                }, {
                    durationMs: Date.now() - requestStartedAt,
                    failedDocuments: publicDocuments.filter(
                        (document) => document.status === 'failed'
                    ).length,
                    documentRetryAttempts: publicDocuments.reduce(
                        (total, document) =>
                            total + Math.max(0, (document.attempts || 1) - 1),
                        0
                    ),
                    ...failedUpload.measurements
                });
                await pubsubService.sendError(
                    userId.toString(),
                    new Error('No document could be processed'),
                    'NO_DOCUMENT',
                    { correlationId }
                );
                return undefined;
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

            // Con solo imágenes la descripción queda vacía: Diagnose la acepta
            // porque llega con uploadId. El clasificador ve el texto real.
            let description = '';

            if (hasPatient || hasDoc) {
                const combinedInputLength = combinedInput.trim().length;
                const minLengthForSummary = PRODUCT_SUMMARY_MIN_CHARS;

                if (combinedInput.length > summarizeCtrl.MAX_SUMMARY_INPUT_CHARS) {
                    const tooLarge = new Error('The extracted text is too long to summarize');
                    tooLarge.phase = 'summarize_input';
                    tooLarge.httpStatus = 400;
                    tooLarge.code = 'INPUT_TOO_LARGE';
                    tooLarge.notifyTeam = true;
                    tooLarge.inputChars = combinedInput.length;
                    throw tooLarge;
                }

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
                // Solo si queda alguna imagen para visión; /diagnose vuelve a
                // filtrar por ruta al listar la subida.
                uploadId: hasImage ? results.uploadId : undefined,
                isImageOnly: isImageOnly,
                forceDiagnosis: req.body.forceDiagnosis === true
                    || req.body.forceDiagnosis === 'true'
            };
            await callDiagnoses(diagnoseData, requestInfo);
            const completedUpload = getUploadObservability(req.files);
            insights.trackEvent('MultimodalAnalysisCompleted', {
                correlationId,
                tenantId: tenantId || '',
                subscriptionId: subscriptionId || '',
                summarized,
                model,
                ...completedUpload.properties
            }, {
                durationMs: Date.now() - requestStartedAt,
                succeededDocuments: publicDocuments.filter(
                    (document) => document.status === 'succeeded'
                ).length,
                failedDocuments: publicDocuments.filter(
                    (document) => document.status === 'failed'
                ).length,
                documentRetryAttempts: publicDocuments.reduce(
                    (total, document) =>
                        total + Math.max(0, (document.attempts || 1) - 1),
                    0
                ),
                totalImages: publicImageRouting.length,
                documentImageRoutes: publicImageRouting.filter(
                    (image) => image.route === 'ocr_text'
                ).length,
                mixedImageRoutes: publicImageRouting.filter(
                    (image) => image.route === 'vision' && image.ocrTextUsed === true
                ).length,
                visionImageRoutes: publicImageRouting.filter(
                    (image) =>
                        image.route === 'vision' &&
                        image.ocrTextUsed !== true
                ).length,
                imageFallbacks: publicImageRouting.filter(
                    (image) => !!image.fallbackReason
                ).length,
                ...completedUpload.measurements
            });
            await pubsubService.sendPreprocessing(userId.toString(), {
                result: 'processing',
                description: description,
                uploadId: results.uploadId,
                images: publicImages,
                imageRouting: publicImageRouting,
                documents: publicDocuments,
                isImageOnly: isImageOnly,
                summarized: summarized,
                model: model,
                correlationId
            });
    } catch (error) {
        console.error('Error en processMultimodalInput:', {
            message: error.message,
            code: error.code,
            phase: error.phase || 'unknown',
            correlationId
        });
        
        insights.error({
            message: error.message || 'Unknown error in processMultimodalInput',
            stack: error.stack,
            code: error.code,
            timestamp: new Date().toISOString(),
            endpoint: 'processMultimodalInput',
            phase: error.phase || 'unknown',
            requestInfo: safeRequestInfo,
            correlationId,
            tenantId: tenantId,
            subscriptionId: subscriptionId
        });
        const statusCode = error.httpStatus === 400 ? 400 : 500;
        if (statusCode === 400) {
            trackMultimodalInputRejected({
                correlationId,
                tenantId,
                subscriptionId,
                requestStartedAt,
                files: req.files,
                validationFields: error.validationFields?.length
                    ? error.validationFields
                    : [REJECTION_FIELD_BY_CODE[error.code] || 'files'],
                phase: error.phase || 'unknown',
                code: error.code || ''
            });
        } else {
            insights.trackEvent('MultimodalAnalysisFailed', {
                correlationId,
                tenantId: tenantId || '',
                subscriptionId: subscriptionId || '',
                phase: error.phase || 'unknown',
                code: error.code || '',
                statusCode
            }, {
                durationMs: Date.now() - requestStartedAt
            });
        }

        let infoError = {
            error: error.message,
            code: error.code,
            phase: error.phase,
            inputChars: error.inputChars,
            files: Array.isArray(req.files) ? req.files.length : 0,
            myuuid: req.body?.myuuid,
            correlationId
        };
        
        if (statusCode === 500 || error.notifyTeam) {
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
        
        if (res.headersSent) {
            await pubsubService.sendError(
                String(req.body.myuuid),
                error,
                error.code || 'PROCESSING_ERROR',
                { correlationId }
            );
            return undefined;
        }
        return res.status(statusCode).json({
            result: 'error',
            error: statusCode === 400
                ? error.message
                : 'Error procesando la entrada multimodal',
            message: statusCode === 400
                ? error.message
                : 'Error procesando la entrada multimodal',
            code: error.code,
            correlationId
        });
    } finally {
        stopSlowWatch?.();
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
            ...(data.uploadId ? { uploadId: data.uploadId } : {}),
            ...(data.forceDiagnosis ? { forceDiagnosis: true } : {})
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
    if (diagnoseStatusCode === 400) {
        throw diagnoseRejection(diagnoseResult, data.description);
    }
    if (diagnoseStatusCode !== 200) {
        const error = new Error('The diagnosis request could not be started');
        error.phase = 'diagnose';
        throw error;
    }
    return diagnoseResult;
}

// Un 400 de Diagnose casi siempre es el contenido del paciente y no merece
// email. La excepción es un resumen de más de 8000 caracteres: lo genera
// nuestro propio resumen, así que sí hay que revisarlo.
function diagnoseRejection(result, description) {
    const details = Array.isArray(result?.details) ? result.details : [];
    const descriptionReasons = details
        .filter((detail) => detail?.field === 'description')
        .map((detail) => String(detail.reason || ''));
    const error = new Error('Diagnose rejected the request');
    error.phase = 'diagnose';
    error.httpStatus = 400;
    error.inputChars = typeof description === 'string' ? description.length : 0;
    error.validationFields = details.map((detail) => detail?.field).filter(Boolean);
    if (descriptionReasons.some((reason) => reason.startsWith('Must be at least'))) {
        error.code = 'DESCRIPTION_TOO_SHORT';
    } else if (descriptionReasons.some((reason) => reason.startsWith('Must not exceed'))) {
        error.code = 'SUMMARY_TOO_LONG';
        error.notifyTeam = true;
    } else {
        error.code = 'INVALID_DIAGNOSE_INPUT';
    }
    return error;
}

// DELETE /medical/upload/:uploadId
// El cliente lo llama al empezar un caso nuevo; si no llega, blobCleanup
// borra la subida a las 24 h. El myuuid es obligatorio porque forma parte del
// prefijo del blob: sin tenant + myuuid + uploadId no hay nada que borrar, y
// un atacante necesitaría los tres para tocar una subida ajena.
const deleteUpload = async (req, res) => {
    const correlationId = ensureCorrelationId(req, res);
    const subscriptionId = getHeader(req, 'x-subscription-id');
    const tenantId = getHeader(req, 'X-Tenant-Id');
    if (!tenantId && !subscriptionId) {
        return res.status(400).send({
            result: 'error',
            message: 'Missing required headers: at least one of X-Tenant-Id or Ocp-Apim-Subscription-Key is required',
            correlationId
        });
    }

    // Algunos proxies descartan el body de un DELETE: se admite también en query.
    const rawMyuuid = req.body?.myuuid ?? req.query?.myuuid;
    const myuuid = typeof rawMyuuid === 'string' ? rawMyuuid.trim() : '';
    const uploadId = req.params?.uploadId;
    const errors = [];
    if (!UUID_PATTERN.test(myuuid)) {
        errors.push({ field: 'myuuid', reason: 'A valid UUID is required' });
    }
    if (!isValidUploadId(uploadId)) {
        errors.push({ field: 'uploadId', reason: 'Must be a valid upload UUID' });
    }
    if (errors.length > 0) {
        return res.status(400).send({
            result: 'error',
            message: 'Invalid request format',
            errors,
            correlationId
        });
    }

    try {
        const { deleted } = await deleteUploadImages(uploadId, { myuuid, tenantId, subscriptionId });
        insights.trackEvent('MultimodalUploadDeleted', {
            correlationId,
            tenantId: tenantId || '',
            subscriptionId: subscriptionId || ''
        }, {
            deletedBlobs: deleted
        });
        return res.status(200).send({ result: 'success', deleted, correlationId });
    } catch (error) {
        insights.error({
            message: 'Error deleting multimodal upload',
            error: error.message,
            code: error.code,
            correlationId,
            tenantId,
            subscriptionId
        });
        return res.status(error.httpStatus || 500).send({
            result: 'error',
            message: error.httpStatus ? error.message : 'The upload could not be deleted',
            ...(error.code ? { code: error.code } : {}),
            correlationId
        });
    }
};

module.exports = {
    deleteUpload,
    processMultimodalInput
}; 