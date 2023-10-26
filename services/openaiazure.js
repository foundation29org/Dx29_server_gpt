
const { OpenAIClient, AzureKeyCredential } = require("@azure/openai");
const config = require('../config')
const insights = require('../services/insights')
const request = require('request')
const blobOpenDx29Ctrl = require('../services/blobOpenDx29')
const serviceEmail = require('../services/email')
const Support = require('../models/support')
const Generalfeedback = require('../models/generalfeedback')

const endpoint = config.AZURE_OPENAI_ENDPOINT;
const azureApiKey = config.AZURE_OPENAI_KEY;

async function callOpenAi (req, res){
  //comprobar créditos del usuario
  

  var jsonText = req.body.value;
  (async () => {
    try {

      const client = new OpenAIClient(endpoint, new AzureKeyCredential(azureApiKey));
    const deploymentId = "normalcalls";
    const messages = [
      { role: "user", content: jsonText}
    ];

    const configCall = {
      temperature: 0,
      max_tokens: 800,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0
    }

    const result = await client.getChatCompletions(deploymentId, messages, configCall);
    /*for (const choice of result.choices) {
      console.log(choice.message);
    }*/
      //blobOpenDx29Ctrl.createBlobOpenDx29(req.body, result);
      if(result.choices[0].message.content == undefined){
        //send email
        serviceEmail.sendMailErrorGPTIP(req.body.lang, req.body.value, result.choices, req.body.ip)
      }
      res.status(200).send(result)
    }catch(e){
      insights.error(e);
      console.log(e)
      if (e.response) {
        console.log(e.response.status);
        console.log(e.response.data);
      } else {
        console.log(e.message);
      }
      console.error("[ERROR]: " + e)
      /*if (e.response.status === 429) {
        console.error("[ERROR] OpenAI responded with status: " + e.response.status)
          console.log("OpenAI Quota exceeded")
          //handle this case
      }*/
      serviceEmail.sendMailErrorGPTIP(req.body.lang, req.body.value, e, req.body.ip)
					.then(response => {
            
					})
					.catch(response => {
						//create user, but Failed sending email.
            insights.error(response);
						console.log('Fail sending email');
					})

      res.status(500).send(e)
    }
    
  })();
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

    const client = new OpenAIClient(endpoint, new AzureKeyCredential(azureApiKey));
    const deploymentId = "anonymized";

    const messages = [
      { role: "user", content: anonymizationPrompt}
    ];

    const configCall = {
      temperature: 0,
      max_tokens: 2000,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0
    }

    const result = await client.getChatCompletions(deploymentId, messages, configCall);
    let infoTrack = {
      value: result,
      myuuid: req.body.myuuid,
      operation: req.body.operation,
      lang: req.body.lang,
      response: req.body.response
    }
    blobOpenDx29Ctrl.createBlobOpenDx29(infoTrack);
    res.status(200).send(result)
  } catch(e) {
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

function opinion (req, res){

  (async () => {
    try {
      blobOpenDx29Ctrl.createBlobOpenVote(req.body);
      res.status(200).send({send: true})
    }catch(e){
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

function sendFeedback (req, res){

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
          support.subscribe= req.body.subscribe
          support.email = req.body.email
          support.description = req.body.info
          support.save((err, supportStored) => {
          })

      res.status(200).send({send: true})
    }catch(e){
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

function sendGeneralFeedback (req, res){

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

      res.status(200).send({send: true})
    }catch(e){
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

function getFeedBack(req, res){
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

  Generalfeedback.find({}, function(err, generalfeedbackList) {
    let frecuenciasP1 = {}; 
    let frecuenciasP2 = {};
    generalfeedbackList.forEach(function(doc) {
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
