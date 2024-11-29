// functions for each call of the api on user. Use the user model

'use strict'

// add the user model
const Support = require('../../models/support')
const serviceEmail = require('../../services/email')
const insights = require('../../services/insights')
const axios = require('axios');
const config = require('../../config')

function isValidSupportData(data) {
	if (!data || typeof data !== 'object') return false;
  
	// Validar campos requeridos
	const requiredFields = ['subscribe', 'email', 'userName', 'description', 'lang'];
	if (!requiredFields.every(field => data.hasOwnProperty(field))) return false;
  
	// Validar email
	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	if (!emailRegex.test(data.email)) return false;
  
	// Validar userName
	if (typeof data.userName !== 'string' || 
		data.userName.length < 2 || 
		data.userName.length > 100) return false;
  
	// Validar description
	if (typeof data.description !== 'string' ||
		data.description.length > 2000) return false;
  
	// Validar subscribe
	if (typeof data.subscribe !== 'boolean') return false;
  
	// Validar lang
	if (typeof data.lang !== 'string' || data.lang.length !== 2) return false;
  
	// Verificar patrones sospechosos
	const suspiciousPatterns = [
	  /\{\{.*\}\}/,  // Handlebars syntax
	  /<script.*?>.*?<\/script>/gis,  // Scripts
	  /\$\{.*\}/,    // Template literals
	  /prompt|system|assistant|user/gi  // OpenAI keywords
	];
  
	return !suspiciousPatterns.some(pattern => 
	  pattern.test(data.userName) || 
	  pattern.test(data.description)
	);
  }
  
  function sanitizeSupportData(data) {
	const sanitizeText = (text) => {
	  return text
		.replace(/[<>]/g, '')
		.replace(/(\{|\}|\||\\)/g, '')
		.replace(/prompt|system|assistant|user/gi, '')
		.trim();
	};
  
	return {
	  ...data,
	  email: data.email.trim().toLowerCase(),
	  userName: sanitizeText(data.userName),
	  description: sanitizeText(data.description),
	  lang: data.lang.trim().toLowerCase(),
	  subscribe: !!data.subscribe // Asegura que sea booleano
	};
  }

  async function sendMsgLogoutSupport(req, res) {
	try {
	  // Validar los datos de entrada
	  if (!isValidSupportData(req.body)) {
		return res.status(400).send({ 
		  result: "error", 
		  message: "Invalid support data format or content" 
		});
	  }
  
	  // Sanitizar los datos
	  const sanitizedData = sanitizeSupportData(req.body);
  
	  // Crear objeto de soporte
	  const support = new Support({
		subject: 'DxGPT support',
		subscribe: sanitizedData.subscribe,
		email: sanitizedData.email,
		description: `Name: ${sanitizedData.userName}, Email: ${sanitizedData.email}, Description: ${sanitizedData.description}`,
		date: new Date(Date.now()).toString()
	  });
  
	  // Enviar al flujo (sin esperar respuesta)
	  sendFlow(support, sanitizedData.lang);
  
	  // Guardar en base de datos (sin esperar respuesta)
	  support.save((err, supportStored) => {
		if (err) {
		  console.log('Error saving support:', err);
		}
	  });
  
	  // Enviar email
	  try {
		await serviceEmail.sendMailSupport(
		  sanitizedData.email,
		  sanitizedData.lang, 
		  support
		);
		return res.status(200).send({ message: 'Email sent' });
	  } catch (emailError) {
		insights.error(emailError);
		return res.status(500).send({ message: 'Fail sending email' });
	  }
  
	} catch (e) {
	  insights.error(e);
	  return res.status(500).send({ message: 'Internal server error' });
	}
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

	const endpointUrl = config.client_server.indexOf('dxgpt.app') === -1
    ? 'https://prod-186.westeurope.logic.azure.com:443/workflows/9dae9a0707e5452abbc7173b05277df6/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=sobGleGrapNnnf5SIgVtX6PmC7Bhzn5oTKPv9MluGwM'
    : 'https://prod-208.westeurope.logic.azure.com:443/workflows/2e5021f1e8764cacb7a60a58bfe1f1db/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=QdRU50xndaLmf47VpR77saF2U_AzJx1W3z6cupllejo';


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

module.exports = {
	sendMsgLogoutSupport,
	sendFlow
}
