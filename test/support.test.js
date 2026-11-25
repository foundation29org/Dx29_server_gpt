'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function stubModule(modulePath, exports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports
  };
}

const state = {
  saved: [],
  emails: [],
  flows: [],
  insightErrors: [],
  saveImpl: async () => {},
  emailImpl: async () => 'ok'
};

class FakeSupport {
  constructor(fields) {
    Object.assign(this, fields);
  }

  async save() {
    await state.saveImpl(this);
    state.saved.push(this);
    return this;
  }

  toObject() {
    return { ...this };
  }
}

// Sin stub de ../config: el controlador ya no lo necesita (solo lo usaba el flujo)
stubModule('../models/support', FakeSupport);
stubModule('../services/email', {
  sendMailSupport: async (email, lang, support) => {
    state.emails.push({ email, lang, support });
    return state.emailImpl();
  }
});
stubModule('../services/insights', {
  error: (message, properties = {}) => state.insightErrors.push({ message, properties }),
  trackEvent: () => {}
});
stubModule('../services/aiUtils', { suspiciousContentErrors: () => [] });
// Ya no hay flujo de Power Automate: si alguien vuelve a llamar a axios, la prueba lo ve
stubModule('axios', {
  post: async (url, body) => {
    state.flows.push(body);
    return { status: 202 };
  }
});

const supportController = require('../controllers/all/support');
const { sendMsgLogoutSupport } = supportController;

function reset() {
  state.saved = [];
  state.emails = [];
  state.flows = [];
  state.insightErrors = [];
  state.saveImpl = async () => {};
  state.emailImpl = async () => 'ok';
}

function request() {
  return {
    headers: { 'x-tenant-id': 'dxgpt-prod' },
    body: {
      subscribe: false,
      email: 'Ana@Example.com',
      userName: 'Ana',
      description: 'La página no carga',
      lang: 'es',
      myuuid: 'uuid-1'
    }
  };
}

function response() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    }
  };
}

test('guarda el mensaje en Mongo y avisa a soporte, sin copiarlo a Power Automate', async () => {
  reset();
  const res = response();
  await sendMsgLogoutSupport(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(state.saved.length, 1);
  assert.equal(state.flows.length, 0);
  assert.equal(state.saved[0].email, 'ana@example.com');
  assert.equal(state.saved[0].lang, 'es');
  assert.equal(state.saved[0].subscribe, false);
  assert.equal(state.emails.length, 1);
  assert.equal(state.emails[0].email, 'ana@example.com');
  assert.equal(state.insightErrors.length, 0);
});

test('si falla el email con el mensaje guardado, responde 200 y lo deja en App Insights', async () => {
  reset();
  state.emailImpl = async () => {
    throw { status: 401, message: 'Fail sending email' };
  };
  const res = response();
  await sendMsgLogoutSupport(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(state.saved.length, 1);
  assert.equal(state.insightErrors.length, 1);
  const logged = state.insightErrors[0];
  assert.equal(logged.message.type, 'SUPPORT_EMAIL_ERROR');
  assert.equal(logged.message.tenantId, 'dxgpt-prod');
  assert.equal(logged.message.myuuid, 'uuid-1');
  assert.equal(logged.properties.messageSaved, 'true');
});

test('si falla Mongo pero el email llega, responde 200 y registra el fallo de guardado', async () => {
  reset();
  state.saveImpl = async () => {
    throw new Error('Mongo down');
  };
  const res = response();
  await sendMsgLogoutSupport(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(state.emails.length, 1);
  assert.equal(state.insightErrors.length, 1);
  assert.equal(state.insightErrors[0].message.type, 'SUPPORT_SAVE_ERROR');
});

test('si fallan Mongo y el email, responde 500', async () => {
  reset();
  state.saveImpl = async () => {
    throw new Error('Mongo down');
  };
  state.emailImpl = async () => {
    throw { status: 401, message: 'Fail sending email' };
  };
  const res = response();
  await sendMsgLogoutSupport(request(), res);

  assert.equal(res.statusCode, 500);
  assert.deepEqual(state.insightErrors.map((e) => e.message.type), ['SUPPORT_SAVE_ERROR', 'SUPPORT_EMAIL_ERROR']);
  assert.equal(state.insightErrors[1].properties.messageSaved, 'false');
});

test('sin X-Tenant-Id ni suscripción sigue respondiendo 400', async () => {
  reset();
  const req = request();
  req.headers = {};
  const res = response();
  await sendMsgLogoutSupport(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(state.saved.length, 0);
  assert.equal(state.emails.length, 0);
});

test('el controlador ya no exporta sendFlow ni lleva URLs de Power Automate', () => {
  assert.deepEqual(Object.keys(supportController), ['sendMsgLogoutSupport']);
  const source = require('node:fs').readFileSync(require.resolve('../controllers/all/support'), 'utf8');
  assert.doesNotMatch(source, /logic\.azure\.com|powerplatform|environment\.api|sendFlow/);
});

test('si el usuario pide novedades, queda subscribe = true en Mongo', async () => {
  reset();
  const req = request();
  req.body.subscribe = true;
  const res = response();
  await sendMsgLogoutSupport(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(state.saved[0].subscribe, true);
  assert.equal(state.flows.length, 0);
});
