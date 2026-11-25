'use strict'

// Avisos internos a soporte (mensajes de soporte, errores de GPT y feedback
// general). Se envían por la API de SendGrid, como billing-fn, en lugar de por
// SMTP de Office 365 con autenticación básica. Las plantillas Handlebars de
// views/email no cambian.

const path = require('path')
const sgMail = require('@sendgrid/mail')
const { create } = require('express-handlebars')
const config = require('../config')
const insights = require('../services/insights')

// config.js no está en git: si una copia local aún no tiene el bloque EMAIL,
// se leen las mismas variables de entorno.
const EMAIL = config.EMAIL || {
  sendgridApiKey: process.env.SENDGRID_API_KEY || '',
  to: process.env.EMAIL_USER || '',
  from: process.env.SENDGRID_FROM_EMAIL || process.env.EMAIL_USER || ''
}

const VIEWS_DIR = path.join(__dirname, '..', 'views', 'email')

const viewEngine = create({
  extname: '.hbs',
  layoutsDir: VIEWS_DIR,
  defaultLayout: 'template'
})

let apiKeyLoaded = ''

function renderTemplate(template, context) {
  return viewEngine.renderView(path.join(VIEWS_DIR, template + '.hbs'), context)
}

async function deliver(subject, template, context) {
  try {
    if (!EMAIL.sendgridApiKey) {
      throw new Error('SENDGRID_API_KEY no está configurada')
    }
    if (!EMAIL.to || !EMAIL.from) {
      throw new Error('EMAIL_USER no está configurada')
    }
    if (apiKeyLoaded !== EMAIL.sendgridApiKey) {
      sgMail.setApiKey(EMAIL.sendgridApiKey)
      apiKeyLoaded = EMAIL.sendgridApiKey
    }

    const html = await renderTemplate(template, context)
    const msg = {
      // Antes iba también en copia oculta a la misma dirección; SendGrid
      // rechaza una dirección repetida entre to y bcc, y no aportaba nada.
      to: EMAIL.to,
      from: EMAIL.from,
      subject: subject,
      html: html,
      // Que SendGrid no reescriba los enlaces ni añada píxel de apertura:
      // el cuerpo llega igual que con SMTP.
      trackingSettings: {
        clickTracking: { enable: false, enableText: false },
        openTracking: { enable: false }
      }
    }
    if (EMAIL.from.toLowerCase() !== EMAIL.to.toLowerCase()) {
      msg.replyTo = EMAIL.to
    }

    await sgMail.send(msg)
    return 'ok'
  } catch (error) {
    // Ni la clave ni el cuerpo del mensaje: solo lo que hace falta para saber
    // por qué falló. Sin propiedad "errors", que insights trata como un 400.
    const sendgridErrors = error && error.response && error.response.body && error.response.body.errors
    insights.error({
      message: 'Fail sending email',
      error: error && error.message,
      stack: error && error.stack,
      operation: 'sendEmail',
      type: 'EMAIL_SEND_ERROR',
      code: error && error.code
    }, {
      template: template,
      sendgridErrors: sendgridErrors ? JSON.stringify(sendgridErrors) : ''
    })
    console.log('Fail sending email:', error && error.message)
    throw {
      status: 401,
      message: 'Fail sending email'
    }
  }
}

function sendMailSupport (email, lang, supportStored){
  let subject = 'Mensaje para soporte de DxGPT';
  if(supportStored.tenantId){
    subject += ' (' + supportStored.tenantId + ')';
  }
  if(supportStored.subscriptionId){
    subject += ' (' + supportStored.subscriptionId + ')';
  }
  return deliver(subject, 'mail_support/_es', {
    email : email,
    lang : lang,
    info: supportStored.toObject()
  })
}

function sendMailError (lang, req, response){
  return deliver('Mensaje para soporte de DxGPT - Error GPT', 'mail_error/_es', {
    lang : lang,
    info: JSON.stringify(req),
    response: JSON.stringify(response)
  })
}

function sendMailErrorGPTIP (lang, req, response, tenantId, subscriptionId){
  let subject = 'Mensaje para soporte de DxGPT - Error GPT';
  if (tenantId) {
    subject = `Mensaje para soporte de DxGPT - Error GPT (${tenantId})`;
  }
  if (subscriptionId) {
    subject += ' - ' + subscriptionId;
  }

  // Manejar caso donde req o response pueden ser strings
  const infoString = typeof req === 'string' ? req : JSON.stringify(req);
  const responseString = typeof response === 'string' ? response : JSON.stringify(response);

  return deliver(subject, 'mail_error_gpt_ip/_es', {
    lang : lang,
    info: infoString,
    response: responseString,
    tenantId: tenantId || '',
    subscriptionId: subscriptionId || ''
  })
}

function sendMailGeneralFeedback (info, myuuid, tenantId, subscriptionId, fileNames, model, isBetaPage){
  let subject = 'Mensaje para soporte de DxGPT - Feedback General';
  if(tenantId){
    subject += ' (' + tenantId + ')';
  }
  if(subscriptionId){
    subject += ' (' + subscriptionId + ')';
  }
  return deliver(subject, 'mail_general_feedback/_es', {
    myuuid: myuuid,
    pregunta1 : info.pregunta1,
    pregunta2 : info.pregunta2,
    userType : info.userType,
    healthcareSpecialty: info.healthcareSpecialty,
    providedHealthcareSpecialty: info.providedHealthcareSpecialty,
    moreFunct : info.moreFunct,
    freeText : info.freeText,
    email : info.email,
    fileNames : fileNames,
    model : model,
    tenantId: tenantId,
    subscriptionId: subscriptionId,
    isBetaPage: isBetaPage
  })
}


module.exports = {
  sendMailSupport,
  sendMailError,
  sendMailErrorGPTIP,
  sendMailGeneralFeedback
}
