// functions for each call of the api on user. Use the user model

'use strict'

// add the user model
const Support = require('../../models/support')
const serviceEmail = require('../../services/email')

function sendMsgLogoutSupport(req, res){
			let support = new Support()
			//support.type = 'Home form'
			support.subject = 'DxGPT support'
			support.platform = 'DxGPT'
			support.description = 'Name: '+req.body.userName+', Email: '+ req.body.email+ ', Description: ' +req.body.description
			support.createdBy = "5c77d0492f45d6006c142ab3";
			// enviamos Email
			serviceEmail.sendMailSupport(req.body.email,req.body.lang, support)
					.then(response => {
						return res.status(200).send({ message: 'Email sent'})
					})
					.catch(response => {
						//create user, but Failed sending email.
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
				res.status(500).send({ message: 'Fail sending email'})
			})
}

module.exports = {
	sendMsgLogoutSupport,
	sendError
}
