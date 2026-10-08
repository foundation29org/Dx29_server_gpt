const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const { smartLimiter } = require('../services/rateLimiter');

const ROUTES_FILE = path.join(__dirname, '..', 'routes', 'index.js');

// routes/index.js arrastra controladores que necesitan la configuración de
// producción, así que el test lee el fichero en vez de cargarlo.
test('smartLimiter is applied once for the whole router, never again per route', () => {
  const lines = fs.readFileSync(ROUTES_FILE, 'utf8').split(/\r?\n/);
  const uses = lines
    .map((text, index) => ({ text: text.trim(), line: index + 1 }))
    .filter(({ text }) => text.includes('smartLimiter'))
    .filter(({ text }) => !text.startsWith('//') && !text.startsWith('const {'));

  assert.deepEqual(
    uses.map(({ text }) => text),
    ['api.use(smartLimiter);'],
    'cada petición debe pasar por smartLimiter una sola vez'
  );
});

function post(port) {
  return new Promise((resolve) => {
    const request = http.request(
      {
        port,
        path: '/diagnose',
        method: 'POST',
        headers: { 'x-tenant-id': 'dxgpt-prod', 'x-client-ip': '203.0.113.77' }
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      }
    );
    request.end();
  });
}

test('an internal visitor gets the full 100 requests per window', async () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';

  const app = express();
  app.set('trust proxy', 1);
  const api = express.Router();
  api.use(smartLimiter);
  api.post('/diagnose', (_req, res) => res.end('ok'));
  app.use(api);

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });

  try {
    const port = server.address().port;
    let accepted = 0;
    let status;
    do {
      status = await post(port);
      if (status !== 429) accepted += 1;
    } while (status !== 429 && accepted < 200);

    assert.equal(accepted, 100);
  } finally {
    if (originalEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalEnv;
    }
    await new Promise((resolve) => server.close(resolve));
  }
});
