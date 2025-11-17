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

  function fixBrokenStrings(jsonText) {
    let result = '';
    let inString = false;
    let i = 0;
  
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
        if (inString) {
          // estamos dentro de un string: decidir si es cierre válido o comilla interna rota
          let k = i + 1;
          // saltar espacios en blanco
          while (k < jsonText.length && /\s/.test(jsonText[k])) {
            k++;
          }
          const next = jsonText[k];
  
          // Si lo siguiente NO es separador JSON (coma, cierre de array/objeto o fin),
          // esta comilla no puede ser un cierre de string válido → la escapamos.
          if (next && next !== ',' && next !== ']' && next !== '}') {
            result += '\\"';
            i++;
            continue;
          }
        }
  
        // caso normal: abrimos o cerramos string
        inString = !inString;
        result += char;
        i++;
        continue;
      }
  
      // resto de caracteres
      result += char;
      i++;
    }
  
    return result;
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
        stack.pop();
        result += char;
        i++;
        continue;
      } else if (top === '[') {
        // Insertar el ']' que falta y NO consumir aún el '}'
        stack.pop();
        result += ']';
        // aquí NO hacemos i++ ni añadimos '}', dejamos que en la próxima
        // iteración se procese este mismo '}' ya con la pila correcta
        continue;
      } else {
        result += char;
        i++;
        continue;
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

function fixSymptomArrays(jsonText) {
  const fields = ['symptoms_in_common', 'symptoms_not_in_common'];
  let text = jsonText;

  for (const field of fields) {
    const key = `"${field}"`;
    let searchStart = 0;

    while (true) {
      const keyIndex = text.indexOf(key, searchStart);
      if (keyIndex === -1) break;

      const colonIndex = text.indexOf(':', keyIndex + key.length);
      if (colonIndex === -1) break;

      const openBracketIndex = text.indexOf('[', colonIndex);
      if (openBracketIndex === -1) break;

      // Buscar el cierre ']' correspondiente
      let j = openBracketIndex + 1;
      let inString = false;
      let backslashCount;
      while (j < text.length) {
        const ch = text[j];

        backslashCount = 0;
        let k = j - 1;
        while (k >= 0 && text[k] === '\\') {
          backslashCount++;
          k--;
        }
        const isEscaped = (backslashCount % 2) === 1;

        if (ch === '"' && !isEscaped) {
          inString = !inString;
        } else if (ch === ']') {
          // aceptamos el ']' aunque inString sea true: arregla arrays con comillas rotas
          break;
        }
        j++;
      }

      if (j >= text.length) {
        // Array truncado, cerrarlo
        const arrayContent = text.slice(openBracketIndex + 1);
        const items = [];
        let current = '';
        inString = false;
        
        // Separar elementos
        for (let idx = 0; idx < arrayContent.length; idx++) {
          const ch = arrayContent[idx];
          backslashCount = 0;
          let k = idx - 1;
          while (k >= 0 && arrayContent[k] === '\\') {
            backslashCount++;
            k--;
          }
          const isEscaped = (backslashCount % 2) === 1;
          
          if (ch === '"' && !isEscaped) {
            inString = !inString;
            current += ch;
          } else if (ch === ',' && !inString) {
            if (current.trim() !== '') items.push(current.trim());
            current = '';
          } else if (!inString && ch.match(/[a-zA-Z0-9]/) && (idx === 0 || arrayContent[idx - 1] === ',' || arrayContent[idx - 1] === ' ')) {
            // Elemento sin comillas
            let elementEnd = idx;
            for (let m = idx; m < arrayContent.length; m++) {
              if (arrayContent[m] === ',') {
                elementEnd = m;
                break;
              }
            }
            if (elementEnd === idx) elementEnd = arrayContent.length;
            const unquotedText = arrayContent.slice(idx, elementEnd).trim();
            if (unquotedText) {
              items.push(unquotedText);
              idx = elementEnd - 1;
              current = '';
              continue;
            }
            current += ch;
          } else {
            current += ch;
          }
        }
        if (current.trim() !== '') items.push(current.trim());
        
        // Normalizar items
        const fixedItems = items.map((item) => {
          const trimmed = item.trim();
          if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
            return trimmed;
          }
          const escaped = trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          return `"${escaped}"`;
        });
        
        const fixedArray = `[${fixedItems.join(', ')}]`;
        text = text.slice(0, openBracketIndex) + fixedArray;
        searchStart = openBracketIndex + fixedArray.length;
        continue;
      }

      const arrayContent = text.slice(openBracketIndex + 1, j); // sin [ ni ]

      // Separar en elementos por comas fuera de strings
      const items = [];
      let current = '';
      inString = false;
      let itemStart = 0;
      
      for (let idx = 0; idx < arrayContent.length; idx++) {
        const ch = arrayContent[idx];

        backslashCount = 0;
        let k = idx - 1;
        while (k >= 0 && arrayContent[k] === '\\') {
          backslashCount++;
          k--;
        }
        const isEscaped = (backslashCount % 2) === 1;

        if (ch === '"' && !isEscaped) {
          if (!inString) {
            // Inicio de string
            itemStart = idx;
          }
          inString = !inString;
          current += ch;
        } else if (ch === ',' && !inString) {
          if (current.trim() !== '') items.push(current.trim());
          current = '';
          itemStart = idx + 1;
        } else {
          // Si no estamos en string y encontramos texto sin comillas
          if (!inString && ch.match(/[a-zA-Z0-9]/) && (idx === 0 || arrayContent[idx - 1] === ',' || arrayContent[idx - 1] === ' ')) {
            // Buscar hasta la siguiente coma o fin
            let elementEnd = idx;
            for (let m = idx; m < arrayContent.length; m++) {
              if (arrayContent[m] === ',') {
                elementEnd = m;
                break;
              }
            }
            if (elementEnd === idx) elementEnd = arrayContent.length;
            const unquotedText = arrayContent.slice(idx, elementEnd).trim();
            if (unquotedText) {
              items.push(unquotedText);
              idx = elementEnd - 1; // -1 porque el for incrementará
              current = '';
              continue;
            }
          }
          current += ch;
        }
      }
      if (current.trim() !== '') items.push(current.trim());

      // Normalizar cada item a string
      const fixedItems = items.map((item) => {
        const trimmed = item.trim();
        if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
          return trimmed; // ya es string bien formado
        }
        const escaped = trimmed
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"');
        return `"${escaped}"`;
      });

      const fixedArray = `[${fixedItems.join(', ')}]`;

      text = text.slice(0, openBracketIndex) + fixedArray + text.slice(j + 1);
      searchStart = openBracketIndex + fixedArray.length;
    }
  }

  return text;
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
async function repairJsonWithGPT(brokenJson, jsonType = 'generic') {
  const timezone = 'Europe/Madrid';
  
  let structureHint = '';
  let instructions = '';
  
  switch (jsonType) {
    case 'diagnosis':
      structureHint = `The JSON must be an array of objects, each with this exact structure and keys:
{
  "diagnosis": "disease name",
  "description": "brief summary",
  "symptoms_in_common": ["symptom1", "symptom2"],
  "symptoms_not_in_common": ["symptom3", "symptom4"]
}`;
      instructions = `1. Fix all JSON syntax errors (missing quotes, brackets, commas, etc.)
2. Do NOT remove objects unless they are completely unusable.
3. Do NOT remove required keys. If a field is missing, infer a reasonable value from context or use an empty string/empty array.
4. Do NOT add extra top-level fields.
5. Ensure all strings are properly quoted.
6. Ensure all arrays are properly closed with ].
7. Ensure all objects are properly closed with }.
8. Return ONLY valid JSON, no explanations, no markdown, no code blocks.
9. Maintain the original meaning as much as possible.`;
      break;
      
    case 'questions':
      structureHint = `The JSON must be an array of strings (questions), for example:
["Question 1?", "Question 2?", "Question 3?"]`;
      instructions = `1. Fix all JSON syntax errors (missing quotes, brackets, commas, etc.)
2. Ensure all strings in the array are properly quoted.
3. Ensure the array is properly closed with ].
4. Return ONLY valid JSON, no explanations, no markdown, no code blocks.
5. Maintain all questions from the original, do not remove any.`;
      break;
      
    case 'object':
      structureHint = `The JSON must be a valid JSON object.`;
      instructions = `1. Fix all JSON syntax errors (missing quotes, brackets, commas, etc.)
2. Ensure all strings are properly quoted.
3. Ensure all arrays are properly closed with ].
4. Ensure all objects are properly closed with }.
5. Return ONLY valid JSON, no explanations, no markdown, no code blocks.
6. Maintain the original structure and keys as much as possible.`;
      break;
      
    default:
      structureHint = `The JSON must be valid JSON (array or object).`;
      instructions = `1. Fix all JSON syntax errors (missing quotes, brackets, commas, etc.)
2. Ensure all strings are properly quoted.
3. Ensure all arrays are properly closed with ].
4. Ensure all objects are properly closed with }.
5. Return ONLY valid JSON, no explanations, no markdown, no code blocks.
6. Maintain the original structure as much as possible.`;
  }
  
  const repairPrompt = `You are a JSON repair assistant. Fix the following broken JSON to make it valid.

${structureHint}

Broken JSON:
${brokenJson}

Instructions:
${instructions}

Return the fixed JSON:`;

  /*const requestBody = {
    model: "gpt-5-mini",
    messages: [{ role: "user", content: repairPrompt }],
    reasoning_effort: "medium"
  };*/

  const requestBody = {
    messages: [{ role: "user", content: repairPrompt }],
    temperature: 0,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0
  };

  try {
    const response = await callAiWithFailover(requestBody, timezone, 'gpt4o', 0, null);
    const choice = response?.data?.choices?.[0];
    if (!choice || !choice.message || !choice.message.content) {
      throw new Error('GPT repair returned no content');
    }
    let repairedText = choice.message.content.trim();

    repairedText = repairedText
      .replace(/^```json\s*|\s*```$/g, '')
      .replace(/^```\s*|\s*```$/g, '');

    return JSON.parse(repairedText);
  } catch (gptError) {
    throw new Error(`GPT repair failed: ${gptError.message}`);
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
    }else{
      cleanResponse = fixBrokenStrings(cleanResponse);
      cleanResponse = safelyFixUnclosedArrays(cleanResponse);
      cleanResponse = fixSymptomArrays(cleanResponse);
      
      // Cerrar estructuras truncadas al final (contando solo fuera de strings)
      let openBraces = 0;
      let closeBraces = 0;
      let openBrackets = 0;
      let closeBrackets = 0;
      let inString = false;
      
      for (let i = 0; i < cleanResponse.length; i++) {
        const char = cleanResponse[i];
        let backslashCount = 0;
        let j = i - 1;
        while (j >= 0 && cleanResponse[j] === '\\') {
          backslashCount++;
          j--;
        }
        const isEscaped = (backslashCount % 2) === 1;
        
        if (char === '"' && !isEscaped) {
          inString = !inString;
        } else if (!inString) {
          if (char === '{') openBraces++;
          else if (char === '}') closeBraces++;
          else if (char === '[') openBrackets++;
          else if (char === ']') closeBrackets++;
        }
      }
      
      // Cerrar arrays primero
      while (openBrackets > closeBrackets) {
        cleanResponse += ']';
        closeBrackets++;
      }
      
      // Cerrar objetos
      while (openBraces > closeBraces) {
        cleanResponse += '}';
        closeBraces++;
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
          return await repairJsonWithGPT(cleanResponse, jsonType);
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