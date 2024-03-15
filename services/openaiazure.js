
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

async function callOpenAi(req, res) {
  //comprobar créditos del usuario


  var jsonText = req.body.value;
  (async () => {
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

  
        //const result = await client.getChatCompletions(deploymentId, messages, configCall);
        const result = await axios.post('https://apiopenai.azure-api.net/dxgpt/deployments', requestBody,{
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

        res.status(500).send(e)
      }
      /*if (e.response.status === 429) {
        console.error("[ERROR] OpenAI responded with status: " + e.response.status)
          console.log("OpenAI Quota exceeded")
          //handle this case
      }*/
      
    }

  })();
}


async function callOpenAiBot(req, res) {
  
    try {
      var jsonText = req.body.value;
      let detectedLang = await detectLang(jsonText);
      console.log(detectedLang);
      if (detectedLang != 'en') {
        jsonText = await translateText(jsonText, detectedLang, 'en');
      }
      console.log(jsonText);
      let promt = "Behave like a hypotethical doctor who has to do a diagnosis for a patient. Give me a list of potential diseases with a short description. Shows for each potential diseases always with '+' and a number, starting with '+1', for example '+23.' (never return -), the name of the disease and finish with ':'. Dont return '-', return '+' instead. You have to indicate which symptoms the patient has in common with the proposed disease and which symptoms the patient does not have in common. The text is  Symptoms: "+jsonText;
      const messages = [
        { role: "user", content: promt}
      ];

      const requestBody = {
        messages: messages,
        temperature: 0,
        max_tokens: 800,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0,
      };


      //const result = await client.getChatCompletions(deploymentId, messages, configCall);
      const result = await axios.post('https://apiopenai.azure-api.net/dxgpt/deployments', requestBody,{
          headers: {
              'Content-Type': 'application/json',
              'Ocp-Apim-Subscription-Key': ApiManagementKey,
          }
      }); 
        
      //blobOpenDx29Ctrl.createBlobCallsOpenDx29(req.body, result.data, requestInfo);
      if (result.data.choices[0].message.content == undefined) {
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
          requestInfo.body = req.body;
          serviceEmail.sendMailErrorGPTIP(req.body.lang, req.body.value, result.data.choices, req.body.ip, requestInfo)
          res.status(200).send(result.data)
        }else{
          let responseOpenai = result.data.choices[0].message.content;
          if(detectedLang!='en'){
            //translateInvert
            responseOpenai = await translateText(result.data.choices[0].message.content, 'en', detectedLang);
          }
          let cleanString = cleanResponse(responseOpenai);
          let topRelatedConditions = parseDiseases(cleanString);
          res.status(200).send(topRelatedConditions)
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

        res.status(500).send(e)
      }
      
    }
}

async function questioncallopenai(req, res) {
  
  try {
    var jsonText = req.body.value;
    var option = req.body.option;
    var premedicalText = req.body.premedicalText;
    let detectedLang = await detectLang(jsonText);
    console.log(detectedLang);
    if (detectedLang != 'en') {
      jsonText = await translateText(jsonText, detectedLang, 'en');
    }
    let promt = '';
    if(option==1){
      promt = 'What are the common symptoms associated with '+jsonText+'? Please provide a list starting with the most probable symptoms at the top.'
    }else if(option==2){
      promt = 'Can you provide detailed information about '+ jsonText+' ? I am a doctor.';
    }else if(option==3){
      promt = 'Given the medical description: '+jsonText+'. , what are the potential symptoms not present in the patient that could help in making a differential diagnosis for '+jsonText + '. Please provide only a list, starting with the most likely symptoms at the top.';
    }else if(option==4){
        promt = premedicalText+'. Why do you think this patient has '+jsonText + '. Indicate the common symptoms with '+jsonText +' and the ones that he/she does not have';
    }

    console.log(jsonText);
    const messages = [
      { role: "user", content: promt}
    ];

    const requestBody = {
      messages: messages,
      temperature: 0,
      max_tokens: 800,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    };


    //const result = await client.getChatCompletions(deploymentId, messages, configCall);
    const result = await axios.post('https://apiopenai.azure-api.net/dxgpt/deployments', requestBody,{
        headers: {
            'Content-Type': 'application/json',
            'Ocp-Apim-Subscription-Key': ApiManagementKey,
        }
    }); 
      
    //blobOpenDx29Ctrl.createBlobCallsOpenDx29(req.body, result.data, requestInfo);
    if (result.data.choices[0].message.content == undefined) {
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
        requestInfo.body = req.body;
        serviceEmail.sendMailErrorGPTIP(req.body.lang, req.body.value, result.data.choices, req.body.ip, requestInfo)
        res.status(200).send(result.data)
      }else{
        let responseOpenai = result.data.choices[0].message.content;
        if(detectedLang!='en'){
          //translateInvert
          responseOpenai = await translateText(result.data.choices[0].message.content, 'en', detectedLang);
        }
        res.status(200).send({info: responseOpenai})
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

      res.status(500).send(e)
    }
    
  }
}

async function detectLang(jsonText) {
  // Debes devolver una promesa aquí, asegúrate de que `request.post` se maneje adecuadamente
  return new Promise((resolve, reject) => {
    const requestBody = [{ "text": jsonText }];
    request.post({ url: 'https://api.cognitive.microsofttranslator.com/detect?api-version=3.0', json: true, headers: { 'Ocp-Apim-Subscription-Key': translationKey, 'Ocp-Apim-Subscription-Region': 'northeurope' }, body: requestBody }, (error, response, body) => {
      if (error) {
        resolve('en');
      } else {
        resolve(body[0].language);
      }
    });
  });
}

async function translateText(jsonText, lang, toLang) {
  // Similar a detectLang, asegúrate de devolver una promesa
  return new Promise((resolve, reject) => {
    const requestBody = [{ "Text": jsonText }];
    let translatedText = jsonText;
    request.post({url:'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&&from='+lang+'&to='+toLang,json: true,headers: {'Ocp-Apim-Subscription-Key': translationKey, 'Ocp-Apim-Subscription-Region': 'northeurope' },body:requestBody}, (error, response, body) => {
      if (error) {
        resolve(translatedText);
      } else {
        resolve(body[0].translations[0].text);
      }
    });
  });
}

function cleanResponse(contentToParse){
  let parseChoices0 = contentToParse;
  if(contentToParse.indexOf("\n\n") > 0 && (contentToParse.indexOf("+") > contentToParse.indexOf("\n\n"))){
    parseChoices0 = contentToParse.split("\n\n");
    parseChoices0.shift();
    parseChoices0 = parseChoices0.toString();
  }else if(contentToParse.indexOf("\n") > 0 && (contentToParse.indexOf("+") > contentToParse.indexOf("\n"))){
      parseChoices0 = contentToParse.split("\n");
      parseChoices0.shift();
      parseChoices0 = parseChoices0.toString();
  }else if(contentToParse.indexOf("\n\n") == 0 && (contentToParse.indexOf("+") > contentToParse.indexOf("\n\n"))){
      parseChoices0 = contentToParse.substring(contentToParse.indexOf("+"));
  }else if(contentToParse.indexOf("\n") == 0 && (contentToParse.indexOf("+") > contentToParse.indexOf("\n"))){
      parseChoices0 = contentToParse.substring(contentToParse.indexOf("+"));
  }
  return parseChoices0;
}

function parseDiseases(cleanString){
  let parseChoices = cleanString;
  let topRelatedConditions = [];
  parseChoices = cleanString.split(/\+(?=\d)/);
  for (let i = 0; i < parseChoices.length; i++) {
    if (parseChoices[i] != '' && parseChoices[i] != "\n\n" && parseChoices[i] != "\n" && parseChoices[i].length>4) {
        topRelatedConditions.push({content:parseChoices[i], name: ''} )
    }
  }
  for (let i = 0; i < topRelatedConditions.length; i++) {
    let index = topRelatedConditions[i].content.indexOf(':');
    let index2 = topRelatedConditions[i].content.indexOf('<strong>');
    if (index != -1 && index2 == -1) {
        let firstPart = topRelatedConditions[i].content.substring(0, index + 1);
        let secondPart = topRelatedConditions[i].content.substring(index + 1, topRelatedConditions[i].content.length);
        if(secondPart == ''){
            topRelatedConditions.splice(i, 1);
            i--;
            continue;
        }
        let index3 = firstPart.indexOf('.');
        let namePart = firstPart.substring(index3+2, firstPart.length-1);        
        
        topRelatedConditions[i] = {content: '<strong>' + firstPart + '</strong>' + secondPart, name: namePart};
    }
  }
  return topRelatedConditions;
}

async function callOpenAiAnonymized(req, res) {
  // Anonymize user message
  var jsonText = req.body.value;
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

    const result = await axios.post('https://apiopenai.azure-api.net/dxgpt/anonymized', requestBody,{
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
    res.status(500).send(e)
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

      res.status(500).send(e)
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

      res.status(500).send(e)
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

      res.status(500).send(e)
    }

  })();
}

function getFeedBack(req, res) {
  /*Generalfeedback.aggregate([
    {
        $group: {
            _id: { pregunta1: "$pregunta1", pregunta2: "$pregunta2" },
            countPregunta1: { $sum: { $cond: [{ $eq: ["$pregunta1", "$pregunta1"] }, 1, 0] } },
            countPregunta2: { $sum: { $cond: [{ $eq: ["$pregunta2", "$pregunta2"] }, 1, 0] } }
        }
    }
], function(err, results) {
    if (err) {
        // Manejar el error como desees, por ejemplo:
        return res.status(500).send(err);
    }

    // Procesar los resultados para obtener un formato más amigable
    let countPregunta1 = {};
    let countPregunta2 = {};

    results.forEach(result => {
        countPregunta1[result._id.pregunta1] = result.countPregunta1;
        countPregunta2[result._id.pregunta2] = result.countPregunta2;
    });

    // Enviar los resultados
    res.status(200).send({
        pregunta1: countPregunta1,
        pregunta2: countPregunta2
    });
});*/

  /*Generalfeedback.find({}, function(err, generalfeedbackList) {
    var listPregunta1= [];
    var listPregunta2= [];

    generalfeedbackList.forEach(function(generalfeedback) {
      listPregunta1.push({name:generalfeedback.pregunta1});
      listPregunta2.push({name:generalfeedback.pregunta2});
    });
    res.status(200).send(listPregunta1)
  });*/

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
  callOpenAiBot,
  questioncallopenai,
  callOpenAiAnonymized,
  opinion,
  sendFeedback,
  sendGeneralFeedback,
  getFeedBack
}
