
const { OpenAIClient, AzureKeyCredential } = require("@azure/openai");
const config = require('../config')
const insights = require('../services/insights')
const request = require('request')
const blobOpenDx29Ctrl = require('../services/blobOpenDx29')
const serviceEmail = require('../services/email')
const Support = require('../models/support')
const Generalfeedback = require('../models/generalfeedback')
const axios = require('axios');
const ApiManagementKey = config.API_MANAGEMENT_KEY;
const translationKey = config.translationKey;
const supportService = require('../controllers/all/support');

async function callOpenAi(req, res) {
  const jsonText = req.body.value;
  const timezone = req.body.timezone;
  const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  const origin = req.get('origin');
  const header_language = req.headers['accept-language'];
  const requestInfo = {
    method: req.method,
    url: req.url,
    headers: req.headers,
    origin: origin,
    body: req.body, // Asegúrate de que el middleware para parsear el cuerpo ya haya sido usado
    ip: clientIp,
    params: req.params,
    query: req.query,
    header_language: header_language,
    timezone: timezone
  };
  try {
    if (req.body.ip === '' || req.body.ip === undefined) {
      await serviceEmail.sendMailErrorGPTIP(req.body.lang, req.body.value, "", req.body.ip, requestInfo);
      res.status(200).send({ result: "blocked" });
    } else {
      const messages = [{ role: "user", content: jsonText }];
      const requestBody = {
        messages: messages,
        temperature: 0,
        max_tokens: 800,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0,
      };

      const endpointUrl = timezone.includes("America") ?
        'https://apiopenai.azure-api.net/dxgptamerica/deployments' :
        'https://apiopenai.azure-api.net/dxgpt/deployments/gpt4o';

      const result = await axios.post(endpointUrl, requestBody, {
        headers: {
          'Content-Type': 'application/json',
          'Ocp-Apim-Subscription-Key': ApiManagementKey,
        }
      });
      if (!result.data.choices[0].message.content) {
        requestInfo.body = req.body;
        await serviceEmail.sendMailErrorGPTIP(req.body.lang, req.body.value, result.data.choices, req.body.ip, requestInfo);
        res.status(200).send({result: "error openai"});
      } else {
        try {
          let parsedData;
          parsedData = JSON.parse(result.data.choices[0].message.content.match(/<5_diagnosis_output>([\s\S]*?)<\/5_diagnosis_output>/)[1]);
          res.status(200).send({result: 'success', data: parsedData});
          return;
        } catch (e) {
            console.error("Failed to parse diagnosis output", e);
            res.status(200).send({result: "error"});
        }
        console.log(parsedData);
      }
    }
  } catch (e) {
    insights.error(e);
    console.log(e);

    if (e.response) {
      console.log(e.response.status);
      console.log(e.response.data);

      // Asegurarse de que e.response.data.error y e.response.data.error.type están definidos antes de acceder
      if (e.response.data && e.response.data.error && e.response.data.error.type === 'invalid_request_error') {
        res.status(400).send(e.response.data.error);
        return;
      }
    } else {
      console.log(e.message);
    }

    try {
      await serviceEmail.sendMailErrorGPTIP(req.body.lang, req.body.value, e, req.body.ip, requestInfo);
    } catch (emailError) {
      insights.error(emailError);
      console.log('Fail sending email');
    }

    res.status(500).send('Internal server error');
  }
}

async function callOpenAiQuestions(req, res) {
  const jsonText = req.body.value;
  const timezone = req.body.timezone;
  const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  const origin = req.get('origin');
  const header_language = req.headers['accept-language'];
  const requestInfo = {
    method: req.method,
    url: req.url,
    headers: req.headers,
    origin: origin,
    body: req.body, // Asegúrate de que el middleware para parsear el cuerpo ya haya sido usado
    ip: clientIp,
    params: req.params,
    query: req.query,
    header_language: header_language,
    timezone: timezone
  };
  try {
    if (req.body.ip === '' || req.body.ip === undefined) {
      await serviceEmail.sendMailErrorGPTIP(req.body.lang, req.body.value, "", req.body.ip, requestInfo);
      res.status(200).send({ result: "blocked" });
    } else {
      const messages = [{ role: "user", content: jsonText }];
      const requestBody = {
        messages: messages,
        temperature: 0,
        max_tokens: 800,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0,
      };

      const endpointUrl = timezone.includes("America") ?
        'https://apiopenai.azure-api.net/dxgptamerica/deployments' :
        'https://apiopenai.azure-api.net/dxgpt/deployments/gpt4o';

      const result = await axios.post(endpointUrl, requestBody, {
        headers: {
          'Content-Type': 'application/json',
          'Ocp-Apim-Subscription-Key': ApiManagementKey,
        }
      });
      
      if (!result.data.choices[0].message.content) {
        requestInfo.body = req.body;
        await serviceEmail.sendMailErrorGPTIP(req.body.lang, req.body.value, result.data.choices, req.body.ip, requestInfo);
        res.status(200).send({result: "error openai"});
      } else {
        res.status(200).send({result: 'success', data: result.data.choices[0].message.content});
      }  
    }
  } catch (e) {
    insights.error(e);
    console.log(e);

    if (e.response) {
      console.log(e.response.status);
      console.log(e.response.data);

      // Asegurarse de que e.response.data.error y e.response.data.error.type están definidos antes de acceder
      if (e.response.data && e.response.data.error && e.response.data.error.type === 'invalid_request_error') {
        res.status(400).send(e.response.data.error);
        return;
      }
    } else {
      console.log(e.message);
    }

    try {
      await serviceEmail.sendMailErrorGPTIP(req.body.lang, req.body.value, e, req.body.ip, requestInfo);
    } catch (emailError) {
      insights.error(emailError);
      console.log('Fail sending email');
    }

    res.status(500).send('Internal server error');
  }
}

async function callOpenAiAnonymized(req, res) {
  const header_language = req.headers['accept-language'];
  // Anonymize user message
  var jsonText = req.body.value;
  let timezone = req.body.timezone
  const requestInfo = {
    method: req.method,
    url: req.url,
    headers: req.headers,
    body: req.body,
    params: req.params,
    query: req.query,
    header_language: header_language,
    timezone: timezone
  };

  var anonymizationPrompt = `The task is to anonymize the following medical document by replacing any personally identifiable information (PII) with [ANON-N], 
  where N is the count of characters that have been anonymized. 
  Only specific information that can directly lead to patient identification needs to be anonymized. This includes but is not limited to: 
  full names, addresses, contact details, Social Security Numbers, and any unique identification numbers. 
  However, it's essential to maintain all medical specifics, such as medical history, diagnosis, treatment plans, and lab results, as they are not classified as PII. 
  The anonymized document should retain the integrity of the original content, apart from the replaced PII. 
  Avoid including any information that wasn't part of the original document and ensure the output reflects the original content structure and intent, albeit anonymized. 
  Here is the original document between the triple quotes:
  ----------------------------------------
  """
  ${jsonText}
  """
  ----------------------------------------
  ANONYMIZED DOCUMENT:"`;

  try {
    if (req.body.ip === '' || req.body.ip === undefined) {
      serviceEmail.sendMailErrorGPTIP(req.body.lang, req.body.value, "", req.body.ip, requestInfo);
      res.status(200).send({ result: "blocked" });
    }else{
      const messages = [
        { role: "user", content: anonymizationPrompt }
      ];
  
      const requestBody = {
        messages: messages,
        temperature: 0,
        max_tokens: 2000,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0,
      };
  

      const endpointUrl = timezone.includes("America") ?
      'https://apiopenai.azure-api.net/dxgptamerica/anonymized' :
      'https://apiopenai.azure-api.net/dxgpt/deployments/gpt4o';//endpointUrl = 'https://apiopenai.azure-api.net/dxgpt/anonymized';
      const result = await axios.post(endpointUrl, requestBody,{
          headers: {
              'Content-Type': 'application/json',
              'Ocp-Apim-Subscription-Key': ApiManagementKey,
          }
      }); 
  
      let infoTrack = {
        value: result.data,
        myuuid: req.body.myuuid,
        operation: req.body.operation,
        lang: req.body.lang,
        response: req.body.response,
        topRelatedConditions: req.body.topRelatedConditions,
        header_language: header_language,
        timezone: timezone
      }
      blobOpenDx29Ctrl.createBlobOpenDx29(infoTrack);
      res.status(200).send(result.data)
    }
    
  } catch (e) {
    insights.error(e);
    console.log(e)
    if (e.response) {
      console.log(e.response.status);
      console.log(e.response.data);
    } else {
      console.log(e.message);
    }
    console.error("[ERROR]: " + e)
    serviceEmail.sendMailErrorGPTIP(req.body.lang, req.body.value, e, req.body.ip, requestInfo);
    res.status(500).send('error')
  }
}

function opinion(req, res) {

  (async () => {
    try {
      blobOpenDx29Ctrl.createBlobOpenVote(req.body);
      res.status(200).send({ send: true })
    } catch (e) {
      insights.error(e);
      console.error("[ERROR] OpenAI responded with status: " + e)
      serviceEmail.sendMailErrorGPT(req.body.lang, req.body.value, e)
        .then(response => {

        })
        .catch(response => {
          insights.error(response);
          //create user, but Failed sending email.
          console.log('Fail sending email');
        })

      res.status(500).send('error')
    }

  })();
}

function sendFeedback(req, res) {

  (async () => {
    try {
      blobOpenDx29Ctrl.createBlobFeedbackVoteDown(req.body);
      serviceEmail.sendMailFeedback(req.body.email, req.body.lang, req.body.info)
        .then(response => {

        })
        .catch(response => {
          //create user, but Failed sending email.
          insights.error(response);
          console.log('Fail sending email');
        })


      let support = new Support()
      //support.type = 'Home form'
      support.subject = 'DxGPT vote down'
      support.subscribe = req.body.subscribe
      support.email = req.body.email
      support.description = req.body.info
      var d = new Date(Date.now());
      var a = d.toString();
      support.date = a;


      supportService.sendFlow(support, req.body.lang)
      support.save((err, supportStored) => {
      })

      res.status(200).send({ send: true })
    } catch (e) {
      insights.error(e);
      console.error("[ERROR] OpenAI responded with status: " + e)
      serviceEmail.sendMailErrorGPT(req.body.lang, req.body.value, e)
        .then(response => {

        })
        .catch(response => {
          insights.error(response);
          //create user, but Failed sending email.
          console.log('Fail sending email');
        })

      res.status(500).send('error')
    }

  })();
}

function sendGeneralFeedback(req, res) {

  (async () => {
    try {
      let generalfeedback = new Generalfeedback()
      generalfeedback.myuuid = req.body.myuuid
      generalfeedback.pregunta1 = req.body.value.pregunta1
      generalfeedback.pregunta2 = req.body.value.pregunta2
      generalfeedback.userType = req.body.value.userType
      generalfeedback.moreFunct = req.body.value.moreFunct
      generalfeedback.freeText = req.body.value.freeText
      generalfeedback.email = req.body.value.email
      var d = new Date(Date.now());
			var a = d.toString();
			generalfeedback.date = a;
      sendFlow(generalfeedback, req.body.lang)
      generalfeedback.save((err, generalfeedbackStored) => {
      })
      serviceEmail.sendMailGeneralFeedback(req.body.value, req.body.myuuid)
        .then(response => {

        })
        .catch(response => {
          insights.error(response);
          //create user, but Failed sending email.
          console.log('Fail sending email');
        })

      res.status(200).send({ send: true })
    } catch (e) {
      insights.error(e);
      console.error("[ERROR] OpenAI responded with status: " + e)
      serviceEmail.sendMailErrorGPT(req.body.lang, req.body, e)
        .then(response => {

        })
        .catch(response => {
          insights.error(response);
          //create user, but Failed sending email.
          console.log('Fail sending email');
        })

      res.status(500).send('error')
    }

  })();
}

async function sendFlow(generalfeedback, lang){
	let requestBody = {
    myuuid: generalfeedback.myuuid,
    pregunta1: generalfeedback.pregunta1,
    pregunta2: generalfeedback.pregunta2,
    userType: generalfeedback.userType,
    moreFunct: generalfeedback.moreFunct,
    freeText: generalfeedback.freeText,
    date: generalfeedback.date,
    email: generalfeedback.email,
    lang: lang
  }
  
	let endpointUrl = 'https://prod-180.westeurope.logic.azure.com:443/workflows/28e2bf2fb424494f8f82890efb4fcbbf/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=WwF6wOV9cd4n1-AIfPZ4vnRmWx_ApJDXJH2QdtvK2BU'

	try {
        await axios.post(endpointUrl, requestBody, {
            headers: {
                'Content-Type': 'application/json'
            }
        });
    } catch (error) {
		console.log(error)
        console.error('Error al enviar datos:', error.message);
    }

}

function getFeedBack(req, res) {

  Generalfeedback.find({}, function (err, generalfeedbackList) {
    let frecuenciasP1 = {};
    let frecuenciasP2 = {};
    generalfeedbackList.forEach(function (doc) {
      let p1 = doc.pregunta1;
      let p2 = doc.pregunta2;

      if (frecuenciasP1[p1]) {
        frecuenciasP1[p1]++;
      } else {
        frecuenciasP1[p1] = 1;
      }

      if (frecuenciasP2[p2]) {
        frecuenciasP2[p2]++;
      } else {
        frecuenciasP2[p2] = 1;
      }
    });

    res.status(200).send({
      pregunta1: frecuenciasP1,
      pregunta2: frecuenciasP2
    });
  })

}

module.exports = {
  callOpenAi,
  callOpenAiQuestions,
  callOpenAiAnonymized,
  opinion,
  sendFeedback,
  sendGeneralFeedback,
  getFeedBack
}
