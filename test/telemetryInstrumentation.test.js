'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  instrumentationOptions,
  isUntrackedDependency
} = require('../services/telemetryInstrumentation');

test('drops internal Azure calls and keeps external services as dependencies', () => {
  const cases = [
    // [host, expected untracked]
    ['dx29gpt.blob.core.windows.net', true],
    ['dxgpt.webpubsub.azure.com', true],
    ['api.cognitive.microsofttranslator.com', true],
    ['DX29GPT.BLOB.CORE.WINDOWS.NET:443', true],
    ['westeurope.livediagnostics.monitor.azure.com', true],
    ['settings.sdk.monitor.azure.com', true],
    ['dxgptindia.openai.azure.com', false],
    ['dxgptdocumentai.cognitiveservices.azure.com', false],
    ['api.perplexity.ai', false],
    ['f29-backend.calmdesert-10724c3e.westeurope.azurecontainerapps.io', false],
    // Un sufijo parecido no basta: tiene que ser el dominio.
    ['blob.core.windows.net.attacker.test', false]
  ];
  for (const [host, expected] of cases) {
    assert.equal(isUntrackedDependency({ hostname: host }), expected, host);
  }
  assert.equal(isUntrackedDependency({ host: 'dx29gpt.blob.core.windows.net:443' }), true);
  assert.equal(isUntrackedDependency({}), false);
  assert.equal(isUntrackedDependency(undefined), false);
});

test('keeps incoming requests and turns off SDK and database spans', () => {
  const options = instrumentationOptions();
  assert.equal(options.http.enabled, true);
  assert.equal(options.http.ignoreOutgoingRequestHook, isUntrackedDependency);
  assert.equal(options.http.ignoreIncomingRequestHook, undefined);
  for (const name of ['azureSdk', 'mongoDb', 'mySql', 'postgreSql', 'redis', 'redis4']) {
    assert.equal(options[name].enabled, false, name);
  }
  // Cada llamada devuelve un objeto nuevo: el SDK puede modificarlo sin efectos.
  assert.notEqual(instrumentationOptions(), options);
});
