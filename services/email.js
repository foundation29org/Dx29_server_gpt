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

    var mailOptions = {
      to: TRANSPORTER_OPTIONS.auth.user,
      from: TRANSPORTER_OPTIONS.auth.user,
      bcc: maillistbcc,
      subject: 'Mensaje para soporte de DxGPT',
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

function sendMailErrorGPT (lang, req, response){
  const decoded = new Promise((resolve, reject) => {
    var maillistbcc = [
      TRANSPORTER_OPTIONS.auth.user
    ];

    var mailOptions = {
      to: TRANSPORTER_OPTIONS.auth.user,
      from: TRANSPORTER_OPTIONS.auth.user,
      bcc: maillistbcc,
      subject: 'Mensaje para soporte de DxGPT - Error GPT',
      template: 'mail_error_gpt/_es',
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

function sendMailFeedback (email, lang, info){
  const decoded = new Promise((resolve, reject) => {
    var maillistbcc = [
      TRANSPORTER_OPTIONS.auth.user
    ];

    var mailOptions = {
      to: TRANSPORTER_OPTIONS.auth.user,
      from: TRANSPORTER_OPTIONS.auth.user,
      bcc: maillistbcc,
      subject: 'Mensaje para soporte de DxGPT - Feedback Down',
      template: 'mail_feedback/_es',
      context: {
        email : email,
        lang : lang,
        info: info
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

function sendMailGeneralFeedback (info, myuuid){
  const decoded = new Promise((resolve, reject) => {
    var maillistbcc = [
      TRANSPORTER_OPTIONS.auth.user
    ];

    var mailOptions = {
      to: TRANSPORTER_OPTIONS.auth.user,
      from: TRANSPORTER_OPTIONS.auth.user,
      bcc: maillistbcc,
      subject: 'Mensaje para soporte de DxGPT - Feedback General',
      template: 'mail_general_feedback/_es',
      context: {
        myuuid: myuuid,
        pregunta1 : info.pregunta1,
        pregunta2 : info.pregunta2,
        moreFunct : info.moreFunct,
        freeText : info.freeText
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

function sendMailError (msg, lang){
  const decoded = new Promise((resolve, reject) => {
    var maillistbcc = [
      TRANSPORTER_OPTIONS.auth.user
    ];

    var mailOptions = {
      to: TRANSPORTER_OPTIONS.auth.user,
      from: TRANSPORTER_OPTIONS.auth.user,
      bcc: maillistbcc,
      subject: 'Mensaje de error para soporte de DxGPT',
      template: 'mail_error/_es',
      context: {
        error : msg,
        lang : lang
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
  sendMailErrorGPT,
  sendMailFeedback,
  sendMailGeneralFeedback,
  sendMailError
}
