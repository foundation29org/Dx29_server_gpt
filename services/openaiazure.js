
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
  //comprobar créditos del usuario


  (async () => {
    var jsonText = req.body.value;
    var timezone = req.body.timezone
    try {
      //if req.body.value contains orvosi, orvosok, or orvoshoz
      let pattern = /orvosi|orvosok|orvosként|Kizárólag|orvoshoz/i;
       let containsWord = pattern.test(req.body.value);
       let header_language = req.headers['accept-language']       
      if(containsWord || req.body.ip == '' || header_language.includes('hu-HU')){
        // La IP del cliente
        const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        const origin = req.get('origin');
        const requestInfo = {
            method: req.method,
            url: req.url,
            headers: req.headers,
            origin: origin,
            body: req.body, // Asegúrate de que el middleware para parsear el cuerpo ya haya sido usado
            ip: clientIp,
            params: req.params,
            query: req.query,
          };
        serviceEmail.sendMailErrorGPTIP(req.body.lang, req.body.value, "", req.body.ip, requestInfo)
        let result = 
          {
            "result": "bloqued"
          };
        res.status(200).send(result)
      }else{  
        const messages = [
          { role: "user", content: jsonText}
        ];

        const requestBody = {
          messages: messages,
          temperature: 0,
          max_tokens: 800,
          top_p: 1,
          frequency_penalty: 0,
          presence_penalty: 0,
        };

        let endpointUrl;
        if (timezone.includes("America")) {
            endpointUrl = 'https://apiopenai.azure-api.net/dxgptamerica/deployments';
        } else {
            endpointUrl = 'https://apiopenai.azure-api.net/dxgpt/deployments';
        }

        //const result = await client.getChatCompletions(deploymentId, messages, configCall);
        const result = await axios.post(endpointUrl, requestBody,{
            headers: {
                'Content-Type': 'application/json',
                'Ocp-Apim-Subscription-Key': ApiManagementKey,
            }
        }); 
        const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        const origin = req.get('origin');
        const requestInfo = {
            method: req.method,
            url: req.url,
            headers: req.headers,
            origin: origin,
            ip: clientIp,
            params: req.params,
            query: req.query,
          };
          
        //blobOpenDx29Ctrl.createBlobCallsOpenDx29(req.body, result.data, requestInfo);
        if (result.data.choices[0].message.content == undefined) {
            requestInfo.body = req.body;
            serviceEmail.sendMailErrorGPTIP(req.body.lang, req.body.value, result.data.choices, req.body.ip, requestInfo)
          }
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
      if(e.response.data.error.type == 'invalid_request_error'){
        //return 400 with the msg of the error
        res.status(400).send(e.response.data.error)
      }else{
        // La IP del cliente
        const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        const origin = req.get('origin');
        const requestInfo = {
            method: req.method,
            url: req.url,
            headers: req.headers,
            origin: origin,
            body: req.body, // Asegúrate de que el middleware para parsear el cuerpo ya haya sido usado
            ip: clientIp,
            params: req.params,
            query: req.query,
          };
        serviceEmail.sendMailErrorGPTIP(req.body.lang, req.body.value, e, req.body.ip, requestInfo)
          .then(response => {

          })
          .catch(response => {
            //create user, but Failed sending email.
            insights.error(response);
            console.log('Fail sending email');
          })

        res.status(500).send('error')
      }
      /*if (e.response.status === 429) {
        console.error("[ERROR] OpenAI responded with status: " + e.response.status)
          console.log("OpenAI Quota exceeded")
          //handle this case
      }*/
      
    }

  })();
}

async function callOpenAiAnonymized(req, res) {
  // Anonymize user message
  var jsonText = req.body.value;
  let timezone = req.body.timezone
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

    let endpointUrl;
        if (timezone.includes("America")) {
            endpointUrl = 'https://apiopenai.azure-api.net/dxgptamerica/anonymized';
        } else {
            endpointUrl = 'https://apiopenai.azure-api.net/dxgpt/anonymized';
        }
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
      topRelatedConditions: req.body.topRelatedConditions
    }
    blobOpenDx29Ctrl.createBlobOpenDx29(infoTrack);
    res.status(200).send(result.data)
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
  callOpenAiAnonymized,
  opinion,
  sendFeedback,
  sendGeneralFeedback,
  getFeedBack
}
