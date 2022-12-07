// Support schema
'use strict'

const mongoose = require ('mongoose');
const Schema = mongoose.Schema

const { conndbaccounts } = require('../db_connect')

const SupportSchema = Schema({
	platform: String,
	subject: String,
	description: String,
	type: String,
	status: {type: String, default: 'unread'},
	statusDate: {type: Date, default: Date.now},
	files: Object,
	date: {type: Date, default: Date.now}
})

module.exports = conndbaccounts.model('Support',SupportSchema)
// we need to export the model so that it is accessible in the rest of the app
