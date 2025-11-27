'use strict'

const { TRANSPORTER_OPTIONS, client_server } = require('../config')
const insights = require('../services/insights')
const nodemailer = require('nodemailer')
var hbs = require('nodemailer-express-handlebars')

var options = {
     viewEngine: {
         extname: '.hbs',
         layoutsDir: 'views/email/',
         defaultLayout : 'template'
     },
     viewPath: 'views/email/',
     extName: '.hbs'
 };

 var transporter = nodemailer.createTransport(TRANSPORTER_OPTIONS);
 transporter.use('compile', hbs(options));

function sendMailSupport (email, lang, supportStored){
  const decoded = new Promise((resolve, reject) => {
    var maillistbcc = [
      TRANSPORTER_OPTIONS.auth.user
    ];

    let subject = 'Mensaje para soporte de DxGPT';
    if(supportStored.tenantId){
      subject += ' (' + supportStored.tenantId + ')';
    }
    if(supportStored.subscriptionId){
      subject += ' (' + supportStored.subscriptionId + ')';
    }
    var mailOptions = {
      to: TRANSPORTER_OPTIONS.auth.user,
      from: TRANSPORTER_OPTIONS.auth.user,
      bcc: maillistbcc,
      subject: subject,
      template: 'mail_support/_es',
      context: {
        email : email,
        lang : lang,
        info: supportStored.toObject()
      }
    };

    transporter.sendMail(mailOptions, function(error, info){
      if (error) {
        insights.error(error);
        console.log(error);
        reject({
          status: 401,
          message: 'Fail sending email'
        })
      } else {
        resolve("ok")
      }
    });

  });
  return decoded
}

function sendMailError (lang, req, response){
  const decoded = new Promise((resolve, reject) => {
    var maillistbcc = [
      TRANSPORTER_OPTIONS.auth.user
    ];

    var mailOptions = {
      to: TRANSPORTER_OPTIONS.auth.user,
      from: TRANSPORTER_OPTIONS.auth.user,
      bcc: maillistbcc,
      subject: 'Mensaje para soporte de DxGPT - Error GPT',
      template: 'mail_error/_es',
      context: {
        lang : lang,
        info: JSON.stringify(req), 
        response: JSON.stringify(response)
      }
    };

    transporter.sendMail(mailOptions, function(error, info){
      if (error) {
        insights.error(error);
        console.log(error);
        reject({
          status: 401,
          message: 'Fail sending email'
        })
      } else {
        resolve("ok")
      }
    });

  });
  return decoded
}

function sendMailErrorGPTIP (lang, req, response, tenantId, subscriptionId){
  
  const decoded = new Promise((resolve, reject) => {
    var maillistbcc = [
      TRANSPORTER_OPTIONS.auth.user
    ];

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
    
    var mailOptions = {
      to: TRANSPORTER_OPTIONS.auth.user,
      from: TRANSPORTER_OPTIONS.auth.user,
      bcc: maillistbcc,
      subject: subject,
      template: 'mail_error_gpt_ip/_es',
      context: {
        lang : lang,
        info: infoString, 
        response: responseString,
        tenantId: tenantId || '',
        subscriptionId: subscriptionId || ''
      }
    };

    transporter.sendMail(mailOptions, function(error, info){
      if (error) {
        insights.error(error);
        console.log(error);
        reject({
          status: 401,
          message: 'Fail sending email'
        })
      } else {
        resolve("ok")
      }
    });

  });
  return decoded
}

function sendMailGeneralFeedback (info, myuuid, tenantId, subscriptionId, fileNames, model, isBetaPage){
  const decoded = new Promise((resolve, reject) => {
    var maillistbcc = [
      TRANSPORTER_OPTIONS.auth.user
    ];

    let subject = 'Mensaje para soporte de DxGPT - Feedback General';
    if(tenantId){
      subject += ' (' + tenantId + ')';
    }
    if(subscriptionId){
      subject += ' (' + subscriptionId + ')';
    }
    var mailOptions = {
      to: TRANSPORTER_OPTIONS.auth.user,
      from: TRANSPORTER_OPTIONS.auth.user,
      bcc: maillistbcc,
      subject: subject,
      template: 'mail_general_feedback/_es',
      context: {
        myuuid: myuuid,
        pregunta1 : info.pregunta1,
        pregunta2 : info.pregunta2,
        userType : info.userType,
        moreFunct : info.moreFunct,
        freeText : info.freeText,
        email : info.email,
        fileNames : fileNames,
        model : model,
        tenantId: tenantId,
        subscriptionId: subscriptionId,
        isBetaPage: isBetaPage
      }
    };

    transporter.sendMail(mailOptions, function(error, info){
      if (error) {
        insights.error(error);
        console.log(error);
        reject({
          status: 401,
          message: 'Fail sending email'
        })
      } else {
        resolve("ok")
      }
    });

  });
  return decoded
}


module.exports = {
  sendMailSupport,
  sendMailError,
  sendMailErrorGPTIP,
  sendMailGeneralFeedback
}
