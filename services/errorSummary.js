'use strict';

// Lo único que se puede pasar de un error a console.*. index.js activa
// setAutoCollectConsole, así que todo console.* acaba en Application Insights, y un
// error de Axios lleva config.headers (la clave del servicio) y config.data (el
// prompt o el texto a traducir, con el caso clínico). Nunca config, request, el cuerpo
// de la respuesta ni la traza.
const MAX_MESSAGE_LENGTH = 300;
const MAX_FIELD_LENGTH = 100;

function shortString(value, max) {
  return String(value).slice(0, max);
}

function errorSummary(error) {
  if (error === null || error === undefined) {
    return { message: String(error) };
  }
  if (typeof error !== 'object') {
    return { message: shortString(error, MAX_MESSAGE_LENGTH) };
  }

  const summary = {};
  if (error.name) summary.name = shortString(error.name, MAX_FIELD_LENGTH);
  if (error.message) summary.message = shortString(error.message, MAX_MESSAGE_LENGTH);
  if (error.code !== undefined && error.code !== null) summary.code = shortString(error.code, MAX_FIELD_LENGTH);

  const status = error.response?.status ?? error.statusCode ?? error.status;
  if (status !== undefined && status !== null) summary.status = shortString(status, MAX_FIELD_LENGTH);

  // Código del proveedor (Azure OpenAI, Translator): {"error": {"code": "..."}}
  const providerCode = error.response?.data?.error?.code;
  if (typeof providerCode === 'string' || typeof providerCode === 'number') {
    summary.providerCode = shortString(providerCode, MAX_FIELD_LENGTH);
  }

  return summary;
}

module.exports = {
  errorSummary
};
