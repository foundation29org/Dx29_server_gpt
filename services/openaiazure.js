
const { OpenAIClient, AzureKeyCredential } = require("@azure/openai");
const config = require('../config')
const request = require('request')
const blobOpenDx29Ctrl = require('../services/blobOpenDx29')
const serviceEmail = require('../services/email')
const Support = require('../models/support')

const endpoint = config.AZURE_OPENAI_ENDPOINT;
const azureApiKey = config.AZURE_OPENAI_KEY;





async function callOpenAi (req, res){
  //comprobar créditos del usuario
  

  var jsonText = req.body.value;
  (async () => {
    try {

      const client = new OpenAIClient(endpoint, new AzureKeyCredential(azureApiKey));
    const deploymentId = "nav29";
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
    for (const choice of result.choices) {
      console.log(choice.message);
    }
      blobOpenDx29Ctrl.createBlobOpenDx29(req.body, result);
      res.status(200).send(result)
    }catch(e){
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
      serviceEmail.sendMailErrorGPT(req.body.lang, req.body.value, e)
					.then(response => {
            
					})
					.catch(response => {
						//create user, but Failed sending email.
						console.log('Fail sending email');
					})

      res.status(500).send(e)
    }
    
  })();
}

function opinion (req, res){

  (async () => {
    try {
      blobOpenDx29Ctrl.createBlobOpenVote(req.body);
      res.status(200).send({send: true})
    }catch(e){
      console.error("[ERROR] OpenAI responded with status: " + e)
      serviceEmail.sendMailErrorGPT(req.body.lang, req.body.value, e)
					.then(response => {
            
					})
					.catch(response => {
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
						console.log('Fail sending email');
					})


          let support = new Support()
          //support.type = 'Home form'
          support.subject = 'dxGPT vote down'
          support.subscribe= req.body.subscribe
          support.email = req.body.email
          support.description = req.body.info
          support.save((err, supportStored) => {
          })

      res.status(200).send({send: true})
    }catch(e){
      console.error("[ERROR] OpenAI responded with status: " + e)
      serviceEmail.sendMailErrorGPT(req.body.lang, req.body.value, e)
					.then(response => {
            
					})
					.catch(response => {
						//create user, but Failed sending email.
						console.log('Fail sending email');
					})

      res.status(500).send(e)
    }
    
  })();
}

module.exports = {
	callOpenAi,
  opinion,
  sendFeedback
}
