const config = require('../config')
let appInsights = require('applicationinsights');

if(config.client_server!='http://localhost:4200'){
	appInsights.setup(config.INSIGHTS)
    .start();
}

const insightsClient = appInsights.defaultClient;
module.exports = insightsClient;