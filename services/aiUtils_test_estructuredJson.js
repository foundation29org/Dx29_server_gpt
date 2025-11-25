const config = require('../config');
const axios = require('axios');
const translationCtrl = require('./translation');
const ApiManagementKey = config.API_MANAGEMENT_KEY;
const API_MANAGEMENT_BASE = config.API_MANAGEMENT_BASE;
const insights = require('./insights');
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const { jsonrepair } = require('jsonrepair');



function sanitizeAiData(data) {
  return {
    ...data,
    description: sanitizeInput(data.description),
    diseases_list: data.diseases_list ? sanitizeInput(data.diseases_list) : '',
    myuuid: data.myuuid.trim(),
    lang: data.lang ? data.lang.trim().toLowerCase() : 'en', // Usar 'en' como predeterminado
    timezone: data.timezone?.trim() || '', // Manejar caso donde timezone es undefined
    iframeParams: sanitizeIframeParams(data.iframeParams) // Sanitizar iframeParams
  };
}

function sanitizeIframeParams(iframeParams) {
  if (!iframeParams || typeof iframeParams !== 'object') {
    return {};
  }

  const sanitized = {};
  const validFields = ['centro', 'ambito', 'especialidad', 'turno', 'servicio', 'id_paciente'];

  for (const field of validFields) {
    if (iframeParams[field] && typeof iframeParams[field] === 'string') {
      sanitized[field] = sanitizeInput(iframeParams[field]);
    }
  }

  return sanitized;
}


function sanitizeInput(input) {
  // Eliminar caracteres especiales y patrones potencialmente peligrosos
  return input
    .replace(/[<>{}]/g, '') // Eliminar caracteres especiales
    .replace(/(\{|\}|\[|\]|\||\\|\/)/g, '') // Eliminar caracteres que podrían ser usados para inyección
    .replace(/prompt:|system:|assistant:|user:/gi, '') // Eliminar palabras clave de OpenAI con ':'
    .trim();
}

// Endpoints para traducción
const translatorEndpoints = [
  {
    name: 'westeurope',
    url: 'https://api.cognitive.microsofttranslator.com',
    key: config.translationKey, // West Europe
    region: 'westeurope'
  },
  {
    name: 'global',
    url: 'https://api.cognitive.microsofttranslator.com',
    key: config.translationKeyGlobal, // global
  }
  // Puedes agregar más si es necesario
];

// Mapa de endpoints para IA
const endpointsMap = {
  gpt4o: {
    asia: [
      `${API_MANAGEMENT_BASE}/as1/call/gpt4o`, // India: 428 calls/min
      `${API_MANAGEMENT_BASE}/as2/call/gpt4o`  // Japan: 300 calls/min
    ],
    europe: [
      `${API_MANAGEMENT_BASE}/eu1/call/gpt4o`, // Sweden: 428 calls/min
      `${API_MANAGEMENT_BASE}/us1/call/gpt4o`  // WestUS: 857 calls/min como backup
    ],
    northamerica: [
      `${API_MANAGEMENT_BASE}/us1/call/gpt4o`, // WestUS: 857 calls/min
      `${API_MANAGEMENT_BASE}/us2/call/gpt4o`  // EastUS2: 420 calls/min
    ],
    southamerica: [
      `${API_MANAGEMENT_BASE}/us1/call/gpt4o`, // WestUS: 857 calls/min
      `${API_MANAGEMENT_BASE}/us2/call/gpt4o`  // EastUS2: 420 calls/min
    ],
    africa: [
      `${API_MANAGEMENT_BASE}/us1/call/gpt4o`, // WestUS: 857 calls/min
      `${API_MANAGEMENT_BASE}/as2/call/gpt4o`  // Japan: 300 calls/min
    ],
    oceania: [
      `${API_MANAGEMENT_BASE}/as2/call/gpt4o`, // Japan: 300 calls/min
      `${API_MANAGEMENT_BASE}/us1/call/gpt4o`  // WestUS: 857 calls/min como backup
    ],
    other: [
      `${API_MANAGEMENT_BASE}/us1/call/gpt4o`, // WestUS: 857 calls/min
      `${API_MANAGEMENT_BASE}/as2/call/gpt4o`  // Japan: 300 calls/min
    ]
  },
  o3: {
    asia: [
      `${API_MANAGEMENT_BASE}/as1/call/o3`, // Sweden
      `${API_MANAGEMENT_BASE}/as2/call/o3`  // EastUS2
    ],
    europe: [
      `${API_MANAGEMENT_BASE}/eu1/call/o3`, // Sweden
      `${API_MANAGEMENT_BASE}/us1/call/o3`  // EastUS2 como backup
    ],
    northamerica: [
      `${API_MANAGEMENT_BASE}/us1/call/o3`, // EastUS2
      `${API_MANAGEMENT_BASE}/us2/call/o3`  // Sweden como backup
    ],
    southamerica: [
      `${API_MANAGEMENT_BASE}/us1/call/o3`, // EastUS2
      `${API_MANAGEMENT_BASE}/us2/call/o3`  // Sweden como backup
    ],
    africa: [
      `${API_MANAGEMENT_BASE}/us1/call/o3`, // Sweden
      `${API_MANAGEMENT_BASE}/as2/call/o3`  // EastUS2 como backup
    ],
    oceania: [
      `${API_MANAGEMENT_BASE}/as2/call/o3`, // EastUS2
      `${API_MANAGEMENT_BASE}/us1/call/o3`  // Sweden como backup
    ],
    other: [
      `${API_MANAGEMENT_BASE}/us1/call/o3`, // Sweden
      `${API_MANAGEMENT_BASE}/as2/call/o3`  // EastUS2 como backup
    ]
  },
  gpt5nano: {
    asia: [
      `${API_MANAGEMENT_BASE}/eu1/call/gpt-5-nano`,
      `${API_MANAGEMENT_BASE}/us2/call/gpt-5-nano`
    ],
    europe: [
      `${API_MANAGEMENT_BASE}/eu1/call/gpt-5-nano`,
      `${API_MANAGEMENT_BASE}/us2/call/gpt-5-nano`
    ],
    northamerica: [
      `${API_MANAGEMENT_BASE}/us2/call/gpt-5-nano`,
      `${API_MANAGEMENT_BASE}/eu1/call/gpt-5-nano`
    ],
    southamerica: [
      `${API_MANAGEMENT_BASE}/us2/call/gpt-5-nano`,
      `${API_MANAGEMENT_BASE}/eu1/call/gpt-5-nano`
    ],
    africa: [
      `${API_MANAGEMENT_BASE}/eu1/call/gpt-5-nano`,
      `${API_MANAGEMENT_BASE}/us2/call/gpt-5-nano`
    ],
    oceania: [
      `${API_MANAGEMENT_BASE}/us2/call/gpt-5-nano`,
      `${API_MANAGEMENT_BASE}/eu1/call/gpt-5-nano`
    ],
    other: [
      `${API_MANAGEMENT_BASE}/eu1/call/gpt-5-nano`,
      `${API_MANAGEMENT_BASE}/us2/call/gpt-5-nano`
    ]
  },
  gpt5mini: {
    asia: [
      `${API_MANAGEMENT_BASE}/as1/call/gpt-5-mini`,
      `${API_MANAGEMENT_BASE}/as2/call/gpt-5-mini`
    ],
    europe: [
      `${API_MANAGEMENT_BASE}/eu1/call/gpt-5-mini`,
      `${API_MANAGEMENT_BASE}/us2/call/gpt-5-mini`
    ],
    northamerica: [
      `${API_MANAGEMENT_BASE}/us2/call/gpt-5-mini`,
      `${API_MANAGEMENT_BASE}/eu1/call/gpt-5-mini`
    ],
    southamerica: [
      `${API_MANAGEMENT_BASE}/us2/call/gpt-5-mini`,
      `${API_MANAGEMENT_BASE}/eu1/call/gpt-5-mini`
    ],
    africa: [
      `${API_MANAGEMENT_BASE}/eu1/call/gpt-5-mini`,
      `${API_MANAGEMENT_BASE}/as2/call/gpt-5-mini`
    ],
    oceania: [
      `${API_MANAGEMENT_BASE}/as2/call/gpt-5-mini`,
      `${API_MANAGEMENT_BASE}/eu1/call/gpt-5-mini`
    ],
    other: [
      `${API_MANAGEMENT_BASE}/eu1/call/gpt-5-mini`,
      `${API_MANAGEMENT_BASE}/as2/call/gpt-5-mini`
    ]
  },
  gpt5: {
    asia: [
      `${API_MANAGEMENT_BASE}/as1/call/gpt-5`,
      `${API_MANAGEMENT_BASE}/as2/call/gpt-5`
    ],
    europe: [
      `${API_MANAGEMENT_BASE}/eu1/call/gpt-5`,
      `${API_MANAGEMENT_BASE}/us2/call/gpt-5`
    ],
    northamerica: [
      `${API_MANAGEMENT_BASE}/us2/call/gpt-5`,
      `${API_MANAGEMENT_BASE}/eu1/call/gpt-5`
    ],
    southamerica: [
      `${API_MANAGEMENT_BASE}/us2/call/gpt-5`,
      `${API_MANAGEMENT_BASE}/eu1/call/gpt-5`
    ],
    africa: [
      `${API_MANAGEMENT_BASE}/eu1/call/gpt-5`,
      `${API_MANAGEMENT_BASE}/as2/call/gpt-5`
    ],
    oceania: [
      `${API_MANAGEMENT_BASE}/as2/call/gpt-5`,
      `${API_MANAGEMENT_BASE}/eu1/call/gpt-5`
    ],
    other: [
      `${API_MANAGEMENT_BASE}/eu1/call/gpt-5`,
      `${API_MANAGEMENT_BASE}/as2/call/gpt-5`
    ]
  }
};

function getEndpointsByTimezone(timezone, model = 'gpt5mini') {
  const tz = timezone?.split('/')[0]?.toLowerCase();
  const region = (() => {
    if (tz?.includes('america')) return 'northamerica';
    if (tz?.includes('europe')) return 'europe';
    if (tz?.includes('asia')) return 'asia';
    if (tz?.includes('africa')) return 'africa';
    if (tz?.includes('australia') || tz?.includes('pacific')) return 'oceania';
    return 'other';
  })();
  console.log('model', model);
  const endpoints = endpointsMap[model]?.[region] || endpointsMap[model].other;
  return endpoints;
}

async function callAiWithFailover(requestBody, timezone, model = 'gpt5mini', retryCount = 0, dataRequest = null) {
  const RETRY_DELAY = 1000;

  const endpoints = getEndpointsByTimezone(timezone, model);
  try {
    const response = await axios.post(endpoints[retryCount], requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': ApiManagementKey,
      }
    });
    return response;
  } catch (error) {
    if (retryCount < endpoints.length - 1) {
      console.warn(`❌ Error en ${endpoints[retryCount]} — Reintentando en ${RETRY_DELAY}ms...`);
      insights.error({
        message: `Fallo AI endpoint ${endpoints[retryCount]}`,
        error: error.message,
        retryCount,
        requestBody,
        timezone,
        model,
        dataRequest
      });
      await delay(RETRY_DELAY);
      return callAiWithFailover(requestBody, timezone, model, retryCount + 1, dataRequest);
    }
    throw error;
  }
}

async function detectLanguageWithRetry(text, lang, retries = 3, delay = 1000) {
  for (let i = 0; i < translatorEndpoints.length; i++) {
    const endpoint = translatorEndpoints[i];

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await translationCtrl.detectLanguage(text, lang, endpoint);
      } catch (error) {
        const isLastTry = attempt === retries - 1 && i === translatorEndpoints.length - 1;
        if (isLastTry) throw error;

        console.warn(`Error in ${endpoint.region}, retrying... (${attempt + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
}

async function translateTextWithRetry(text, fromLang, retries = 3, delay = 1000) {
  for (let i = 0; i < translatorEndpoints.length; i++) {
    const endpoint = translatorEndpoints[i];

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await translationCtrl.translateText(text, fromLang, endpoint);
      } catch (error) {
        const isLastTry = attempt === retries - 1 && i === translatorEndpoints.length - 1;
        if (isLastTry) throw error;

        console.warn(`Error in ${endpoint.name}, retrying... (${attempt + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
}


async function translateInvertWithRetry(text, toLang, retries = 3, delay = 1000) {
  for (let i = 0; i < translatorEndpoints.length; i++) {
    const endpoint = translatorEndpoints[i];

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await translationCtrl.translateInvert(text, toLang, endpoint);
      } catch (error) {
        const isLastTry = attempt === retries - 1 && i === translatorEndpoints.length - 1;
        if (isLastTry) throw error;

        console.warn(`Error in ${endpoint.name} (invert), retrying... (${attempt + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
}

function stripComments(jsonText) {
  let result = '';
  let i = 0;
  let inString = false;

  while (i < jsonText.length) {
    const char = jsonText[i];

    // contar backslashes para saber si la comilla está escapada
    let backslashCount = 0;
    let j = i - 1;
    while (j >= 0 && jsonText[j] === '\\') {
      backslashCount++;
      j--;
    }
    const isEscaped = (backslashCount % 2) === 1;

    if (char === '"' && !isEscaped) {
      inString = !inString;
      result += char;
      i++;
      continue;
    }

    if (!inString && char === '/' && i + 1 < jsonText.length) {
      const next = jsonText[i + 1];

      // Comentario tipo //
      if (next === '/') {
        i += 2;
        while (i < jsonText.length && jsonText[i] !== '\n' && jsonText[i] !== '\r') {
          i++;
        }
        continue;
      }

      // Comentario tipo /* ... */
      if (next === '*') {
        i += 2;
        while (i + 1 < jsonText.length && !(jsonText[i] === '*' && jsonText[i + 1] === '/')) {
          i++;
        }
        i += 2; // saltar */
        continue;
      }
    }

    result += char;
    i++;
  }

  return result;
}

function parseFollowUpQuestions(raw) {
  // 1) Limpiar fences
  let text = raw.trim()
    .replace(/^```json\s*|\s*```$/g, '')
    .replace(/^```\s*|\s*```$/g, '');

  // 2) Intento directo de parseo
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      const normalized = parsed.map(x => {
        let t = String(x);
        t = t.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return `"${t}"`;
      });
      return `[${normalized.join(', ')}]`; // ← JSON string válido
    }
  } catch (_) {
    // seguimos al modo reparación manual
  }

  // 3) Extraer contenido entre [ y ]
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Invalid follow-up JSON: no array brackets');
  }

  const inner = text.slice(start + 1, end);

  // 4) Separar en items por comas fuera de strings
  const items = [];
  let current = '';
  let inString = false;
  let backslashCount = 0;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];

    if (ch === '\\') {
      backslashCount++;
      current += ch;
      continue;
    }

    const isEscaped = backslashCount % 2 === 1;
    backslashCount = 0;

    if (ch === '"' && !isEscaped) {
      inString = !inString;
      current += ch;
    } else if (ch === ',' && !inString) {
      if (current.trim() !== '') items.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') items.push(current.trim());

  // 5) Normalizar cada item
  const normalizedItems = items.map(item => {
    let t = item.trim();

    // quitar comillas exteriores si las hay
    if (t.startsWith('"') && t.endsWith('"')) {
      t = t.slice(1, -1);
    }

    // escapar \ y "
    t = t.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${t}"`;
  });

  // 6) Devolver JSON string
  return `[${normalizedItems.join(', ')}]`;
}

/**
 * Intenta reparar un JSON usando GPT como último recurso
 * @param {string} brokenJson - El JSON roto a reparar
 * @param {string} jsonType - Tipo de JSON esperado: 'diagnosis', 'questions', 'object', o 'generic'
 * @returns {Promise<any>} - El JSON reparado y parseado
 * @throws {Error} - Si GPT no puede reparar el JSON
 */
async function repairJsonWithGPT(brokenJson, jsonType = "generic") {
  const timezone = "Europe/Madrid";

  // ======= DEFINICIÓN DE STRUCTURED OUTPUT SEGÚN jsonType =======
  let responseFormat;

  if (jsonType === "diagnosis") {
    responseFormat = {
      type: "json_schema",
      json_schema: {
        name: "DiagnosisList",
        strict: true,
        schema: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "diagnosis",
              "description",
              "symptoms_in_common",
              "symptoms_not_in_common"
            ],
            properties: {
              diagnosis: { type: "string" },
              description: { type: "string" },
              symptoms_in_common: {
                type: "array",
                items: { type: "string" }
              },
              symptoms_not_in_common: {
                type: "array",
                items: { type: "string" }
              }
            }
          }
        }
      }
    };
  }

  else if (jsonType === "questions") {
    responseFormat = {
      type: "json_schema",
      json_schema: {
        name: "FollowUpQuestions",
        strict: true,
        schema: {
          type: "array",
          items: {
            type: "string"
          }
        }
      }
    };
  }


  // ---- Prompt distinto según haya schema o no ----
  const intro = responseFormat
    ? "The following JSON is broken. Repair it so that it becomes valid JSON matching the required schema."
    : "The following JSON is broken. Repair it so that it becomes valid JSON, preserving the original structure and meaning as much as possible.";

  // ======= PROMPT SIMPLE Y ROBUSTO =======
  const prompt = `
${intro}

Return ONLY valid JSON (no explanations).

Broken JSON:
${brokenJson}
`.trim();

  const requestBody = {
    messages: [{ role: "user", content: prompt }],
    ...(responseFormat ? { response_format: responseFormat } : {}),
    temperature: 0,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0
  };

  try {
    const response = await callAiWithFailover(
      requestBody,
      timezone,
      "gpt4o",
      0,
      null
    );

    const content = response?.data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("No content returned from GPT");

    if (typeof content === "object") {
      return content;
    }

    let text = String(content).trim();
    text = text
      .replace(/^```json\s*|\s*```$/g, "")
      .replace(/^```\s*|\s*```$/g, "");

    return JSON.parse(text);

  } catch (err) {
    const msg = String(err.message || '');
    // Si structured outputs falla, intentar sin response_format
    if (
      msg.includes('400') ||
      msg.includes('response_format') ||
      msg.includes('Unexpected token') || // errores típicos de JSON.parse
      msg.includes('Failed to parse')     // por si lanzas tú mismo
    ) {
      console.warn('⚠️  Structured outputs no soportado, intentando sin response_format...');
      
      const fallbackRequestBody = {
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0
      };
      
      try {
        const fallbackResponse = await callAiWithFailover(
          fallbackRequestBody,
          timezone,
          "gpt4o",
          0,
          null
        );
        
        const fallbackContent = fallbackResponse?.data?.choices?.[0]?.message?.content;
        if (!fallbackContent) throw new Error("No content returned");
        
        // Limpiar markdown si existe
        let cleaned = typeof fallbackContent === 'string' 
          ? fallbackContent.trim().replace(/^```json\s*|\s*```$/g, '').replace(/^```\s*|\s*```$/g, '')
          : fallbackContent;
        
        return typeof cleaned === 'string' ? JSON.parse(cleaned) : cleaned;
      } catch (fallbackError) {
        throw new Error("JSON repair failed (with and without structured outputs): " + fallbackError.message);
      }
    }
    throw new Error("Structured Output repair failed: " + err.message);
  }
}

/**
 * Parsea un JSON con fixes automáticos para errores comunes usando jsonrepair
 * Maneja errores como barras invertidas mal escapadas, strings sin comillas, paréntesis sobrantes, etc.
 * @param {string} jsonText - El texto JSON a parsear
 * @param {string} jsonType - Tipo de JSON esperado: 'diagnosis', 'questions', 'object', o 'generic' (opcional)
 * @returns {Promise<any>} - El objeto parseado
 * @throws {Error} - Si el JSON no puede ser parseado después de todos los intentos
 */
async function parseJsonWithFixes(jsonText, jsonType = 'generic') {
  let cleanResponse = jsonText.trim()
    .replace(/^```json\s*|\s*```$/g, '')
    .replace(/^```\s*|\s*```$/g, '');
  cleanResponse = stripComments(cleanResponse);
  // 1) Intento directo
  try {
    return JSON.parse(cleanResponse);
  } catch (initialError) {

    // 2) Fix seguro de arrays mal cerrados
    if (jsonType === 'questions') {
      // Reparador específico de arrays de strings → devuelve JSON string
      try {
        cleanResponse = parseFollowUpQuestions(cleanResponse);
      } catch (e) {
        // Si falla, dejamos cleanResponse como estaba y dejamos que jsonrepair/GPT intenten
      }
    }

    // 3) Reintento
    try {
      return JSON.parse(cleanResponse);
    } catch (fixError) {

      // 4) jsonrepair como última capa
      try {
        const repaired = jsonrepair(cleanResponse);
        return JSON.parse(repaired);
      } catch (repairError) {
        insights.error({
          message: `Error al reparar JSON con jsonrepair`,
          error: repairError.message,
          jsonText: cleanResponse,
          jsonType: jsonType
        });
        // 5) Si nada funciona, intentar con GPT como último recurso
        try {
          const result = await repairJsonWithGPT(cleanResponse, jsonType);

          if (jsonType === 'diagnosis' && !Array.isArray(result)) {
            throw new Error('GPT repair did not return an array for diagnosis JSON');
          }
          if (jsonType === 'questions' && !Array.isArray(result)) {
            throw new Error('GPT repair did not return an array for questions JSON');
          }
          return result;
        } catch (gptError) {
          // Si GPT también falla, lanzar el error original
          insights.error({
            message: `Error al reparar JSON con GPT`,
            error: gptError.message,
            jsonText: cleanResponse,
            jsonType: jsonType
          });
          throw initialError;
        }
      }
    }
  }
}

module.exports = {
  sanitizeAiData,
  sanitizeInput,
  getEndpointsByTimezone,
  callAiWithFailover,
  detectLanguageWithRetry,
  translateTextWithRetry,
  translateInvertWithRetry,
  parseJsonWithFixes
}; 