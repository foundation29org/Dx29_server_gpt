const config = require('../config')
let appInsights = require('applicationinsights');

function error(message, properties = {}) {
  //client.trackTrace({message: message});
  if(config.client_server == 'http://localhost:4200'){
    console.log('AppInsights tracking:')
    console.log(message)
    if (Object.keys(properties).length > 0) {
      console.log('Properties:', properties)
    }
  }else{
    let stringException;
    if (typeof message === 'string') {
      stringException = message;
    } else if (typeof message === 'object') {
      stringException = JSON.stringify(message);
    } else {
      stringException = message.toString();
    }
    
    // Extraer propiedades del objeto message si es un objeto
    let customProperties = { ...properties };
    if (typeof message === 'object' && message !== null) {
      // Si message tiene propiedades útiles, agregarlas a customProperties
      if (message.tenantId) customProperties.tenantId = message.tenantId;
      if (message.subscriptionId) customProperties.subscriptionId = message.subscriptionId;
      if (message.endpoint) customProperties.endpoint = message.endpoint;
      if (message.errors) customProperties.errors = JSON.stringify(message.errors);
    }
    
    appInsights.defaultClient.trackException({
      exception: new Error(stringException),
      properties: customProperties
    });
    
    // También registrar como evento para tener más visibilidad
    if (Object.keys(customProperties).length > 0) {
      appInsights.defaultClient.trackEvent({
        name: 'Error',
        properties: {
          message: stringException,
          ...customProperties
        }
      });
    }
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