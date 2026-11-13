// functions for each call of the api on user. Use the user model

'use strict'

// add the user model
const Support = require('../../models/support')
const serviceEmail = require('../../services/email')
const insights = require('../../services/insights')
const { suspiciousContentErrors } = require('../../services/aiUtils')

function getHeader(req, name) {
	return req.headers[name.toLowerCase()];
  }

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
	if (typeof data.lang !== 'string' || data.lang.length < 2 || data.lang.length > 8) return false;
  
	// Verificar patrones sospechosos
	return suspiciousContentErrors({ userName: data.userName, description: data.description }).length === 0;
  }
  
  function sanitizeSupportData(data) {
	const sanitizeText = (text) => {
	  return text
		.replace(/[<>]/g, '')
		.replace(/(\{|\}|\||\\)/g, '')
		.replace(/prompt:|system:|assistant:|user:/gi, '')
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
	// Obtener headers
	const subscriptionId = getHeader(req, 'x-subscription-id');
	const tenantId = getHeader(req, 'X-Tenant-Id');

	// Validar que al menos uno de los dos headers esté presente
	// APIM convierte Ocp-Apim-Subscription-Key a x-subscription-id, tenants envían X-Tenant-Id
	if (!tenantId && !subscriptionId) {
		insights.error({
			message: "Missing required headers: at least one of X-Tenant-Id or Ocp-Apim-Subscription-Key is required",
			headers: req.headers,
			endpoint: 'sendMsgLogoutSupport'
		});
		return res.status(400).send({
			result: "error",
			message: "Missing required headers: at least one of X-Tenant-Id or Ocp-Apim-Subscription-Key is required"
		});
	}
	
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
		date: new Date(Date.now()).toString(),
		tenantId: tenantId,
		subscriptionId: subscriptionId,
		myuuid: sanitizedData.myuuid,
		lang: sanitizedData.lang
	  });
  
	  // Guardar en base de datos. Mongo es la única copia del mensaje (ya no se
	  // copia a SharePoint con Power Automate); el email a soporte es solo un aviso.
	  let saved = false;
	  try {
		await support.save();
		saved = true;
	  } catch (saveError) {
		console.log('Error saving support:', saveError);
		insights.error({
		  message: 'Error saving support message',
		  error: saveError && saveError.message,
		  operation: 'sendMsgLogoutSupport',
		  type: 'SUPPORT_SAVE_ERROR',
		  tenantId: tenantId,
		  subscriptionId: subscriptionId,
		  myuuid: sanitizedData.myuuid
		});
	  }

	  // Enviar email. Si falla con el mensaje ya guardado, el usuario no lo ha
	  // perdido: se responde bien y el fallo queda en App Insights.
	  let emailed = false;
	  try {
		await serviceEmail.sendMailSupport(
		  sanitizedData.email,
		  sanitizedData.lang,
		  support
		);
		emailed = true;
	  } catch (emailError) {
		insights.error({
		  message: 'Email to support failed',
		  error: emailError && emailError.message,
		  operation: 'sendMsgLogoutSupport',
		  type: 'SUPPORT_EMAIL_ERROR',
		  tenantId: tenantId,
		  subscriptionId: subscriptionId,
		  myuuid: sanitizedData.myuuid
		}, { messageSaved: String(saved) });
		console.log('Fail sending email');
	  }

	  // Solo es un fallo para el usuario si no ha quedado ni en Mongo ni en el email
	  if (!saved && !emailed) {
		return res.status(500).send({ message: 'Internal server error' });
	  }
	  return res.status(200).send({ message: saved ? 'Support message saved' : 'Email sent' });
  
	} catch (e) {
		let infoError = {
			body: req.body,
			error: e.message,
			type: e.code || 'SUPPORT_ERROR',
			tenantId: tenantId,
			subscriptionId: subscriptionId
		};
		insights.error(infoError);
		return res.status(500).send({ message: 'Internal server error' });
	}
  }

module.exports = {
	sendMsgLogoutSupport
}
