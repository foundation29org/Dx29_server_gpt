// functions for each call of the api on Lang. Use the Lang model

'use strict'

// add the lang model
const Lang = require('../../models/lang')

/**
 * @api {get} https://health29.org/api/langs/ Get languages
 * @apiName getLangs
 * @apiDescription This method return the languages available in health 29. you get a list of languages, and for each one you have the name and the code.
 * We currently have 5 languages, but we will include more. The current languages are:
 * * English: en
 * * Spanish: es
 * * German: de
 * * Dutch: nl
 * * Portuguese: pt
 * @apiGroup Languages
 * @apiVersion 1.0.0
 * @apiExample {js} Example usage:
 *   this.http.get('https://health29.org/api/langs)
 *    .subscribe( (res : any) => {
 *      console.log('languages: '+ res.listLangs);
 *     }, (err) => {
 *      ...
 *     }
 *
 * @apiSuccessExample Success-Response:
 * HTTP/1.1 200 OK
 * [
 *   {
 *     "name": "English",
 *     "code": "en"
 *   },
 *   {
 *     "name": "Español,Castellano",
 *     "code": "es"
 *   },
 *   {
 *     "name": "Deutsch",
 *     "code": "de"
 *   },
 *   {
 *     "name": "Nederlands,Vlaams",
 *     "code": "nl"
 *   },
 *   {
 *     "name": "Português",
 *     "code": "pt"
 *   }
 * ]
 */
function getLangs (req, res){
	Lang.find({}, function(err, langs) {
    var listLangs = [];

		if(langs!=undefined){
			langs.forEach(function(lang) {
				if(lang.code!='nl'){
					listLangs.push({name:lang.name, code: lang.code});
				}

	    });
		}
    res.status(200).send(listLangs)
  });
}

module.exports = {
	getLangs
}
