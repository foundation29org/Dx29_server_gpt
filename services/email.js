'use strict'

const { TRANSPORTER_OPTIONS, client_server, blobAccessToken } = require('../config')
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

function sendMailSupport (email, lang, role, supportStored){
  const decoded = new Promise((resolve, reject) => {
    var urlImg = 'https://www.dx29.ai/assets/img/logo-Dx29.png';
    var attachments = [];
    if(supportStored.files.length>0){
      supportStored.files.forEach(function(file) {
        var urlpath = blobAccessToken.blobAccountUrl+'filessupport/'+file+blobAccessToken.sasToken;
        attachments.push({filename: file, path: urlpath});
      });
    }
    var maillistbcc = [
      TRANSPORTER_OPTIONS.auth.user
    ];

    var mailOptions = {
      to: TRANSPORTER_OPTIONS.auth.user,
      from: TRANSPORTER_OPTIONS.auth.user,
      bcc: maillistbcc,
      subject: 'Mensaje para soporte de DX29',
      template: 'mail_support/_es',
      context: {
        email : email,
        lang : lang,
        info: supportStored
      },
      attachments: attachments
    };

    transporter.sendMail(mailOptions, function(error, info){
      if (error) {
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

function sendMailResultsUndiagnosed (email, msg, symptoms, diseases, lang, dateHeader, pdfBase64){

  const decoded = new Promise((resolve, reject) => {

    //var mydata = JSON.stringify(data);

    var maillistbcc = [
      'maria.larrabe@foundation29.org'
    ];

    var mailOptions = {};
    var subjectlang = 'Dx29 results';

    if(lang=='es'){
      subjectlang='Resultados de Dx29';
    }

    const ts_hms = new Date();    
    var stringDate = 
      ts_hms.getFullYear() + '-' + 
      ("0" + (ts_hms.getMonth() + 1)).slice(-2) + '-' + 
      ("0" + (ts_hms.getDate())).slice(-2) + '_' +
      ("0" + ts_hms.getHours()).slice(-2) + '' +
      ("0" + ts_hms.getMinutes()).slice(-2) + '' +
      ("0" + ts_hms.getSeconds()).slice(-2);
      var fileName = 'Dx29_Report_'+stringDate+'.pdf';


    if(msg==''){
      mailOptions = {
        to: email,
        from: TRANSPORTER_OPTIONS.auth.user,
        bcc: maillistbcc,
        subject: subjectlang,
        template: 'send_mail_results_und/no_msg_'+lang,
        context: {
          dateHeader: dateHeader,
          symptoms : symptoms,
          diseases : diseases
        },
        attachments: [
        {   // utf-8 string as an attachment
          filename: fileName,
          path: pdfBase64
        }]
      };
    }else{
      mailOptions = {
        to: email,
        from: TRANSPORTER_OPTIONS.auth.user,
        bcc: maillistbcc,
        subject: subjectlang,
        template: 'send_mail_results_und/with_msg_'+lang,
        context: {
          dateHeader: dateHeader,
          msg: msg,
          symptoms : symptoms,
          diseases : diseases
        },
        attachments: [
        {   // utf-8 string as an attachment
          filename: fileName,
          path: pdfBase64
        }]
      };
    }


    transporter.sendMail(mailOptions, function(error, info){
      if (error) {
        console.log(error);
        console.log(info);
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

function sendMailResultsDiagnosed (email, msg, symptoms, disease, lang, dateHeader, pdfBase64){

  const decoded = new Promise((resolve, reject) => {

    //var mydata = JSON.stringify(data);

    var maillistbcc = [
      'maria.larrabe@foundation29.org'
    ];

    var mailOptions = {};
    var subjectlang = 'Dx29 results';

    if(lang=='es'){
      subjectlang='Resultados de Dx29';
    }


    const ts_hms = new Date();    
    var stringDate = 
      ts_hms.getFullYear() + '-' + 
      ("0" + (ts_hms.getMonth() + 1)).slice(-2) + '-' + 
      ("0" + (ts_hms.getDate())).slice(-2) + '_' +
      ("0" + ts_hms.getHours()).slice(-2) + '' +
      ("0" + ts_hms.getMinutes()).slice(-2) + '' +
      ("0" + ts_hms.getSeconds()).slice(-2);
      var fileName = 'Dx29_Report_'+stringDate+'.pdf';

    if(msg==''){
      mailOptions = {
        to: email,
        from: TRANSPORTER_OPTIONS.auth.user,
        bcc: maillistbcc,
        subject: subjectlang,
        template: 'send_mail_results_diag/no_msg_'+lang,
        context: {
          dateHeader: dateHeader,
          symptoms : symptoms,
          disease : disease
        },
        attachments: [
        {   // utf-8 string as an attachment
          filename: fileName,
          path: pdfBase64
        }]
      };
    }else{
      mailOptions = {
        to: email,
        from: TRANSPORTER_OPTIONS.auth.user,
        bcc: maillistbcc,
        subject: subjectlang,
        template: 'send_mail_results_diag/with_msg_'+lang,
        context: {
          dateHeader: dateHeader,
          msg: msg,
          symptoms : symptoms,
          disease : disease
        },
        attachments: [
        {   // utf-8 string as an attachment
          filename: fileName,
          path: pdfBase64
        }]
      };
    }


    transporter.sendMail(mailOptions, function(error, info){
      if (error) {
        console.log(error);
        console.log(info);
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

function sendRevolution (email, lang, bodyAttachments){

  const decoded = new Promise((resolve, reject) => {

    //var mydata = JSON.stringify(data);

    var maillistbcc = [
      'maria.larrabe@foundation29.org'
    ];

    var mailOptions = {};
    var subjectlang = 'Dx29 Revolution';

    if(lang=='es'){
      subjectlang='Revolución de Dx29';
    }

    mailOptions = {
      to: email,
      from: TRANSPORTER_OPTIONS.auth.user,
      bcc: maillistbcc,
      subject: subjectlang,
      template: 'send_mail_revolution/_'+lang
    };
    
    transporter.sendMail(mailOptions, function(error, info){
      if (error) {
        console.log(error);
        console.log(info);
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
  sendMailResultsUndiagnosed,
  sendMailResultsDiagnosed,
  sendRevolution
}
