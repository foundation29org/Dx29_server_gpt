// functions for each call of the api on Lang. Use the Lang model

'use strict'

// add the lang model
const Lang = require('../../models/lang')

async function getLangs(req, res) {
	try {
	  const langs = await Lang.find({});
	  const listLangs = langs
		.filter(lang => lang.code !== 'nl')
		.map(lang => ({ name: lang.name, code: lang.code }))
        .sort((a, b) => a.name.localeCompare(b.name));
  
	  res.status(200).send(listLangs);
	} catch (err) {
	  res.status(500).send({ error: 'Error fetching languages' });
	}
  }
  
  module.exports = {
	getLangs
  }
