/*
* MAIN FILE, REQUESTS INFORMATION OF THE CONFIG (CONFIG.JS WHERE TO ESTABLISH IF IT IS DEVELOPMENT OR PROD)
* AND CONFIGURATION WITH EXPRESS (APP.JS), AND ESTABLISH THE CONNECTION WITH THE BD MONGO AND BEGINS TO LISTEN
*/

'use strict'
const config = require('./config')
const mongoose = require('mongoose');
const app = require('./app')
let appInsights = require('applicationinsights');

if(config.client_server!='http://localhost:4200'){
	appInsights.setup(config.INSIGHTS)
    .setAutoDependencyCorrelation(true)
    .setAutoCollectRequests(true)
    .setAutoCollectPerformance(true, true)
    .setAutoCollectExceptions(true)
    .setAutoCollectDependencies(true)
    .setAutoCollectConsole(true, true)
    .setUseDiskRetryCaching(true)
    .setSendLiveMetrics(true)
    .setDistributedTracingMode(appInsights.DistributedTracingModes.AI)
    .start();
}

mongoose.Promise = global.Promise

app.listen(config.port, () => {
	console.log(`API REST corriendo en http://localhost:${config.port}`)
})
