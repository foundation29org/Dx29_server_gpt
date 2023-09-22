const config = require('../config')
const insightsClient = require('./initinsights');

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
    insightsClient.trackException({exception: new Error(stringException)});
  }
  
}

module.exports = {
    error
}