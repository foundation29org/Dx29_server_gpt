const OpenAI = require('openai-api');
const config = require('../config')
const request = require('request')
const blobOpenDx29Ctrl = require('../services/blobOpenDx29')

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
          maxTokens: 256,
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
      console.error("[ERROR] OpenAI responded with status: " + e.response.status)
      if (e.response.status === 429) {
          console.log("OpenAI Quota exceeded")
          //handle this case
      }
      serviceEmail.sendMailErrorGPT(req.body.lang, req.body.value, e.response)
					.then(response => {
						console.log('Email sent')
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
	callOpenAi
}
