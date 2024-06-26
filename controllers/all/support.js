// functions for each call of the api on user. Use the user model

'use strict'

// add the user model
const Support = require('../../models/support')
const serviceEmail = require('../../services/email')
const insights = require('../../services/insights')
const axios = require('axios');

function sendMsgLogoutSupport(req, res){
			let support = new Support()
			//support.type = 'Home form'
			support.subject = 'DxGPT support'
			support.email = req.body.email
			support.description = 'Name: '+req.body.userName+', Email: '+ req.body.email+ ', Description: ' +req.body.description
			var d = new Date(Date.now());
			var a = d.toString();
			support.date = a;
			support.subscribe = false

			sendFlow(support, req.body.lang)
			support.save((err, supportStored) => {
			})
			// enviamos Email
			serviceEmail.sendMailSupport(req.body.email,req.body.lang, support)
					.then(response => {
						return res.status(200).send({ message: 'Email sent'})
					})
					.catch(response => {
						//create user, but Failed sending email.
						insights.error(response);
						res.status(500).send({ message: 'Fail sending email'})
					})
}


async function sendFlow(support, lang){
	let requestBody = {
		subject: support.subject,
		subscribe: support.subscribe.toString(),
		email: support.email,
		description: support.description,
		date: support.date,
		lang: lang
	}
	let endpointUrl = 'https://prod-208.westeurope.logic.azure.com:443/workflows/2e5021f1e8764cacb7a60a58bfe1f1db/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=QdRU50xndaLmf47VpR77saF2U_AzJx1W3z6cupllejo'

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

function sendMsSubscribe(req, res){
	let support = new Support()
	//support.type = 'Home form'
	support.subject = 'DxGPT msg'
	support.subscribe= req.body.subscribe
	support.email = req.body.email
	support.description = req.body.description
	var d = new Date(Date.now());
	var a = d.toString();
	support.date = a;
	sendFlow(support, req.body.lang)
	support.save((err, supportStored) => {
	})
	// enviamos Email
	serviceEmail.sendMailSupport(req.body.email,req.body.lang, support)
			.then(response => {
				return res.status(200).send({ message: 'Email sent'})
			})
			.catch(response => {
				//create user, but Failed sending email.
				insights.error(response);
				res.status(500).send({ message: 'Fail sending email'})
			})
}

function sendError(req, res){
	// enviamos Email
	serviceEmail.sendMailError(req.body.value,req.body.lang)
			.then(response => {
				return res.status(200).send({ message: 'Email sent'})
			})
			.catch(response => {
				//create user, but Failed sending email.
				insights.error(response);
				res.status(500).send({ message: 'Fail sending email'})
			})
}

module.exports = {
	sendMsgLogoutSupport,
	sendMsSubscribe,
	sendError,
	sendFlow
}
