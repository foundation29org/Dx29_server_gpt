const multer = require('multer');
const { default: createDocumentIntelligenceClient, getLongRunningPoller, isUnexpected } = require("@azure-rest/ai-document-intelligence");
const config = require('../../config');
const axios = require('axios');
const summarizeCtrl = require('../../services/summarizeService')
const blobFiles = require('../../services/blobFiles');
const insights = require('../../services/insights');
const blobOpenDx29Ctrl = require('../../services/blobOpenDx29');
const serviceEmail = require('../../services/email');
const CostTrackingService = require('../../services/costTrackingService');
const { calculatePrice, formatCost } = require('../../services/costUtils');

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

// Función de delay para retry
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Endpoints para gpt-5
const gpt5ImagesEndpoints = [
    `${config.API_MANAGEMENT_BASE}/eu1/call/gpt-5`, // Suiza
    `${config.API_MANAGEMENT_BASE}/us2/call/gpt-5`  // EastUS2
];

// Función para llamar a gpt-5 con failover
async function callGptImagesWithFailover(requestBody, retryCount = 0) {
    const RETRY_DELAY = 1000;

    try {
        const response = await axios.post(gpt5ImagesEndpoints[retryCount], requestBody, {
            headers: {
                'Content-Type': 'application/json',
                'Ocp-Apim-Subscription-Key': config.API_MANAGEMENT_KEY,
            }
        });
        return response;
    } catch (error) {
        console.error('Error completo en detectTypeDoc:', {
            message: error.message,
            status: error.response?.status,
            statusText: error.response?.statusText,
            data: error.response?.data,
            requestBody: requestBody
          });
          throw error;
    }
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
            return textContent;
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
        console.log('Análisis completado');

        if (result.status === 'failed') {
            console.error('Error in analyzing document:', result.error);
            throw new Error('Error processing the document after multiple attempts. Please try again with other document.');
        } else {
            console.log('Documento procesado exitosamente');
            return result.analyzeResult.content;
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

/**
 * Clasifica una imagen médica en:
 *   radiograph | ct | mri | ultrasound | ecg | clinical_photo | text_document | other
 * Devuelve siempre el string en minúsculas.
 */
const detectTypeDoc = async (base64Image, costTrackingData = null, blobUrl = null) => {
  
    // Prompt MUY conciso: queremos ahorrar tokens y forzar una respuesta única.
    const promptClassifier = `
  You are a medical triage assistant.
  
  Classify the uploaded image into exactly one of these categories (lower-case):
  - radiograph         (plain X-ray images)
  - ct                 (computed tomography)
  - mri                (magnetic resonance imaging)
  - ultrasound         (ultrasound / echography)
  - ecg                (electrocardiogram traces)
  - face_photo         (photographs where the main focus is the patient's face, especially for dysmorphic features or genetic syndromes)
  - clinical_photo     (photographs of other body parts, skin, wounds, lesions, but NOT the face as main focus)
  - text_document      (scanned or photographed medical documents)
  - other              (anything else)
  
  Respond with ONLY the category word, no explanation, no punctuation.
  `.trim();
  
    try {
        const requestBody = {
            model: "gpt-5",
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: promptClassifier
                  },
                  {
                    type: "image_url",
                    image_url: {
                      url: blobUrl
                    }
                  }
                ]
              }
            ],
            reasoning_effort: "low"
          };

      let aiStartTime = Date.now();
      const { data } = await callGptImagesWithFailover(requestBody);
      let aiEndTime = Date.now();

      // Cost tracking para detectTypeDoc
      if (costTrackingData) {
        try {
          const usage = data.usage;
          const costData = calculatePrice(usage, 'gpt5mini');
          console.log(`💰 detectTypeDoc - AI Call: $${formatCost(costData.totalCost)} (${costData.totalTokens} tokens, ${aiEndTime - aiStartTime}ms)`);

          const aiStage = {
            name: 'ai_call',
            cost: costData.totalCost,
            tokens: { input: costData.inputTokens, output: costData.outputTokens, total: costData.totalTokens },
            model: 'gpt5mini',
            duration: aiEndTime - aiStartTime,
            success: true
          };
          await CostTrackingService.saveSimpleOperationCost(
            costTrackingData,
            'multimodal_detect_type',
            aiStage,
            'success'
          );
        } catch (costError) {
          console.error('Error guardando cost tracking para detectTypeDoc:', costError);
        }
      }
      // Azure devuelve un array "output" con elementos type === "message"
      const raw = data.choices[0].message.content.trim().toLowerCase();
  
      // Validamos la salida para evitar sorpresas
      const valid = ["radiograph", "ct", "mri", "ultrasound", "ecg", "clinical_photo", "face_photo", "text_document", "other"];
      if (!raw || !valid.includes(raw)) {
        throw new Error(`Unexpected category: ${raw}`);
      }
      return raw; // ← la categoría final
    } catch (err) {
      console.error("Error classifying image:", err);
      throw new Error("Failed to detect image type");
    }
  };



const processImage = async (blobUrl, promptImage, effort, costTrackingData = null) => {
    try {
        const requestBody = {
            model: "gpt-5",
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: promptImage
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: blobUrl
                            }
                        }
                    ]
                }
            ],
            reasoning_effort: "low"
        };

        let aiStartTime = Date.now();
        const response = await callGptImagesWithFailover(requestBody);
        let aiEndTime = Date.now();

        // Cost tracking para processImage
        if (costTrackingData) {
          try {
            const usage = response.data.usage;
            const costData = calculatePrice(usage, 'gpt5mini');
            console.log(`💰 processImage - AI Call: $${formatCost(costData.totalCost)} (${costData.totalTokens} tokens, ${aiEndTime - aiStartTime}ms)`);

            const aiStage = {
              name: 'ai_call',
              cost: costData.totalCost,
              tokens: { input: costData.inputTokens, output: costData.outputTokens, total: costData.totalTokens },
              model: 'gpt5mini',
              duration: aiEndTime - aiStartTime,
              success: true
            };
            await CostTrackingService.saveSimpleOperationCost(
              costTrackingData,
              'multimodal_process_image',
              aiStage,
              'success'
            );
          } catch (costError) {
            console.error('Error guardando cost tracking para processImage:', costError);
          }
        }

        
        
        // Buscar el elemento de tipo "message" en el output
        const messageElement = response.data.choices[0].message.content;
        if (messageElement) {
            return messageElement; // ← Cambio aquí: devolver directamente el contenido
        } else {
            throw new Error('No se encontró el contenido de la respuesta');
        }
    } catch (error) {
        console.error('Error procesando imagen con Azure OpenAI:', error);
        throw new Error('Error al procesar la imagen');
    }
};

const processMultimodalInput = async (req, res) => {
    const subscriptionId = getHeader(req, 'x-subscription-id');
    const tenantId = getHeader(req, 'X-Tenant-Id');
    
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
                        const documentText = await processDocument(fileBuffer, originalName, blobUrl);
                        documentTexts.push(`--- Documento ${i + 1}: ${originalName} ---\n${documentText}`);
                    }
                    
                    // Combinar todos los documentos
                    results.documentAnalysis = documentTexts.join('\n\n');
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

            // Variables para cost tracking
            const costTrackingData = {
                myuuid: req.body.myuuid || 'default-uuid',
                tenantId: tenantId,
                subscriptionId: subscriptionId,
                lang: req.body.lang || 'es',
                timezone: req.body.timezone || 'UTC',
                description: `${req.body.text ? req.body.text.substring(0, 100) + '...' : 'Multimodal input'} - Process multimodal`,
                iframeParams: req.body.iframeParams || {}
            };

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
                        
                        const base64Image = fileBuffer.toString("base64");
                        
                        // Detectar el tipo de imagen
                        const typeImage = await detectTypeDoc(base64Image, costTrackingData, blobUrl);
                        console.log(`Tipo de imagen ${i + 1}:`, typeImage);
                        let imageAnalysis = '';
                        switch (typeImage) {
                            case "radiograph":
                                let promptRadiology = `
                                **Task – two stages (no diagnosis):**
                                1️⃣ Identify imaging modality:
                                • X-ray → state projection (PA, lateral, oblique…)
                                • CT or MRI → state plane (axial, coronal, sagittal) and sequence/phase
                                • Ultrasound → state view (longitudinal, transverse, apical four-chamber…)
                                • Otherwise say "uncertain modality"
                                2️⃣ For **each anatomical region** list:
                                • normal structures visible
                                • abnormal radiographic features (opacity, fractures, devices, artefacts, masses…)

                                **Hard rules – must be obeyed:**
                                - ✅ Output ONLY the two section headers exactly:
                                "Imaging Identification"
                                "Radiographic Findings"
                                - ❌ NO section named diagnosis, impression, assessment, conclusión…
                                - ❌ Do NOT name diseases (pneumonia, effusion, tumour…). Describe appearances only
                                (e.g. "homogeneous left-sided opacity").
                                - If uncertain, write "uncertain" rather than propose a disease.
                                - Keep total length ≤ 150 words.
                                `.trim();
                                if (results.textInput && results.textInput.trim() !== '') {
                                    promptRadiology += `\n\nAdditional patient description provided by the user:\n"${results.textInput.trim()}"\nUse this information to help inform your analysis.`;
                                }
                                imageAnalysis = await processImage(blobUrl, promptRadiology, "high", costTrackingData);
                                break;
                            case "ct":
                                let promptCT = `
                                **Task – two stages (no diagnosis)**  
                                1️⃣ **Imaging Identification**  
                                • Confirm modality is CT (computed tomography).  
                                • State acquisition plane(s) shown (axial, coronal, sagittal, 3-D MPR…).  
                                • Mention contrast phase if recognizable (non-contrast, arterial, venous, delayed) or "uncertain phase".  
                                • Note slice thickness or kernel only if obvious (e.g. bone algorithm).  

                                2️⃣ **For each anatomical region imaged** list:  
                                • normal structures visualised;  
                                • abnormal tomographic features (high/low density areas, masses, fluid collections, calcifications, air, fractures, devices, artefacts…).  

                                **Hard rules – must be obeyed**  
                                - ✅ Output **ONLY** the two section headers (verbatim, case-sensitive):  
                                **Imaging Identification**  
                                **Tomographic Findings**  
                                - ❌ Do **NOT** include any section or line labelled diagnosis, impression, assessment, conclusión, posibles diagnósticos, etc.  
                                - ❌ Do **NOT** name diseases, pathologies, or clinical conditions (e.g. appendicitis, PE, metastasis).  
                                Describe appearances only (e.g. "focal high-density crescent adjacent to skull inner table").  
                                - If uncertain, write **"uncertain"** rather than propose a disease.  
                                - Keep total length ≤ 150 words.
                                `.trim();
                                if (results.textInput && results.textInput.trim() !== '') {
                                    promptCT += `\n\nAdditional patient description provided by the user:\n"${results.textInput.trim()}"\nUse this information to help inform your analysis.`;
                                }
                                imageAnalysis = await processImage(blobUrl, promptCT, "high", costTrackingData);
                                break;
                            case "mri":
                                let promptMRI = `
                                **Task – two stages (no diagnosis)**  
                                1️⃣ **Imaging Identification**  
                                • Confirm modality is MRI (magnetic resonance imaging).  
                                • Specify main sequence(s) seen (T1-w, T2-w, FLAIR, DWI, GRE, etc.).  
                                • State acquisition plane(s) (axial, coronal, sagittal) and contrast use if obvious  
                                    (pre-contrast, post-gadolinium, or "uncertain").  

                                2️⃣ **For each anatomical region imaged** list:  
                                • normal structures visualised;  
                                • abnormal MR features (signal intensities, mass effect, edema, enhancement, restricted diffusion, susceptibility, devices, artefacts…).  

                                **Hard rules – must be obeyed**  
                                - ✅ Output **ONLY** the two section headers (verbatim, case-sensitive):  
                                **Imaging Identification**  
                                **MR Findings**  
                                - ❌ Do **NOT** include any section or line labelled diagnosis, impression, assessment, conclusión, posibles diagnósticos, etc.  
                                - ❌ Do **NOT** name diseases or clinical conditions (e.g. multiple sclerosis, tumour, infarct).  
                                Describe appearances only (e.g. "hyperintense lesion on T2 with mild mass effect").  
                                - If uncertain, write **"uncertain"** rather than propose a disease.  
                                - Keep total length ≤ 150 words.
                                `.trim();
                                if (results.textInput && results.textInput.trim() !== '') {
                                    promptMRI += `\n\nAdditional patient description provided by the user:\n"${results.textInput.trim()}"\nUse this information to help inform your analysis.`;
                                }
                                imageAnalysis = await processImage(blobUrl, promptMRI, "high", costTrackingData);
                                break;
                            case "ultrasound":
                                let promptUltrasound = `
                                **Task – two stages (no diagnosis)**  
                                1️⃣ **Imaging Identification**  
                                • Confirm modality is ultrasound.  
                                • Specify view or window (e.g. subcostal four-chamber, longitudinal RUQ, transverse thyroid).  
                                • Indicate mode(s) used if identifiable (B-mode, Color Doppler, M-mode).  
                                2️⃣ **For each scanned region** list:  
                                • normal structures seen;  
                                • abnormal sonographic features (heterogeneous echotexture, anechoic fluid, shadowing, Doppler aliasing, devices, artefacts…).

                                **Hard rules – must be obeyed**  
                                - ✅ Output **ONLY** the two section headers (verbatim, case-sensitive):  
                                **Imaging Identification**  
                                **Sonographic Findings**  
                                - ❌ Do **NOT** include any section or line labelled diagnosis, impression, assessment, conclusión, posibles diagnósticos, etc.  
                                - ❌ Do **NOT** name diseases, pathologies, or clinical conditions (e.g. cholecystitis, DVT, carcinoma).  
                                Describe appearances only (e.g. "well-defined round anechoic lesion with posterior enhancement").  
                                - If uncertain, write **"uncertain"** rather than propose a disease.  
                                - Keep total length ≤ 150 words.
                                `.trim();   
                                if (results.textInput && results.textInput.trim() !== '') {
                                    promptUltrasound += `\n\nAdditional patient description provided by the user:\n"${results.textInput.trim()}"\nUse this information to help inform your analysis.`;
                                }
                                imageAnalysis = await processImage(blobUrl, promptUltrasound, "high", costTrackingData);
                                break;
                            case "ecg":
                                let promptECG = `
                                **Task – two stages (no diagnosis)**  
                                1️⃣ **ECG Identification**  
                                   • Confirm modality is ECG.  
                                   • State type (12-lead, rhythm strip, telemetry snapshot).  
                                   • Note paper speed if visible (25 mm/s, 50 mm/s) and calibration (10 mm/mV).  
                                   • List the leads displayed (e.g. I, II, III, V1–V6) or say "uncertain leads".  
                                
                                2️⃣ **For the waveform displayed** list:  
                                   • normal features observed (regular rhythm, narrow QRS, upright T in lead II, etc.);  
                                   • abnormal waveform features (irregular R-R intervals, prolonged PR, wide QRS, ST-segment elevation/depression, T-wave inversion, pathologic Q waves, pacemaker spikes, artefacts…).  
                                
                                **Hard rules – must be obeyed**  
                                - ✅ Output **ONLY** the two section headers (verbatim, case-sensitive):  
                                  **ECG Identification**  
                                  **ECG Findings**  
                                - ❌ Do **NOT** include any section or line labelled diagnosis, impression, assessment, conclusión, posibles diagnósticos, etc.  
                                - ❌ Do **NOT** name diseases or clinical conditions (e.g. atrial fibrillation, myocardial infarction, bundle-branch block).  
                                  Describe appearances only (e.g. "irregularly irregular rhythm", "ST-segment elevation 2 mm in V2–V3").  
                                - If uncertain, write **"uncertain"** rather than propose a disease.  
                                - Keep total length ≤ 150 words.
                                `.trim();
                                if (results.textInput && results.textInput.trim() !== '') {
                                    promptECG += `\n\nAdditional patient description provided by the user:\n"${results.textInput.trim()}"\nUse this information to help inform your analysis.`;
                                }
                                imageAnalysis = await processImage(blobUrl, promptECG, "high", costTrackingData);
                                break;
                            case "clinical_photo":
                                let promptClinicalPhoto = `
                                **Task – two stages (no diagnosis)**  
                                1️⃣ **Photo Identification**  
                                   • Confirm modality is a clinical photograph.  
                                   • Specify body region and orientation (e.g. dorsal right hand, anterior face) if discernible.  
                                   • Mention lighting (natural, flash) and presence/absence of scale marker or ruler.  
                                
                                2️⃣ **For the region shown** list:  
                                   • normal visible structures (skin creases, nails, hair, surrounding tissue…);  
                                   • abnormal visible features (color change, swelling, ulceration, rash pattern, mass, discharge, scar, devices, foreign bodies, artefacts…).  
                                
                                **Hard rules – must be obeyed**  
                                - ✅ Output **ONLY** the two section headers (verbatim, case-sensitive):  
                                  **Photo Identification**  
                                  **Photo Findings**  
                                - ❌ Do **NOT** include any section or line labelled diagnosis, impression, assessment, conclusión, posibles diagnósticos, etc.  
                                - ❌ Do **NOT** name diseases or clinical conditions (e.g. psoriasis, cellulitis, melanoma).  
                                  Describe appearances only (e.g. "round erythematous patch with central crust").  
                                - If uncertain, write **"uncertain"** rather than propose a disease.  
                                - Keep total length ≤ 150 words.
                                `.trim();
                                if (results.textInput && results.textInput.trim() !== '') {
                                    promptClinicalPhoto += `\n\nAdditional patient description provided by the user:\n"${results.textInput.trim()}"\nUse this information to help inform your analysis.`;
                                }
                                imageAnalysis = await processImage(blobUrl, promptClinicalPhoto, "high", costTrackingData);
                                break;
                            case "face_photo":
                                let promptFace = `You are an expert clinician in pediatric dysmorphology.\n\nTASK\nBased solely on the facial features visible in the provided photograph, return a valid JSON array with the names of 5 possible rare genetic syndromes or diseases that could be considered as differential diagnoses.\n\nOUTPUT RULES\n• Output only the JSON array—no XML, Markdown, or extra text.\n• Use double quotes for all strings.\n• List diagnoses in order from most to least likely.\n If you are unsure, make your best guess based on the visible features.\n\nPATIENT IMAGE: (attach the image as input)`;
                                if (results.textInput && results.textInput.trim() !== '') {
                                    promptFace += `\n\nAdditional patient description provided by the user:\n"${results.textInput.trim()}"\nUse this information to help inform your analysis.`;
                                }
                                promptFace = promptFace.trim();
                                imageAnalysis = await processImage(blobUrl, promptFace, "high", costTrackingData);
                                break;
                            case "text_document":
                                const promptTextDocument = `
                                **Task – two stages (no interpretation)**  
                                1️⃣ **Raw Text**  
                                   • Transcribe *verbatim* every readable word from the document image.  
                                   • Preserve line breaks; ignore illegible parts.  
                                2️⃣ **Document Summary**  
                                   • Produce a concise, lay-friendly summary of the key facts *exactly as written* in the document.  
                                   • Re-use the same order of information when possible (patient details, date, findings, plan, signatures).  
                                   • Do **NOT** add diagnoses, advice, or content that is not present in the text.  
                                
                                **Hard rules – must be obeyed**  
                                - ✅ Output **ONLY** the two section headers (verbatim, case-sensitive):  
                                  **Raw Text**  
                                  **Document Summary**  
                                - ❌ Do **NOT** include any other sections ("Impression", "Assessment", etc.).  
                                - ❌ Do **NOT** infer or guess missing information. If part of the text is unreadable, write "[illegible]".  
                                - Keep *Raw Text* exactly as seen; keep *Document Summary* ≤ 25 lines.  
                                - If a usual field (e.g. medications, tests) is absent, state "None reported."  
                                `.trim();
                                imageAnalysis = await processImage(blobUrl, promptTextDocument, "high", costTrackingData);
                                break;
                            default:
                                const promptGeneric = `
                                You are a visual assistant. Briefly describe the main elements in the image (≤80 words) using plain language.
                                Do NOT guess diagnoses, personal identities, or sensitive data.
                                `.trim();
                                imageAnalysis = await processImage(blobUrl, promptGeneric, "high", costTrackingData);
                                break;
                        }
                        
                        // Añadir análisis de imagen al array
                        imageAnalyses.push(`--- Imagen ${i + 1}: ${originalName} (${typeImage}) ---\n${imageAnalysis}`);
                        imageUrls.push(blobUrl);
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
            combinedInput += `<PATIENT_TEXT>\n${results.textInput.trim()}\n</PATIENT_TEXT>\n`;
            }
            if (results.documentAnalysis?.trim()) {
            combinedInput += `<DOCUMENT_TEXT>\n${results.documentAnalysis.trim()}\n</DOCUMENT_TEXT>\n`;
            }
            if (results.imageAnalysis?.trim()) {
            combinedInput += `<IMAGE_REPORT>\n${results.imageAnalysis.trim()}\n</IMAGE_REPORT>\n`;
            }
            if (!combinedInput.trim()) {
            combinedInput = 'No se proporcionó ningún contenido para analizar.';
            }

            // Crear un objeto request simulado para el servicio de summarize
            const mockReq = {
                body: {
                    description: combinedInput,
                    lang: req.body.lang || 'es',
                    myuuid: req.body.myuuid || 'default-uuid',
                    timezone: req.body.timezone || 'UTC'
                },
                headers: req.headers,
                get: (header) => req.headers[header],
                connection: { remoteAddress: req.ip },
                params: req.params,
                query: req.query
            };

            // Crear un objeto response simulado
            const mockRes = {
                status: (code) => ({
                    send: (data) => {
                        if (code === 200) {
                            console.log('entras');
                            res.json({
                                summary: data.data.summary,
                                details: results,
                                detectedLang: data.detectedLang
                            });
                        } else {
                            res.status(code).json(data);
                        }
                    }
                })
            };
            console.log('combinedInput');
            console.log(combinedInput)

            // Usar:
            let summaryResult = null;
            const captureRes = {
                status: (code) => ({
                    send: (data) => {
                        if (code === 200) {
                            summaryResult = data; // Capturar el resultado
                            console.log('summaryResult');
                        }
                    }
                })
            };

            const hasPatient = !!results.textInput?.trim();
            const hasDoc = !!results.documentAnalysis?.trim();
            const hasImage = !!results.imageAnalysis?.trim();

            if (!hasPatient && !hasDoc && hasImage) {
                return res.status(200).send({
                    summary: `${results.imageAnalysis.trim()}`,
                    imageUrls: results.imageUrls || [],
                    details: results,
                    detectedLang: req.body.lang || 'es'
                });
            } else {
                // Capturar el resultado del summarize
                let summaryResult = null;
                const captureRes = {
                    status: (code) => ({
                        send: (data) => {
                            if (code === 200) {
                                summaryResult = data; // Capturar el resultado
                            }
                        }
                    })
                };

                await summarizeCtrl.summarize(mockReq, captureRes);

                // Devolver resultado con URLs de imagen si las hay
                if (summaryResult) {
                    return res.status(200).send({
                        summary: summaryResult.data.summary,
                        imageUrls: results.imageUrls || [],
                        details: results,
                        detectedLang: summaryResult.detectedLang
                    });
                }
            }
            
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
            body: req.body,
            error: error.message,
            myuuid: req.body.myuuid,
            tenantId: tenantId,
            subscriptionId: subscriptionId
        };
        
        await blobOpenDx29Ctrl.createBlobErrorsDx29(infoError, tenantId, subscriptionId);
        
        try {
            let lang = req.body.lang ? req.body.lang : 'en';
            await serviceEmail.sendMailErrorGPTIP(
                lang,
                req.body.text || 'Multimodal input error',
                infoError,
                requestInfo
            );
        } catch (emailError) {
            console.error('Error sending error email:', emailError);
        }
        
        res.status(500).json({ error: 'Error procesando la entrada multimodal' });
    }
};

module.exports = {
    processMultimodalInput
}; 