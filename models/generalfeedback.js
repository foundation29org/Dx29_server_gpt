// Support schema
'use strict'

const mongoose = require ('mongoose');
const Schema = mongoose.Schema

const { conndbaccounts } = require('../db_connect')

const GeneralfeedbackSchema = Schema({
	myuuid: String,
	pregunta1: String,
	pregunta2: String,
	moreFunct: String,
	freeText: String,
	date: {type: Date, default: Date.now}
})

module.exports = conndbaccounts.model('Generalfeedback',GeneralfeedbackSchema)
// we need to export the model so that it is accessible in the rest of the app
