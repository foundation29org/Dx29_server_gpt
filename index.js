/*
* MAIN FILE, REQUESTS INFORMATION OF THE CONFIG (CONFIG.JS WHERE TO ESTABLISH IF IT IS DEVELOPMENT OR PROD)
* AND CONFIGURATION WITH EXPRESS (APP.JS), AND ESTABLISH THE CONNECTION WITH THE BD MONGO AND BEGINS TO LISTEN
*/

'use strict'

const mongoose = require('mongoose');
const app = require('./app')
const config = require('./config')
mongoose.Promise = global.Promise

app.listen(config.port, () => {
	console.log(`API REST corriendo en http://localhost:${config.port}`)
})
