// LangSchema
'use strict'

const mongoose = require ('mongoose');
const Schema = mongoose.Schema

const { conndbaccounts } = require('../db_connect')

const LangSchema = Schema({
	name: {	type: String,	unique: true,	required: true },
	code: {	type: String,	index: true,	unique: true,	required: true }
}, { versionKey: false // You should be aware of the outcome after set to false
})

module.exports = conndbaccounts.model('Lang',LangSchema)
// we need to export the model so that it is accessible in the rest of the app
