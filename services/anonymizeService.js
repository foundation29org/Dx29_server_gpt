const { getEndpointsByTimezone } = require('./aiUtils');
const ApiManagementKey = require('../config').API_MANAGEMENT_KEY;
const insights = require('./insights');
const axios = require('axios');
const { encodingForModel } = require("js-tiktoken");

function calculateMaxTokensAnon(jsonText) {
  const enc = encodingForModel("gpt-4o");
  const patientDescriptionTokens = enc.encode(jsonText).length;
  return patientDescriptionTokens + 100;
}

async function anonymizeText(text, timezone, tenantId, subscriptionId, myuuid) {
  const RETRY_DELAY = 1000;

  const endpoints = getEndpointsByTimezone(timezone, 'gpt4o', 'anonymized');

  const anonymizationPrompt = `The task is to anonymize the following medical document by replacing any personally identifiable information (PII) with [ANON-N], 
  where N is the count of characters that have been anonymized. 
  Only specific information that can directly lead to patient identification needs to be anonymized. This includes but is not limited to: 
  full names, addresses, contact details, Social Security Numbers, and any unique identification numbers. 
  However, it's essential to maintain all medical specifics, such as medical history, diagnosis, treatment plans, and lab results, as they are not classified as PII. 
  Note: Do not anonymize age, as it is not considered PII in this context. 
  The anonymized document should retain the integrity of the original content, apart from the replaced PII. 
  Avoid including any information that wasn't part of the original document and ensure the output reflects the original content structure and intent, albeit anonymized. 
  If any part of the text is already anonymized (represented by asterisks or [ANON-N]), do not anonymize it again. 
  Here is the original document:

  {{text}}

  ANONYMIZED DOCUMENT:"`;

  const messages = [{ role: "user", content: anonymizationPrompt.replace("{{text}}", text) }];
  const requestBody = {
    messages,
    temperature: 0,
    max_tokens: calculateMaxTokensAnon(text),
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

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
        model: 'gpt4o',
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