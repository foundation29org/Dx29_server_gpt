'use strict'

const config = require('../config')
const request = require('request')
const insights = require('../services/insights')

function getDetectLanguage(req, res) {
    var jsonText = req.body;
    var translationKey = config.translationKey;
    request.post({ url: 'https://api.cognitive.microsofttranslator.com/detect?api-version=3.0', json: true, headers: { 'Ocp-Apim-Subscription-Key': translationKey, 'Ocp-Apim-Subscription-Region': 'northeurope' }, body: jsonText }, (error, response, body) => {
      if (error) {
        console.error(error)
        insights.error(error);
        res.status(500).send(error)
      }
      if (body == 'Missing authentication token.') {
        res.status(401).send(body)
      } else {
        res.status(200).send(body)
      }
  
    });
  }

function getTranslationDictionary (req, res){
  var lang = req.body.lang;
  var info = req.body.info;
  var translationKey = config.translationKey;
  request.post({url:'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&&from='+lang+'&to=en',json: true,headers: {'Ocp-Apim-Subscription-Key': translationKey, 'Ocp-Apim-Subscription-Region': 'northeurope' },body:info}, (error, response, body) => {
    if (error) {
      console.error(error)
      insights.error(error);
      res.status(500).send(error)
    }
    if(body=='Missing authentication token.'){
      res.status(401).send(body)
    }else{
      res.status(200).send(body)
    }

  });
}

function getTranslationDictionaryInvert (req, res){
  var lang = req.body.lang;
  var info = req.body.info;
  var translationKey = config.translationKey;
  request.post({url:'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&&from=en&to='+lang,json: true,headers: {'Ocp-Apim-Subscription-Key': translationKey, 'Ocp-Apim-Subscription-Region': 'northeurope' },body:info}, (error, response, body) => {
    if (error) {
      console.error(error)
      insights.error(error);
      res.status(500).send(error)
    }
    if(body=='Missing authentication token.'){
      res.status(401).send(body)
    }else{
      res.status(200).send(body)
    }

  });
}

function getTranslationSegments(req, res){
    var lang = req.body.lang;
    var segments = req.body.info;
    var translationKey = config.translationKey;
    request.post({url:'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&&from=en&to='+lang+'&textType=html',json: true,headers: {'Ocp-Apim-Subscription-Key': translationKey, 'Ocp-Apim-Subscription-Region': 'northeurope' },body:segments}, (error, response, body) => {
      if (error) {
        console.error(error)
        insights.error(error);
        res.status(500).send(error)
      }
      if(body=='Missing authentication token.'){
        res.status(401).send(body)
      }else{
        res.status(200).send(body)
      }
  
    });
  }

module.exports = {
  getDetectLanguage,
  getTranslationDictionary,
  getTranslationDictionaryInvert,
  getTranslationSegments
}
