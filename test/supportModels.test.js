'use strict';

// Esquemas de supports y generalfeedbacks: los campos que usan la página de gestión de soporte y
// el script de novedades. Se prueba con mongoose sin conexión (db_connect conectaría a Mongo).
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const dbConnectPath = require.resolve('../db_connect');
require.cache[dbConnectPath] = { id: dbConnectPath, filename: dbConnectPath, loaded: true, exports: mongoose };

const Support = require('../models/support');
const Generalfeedback = require('../models/generalfeedback');

test('un soporte nuevo queda sin contestar y sin suscripción por defecto', () => {
  const doc = new Support({ email: 'ana@example.com', lang: 'es' });
  assert.equal(doc.status, 'unread');
  assert.equal(doc.subscribe, false);
  assert.equal(doc.answeredAt, undefined);
  assert.equal(doc.unsubscribedAt, undefined);
});

test('una encuesta nueva guarda su idioma y queda sin contestar', () => {
  const doc = new Generalfeedback({ myuuid: 'x', email: 'ana@example.com', lang: 'es' });
  assert.equal(doc.lang, 'es');
  assert.equal(doc.status, 'unread');
  assert.equal(doc.answeredAt, undefined);
  assert.equal(doc.unsubscribedAt, undefined);
});

test('los dos esquemas declaran status, answeredAt y unsubscribedAt', () => {
  for (const Model of [Support, Generalfeedback]) {
    assert.equal(Model.schema.path('status').instance, 'String');
    assert.equal(Model.schema.path('answeredAt').instance, 'Date');
    assert.equal(Model.schema.path('unsubscribedAt').instance, 'Date');
  }
  assert.equal(Generalfeedback.schema.path('lang').instance, 'String');
});
