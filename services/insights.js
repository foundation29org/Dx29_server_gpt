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
    let stack;
    if (typeof message === 'string') {
      stringException = message;
    } else if (typeof message === 'object' && message !== null) {
      // No serializar el objeto entero: arrastra cuerpos de petición,
      // cabeceras y trazas al texto de la excepción.
      const summary = [message.message, message.error]
        .filter((value) => typeof value === 'string' && value.trim());
      stringException = [...new Set(summary)].join(' | ') ||
        'Unhandled error';
      stack = typeof message.stack === 'string' ? message.stack : undefined;
    } else {
      stringException = String(message);
    }
    
    // Extraer propiedades del objeto message si es un objeto
    let customProperties = { ...properties };
    if (typeof message === 'object' && message !== null) {
      // Promover solo metadatos seguros y consultables. No copiar cuerpos,
      // nombres de archivo, URLs ni contenido clínico.
      const safeFields = [
        'tenantId',
        'subscriptionId',
        'endpoint',
        'correlationId',
        'phase',
        'code',
        'statusCode',
        'mimeType',
        'retryable'
      ];
      safeFields.forEach((field) => {
        if (message[field] !== undefined && message[field] !== null) {
          customProperties[field] = String(message[field]);
        }
      });
      if (message.errors) {
        customProperties.errors = JSON.stringify(message.errors);
      }
    }
    
    const exception = new Error(stringException);
    if (stack) {
      exception.stack = stack;
    }
    appInsights.defaultClient.trackException({
      exception,
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

// customDimensions solo admite cadenas; los valores numéricos van en
// measurements para que sean agregables en los dashboards.
function normalizeProperties(properties = {}) {
  return Object.entries(properties).reduce((normalized, [key, value]) => {
    if (value !== undefined && value !== null) {
      normalized[key] = typeof value === 'string' ? value : String(value);
    }
    return normalized;
  }, {});
}

function normalizeMeasurements(measurements) {
  if (!measurements) {
    return undefined;
  }
  return Object.entries(measurements).reduce((normalized, [key, value]) => {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      normalized[key] = numeric;
    }
    return normalized;
  }, {});
}

function trackEvent(eventName, properties = {}, measurements = undefined) {
  const safeProperties = normalizeProperties(properties);
  const safeMeasurements = normalizeMeasurements(measurements);
  if(config.client_server == 'http://localhost:4200'){
    console.log('AppInsights custom event:')
    console.log('Event:', eventName)
    console.log('Properties:', safeProperties)
    if (safeMeasurements) {
      console.log('Measurements:', safeMeasurements)
    }
  }else{
    if (appInsights.defaultClient) {
      appInsights.defaultClient.trackEvent({
        name: eventName,
        properties: safeProperties,
        measurements: safeMeasurements
      });
    } else {
      console.log('AppInsights client not available, logging event locally:')
      console.log('Event:', eventName)
      console.log('Properties:', safeProperties)
    }
  }
}

module.exports = {
    error,
    trackEvent
}