const config = require('../config')
let appInsights = require('applicationinsights');

function error(message) {
  //client.trackTrace({message: message});
  if(config.client_server == 'http://localhost:4200'){
    console.log('AppInsights tracking:')
    console.log(message)
  }else{
    let stringException;
    if (typeof message === 'string') {
      stringException = message;
    } else if (typeof message === 'object') {
      stringException = JSON.stringify(message);
    } else {
      stringException = message.toString();
    }
    appInsights.defaultClient.trackException({exception: new Error(stringException)});
  }
  
}

function trackEvent(eventName, properties = {}) {
  if(config.client_server == 'http://localhost:4200'){
    console.log('AppInsights custom event:')
    console.log('Event:', eventName)
    console.log('Properties:', properties)
  }else{
    if (appInsights.defaultClient) {
      appInsights.defaultClient.trackEvent({
        name: eventName,
        properties: properties
      });
    } else {
      console.log('AppInsights client not available, logging event locally:')
      console.log('Event:', eventName)
      console.log('Properties:', properties)
    }
  }
}

module.exports = {
    error,
    trackEvent
}