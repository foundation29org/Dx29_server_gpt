'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const bodyParser = require('body-parser');
const { HEADER, createApimGatewayGuard } = require('../services/apimGatewayGuard');

const SECRET = 'a'.repeat(48);
const OLD_SECRET = 'b'.repeat(48);

function run(guard, { method = 'POST', path = '/api/diagnose', headers = {} } = {}) {
  const req = { method, path, headers: { ...headers }, correlationId: 'corr-1' };
  const out = { nextCalled: false, status: null, body: null, req };
  const res = {
    status(code) {
      out.status = code;
      return this;
    },
    json(body) {
      out.body = body;
      return this;
    }
  };
  guard(req, res, () => {
    out.nextCalled = true;
  });
  return out;
}

function makeGuard(options = {}) {
  const events = [];
  const guard = createApimGatewayGuard({
    secrets: SECRET,
    mode: undefined,
    track: (name, props) => events.push({ name, props }),
    ...options
  });
  return { guard, events };
}

test('without a configured secret the guard lets everything through', () => {
  const events = [];
  const guard = createApimGatewayGuard({ secrets: '', track: (n, p) => events.push(p) });
  const out = run(guard, { headers: { [HEADER]: SECRET } });
  assert.equal(out.nextCalled, true);
  assert.equal(events.length, 0);
  // Aunque esté apagado, la cabecera no llega a los controladores (que la registrarían en errores)
  assert.equal(out.req.headers[HEADER], undefined);
});

test('accepts the right secret and removes the header before the routes', () => {
  const { guard, events } = makeGuard();
  const out = run(guard, { headers: { [HEADER]: SECRET } });
  assert.equal(out.nextCalled, true);
  assert.equal(out.req.headers[HEADER], undefined);
  assert.equal(events.length, 0);
});

test('rejects a missing or wrong secret with 403 in enforce mode', () => {
  const { guard, events } = makeGuard();
  const missing = run(guard);
  assert.equal(missing.nextCalled, false);
  assert.equal(missing.status, 403);
  assert.deepEqual(missing.body, { error: 'forbidden' });

  const wrong = run(guard, { headers: { [HEADER]: 'not-the-secret' } });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.req.headers[HEADER], undefined);

  assert.deepEqual(events.map((e) => e.props.reason), ['missing', 'mismatch']);
  assert.equal(events[0].name, 'ApimGatewayKeyRejected');
  assert.equal(events[0].props.mode, 'enforce');
  assert.equal(events[0].props.path, '/api/diagnose');
  assert.equal(events[0].props.correlationId, 'corr-1');
  // El evento nunca lleva el valor recibido
  assert.ok(!JSON.stringify(events).includes('not-the-secret'));
});

test('accepts any of several comma-separated secrets, for rotation', () => {
  const { guard } = makeGuard({ secrets: ` ${SECRET} , ${OLD_SECRET} ` });
  assert.equal(run(guard, { headers: { [HEADER]: SECRET } }).nextCalled, true);
  assert.equal(run(guard, { headers: { [HEADER]: OLD_SECRET } }).nextCalled, true);
  assert.equal(run(guard, { headers: { [HEADER]: 'c'.repeat(48) } }).status, 403);
});

test('report mode lets the request through but records it', () => {
  const { guard, events } = makeGuard({ mode: 'Report' });
  const out = run(guard);
  assert.equal(out.nextCalled, true);
  assert.equal(out.status, null);
  assert.equal(events.length, 1);
  assert.equal(events[0].props.mode, 'report');
});

test('an unknown mode falls back to enforce', () => {
  const { guard } = makeGuard({ mode: 'log' });
  assert.equal(run(guard).status, 403);
});

test('only GET of the health check is open', () => {
  const { guard, events } = makeGuard();
  assert.equal(run(guard, { method: 'GET', path: '/api/internal/health' }).nextCalled, true);
  assert.equal(run(guard, { method: 'GET', path: '/api/internal/health/' }).nextCalled, true);
  assert.equal(run(guard, { method: 'POST', path: '/api/internal/health' }).status, 403);
  assert.equal(run(guard, { method: 'GET', path: '/api/internal/langs' }).status, 403);
  assert.equal(events.length, 2);
});

test('a repeated header is rejected', () => {
  const { guard, events } = makeGuard();
  const out = run(guard, { headers: { [HEADER]: [SECRET, SECRET] } });
  assert.equal(out.status, 403);
  assert.equal(events[0].props.reason, 'repeated');
});

test('caps rejection events at 20 per minute and reports how many were dropped', () => {
  let clock = 0;
  const { guard, events } = makeGuard({ now: () => clock });
  for (let i = 0; i < 25; i += 1) run(guard);
  assert.equal(events.length, 20);
  clock = 60000;
  run(guard);
  assert.equal(events.length, 21);
  assert.equal(events[20].props.droppedSinceLastEvent, '5');
});

test('in an Express app it rejects before reading the body', async () => {
  const app = express();
  let parsed = false;
  app.use(createApimGatewayGuard({ secrets: SECRET, track: () => {} }));
  app.use(bodyParser.json({ limit: '50mb' }));
  app.use((req, res, next) => {
    parsed = true;
    next();
  });
  app.post('/api/diagnose', (req, res) => res.json({ ok: true, sawHeader: Boolean(req.headers[HEADER]) }));
  const server = app.listen(0);
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/diagnose`;
    const body = JSON.stringify({ description: 'x'.repeat(1000) });
    const rejected = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(rejected.status, 403);
    assert.equal(parsed, false);

    const accepted = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DxGPT-Gateway-Key': SECRET }, body });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { ok: true, sawHeader: false });
  } finally {
    server.close();
  }
});
