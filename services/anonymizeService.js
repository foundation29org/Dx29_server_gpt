const { getEndpointsByTimezone } = require('./aiUtils');
const insights = require('./insights');
const axios = require('axios');
const { encodingForModel } = require("js-tiktoken");

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function calculateMaxTokensAnon(jsonText) {
  const enc = encodingForModel("gpt-4o");
  const patientDescriptionTokens = enc.encode(jsonText).length;
  return patientDescriptionTokens + 100;
}

async function anonymizeText(text, timezone, tenantId, subscriptionId, myuuid, model = 'gpt54mini') {
  const RETRY_DELAY = 1000;
  const endpoints = getEndpointsByTimezone(timezone, model);
  const devInstruction = `
You are a medical text anonymizer. Remove ONLY direct identifiers of a specific person or healthcare facility.

ANONYMIZE:
- Personal names of a specific patient, relative, or clinician when context indicates a person (e.g. "John Smith", "Dr. Neha Verma", "Varón de 55 años (José)"), even if lowercase.
- Street addresses, postal/ZIP codes, phone numbers, emails, and clinic websites.
- Government IDs (DNI/NIE/SSN), medical record/request numbers (MRN/NHC), and clinician license numbers (e.g. "Lic. 48291", "Col. 12345").
- Specific hospital or clinic names in patient reports or prescriptions.

DO NOT ANONYMIZE (preserve all clinical content):
- Ages, dates of birth, and clinical/test/vaccination dates or years.
- Diagnoses, symptoms, lab/imaging results, vital signs, gene symbols/variants, vaccine lot numbers, and device names.
- Medications (generic, brand, or suffixed brands like "-AH", "-XR", "-OD", "-Max").
- Medical eponyms: scores/indices/scales (e.g. Walter, Glasgow, Barthel), textbooks/authors/theories (e.g. Miller's, Morgan & Mikhail, Orem), diseases/signs, medical typos, or food/diet terms.
- General city/region names or hospital acronyms in protocol/vaccination queries (e.g. "HULP", "Huesca").
- Never anonymize a standalone word in a short query without personal/demographic/clinical-role context. When in doubt, DO NOT anonymize.

If no direct identifiers exist, return the text IDENTICAL.
Replace ONLY each identifier span with [ANON-N] (N = exact character count replaced). Leave existing *** or [ANON-N] unchanged. Never use asterisks (*) or add explanations.
`;

  const anonymizationPrompt = `
Anonymize the following medical text according to the rules above.

Original text:
{{text}}
`;

  const messages = [
    { role: "developer", content: devInstruction },
    { role: "user", content: anonymizationPrompt.replace("{{text}}", text) }
  ];
  let requestBody = {
    messages,
    temperature: 0,
    max_tokens: calculateMaxTokensAnon(text),
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  if(model=='gpt5nano'){
    requestBody = {
      model: "gpt-5-nano",
      messages: [
        { role: "developer", content: devInstruction },
        { role: "user", content: anonymizationPrompt.replace("{{text}}", text) }
      ],
      reasoning_effort: "low" //minimal, low, medium, high
    };
  }else if(model=='gpt5mini'){
    requestBody = {
      model: "gpt-5-mini",
      messages: [
        { role: "developer", content: devInstruction },
        { role: "user", content: anonymizationPrompt.replace("{{text}}", text) }
      ],
      reasoning_effort: "minimal" //minimal, low, medium, high
    };
  }else if(model=='gpt54mini'){
    requestBody = {
      model: "gpt-5.4-mini",
      messages: [
        { role: "developer", content: devInstruction },
        { role: "user", content: anonymizationPrompt.replace("{{text}}", text) }
      ],
      reasoning_effort: "minimal" //minimal, low, medium, high
    };
  }

  async function tryEndpoint(endpoint) {
    // El endpoint ahora es un objeto { url, apiKey }
    if (!endpoint || !endpoint.url || !endpoint.apiKey) {
      throw new Error('Endpoint no configurado o inválido');
    }

    const requestBodyCopy = { ...requestBody };
    if (requestBodyCopy.model) {
      delete requestBodyCopy.model;
    }

    const result = await axios.post(
      endpoint.url,
      requestBodyCopy,
      {
        headers: {
          'Content-Type': 'application/json',
          'api-key': endpoint.apiKey
        }
      }
    );
    return result;
  }

  let result;
  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i];
    try {
      result = await tryEndpoint(endpoint);
      break; // Si la llamada es exitosa, salimos del bucle
    } catch (error) {
      if (i === endpoints.length - 1) {
        // Si es el último endpoint, propagamos el error
        throw error;
      }
      const endpointUrl = endpoint?.url || '[endpoint no configurado]';
      console.log(`Failed to call ${endpointUrl}, retrying with next endpoint in ${RETRY_DELAY}ms...`);
      insights.error({
        message: `Failed to call anonymization endpoint ${endpointUrl}`,
        error: error.message,
        retryCount: i,
        operation: 'anonymizeText',
        requestData: text,
        model: model,
        timezone: timezone,
        tenantId: tenantId,
        subscriptionId: subscriptionId,
        myuuid: myuuid
      });
      await delay(RETRY_DELAY);
    }
  }

  const resultResponse = {
    hasPersonalInfo: false,
    anonymizedText: '',
    markdownText: '',
    htmlText: '',
    usage: result?.data?.usage || null
  };

  const content = result?.data?.choices?.[0]?.message?.content;
  // Verificar si existe el contenido
  if (content) {
    const response = content.trim().replace(/^"""\s*|\s*"""$/g, '');
    const parts = response.split(/(\[ANON-\d+\])/g);
    resultResponse.hasPersonalInfo = parts.length > 1;

    resultResponse.anonymizedText = parts.map(part => {
      const match = part.match(/\[ANON-(\d+)\]/);
      return match ? '*'.repeat(parseInt(match[1])) : part;
    }).join('');

    // Versión segura para Markdown: usar bloques negros Unicode (sin HTML)
    resultResponse.markdownText = parts.map(part => {
      const match = part.match(/\[ANON-(\d+)\]/);
      return match ? '█'.repeat(parseInt(match[1])) : part;
    }).join('');

    resultResponse.htmlText = response;
    /*resultResponse.htmlText = parts.map(part => {
      const match = part.match(/\[ANON-(\d+)\]/);
      return match
        ? `<span style="background-color: black; display: inline-block; width:${parseInt(match[1])}em;">&nbsp;</span>`
        : part;
    }).join('').replace(/\n/g, '<br>');*/
  }
  return resultResponse;
}

module.exports = {
  anonymizeText
}; 