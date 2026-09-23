'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { needsLimiter } = require('../services/rateLimiter');

function listen(app) {
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function hit(server, headers) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/',
      headers
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    req.on('error', reject);
    req.end();
  });
}

test('rates each visitor separately even when every chain ends at the same proxy', async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.get('/', needsLimiter, (_req, res) => res.end('ok'));
  const server = await listen(app);

  try {
    const first = await hit(server, {
      'x-forwarded-for': '173.176.210.241,172.70.50.123:14789,40.70.146.136:26944,40.70.146.136,108.143.55.53'
    });
    const sameVisitorNewPort = await hit(server, {
      'x-forwarded-for': '173.176.210.241,172.70.50.123:18084,20.44.13.137:35066,20.44.13.137,108.143.55.53'
    });
    const otherVisitor = await hit(server, {
      'x-forwarded-for': '82.26.72.153,172.64.213.142:16447,20.205.74.202:62038,20.205.74.202,108.143.55.53'
    });

    assert.equal(first.headers['x-ratelimit-remaining'], '99');
    assert.equal(sameVisitorNewPort.headers['x-ratelimit-remaining'], '98');
    assert.equal(otherVisitor.headers['x-ratelimit-remaining'], '99');
  } finally {
    server.close();
  }
});

test('uses the gateway client IP and ignores a port glued to the visitor', async () => {
  const app = express();
  app.get('/', needsLimiter, (_req, res) => res.end('ok'));
  const server = await listen(app);

  try {
    const first = await hit(server, {
      'x-client-ip': '203.0.113.10',
      'x-forwarded-for': '198.51.100.20,108.143.55.53'
    });
    const spoofedList = await hit(server, {
      'x-client-ip': '203.0.113.10,198.51.100.20',
      'x-forwarded-for': '187.13.6.132:22984,187.13.6.132,108.143.55.53'
    });

    assert.equal(first.headers['x-ratelimit-remaining'], '99');
    assert.equal(spoofedList.headers['x-ratelimit-remaining'], '99');
  } finally {
    server.close();
  }
});
