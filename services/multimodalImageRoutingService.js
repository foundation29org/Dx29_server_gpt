'use strict';

const insights = require('./insights');
const CostTrackingService = require('./costTrackingService');
const { calculatePrice } = require('./costUtils');
const {
  extractDocument,
  failedDocumentResult,
  toPublicDocumentResult,
  mapWithConcurrency
} = require('./documentIntelligenceService');
const {
  classifyImage,
  fallbackClassification,
  isNotMedicalImage,
  shouldExtractDocumentText,
  shouldExtractMixedDocumentText
} = require('./multimodalImageClassifierService');
const {
  getImageClassifierConcurrency,
  getImageClassifierModel,
  getImageOcrMinChars
} = require('./multimodalImageRoutingConfig');
const {
  createUploadId,
  storeClassifiedImage,
  toDataUrl,
  toPublicImage
} = require('./multimodalUploadService');

// prebuilt-layout no acepta WEBP: intentar el OCR solo gasta un reintento.
const OCR_SUPPORTED_IMAGE_TYPES = Object.freeze([
  'image/jpeg',
  'image/png'
]);
const UPLOAD_CONCURRENCY = 2;

async function saveDocumentExtractionCost(documents, context, source) {
  const succeededDocuments = (documents || []).filter((document) =>
    document.status === 'succeeded'
  );
  const totalPagesProcessed = succeededDocuments.reduce(
    (total, document) => total + (document.pages || 0),
    0
  );
  if (totalPagesProcessed <= 0) {
    return;
  }

  const totalDurationMs = succeededDocuments.reduce(
    (total, document) => total + (document.durationMs || 0),
    0
  );
  const cost = (totalPagesProcessed / 1000) * 1.5;

  await CostTrackingService.saveCostRecordBestEffort({
    myuuid: context.myuuid || 'default-uuid',
    tenantId: context.tenantId,
    subscriptionId: context.subscriptionId,
    operation: 'multimodal_extract_document',
    model: 'document_intelligence',
    lang: context.lang || 'en',
    timezone: context.timezone || 'UTC',
    stages: [{
      name: 'document_intelligence',
      cost,
      tokens: { input: 0, output: 0, total: 0 },
      model: 'document_intelligence',
      duration: totalDurationMs,
      success: true
    }],
    totalCost: cost,
    totalTokens: { input: 0, output: 0, total: 0 },
    status: 'success',
    iframeParams: context.iframeParams || {},
    operationData: {
      source,
      correlationId: context.correlationId || '',
      totalPages: totalPagesProcessed,
      succeededDocuments: succeededDocuments.length,
      failedDocuments: (documents || []).filter(
        (document) => document.status === 'failed'
      ).length,
      retriedDocuments: (documents || []).filter(
        (document) => (document.attempts || 1) > 1
      ).length
    }
  }, {
    context: `multimodal ${source} document intelligence save`
  });
}

// Documento puro -> OCR sin imagen. Imagen mixta -> OCR + imagen. Imagen no
// médica -> se descarta. Imagen médica pura, duda, fallo del clasificador u
// OCR insuficiente -> visión.
async function classifyAndRouteImages(files, context) {
  return mapWithConcurrency(
    files,
    getImageClassifierConcurrency(),
    async (file) => {
      let classification;
      try {
        classification = await classifyImage(
          { url: toDataUrl(file.buffer, file.mimetype) },
          { timezone: context.timezone }
        );
      } catch (error) {
        classification = fallbackClassification(error);
        insights.error({
          message: 'Image classification failed; using direct vision fallback',
          error: error.message,
          mimeType: file.mimetype,
          correlationId: context.correlationId,
          tenantId: context.tenantId,
          subscriptionId: context.subscriptionId
        });
      }

      if (isNotMedicalImage(classification)) {
        return {
          file,
          classification,
          route: 'not_medical',
          useExtractedText: false,
          fallbackReason: null,
          extraction: null
        };
      }

      const isDocumentOnly = shouldExtractDocumentText(classification);
      const isMixedDocument = shouldExtractMixedDocumentText(classification);
      if (!isDocumentOnly && !isMixedDocument) {
        return {
          file,
          classification,
          route: 'vision',
          useExtractedText: false,
          fallbackReason: classification.error
            ? 'classification_failed'
            : null,
          extraction: null
        };
      }

      if (!OCR_SUPPORTED_IMAGE_TYPES.includes(file.mimetype)) {
        return {
          file,
          classification,
          route: 'vision',
          useExtractedText: false,
          fallbackReason: 'ocr_unsupported_type',
          extraction: null
        };
      }

      try {
        const extraction = await extractDocument({
          fileBuffer: file.buffer,
          originalName: file.originalname,
          mimeType: file.mimetype || 'application/octet-stream',
          size: file.size
        });
        const enoughText = extraction.content.trim().length >=
          getImageOcrMinChars();
        if (enoughText) {
          return {
            file,
            classification,
            route: isDocumentOnly ? 'ocr_text' : 'vision',
            useExtractedText: true,
            fallbackReason: null,
            extraction
          };
        }
        return {
          file,
          classification,
          route: 'vision',
          useExtractedText: false,
          fallbackReason: 'ocr_text_too_short',
          extraction
        };
      } catch (error) {
        insights.error({
          message: 'Document image OCR failed; using direct vision fallback',
          error: error.message,
          mimeType: file.mimetype,
          correlationId: context.correlationId,
          tenantId: context.tenantId,
          subscriptionId: context.subscriptionId
        });
        return {
          file,
          classification,
          route: 'vision',
          useExtractedText: false,
          fallbackReason: 'ocr_failed',
          extraction: failedDocumentResult(
            file.originalname,
            file.mimetype,
            'The document image could not be processed',
            error.attempts || 1,
            file.size
          )
        };
      }
    }
  );
}

async function saveImageClassificationCost(routedImages, context) {
  const billableResults = (routedImages || []).filter((result) =>
    result.classification?.usage
  );
  if (billableResults.length === 0) {
    return;
  }

  const totals = billableResults.reduce((aggregate, result) => {
    const model = result.classification.model ||
      getImageClassifierModel();
    const cost = calculatePrice(result.classification.usage, model);
    aggregate.cost += cost.totalCost;
    aggregate.input += cost.inputTokens;
    aggregate.output += cost.outputTokens;
    aggregate.total += cost.totalTokens;
    aggregate.duration += result.classification.durationMs || 0;
    return aggregate;
  }, {
    cost: 0,
    input: 0,
    output: 0,
    total: 0,
    duration: 0
  });
  const model = billableResults[0].classification.model ||
    getImageClassifierModel();

  await CostTrackingService.saveCostRecordBestEffort({
    myuuid: context.myuuid || 'default-uuid',
    tenantId: context.tenantId,
    subscriptionId: context.subscriptionId,
    operation: 'multimodal_detect_type',
    model,
    lang: context.lang || 'en',
    timezone: context.timezone || 'UTC',
    stages: [{
      name: 'image_classification',
      cost: totals.cost,
      tokens: {
        input: totals.input,
        output: totals.output,
        total: totals.total
      },
      model,
      duration: totals.duration,
      success: true
    }],
    totalCost: totals.cost,
    totalTokens: {
      input: totals.input,
      output: totals.output,
      total: totals.total
    },
    status: 'success',
    iframeParams: context.iframeParams || {},
    operationData: {
      correlationId: context.correlationId || '',
      totalImages: routedImages.length,
      documentTextRoutes: routedImages.filter(
        (result) => result.route === 'ocr_text'
      ).length,
      mixedOcrVisionRoutes: routedImages.filter(
        (result) => result.route === 'vision' &&
          result.useExtractedText === true
      ).length,
      visionRoutes: routedImages.filter(
        (result) => result.route === 'vision' &&
          result.useExtractedText !== true
      ).length,
      notMedicalRoutes: routedImages.filter(
        (result) => result.route === 'not_medical'
      ).length,
      unknownClassifications: routedImages.filter(
        (result) => result.classification.classification === 'unknown'
      ).length
    }
  }, {
    context: 'multimodal image classification save'
  });
}

// Imagen convertida a texto o descartada por no médica: aparece en la
// respuesta para que el cliente sepa qué se hizo con ella, pero no existe en
// blob ni tiene referencia reutilizable.
function unstoredImage(result) {
  return {
    uploadId: null,
    index: null,
    name: result.file.originalname,
    size: result.file.size,
    mimeType: result.file.mimetype,
    routing: result.route,
    diagnosticUse: false
  };
}

function toPublicImageRouting(result) {
  return {
    name: result.image.name,
    size: result.image.size,
    classification: result.classification.classification,
    confidence: result.classification.confidence,
    hasDocumentText: result.classification.hasDocumentText,
    hasMedicalVisual: result.classification.hasMedicalVisual,
    route: result.route,
    ocrTextUsed: result.useExtractedText === true,
    ocr: result.extraction
      ? toPublicDocumentResult(result.extraction)
      : null,
    fallbackReason: result.fallbackReason || null
  };
}

async function processUploadedImages({
  files = [],
  body,
  tenantId,
  subscriptionId,
  correlationId
}) {
  if (files.length === 0) {
    return {
      uploadId: null,
      visionImages: [],
      imageRouting: [],
      publicImages: [],
      imageDocumentAnalysis: ''
    };
  }

  const context = {
    myuuid: body.myuuid,
    tenantId,
    subscriptionId,
    lang: body.lang,
    timezone: body.timezone,
    iframeParams: body.iframeParams,
    correlationId
  };
  const routed = await classifyAndRouteImages(files, context);

  // Solo se guardan las imágenes que /diagnose volverá a necesitar. Una imagen
  // documental ya es texto dentro de la descripción: persistirla sería dejar
  // datos clínicos en blob sin ningún lector.
  const visionRouted = routed.filter((result) => result.route === 'vision');
  const uploadId = visionRouted.length > 0 ? createUploadId() : null;
  const storedImages = await mapWithConcurrency(
    visionRouted,
    UPLOAD_CONCURRENCY,
    (result, index) => storeClassifiedImage(result.file, {
      uploadId,
      index,
      routing: result.route,
      classification: result.classification
    }, context)
  );
  const storedByFile = new Map(
    visionRouted.map((result, position) => [result.file, storedImages[position]])
  );
  const imageRouting = routed.map((result) => ({
    ...result,
    image: storedByFile.get(result.file) || unstoredImage(result)
  }));

  const visionImages = storedImages;
  const imageTextResults = imageRouting
    .filter((result) =>
      result.useExtractedText === true &&
      result.extraction?.status === 'succeeded'
    );

  void saveImageClassificationCost(imageRouting, context).catch((error) => {
    insights.error({
      message: 'Error saving image classification cost',
      error: error.message,
      correlationId,
      tenantId,
      subscriptionId
    });
  });
  void saveDocumentExtractionCost(
    imageTextResults.map((result) => result.extraction),
    context,
    'document_image'
  ).catch((error) => {
    insights.error({
      message: 'Error saving document image extraction cost',
      error: error.message,
      correlationId,
      tenantId,
      subscriptionId
    });
  });

  return {
    uploadId,
    visionImages,
    imageRouting: imageRouting.map(toPublicImageRouting),
    publicImages: imageRouting.map((result) => toPublicImage(result.image)),
    imageDocumentAnalysis: imageTextResults
      .map((result, index) =>
        `--- ${result.route === 'vision' ? 'Imagen mixta' : 'Imagen documental'} ` +
        `${index + 1}: ${result.extraction.name} ---\n${result.extraction.content}`
      )
      .join('\n\n')
  };
}

module.exports = {
  processUploadedImages,
  saveDocumentExtractionCost
};
