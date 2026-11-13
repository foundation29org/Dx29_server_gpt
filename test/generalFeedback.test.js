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
  errorEmails: [],
  flows: [],
  insightErrors: [],
  saveImpl: async () => {},
  emailImpl: async () => 'ok'
};

class FakeGeneralfeedback {
  constructor(fields) {
    Object.assign(this, fields);
  }

  async save() {
    await state.saveImpl(this);
    state.saved.push(this);
    return this;
  }
}

// Sin stub de ../config: el servicio ya no lo necesita (solo lo usaba el flujo)
stubModule('../models/generalfeedback', FakeGeneralfeedback);
stubModule('../services/email', {
  sendMailGeneralFeedback: async (...args) => {
    state.emails.push(args);
    return state.emailImpl();
  },
  sendMailError: async (...args) => {
    state.errorEmails.push(args);
  }
});
stubModule('../services/insights', {
  error: (message, properties = {}) => state.insightErrors.push({ message, properties }),
  trackEvent: () => {}
});
stubModule('../services/aiUtils', { resolveDiagnoseModel: (model) => model || 'gpt-default' });
// Ya no hay flujo de Power Automate: si alguien vuelve a llamar a axios, la prueba lo ve
stubModule('axios', {
  post: async (url, body) => {
    state.flows.push(body);
    return { status: 202 };
  }
});

const feedbackService = require('../services/generalFeedbackService');
const { sendGeneralFeedback } = feedbackService;

function reset() {
  state.saved = [];
  state.emails = [];
  state.errorEmails = [];
  state.flows = [];
  state.insightErrors = [];
  state.saveImpl = async () => {};
  state.emailImpl = async () => 'ok';
}

function request(overrides = {}) {
  return {
    headers: { 'x-tenant-id': 'dxgpt-prod', 'x-subscription-id': 'brave-water-0ce6c5a03' },
    body: {
      myuuid: '0f8fad5b-d9cb-469f-a165-70867728950e',
      lang: 'ES',
      value: {
        pregunta1: 4,
        pregunta2: 5,
        userType: 'patient',
        moreFunct: 'Más idiomas',
        freeText: '',
        email: 'Ana@Example.com'
      },
      ...overrides
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

test('guarda la encuesta en Mongo con su idioma y avisa a soporte, sin Power Automate', async () => {
  reset();
  const res = response();
  await sendGeneralFeedback(request(), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { send: true });
  assert.equal(state.saved.length, 1);
  const saved = state.saved[0];
  assert.equal(saved.lang, 'es');
  assert.equal(saved.email, 'ana@example.com');
  assert.equal(saved.pregunta1, 4);
  assert.equal(saved.tenantId, 'dxgpt-prod');
  assert.equal(saved.subscriptionId, 'brave-water-0ce6c5a03');
  assert.equal(state.flows.length, 0);
  assert.equal(state.emails.length, 1);
  assert.equal(state.insightErrors.length, 0);
});

test('sin lang guarda inglés', async () => {
  reset();
  const req = request();
  delete req.body.lang;
  const res = response();
  await sendGeneralFeedback(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(state.saved[0].lang, 'en');
});

test('si falla el email con la encuesta guardada, sigue respondiendo 200', async () => {
  reset();
  state.emailImpl = async () => {
    throw new Error('SendGrid 401');
  };
  const res = response();
  await sendGeneralFeedback(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(state.saved.length, 1);
  assert.equal(state.insightErrors.length, 1);
});

test('si falla Mongo responde 500 y no se copia a ningún flujo', async () => {
  reset();
  state.saveImpl = async () => {
    throw new Error('Mongo down');
  };
  const res = response();
  await sendGeneralFeedback(request(), res);

  assert.equal(res.statusCode, 500);
  assert.equal(state.flows.length, 0);
  assert.equal(state.errorEmails.length, 1);
});

test('con datos no válidos responde 400 y no guarda nada', async () => {
  reset();
  const res = response();
  await sendGeneralFeedback(request({ value: { pregunta1: 9, pregunta2: 5, userType: 'patient', moreFunct: '' } }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(state.saved.length, 0);
  assert.equal(state.emails.length, 0);
});

test('sin X-Tenant-Id ni suscripción responde 400', async () => {
  reset();
  const req = request();
  req.headers = {};
  const res = response();
  await sendGeneralFeedback(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(state.saved.length, 0);
});

test('el servicio ya no exporta sendFlow ni lleva URLs de Power Automate', () => {
  assert.deepEqual(Object.keys(feedbackService).sort(), ['sanitizeGeneralFeedbackData', 'sendGeneralFeedback']);
  const source = require('node:fs').readFileSync(require.resolve('../services/generalFeedbackService'), 'utf8');
  assert.doesNotMatch(source, /logic\.azure\.com|powerplatform|environment\.api|sendFlow/);
});
