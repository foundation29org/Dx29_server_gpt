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

const server = app.listen(config.port, () => {
	console.log(`API REST corriendo en http://localhost:${config.port}`)
})

// Manejar cierre graceful
process.on('SIGTERM', () => handleShutdown());
process.on('SIGINT', () => handleShutdown());

async function handleShutdown() {
    console.log('Iniciando cierre del servidor...');
    try {
        await queueService.close();
        server.close(() => {
            console.log('Servidor cerrado correctamente');
            process.exit(0);
        });
    } catch (error) {
        console.error('Error durante el cierre:', error);
        process.exit(1);
    }
}
