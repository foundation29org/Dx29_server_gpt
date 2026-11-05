'use strict';

// Qué instrumenta Application Insights. index.js lo carga antes que cualquier
// otro paquete, así que este módulo no puede requerir nada.
//
// Con la v2 las dependencies eran ~840.000 a la semana, el 46 % de la ingesta,
// y casi todas ruido: el sondeo de las colas de Service Bus, cada mensaje de
// progreso de Web PubSub, Blob Storage y cada traducción. Solo se registran
// las llamadas HTTP externas que tardan o fallan: Azure OpenAI, Document
// Intelligence, Perplexity y el backend de F29.
const UNTRACKED_DEPENDENCY_HOST_SUFFIXES = Object.freeze([
  '.blob.core.windows.net',
  '.webpubsub.azure.com',
  '.microsofttranslator.com',
  // Llamadas del propio SDK: el ping de Live Metrics y la lectura de settings.
  '.monitor.azure.com'
]);

function requestHost(request) {
  const host = request?.hostname || request?.host || '';
  return String(host).toLowerCase().replace(/:\d+$/, '');
}

function isUntrackedDependency(request) {
  const host = requestHost(request);
  return UNTRACKED_DEPENDENCY_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

// El shim reemplaza su objeto entero por este, así que se nombran todas.
// azureSdk son los spans InProc de los SDK de Azure (sendToUser de Web PubSub,
// Blob Storage...). mongoDb no existía en la v2: cada consulta sería una dependency.
function instrumentationOptions() {
  return {
    http: { enabled: true, ignoreOutgoingRequestHook: isUntrackedDependency },
    azureSdk: { enabled: false },
    mongoDb: { enabled: false },
    mySql: { enabled: false },
    postgreSql: { enabled: false },
    redis: { enabled: false },
    redis4: { enabled: false },
    bunyan: { enabled: false },
    winston: { enabled: false }
  };
}

module.exports = {
  UNTRACKED_DEPENDENCY_HOST_SUFFIXES,
  instrumentationOptions,
  isUntrackedDependency
};
