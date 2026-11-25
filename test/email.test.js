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

const API_KEY = 'SG.test-key-not-real';

const state = {
  sent: [],
  apiKeys: [],
  insightErrors: [],
  sendImpl: async () => [{ statusCode: 202, headers: {} }]
};

const config = {
  client_server: 'http://localhost:4200',
  EMAIL: { sendgridApiKey: API_KEY, to: 'support@example.org', from: 'support@example.org' }
};

stubModule('../config', config);
stubModule('../services/insights', {
  error: (message, properties = {}) => state.insightErrors.push({ message, properties }),
  trackEvent: () => {}
});
stubModule('@sendgrid/mail', {
  setApiKey: (key) => state.apiKeys.push(key),
  send: async (msg) => {
    state.sent.push(msg);
    return state.sendImpl(msg);
  }
});

const email = require('../services/email');

function reset() {
  state.sent = [];
  state.insightErrors = [];
  state.sendImpl = async () => [{ statusCode: 202, headers: {} }];
  config.EMAIL.sendgridApiKey = API_KEY;
  config.EMAIL.to = 'support@example.org';
  config.EMAIL.from = 'support@example.org';
}

function supportDoc(fields) {
  return { ...fields, toObject: () => ({ ...fields }) };
}

test('el mensaje de soporte va a EMAIL_USER con el asunto y la plantilla de siempre', async () => {
  reset();
  const result = await email.sendMailSupport('ana@example.com', 'es', supportDoc({
    subject: 'DxGPT support',
    description: 'Name: Ana, Email: ana@example.com, Description: No carga',
    tenantId: 'dxgpt-prod',
    subscriptionId: 'sub-1',
    myuuid: 'uuid-1'
  }));

  assert.equal(result, 'ok');
  assert.deepEqual(state.apiKeys.slice(-1), [API_KEY]);
  assert.equal(state.sent.length, 1);
  const msg = state.sent[0];
  assert.equal(msg.to, 'support@example.org');
  assert.equal(msg.from, 'support@example.org');
  assert.equal(msg.subject, 'Mensaje para soporte de DxGPT (dxgpt-prod) (sub-1)');
  // SendGrid rechaza la misma dirección en to y bcc
  assert.equal(msg.bcc, undefined);
  assert.equal(msg.replyTo, undefined);
  assert.match(msg.html, /Nuevo caso de soporte de: ana@example.com/);
  assert.match(msg.html, /Descripción: Name: Ana, Email: ana@example.com, Description: No carga/);
  assert.match(msg.html, /Tenant ID: dxgpt-prod/);
  assert.match(msg.html, /UUID: uuid-1/);
  // Con el layout template.hbs alrededor
  assert.match(msg.html, /DxGPT Team/);
  assert.equal(msg.trackingSettings.clickTracking.enable, false);
  assert.equal(msg.trackingSettings.openTracking.enable, false);
});

test('el contenido del usuario se escapa en el HTML', async () => {
  reset();
  await email.sendMailSupport('ana@example.com', 'es', supportDoc({
    description: '<img src=x onerror=alert(1)>'
  }));
  assert.doesNotMatch(state.sent[0].html, /<img src=x/);
  assert.match(state.sent[0].html, /&lt;img src&#x3D;x onerror&#x3D;alert\(1\)&gt;/);
});

test('el aviso de error de GPT mantiene sus asuntos y acepta texto o JSON', async () => {
  reset();
  await email.sendMailErrorGPTIP('es', 'Fail callInfoDisease AI call', [{ a: 1 }], 'dxgpt-prod', 'sub-9');
  await email.sendMailErrorGPTIP('en', { body: 'x' }, 'resp', undefined, undefined);

  assert.equal(state.sent[0].subject, 'Mensaje para soporte de DxGPT - Error GPT (dxgpt-prod) - sub-9');
  assert.match(state.sent[0].html, /Info: Fail callInfoDisease AI call/);
  assert.match(state.sent[0].html, /Response: \[\{&quot;a&quot;:1\}\]/);
  assert.equal(state.sent[1].subject, 'Mensaje para soporte de DxGPT - Error GPT');
  assert.match(state.sent[1].html, /Info: \{&quot;body&quot;:&quot;x&quot;\}/);
});

test('el error genérico y el feedback general mantienen asunto y plantilla', async () => {
  reset();
  await email.sendMailError('es', { value: 'x' }, { message: 'boom' });
  await email.sendMailGeneralFeedback(
    { pregunta1: 4, pregunta2: 5, userType: 'clinician', freeText: 'Muy útil', email: 'ana@example.com' },
    'uuid-2', 'dxgpt-prod', null, ['informe.pdf'], 'gpt5', true
  );

  assert.equal(state.sent[0].subject, 'Mensaje para soporte de DxGPT - Error GPT');
  assert.equal(state.sent[1].subject, 'Mensaje para soporte de DxGPT - Feedback General (dxgpt-prod)');
  assert.match(state.sent[1].html, /Muy útil/);
  assert.match(state.sent[1].html, /uuid-2/);
});

test('con SENDGRID_FROM_EMAIL distinto, sale de ese remitente y las respuestas van a soporte', async () => {
  reset();
  config.EMAIL.from = 'noreply@example.app';
  await email.sendMailError('es', {}, {});
  assert.equal(state.sent[0].from, 'noreply@example.app');
  assert.equal(state.sent[0].to, 'support@example.org');
  assert.equal(state.sent[0].replyTo, 'support@example.org');
});

test('si SendGrid falla, rechaza como antes y deja el motivo en App Insights sin la clave', async () => {
  reset();
  state.sendImpl = async () => {
    const error = new Error('Forbidden');
    error.code = 403;
    error.response = {
      headers: {},
      body: { errors: [{ message: 'The from address does not match a verified Sender Identity.' }] }
    };
    throw error;
  };

  await assert.rejects(
    email.sendMailSupport('ana@example.com', 'es', supportDoc({})),
    { status: 401, message: 'Fail sending email' }
  );
  assert.equal(state.insightErrors.length, 1);
  const logged = state.insightErrors[0];
  assert.equal(logged.message.code, 403);
  assert.equal(logged.message.type, 'EMAIL_SEND_ERROR');
  // "errors" haría que insights lo tratase como un rechazo de validación
  assert.equal(logged.message.errors, undefined);
  assert.equal(logged.properties.template, 'mail_support/_es');
  assert.match(logged.properties.sendgridErrors, /verified Sender Identity/);
  assert.doesNotMatch(JSON.stringify(logged), /SG\.test-key/);
});

test('sin SENDGRID_API_KEY no llama a SendGrid y rechaza', async () => {
  reset();
  config.EMAIL.sendgridApiKey = '';
  await assert.rejects(email.sendMailError('es', {}, {}), { message: 'Fail sending email' });
  assert.equal(state.sent.length, 0);
  assert.match(state.insightErrors[0].message.error, /SENDGRID_API_KEY/);
});
