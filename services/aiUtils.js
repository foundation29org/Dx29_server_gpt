const config = require('../config');
const axios = require('axios');
const translationCtrl = require('./translation');
const insights = require('./insights');
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const { jsonrepair } = require('jsonrepair');

// Detectar si es deployment self-hosted (sin APIM)
const isSelfHosted = config.IS_SELF_HOSTED || false;

// Mapeo de regiones: usar self-hosted si está configurado y no hay APIM, sino usar regiones SaaS
const getRegionToAzureOpenAI = () => {
  if (isSelfHosted && config.AZURE_OPENAI_SELFHOSTED?.primary?.baseUrl && config.AZURE_OPENAI_SELFHOSTED?.primary?.apiKey) {
    // Self-hosted: usar PRIMARY y FALLBACK
    return {
      primary: config.AZURE_OPENAI_SELFHOSTED.primary,
      fallback: config.AZURE_OPENAI_SELFHOSTED.fallback
    };
  }
  // SaaS Multi-tenant: usar regiones específicas (as1, as2, eu1, us1, us2)
  return config.AZURE_OPENAI_REGIONS;
};

const regionToAzureOpenAI = getRegionToAzureOpenAI();

// Mapeo de modelos a deployments y api-versions
const modelConfig = {
  'gpt4o': {
    apiVersion: '2024-02-15-preview',
    path: '/openai/deployments/normalcalls/chat/completions'
  },
  'gpt-5': {
    apiVersion: '2025-01-01-preview',
    path: '/openai/deployments/gpt-5/chat/completions'
  },
  'gpt-5-mini': {
    apiVersion: '2025-01-01-preview',
    path: '/openai/deployments/gpt-5-mini/chat/completions'
  },
  'gpt-5-nano': {
    apiVersion: '2025-01-01-preview',
    path: '/openai/deployments/gpt-5-nano/chat/completions'
  },
  'o3': {
    apiVersion: '2025-04-01-preview',
    path: '/openai/responses'
  }
};

/**
 * Construye la URL completa de Azure OpenAI para un endpoint específico
 * @param {string} region - Región (as1, as2, eu1, us1, us2 para SaaS) o (primary, fallback para self-hosted)
 * @param {string} model - Modelo (gpt4o, gpt-5, gpt-5-mini, gpt-5-nano, o3)
 * @returns {Object} - { url, apiKey } o null si no está configurado
 */
function buildAzureOpenAIEndpoint(region, model) {
  const regionConfig = regionToAzureOpenAI[region];
  if (!regionConfig || !regionConfig.baseUrl || !regionConfig.apiKey) {
    console.warn(`⚠️ Región ${region} no configurada o sin API key`);
    return null;
  }

  // Buscar directamente en modelConfig
  const modelCfg = modelConfig[model];
  if (!modelCfg) {
    console.warn(`⚠️ Modelo ${model} no tiene configuración en modelConfig`);
    return null;
  }

  const url = `${regionConfig.baseUrl}${modelCfg.path}?api-version=${modelCfg.apiVersion}`;
  return {
    url,
    apiKey: regionConfig.apiKey
  };
}



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

/**
 * Obtiene los endpoints simplificados para self-hosted (solo PRIMARY y FALLBACK)
 */
function getSelfHostedEndpoints(model) {
  const endpoints = [];
  
  // PRIMARY siempre está disponible si está configurado
  if (regionToAzureOpenAI.primary && regionToAzureOpenAI.primary.baseUrl && regionToAzureOpenAI.primary.apiKey) {
    const primaryEndpoint = buildAzureOpenAIEndpoint('primary', model);
    if (primaryEndpoint) {
      endpoints.push(primaryEndpoint);
    }
  }
  
  // FALLBACK solo si está configurado
  if (regionToAzureOpenAI.fallback && regionToAzureOpenAI.fallback.baseUrl && regionToAzureOpenAI.fallback.apiKey) {
    const fallbackEndpoint = buildAzureOpenAIEndpoint('fallback', model);
    if (fallbackEndpoint) {
      endpoints.push(fallbackEndpoint);
    }
  }
  
  return endpoints;
}

// Mapa de endpoints para IA - ahora apunta directamente a Azure OpenAI
// El formato es: { url: string, apiKey: string }
const endpointsMap = {
  gpt4o: {
    asia: [
      buildAzureOpenAIEndpoint('as1', 'gpt4o'),
      buildAzureOpenAIEndpoint('as2', 'gpt4o')
    ],
    europe: [
      buildAzureOpenAIEndpoint('eu1', 'gpt4o'),
      buildAzureOpenAIEndpoint('us1', 'gpt4o')
    ],
    northamerica: [
      buildAzureOpenAIEndpoint('us1', 'gpt4o'),
      buildAzureOpenAIEndpoint('us2', 'gpt4o')
    ],
    southamerica: [
      buildAzureOpenAIEndpoint('us1', 'gpt4o'),
      buildAzureOpenAIEndpoint('us2', 'gpt4o')
    ],
    africa: [
      buildAzureOpenAIEndpoint('us1', 'gpt4o'),
      buildAzureOpenAIEndpoint('as2', 'gpt4o')
    ],
    oceania: [
      buildAzureOpenAIEndpoint('as2', 'gpt4o'),
      buildAzureOpenAIEndpoint('us1', 'gpt4o')
    ],
    other: [
      buildAzureOpenAIEndpoint('us1', 'gpt4o'),
      buildAzureOpenAIEndpoint('as2', 'gpt4o')
    ]
  },
  o3: {
    asia: [
      buildAzureOpenAIEndpoint('as1', 'o3'),
      buildAzureOpenAIEndpoint('as2', 'o3')
    ],
    europe: [
      buildAzureOpenAIEndpoint('eu1', 'o3'),
      buildAzureOpenAIEndpoint('us1', 'o3')
    ],
    northamerica: [
      buildAzureOpenAIEndpoint('us1', 'o3'),
      buildAzureOpenAIEndpoint('us2', 'o3')
    ],
    southamerica: [
      buildAzureOpenAIEndpoint('us1', 'o3'),
      buildAzureOpenAIEndpoint('us2', 'o3')
    ],
    africa: [
      buildAzureOpenAIEndpoint('us1', 'o3'),
      buildAzureOpenAIEndpoint('as2', 'o3')
    ],
    oceania: [
      buildAzureOpenAIEndpoint('as2', 'o3'),
      buildAzureOpenAIEndpoint('us1', 'o3')
    ],
    other: [
      buildAzureOpenAIEndpoint('us1', 'o3'),
      buildAzureOpenAIEndpoint('as2', 'o3')
    ]
  },
  gpt5nano: {
    asia: [
      buildAzureOpenAIEndpoint('eu1', 'gpt-5-nano'),
      buildAzureOpenAIEndpoint('us2', 'gpt-5-nano')
    ],
    europe: [
      buildAzureOpenAIEndpoint('eu1', 'gpt-5-nano'),
      buildAzureOpenAIEndpoint('us2', 'gpt-5-nano')
    ],
    northamerica: [
      buildAzureOpenAIEndpoint('us2', 'gpt-5-nano'),
      buildAzureOpenAIEndpoint('eu1', 'gpt-5-nano')
    ],
    southamerica: [
      buildAzureOpenAIEndpoint('us2', 'gpt-5-nano'),
      buildAzureOpenAIEndpoint('eu1', 'gpt-5-nano')
    ],
    africa: [
      buildAzureOpenAIEndpoint('eu1', 'gpt-5-nano'),
      buildAzureOpenAIEndpoint('us2', 'gpt-5-nano')
    ],
    oceania: [
      buildAzureOpenAIEndpoint('us2', 'gpt-5-nano'),
      buildAzureOpenAIEndpoint('eu1', 'gpt-5-nano')
    ],
    other: [
      buildAzureOpenAIEndpoint('eu1', 'gpt-5-nano'),
      buildAzureOpenAIEndpoint('us2', 'gpt-5-nano')
    ]
  },
  gpt5mini: {
    asia: [
      buildAzureOpenAIEndpoint('as1', 'gpt-5-mini'),
      buildAzureOpenAIEndpoint('as2', 'gpt-5-mini')
    ],
    europe: [
      buildAzureOpenAIEndpoint('eu1', 'gpt-5-mini'),
      buildAzureOpenAIEndpoint('us2', 'gpt-5-mini')
    ],
    northamerica: [
      buildAzureOpenAIEndpoint('us2', 'gpt-5-mini'),
      buildAzureOpenAIEndpoint('eu1', 'gpt-5-mini')
    ],
    southamerica: [
      buildAzureOpenAIEndpoint('us2', 'gpt-5-mini'),
      buildAzureOpenAIEndpoint('eu1', 'gpt-5-mini')
    ],
    africa: [
      buildAzureOpenAIEndpoint('eu1', 'gpt-5-mini'),
      buildAzureOpenAIEndpoint('as2', 'gpt-5-mini')
    ],
    oceania: [
      buildAzureOpenAIEndpoint('as2', 'gpt-5-mini'),
      buildAzureOpenAIEndpoint('eu1', 'gpt-5-mini')
    ],
    other: [
      buildAzureOpenAIEndpoint('eu1', 'gpt-5-mini'),
      buildAzureOpenAIEndpoint('as2', 'gpt-5-mini')
    ]
  },
  gpt5: {
    asia: [
      buildAzureOpenAIEndpoint('as1', 'gpt-5'),
      buildAzureOpenAIEndpoint('as2', 'gpt-5')
    ],
    europe: [
      buildAzureOpenAIEndpoint('eu1', 'gpt-5'),
      buildAzureOpenAIEndpoint('us2', 'gpt-5')
    ],
    northamerica: [
      buildAzureOpenAIEndpoint('us2', 'gpt-5'),
      buildAzureOpenAIEndpoint('eu1', 'gpt-5')
    ],
    southamerica: [
      buildAzureOpenAIEndpoint('us2', 'gpt-5'),
      buildAzureOpenAIEndpoint('eu1', 'gpt-5')
    ],
    africa: [
      buildAzureOpenAIEndpoint('eu1', 'gpt-5'),
      buildAzureOpenAIEndpoint('as2', 'gpt-5')
    ],
    oceania: [
      buildAzureOpenAIEndpoint('as2', 'gpt-5'),
      buildAzureOpenAIEndpoint('eu1', 'gpt-5')
    ],
    other: [
      buildAzureOpenAIEndpoint('eu1', 'gpt-5'),
      buildAzureOpenAIEndpoint('as2', 'gpt-5')
    ]
  }
};

function getEndpointsByTimezone(timezone, model = 'gpt5mini') {
  // Si es self-hosted, usar endpoints simplificados (PRIMARY y FALLBACK)
  if (isSelfHosted && regionToAzureOpenAI.primary) {
    const endpoints = getSelfHostedEndpoints(model);
    if (endpoints.length > 0) {
      return endpoints;
    }
    // Si no hay endpoints configurados para self-hosted, lanzar error
    throw new Error('No hay endpoints de Azure OpenAI configurados para self-hosted. Configura AZURE_OPENAI_SELFHOSTED_PRIMARY_BASE_URL y AZURE_OPENAI_SELFHOSTED_PRIMARY_KEY');
  }

  // Para SaaS Multi-tenant, usar lógica de regiones geográficas
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
  const endpoint = endpoints[retryCount];
  
  // Si el endpoint es null (no configurado), intentar el siguiente
  if (!endpoint || !endpoint.url || !endpoint.apiKey) {
    if (retryCount < endpoints.length - 1) {
      return callAiWithFailover(requestBody, timezone, model, retryCount + 1, dataRequest);
    }
    throw new Error(`No hay endpoints configurados para modelo ${model} en región ${timezone}`);
  }

  try {
    // Preparar el body
    // Para o3, el endpoint /openai/responses requiere el campo 'model' en el body
    // Para otros modelos (chat completions), el modelo está en la URL, así que lo removemos
    const requestBodyCopy = { ...requestBody };
    const isO3Endpoint = endpoint.url.includes('/openai/responses');
    
    if (!isO3Endpoint && requestBodyCopy.model) {
      // Solo remover 'model' si NO es el endpoint de o3
      delete requestBodyCopy.model;
    }

    const response = await axios.post(endpoint.url, requestBodyCopy, {
      headers: {
        'Content-Type': 'application/json',
        'api-key': endpoint.apiKey
      }
    });
    return response;
  } catch (error) {
    if (retryCount < endpoints.length - 1) {
      console.warn(`❌ Error en ${endpoint.url} — Reintentando en ${RETRY_DELAY}ms...`);
      insights.error({
        message: `Fallo AI endpoint ${endpoint.url}`,
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