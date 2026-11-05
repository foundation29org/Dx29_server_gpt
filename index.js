/*
* MAIN FILE, REQUESTS INFORMATION OF THE CONFIG (CONFIG.JS WHERE TO ESTABLISH IF IT IS DEVELOPMENT OR PROD)
* AND CONFIGURATION WITH EXPRESS (APP.JS), AND ESTABLISH THE CONNECTION WITH THE BD MONGO AND BEGINS TO LISTEN
*/

'use strict'
// config solo lee process.env. Application Insights 3 (OpenTelemetry) tiene que
// arrancar antes de cargar mongoose, express y el resto: si no, no instrumenta
// las librerías de terceros. Desde la subida a la v3 (28/10/2026) no llegan
// requests ni dependencies; si sigue igual, los avisos del SDK dirán por qué.
const config = require('./config')
let appInsights = require('applicationinsights');
const { instrumentationOptions } = require('./services/telemetryInstrumentation');

const insightsKey = config.insightsKey;
const url = "InstrumentationKey="+insightsKey+";IngestionEndpoint=https://westeurope-5.in.applicationinsights.azure.com/;LiveEndpoint=https://westeurope.livediagnostics.monitor.azure.com/"
if(config.client_server!='http://localhost:4200'){
	appInsights.setup(url)
    .setAutoDependencyCorrelation(true)
    .setAutoCollectRequests(true)
    .setAutoCollectPerformance(true, true)
    .setAutoCollectExceptions(true)
    .setAutoCollectDependencies(true)
    .setAutoCollectConsole(true, true)
    .setUseDiskRetryCaching(true)
    .setSendLiveMetrics(true)
    .setDistributedTracingMode(appInsights.DistributedTracingModes.AI)
    // Avisos del propio SDK (p. ej. un export fallido) a consola, y de ahí a traces.
    .setInternalLogging(false, true)
    .setAzureMonitorOptions({ instrumentationOptions: instrumentationOptions() })
    .start();
}

const mongoose = require('mongoose');
const app = require('./app')
const queueService = app.get('queueService');

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
        if (queueService) {
            await queueService.close();
        }
        await mongoose.connection.close();
        server.close(() => {
            console.log('Servidor cerrado correctamente');
            process.exit(0);
        });
    } catch (error) {
        console.error('Error durante el cierre:', error);
        process.exit(1);
    }
}
