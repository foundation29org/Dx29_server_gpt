const { getEndpointsByTimezone } = require('./aiUtils');
const ApiManagementKey = require('../config').API_MANAGEMENT_KEY;
const insights = require('./insights');
const axios = require('axios');
const { encodingForModel } = require("js-tiktoken");

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function calculateMaxTokensAnon(jsonText) {
  const enc = encodingForModel("gpt-4o");
  const patientDescriptionTokens = enc.encode(jsonText).length;
  return patientDescriptionTokens + 100;
}

async function anonymizeText(text, timezone, tenantId, subscriptionId, myuuid, model = 'gpt5mini') {
  const RETRY_DELAY = 1000;
  const endpoints = getEndpointsByTimezone(timezone, model);
  const devInstruction = `
You are a medical text anonymizer.

Your ONLY job is to remove direct identifiers of a person.

DIRECT IDENTIFIERS (anonymize):
- Full personal names (e.g. "John Smith", "María García").
- Full postal addresses.
- Phone numbers.
- Email addresses.
- Government IDs (DNI/NIE/passport/SSN, etc.).
- Medical record numbers (MRN/NHC, etc.).

DO NOT anonymize:
- Ages (e.g. "14-year-old").
- Clinical event dates (e.g. seizure dates, admission dates, test dates), or years.
- Diagnoses, symptoms, lab results, imaging findings, vital signs.
- Gene symbols/variants (e.g. SCN1A, c.4126T>C, p.Cys1376Arg).
- Medication names (generic or brand: valproate, Diacomit, Depakine, etc.).
- Device/orthosis/product names (e.g. FODA).

If the text contains NO direct identifiers according to this list, return it IDENTICAL.

When you anonymize a span, replace ONLY that span with [ANON-N],
where N is the exact count of replaced characters in that span.

Never use asterisks (*). Never add explanations or extra text.
`;

  const anonymizationPrompt = `
Anonymize the following medical text according to the rules above.

Original text:
{{text}}
`;

  const messages = [
    //{ role: "developer", content: devInstruction },
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
  }

  async function tryEndpoint(endpointUrl) {
    const result = await axios.post(
      endpointUrl,
      requestBody,
      {
        headers: {
          'Content-Type': 'application/json',
          'Ocp-Apim-Subscription-Key': ApiManagementKey,
        }
      }
    );
    return result;
  }

  let result;
  for (let i = 0; i < endpoints.length; i++) {
    try {
      result = await tryEndpoint(endpoints[i]);
      break; // Si la llamada es exitosa, salimos del bucle
    } catch (error) {
      if (i === endpoints.length - 1) {
        // Si es el último endpoint, propagamos el error
        throw error;
      }
      console.log(`Failed to call ${endpoints[i]}, retrying with next endpoint in ${RETRY_DELAY}ms...`);
      insights.error({
        message: `Failed to call anonymization endpoint ${endpoints[i]}`,
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

    resultResponse.htmlText = parts.map(part => {
      const match = part.match(/\[ANON-(\d+)\]/);
      return match
        ? `<span style="background-color: black; display: inline-block; width:${parseInt(match[1])}em;">&nbsp;</span>`
        : part;
    }).join('').replace(/\n/g, '<br>');
  }

  return resultResponse;
}

module.exports = {
  anonymizeText
}; 