const config = require('../config')
let appInsights = require('applicationinsights');

if(config.client_server!='http://localhost:4200'){
	appInsights.setup(config.INSIGHTS)
    .setAutoDependencyCorrelation(true)
    .setAutoCollectRequests(true)
    .setAutoCollectPerformance(true, true)
    .setAutoCollectExceptions(true)
    .setAutoCollectDependencies(true)
    .setAutoCollectConsole(true)
    .setUseDiskRetryCaching(true)
    .setSendLiveMetrics(false)
    .setDistributedTracingMode(appInsights.DistributedTracingModes.AI)
    .start();
}

const insightsClient = appInsights.defaultClient;
module.exports = insightsClient;