const config = require('../config');
const axios = require('axios');
const translationCtrl = require('./translation');
const ApiManagementKey = config.API_MANAGEMENT_KEY;
const API_MANAGEMENT_BASE = config.API_MANAGEMENT_BASE;
const insights = require('./insights');
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));



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
      `${API_MANAGEMENT_BASE}/eu1/call/gpt4o`, // Suiza: 428 calls/min
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
      `${API_MANAGEMENT_BASE}/eu1/call/o3`, // Suiza
      `${API_MANAGEMENT_BASE}/us2/call/o3`  // EastUS2
    ],
    europe: [
      `${API_MANAGEMENT_BASE}/eu1/call/o3`, // Suiza
      `${API_MANAGEMENT_BASE}/us2/call/o3`  // EastUS2 como backup
    ],
    northamerica: [
      `${API_MANAGEMENT_BASE}/us2/call/o3`, // EastUS2
      `${API_MANAGEMENT_BASE}/eu1/call/o3`  // Suiza como backup
    ],
    southamerica: [
      `${API_MANAGEMENT_BASE}/us2/call/o3`, // EastUS2
      `${API_MANAGEMENT_BASE}/eu1/call/o3`  // Suiza como backup
    ],
    africa: [
      `${API_MANAGEMENT_BASE}/eu1/call/o3`, // Suiza
      `${API_MANAGEMENT_BASE}/us2/call/o3`  // EastUS2 como backup
    ],
    oceania: [
      `${API_MANAGEMENT_BASE}/us2/call/o3`, // EastUS2
      `${API_MANAGEMENT_BASE}/eu1/call/o3`  // Suiza como backup
    ],
    other: [
      `${API_MANAGEMENT_BASE}/eu1/call/o3`, // Suiza
      `${API_MANAGEMENT_BASE}/us2/call/o3`  // EastUS2 como backup
    ]
  },
  o3images: {
    europe: [
      `${API_MANAGEMENT_BASE}/eu1/call/o3images`, // Suiza
      `${API_MANAGEMENT_BASE}/us2/call/o3images`  // EastUS2 como backup
    ],
    asia: [
      `${API_MANAGEMENT_BASE}/eu1/call/o3images`, // Suiza
      `${API_MANAGEMENT_BASE}/us2/call/o3images`  // EastUS2 como backup
    ],
    northamerica: [
      `${API_MANAGEMENT_BASE}/us2/call/o3images`, // EastUS2
      `${API_MANAGEMENT_BASE}/eu1/call/o3images`  // Suiza como backup
    ],
    southamerica: [
      `${API_MANAGEMENT_BASE}/us2/call/o3images`, // EastUS2
      `${API_MANAGEMENT_BASE}/eu1/call/o3images`  // Suiza como backup
    ],
    africa: [
      `${API_MANAGEMENT_BASE}/eu1/call/o3images`, // Suiza
      `${API_MANAGEMENT_BASE}/us2/call/o3images`  // EastUS2 como backup
    ],
    oceania: [
      `${API_MANAGEMENT_BASE}/us2/call/o3images`, // EastUS2
      `${API_MANAGEMENT_BASE}/eu1/call/o3images`  // Suiza como backup
    ],
    other: [
      `${API_MANAGEMENT_BASE}/eu1/call/o3images`, // Suiza
      `${API_MANAGEMENT_BASE}/us2/call/o3images`  // EastUS2 como backup
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
      `${API_MANAGEMENT_BASE}/eu1/call/gpt-5-mini`,
      `${API_MANAGEMENT_BASE}/us2/call/gpt-5-mini`
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
      `${API_MANAGEMENT_BASE}/us2/call/gpt-5-mini`
    ],
    oceania: [
      `${API_MANAGEMENT_BASE}/us2/call/gpt-5-mini`,
      `${API_MANAGEMENT_BASE}/eu1/call/gpt-5-mini`
    ],
    other: [
      `${API_MANAGEMENT_BASE}/eu1/call/gpt-5-mini`,
      `${API_MANAGEMENT_BASE}/us2/call/gpt-5-mini`
    ]
  },
  gpt4omini: {
    europe: [
      `${API_MANAGEMENT_BASE}/eu1/gpt-4o-mini`,
      `${API_MANAGEMENT_BASE}/us2/gpt-4o-mini`
    ],
    northamerica: [
      `${API_MANAGEMENT_BASE}/us2/gpt-4o-mini`,
      `${API_MANAGEMENT_BASE}/eu1/gpt-4o-mini`
    ],
    asia: [
      `${API_MANAGEMENT_BASE}/eu1/gpt-4o-mini`,
      `${API_MANAGEMENT_BASE}/us2/gpt-4o-mini`
    ],
    southamerica: [
      `${API_MANAGEMENT_BASE}/eu1/gpt-4o-mini`,
      `${API_MANAGEMENT_BASE}/us2/gpt-4o-mini`
    ],
    africa: [
      `${API_MANAGEMENT_BASE}/eu1/gpt-4o-mini`,
      `${API_MANAGEMENT_BASE}/us2/gpt-4o-mini`
    ],
    oceania: [
      `${API_MANAGEMENT_BASE}/eu1/gpt-4o-mini`,
      `${API_MANAGEMENT_BASE}/us2/gpt-4o-mini`
    ],
    other: [
      `${API_MANAGEMENT_BASE}/eu1/gpt-4o-mini`,
      `${API_MANAGEMENT_BASE}/us2/gpt-4o-mini`
    ]
  },
  summarizegpt4omini: {
    europe: [
      `${API_MANAGEMENT_BASE}/eu1/summarize/gpt-4o-mini`,
      `${API_MANAGEMENT_BASE}/us2/summarize/gpt-4o-mini`
    ],
    northamerica: [
      `${API_MANAGEMENT_BASE}/us2/summarize/gpt-4o-mini`,
      `${API_MANAGEMENT_BASE}/eu1/summarize/gpt-4o-mini`
    ],
    asia: [
      `${API_MANAGEMENT_BASE}/eu1/summarize/gpt-4o-mini`,
      `${API_MANAGEMENT_BASE}/us2/summarize/gpt-4o-mini`
    ],
    southamerica: [
      `${API_MANAGEMENT_BASE}/eu1/summarize/gpt-4o-mini`,
      `${API_MANAGEMENT_BASE}/us2/summarize/gpt-4o-mini`
    ],
    africa: [
      `${API_MANAGEMENT_BASE}/eu1/summarize/gpt-4o-mini`,
      `${API_MANAGEMENT_BASE}/us2/summarize/gpt-4o-mini`
    ],
    oceania: [
      `${API_MANAGEMENT_BASE}/eu1/summarize/gpt-4o-mini`,
      `${API_MANAGEMENT_BASE}/us2/summarize/gpt-4o-mini`
    ],
    other: [
      `${API_MANAGEMENT_BASE}/eu1/summarize/gpt-4o-mini`,
      `${API_MANAGEMENT_BASE}/us2/summarize/gpt-4o-mini`
    ]
  }
};

function getEndpointsByTimezone(timezone, model = 'gpt4o', mode = 'call') {
  const tz = timezone?.split('/')[0]?.toLowerCase();
  const region = (() => {
    if (tz?.includes('america')) return 'northamerica';
    if (tz?.includes('europe')) return 'europe';
    if (tz?.includes('asia')) return 'asia';
    if (tz?.includes('africa')) return 'africa';
    if (tz?.includes('australia') || tz?.includes('pacific')) return 'oceania';
    return 'other';
  })();
  let suffix = mode === 'anonymized' ? 'anonymized' : 'call';
  console.log('model', model);
  if(model!='gpt4o' && mode == 'anonymized'){
    suffix = 'call';
  }
  const endpoints = endpointsMap[model]?.[region] || endpointsMap[model].other;
  return endpoints.map(endpoint => endpoint.replace('/call/', `/${suffix}/`));
}

async function callAiWithFailover(requestBody, timezone, model = 'gpt4o', retryCount = 0, dataRequest = null) {
    const RETRY_DELAY = 1000;
  
    const endpoints = getEndpointsByTimezone(timezone, model, 'call');
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

module.exports = {
  sanitizeAiData,
  sanitizeInput,
  getEndpointsByTimezone,
  callAiWithFailover,
  detectLanguageWithRetry,
  translateTextWithRetry,
  translateInvertWithRetry
}; 