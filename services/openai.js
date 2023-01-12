const OpenAI = require('openai-api');
const config = require('../config')
const request = require('request')
const blobOpenDx29Ctrl = require('../services/blobOpenDx29')
const serviceEmail = require('../services/email')
const Support = require('../models/support')

// Load your key from an environment variable or secret management service
// (do not include your key directly in your code)
const OPENAI_API_KEY = config.OPENAI_API_KEY;

const openai = new OpenAI(OPENAI_API_KEY);


function callOpenAi (req, res){
  //comprobar créditos del usuario
  
  var jsonText = req.body.value;
  (async () => {
    try {
        const gptResponse = await openai.complete({
          engine: 'text-davinci-003',//davinci-instruct-beta-v3
          prompt: jsonText,
          maxTokens: 300,
          temperature: 0,
          topP: 1,
          presencePenalty: 0,
          frequencyPenalty: 0,
          bestOf: 1,
          n: 1,
          stream: false
      });
      blobOpenDx29Ctrl.createBlobOpenDx29(req.body, gptResponse.data);
      res.status(200).send(gptResponse.data)
    }catch(e){
      console.error("[ERROR]: " + e)
      if (e.response.status === 429) {
        console.error("[ERROR] OpenAI responded with status: " + e.response.status)
          console.log("OpenAI Quota exceeded")
          //handle this case
      }
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
          support.subject = 'DxGPT vote down'
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
