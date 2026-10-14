'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const savedDocuments = [];

const resolvedDbPath = require.resolve('../db_connect');
const mongoose = require('mongoose');
require.cache[resolvedDbPath] = {
  id: resolvedDbPath,
  filename: resolvedDbPath,
  loaded: true,
  exports: mongoose
};

const Permalink = require('../models/permalink');
Permalink.prototype.save = async function saveStub() {
  await this.validate();
  savedDocuments.push(this.toObject());
  return this;
};

const permalinkController = require('../controllers/all/permalink');

function createRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

test('createPermalink accepts empty descriptions from image-only diagnoses', async () => {
  savedDocuments.length = 0;
  const req = {
    body: {
      medicalDescription: '',
      anonymizedDescription: '',
      diagnoses: [{ name: 'Balanitis' }],
      lang: 'en',
      createdDate: '2026-10-14T09:55:15.000Z',
      myuuid: '12345678-1234-1234-1234-123456789abc'
    }
  };
  const res = createRes();

  await permalinkController.createPermalink(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.success, true);
  assert.equal(typeof res.body.permalinkId, 'string');
  assert.equal(savedDocuments.length, 1);
  assert.equal(savedDocuments[0].medicalDescription, '');
  assert.equal(savedDocuments[0].anonymizedDescription, '');
});

test('createPermalink rejects requests where medicalDescription is missing or not a string', async () => {
  savedDocuments.length = 0;
  const req = {
    body: {
      anonymizedDescription: 'anon',
      diagnoses: [{ name: 'Balanitis' }],
      lang: 'en',
      createdDate: '2026-10-14T09:55:15.000Z',
      myuuid: '12345678-1234-1234-1234-123456789abc'
    }
  };
  const res = createRes();

  await permalinkController.createPermalink(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.equal(savedDocuments.length, 0);
});
