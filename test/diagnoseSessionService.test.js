'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// El modelo de Mongo se sustituye: aquí solo se comprueba la consulta y cómo se lee la respuesta.
const queries = [];
let latest = null;
const modelPath = require.resolve('../models/diagnoseSession');
require.cache[modelPath] = {
  id: modelPath,
  filename: modelPath,
  loaded: true,
  exports: {
    findOne: (filter, projection) => {
      const query = { filter, projection, sort: null, maxTimeMS: null };
      queries.push(query);
      return {
        sort(order) { query.sort = order; return this; },
        maxTimeMS(ms) { query.maxTimeMS = ms; return this; },
        // 'hang' imita a Mongoose reteniendo la consulta sin conexión.
        lean: () => (latest === 'hang' ? new Promise(() => {}) : Promise.resolve(latest))
      };
    }
  }
};

const DiagnoseSessionService = require('../services/diagnoseSessionService');

test('hasRecentImageAsk looks at the user\'s latest query in the window, newest first', async () => {
  latest = { betaPage: false, answer: { imageRule: 'ask_patient_data' } };
  const before = Date.now();
  assert.equal(await DiagnoseSessionService.hasRecentImageAsk({ myuuid: 'u1', tenantId: 'dxgpt-prod', windowMs: 60000 }), true);
  const { filter, projection, sort } = queries.at(-1);
  assert.equal(filter.myuuid, 'u1');
  assert.equal(filter.tenantId, 'dxgpt-prod');
  assert.equal('subscriptionId' in filter, false);
  assert.ok(filter.timestamp.$gte.getTime() >= before - 60000 && filter.timestamp.$gte.getTime() <= Date.now() - 60000);
  assert.deepEqual(projection, { 'answer.imageRule': 1, betaPage: 1 });
  assert.deepEqual(sort, { timestamp: -1 });
  assert.equal(queries.at(-1).maxTimeMS, 1500);
});

test('hasRecentImageAsk is false when the latest query was something else', async () => {
  for (const doc of [
    null,
    { betaPage: false, answer: { imageRule: 'already_asked' } },
    { betaPage: false, answer: { intentAction: 'go' } },
    { betaPage: true, answer: { imageRule: 'ask_patient_data' } }
  ]) {
    latest = doc;
    assert.equal(await DiagnoseSessionService.hasRecentImageAsk({ myuuid: 'u1', subscriptionId: 's1' }), false, JSON.stringify(doc));
  }
  assert.equal(queries.at(-1).filter.subscriptionId, 's1');

  const count = queries.length;
  assert.equal(await DiagnoseSessionService.hasRecentImageAsk({ myuuid: '' }), false);
  assert.equal(queries.length, count);
});

test('hasRecentImageAsk gives up quickly when Mongo does not answer', async () => {
  latest = 'hang';
  const started = Date.now();
  await assert.rejects(
    DiagnoseSessionService.hasRecentImageAsk({ myuuid: 'u1', timeoutMs: 50 }),
    /timed out/
  );
  assert.ok(Date.now() - started < 1000);
  assert.equal(queries.at(-1).maxTimeMS, 50);
});
