'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { errorSummary } = require('../services/errorSummary');

function axiosLikeError() {
  const error = new Error('Request failed with status code 400');
  error.name = 'AxiosError';
  error.code = 'ERR_BAD_REQUEST';
  error.config = {
    url: 'https://example.openai.azure.com/openai/deployments/x/chat/completions',
    headers: { 'api-key': 'secret-key-value', 'Ocp-Apim-Subscription-Key': 'translator-key' },
    data: JSON.stringify({ messages: [{ role: 'user', content: 'Juan Pérez, 45 años, dolor torácico' }] })
  };
  error.request = { _header: 'POST /openai HTTP/1.1\r\napi-key: secret-key-value' };
  error.response = {
    status: 400,
    headers: { 'x-request-id': 'abc' },
    data: { error: { code: 'content_filter', message: 'The response was filtered' } }
  };
  return error;
}

test('un error de Axios solo deja nombre, mensaje, código y estado', () => {
  const summary = errorSummary(axiosLikeError());

  assert.deepEqual(summary, {
    name: 'AxiosError',
    message: 'Request failed with status code 400',
    code: 'ERR_BAD_REQUEST',
    status: '400',
    providerCode: 'content_filter'
  });
  const printed = JSON.stringify(summary);
  assert.doesNotMatch(printed, /secret-key-value|translator-key|Juan Pérez|dolor torácico|example\.openai/);
});

test('acepta errores sin respuesta, con statusCode y valores que no son objetos', () => {
  const network = new Error('socket hang up');
  network.code = 'ECONNRESET';
  assert.deepEqual(errorSummary(network), { name: 'Error', message: 'socket hang up', code: 'ECONNRESET' });

  assert.deepEqual(errorSummary({ statusCode: 503, message: 'Service Unavailable' }), {
    message: 'Service Unavailable',
    status: '503'
  });
  assert.deepEqual(errorSummary('texto suelto'), { message: 'texto suelto' });
  assert.deepEqual(errorSummary(undefined), { message: 'undefined' });
  assert.deepEqual(errorSummary(null), { message: 'null' });
});

test('recorta los mensajes largos', () => {
  const summary = errorSummary(new Error('x'.repeat(5000)));
  assert.equal(summary.message.length, 300);
});

test('no copia la traza ni propiedades propias del error', () => {
  const error = new Error('fallo');
  error.requestData = { description: 'texto del caso' };
  const summary = errorSummary(error);
  assert.equal(summary.stack, undefined);
  assert.equal(summary.requestData, undefined);
});
