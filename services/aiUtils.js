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

/**
 * Repara arrays que se cierran con } en lugar de ]
 * Detecta cuando un array está abierto y se encuentra un } que debería ser un ]
 * @param {string} jsonText - El texto JSON a reparar
 * @returns {string} - El JSON reparado
 */
function safelyFixUnclosedArrays(jsonText) {
  let result = '';
  let i = 0;
  let inString = false;
  const stack = []; // pila de delimitadores: '[' o '{'

  while (i < jsonText.length) {
    const char = jsonText[i];

    // Contar barras invertidas antes del carácter actual
    let backslashCount = 0;
    let j = i - 1;
    while (j >= 0 && jsonText[j] === '\\') {
      backslashCount++;
      j--;
    }
    const isEscaped = (backslashCount % 2) === 1;

    // Entrar/salir de string
    if (char === '"' && !isEscaped) {
      inString = !inString;
      result += char;
      i++;
      continue;
    }

    // Dentro de string, copiar tal cual
    if (inString) {
      result += char;
      i++;
      continue;
    }

    // Fuera de string: gestionar delimitadores
    if (char === '[') {
      stack.push('[');
      result += char;
    } else if (char === '{') {
      stack.push('{');
      result += char;
    } else if (char === ']') {
      // Cierra array si la cima es '['
      if (stack.length > 0 && stack[stack.length - 1] === '[') {
        stack.pop();
      }
      result += char;
    } else if (char === '}') {
      const top = stack.length > 0 ? stack[stack.length - 1] : null;

      if (top === '{') {
        // Cierre normal de objeto
        stack.pop();
        result += char;
      } else if (top === '[') {
        // Aquí está el caso roto: hay un '[' abierto y aparece un '}'
        // Primero cerramos el array
        stack.pop();
        result += ']';

        // Ahora procesamos el '}' de nuevo:
        // Miramos la nueva cima de la pila
        const newTop = stack[stack.length - 1];
        if (newTop === '{') {
          stack.pop();
        }
        result += char;
      } else {
        // No coincide con nada esperable, lo dejamos pasar
        result += char;
      }
    } else {
      result += char;
    }

    i++;
  }

  // Si quedan corchetes sin cerrar, los cerramos al final
  while (stack.length > 0 && stack[stack.length - 1] === '[') {
    stack.pop();
    result += ']';
  }

  return result;
}

/**
 * Parsea un JSON con fixes automáticos para errores comunes usando jsonrepair
 * Maneja errores como barras invertidas mal escapadas, strings sin comillas, paréntesis sobrantes, etc.
 * @param {string} jsonText - El texto JSON a parsear
 * @returns {any} - El objeto parseado
 * @throws {Error} - Si el JSON no puede ser parseado después de todos los intentos
 */
function parseJsonWithFixes(jsonText) {
  let cleanResponse = jsonText.trim()
    .replace(/^```json\s*|\s*```$/g, '')
    .replace(/^```\s*|\s*```$/g, '');

  // 1) Intento directo
  try {
    return JSON.parse(cleanResponse);
  } catch (initialError) {

    // 2) Fix seguro de arrays mal cerrados
    cleanResponse = safelyFixUnclosedArrays(cleanResponse);

    // 3) Reintento
    try {
      return JSON.parse(cleanResponse);
    } catch (fixError) {

      // 4) jsonrepair como última capa
      try {
        const repaired = jsonrepair(cleanResponse);
        return JSON.parse(repaired);
      } catch (repairError) {
        // Si nada funciona, re-lanzamos el error original
        throw initialError;
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