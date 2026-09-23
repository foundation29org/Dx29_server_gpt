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

const tracked = {
  exceptions: [],
  events: []
};

stubModule('../config', {
  client_server: 'https://client.test'
});
stubModule('applicationinsights', {
  defaultClient: {
    trackException: (entry) => tracked.exceptions.push(entry),
    trackEvent: (entry) => tracked.events.push(entry)
  }
});

delete require.cache[require.resolve('../services/insights')];
const insights = require('../services/insights');

test.beforeEach(() => {
  tracked.exceptions = [];
  tracked.events = [];
});

test('promotes safe correlation metadata without copying clinical fields', () => {
  insights.error({
    message: 'Document extraction failed',
    correlationId: 'case-123',
    phase: 'extract_documents',
    code: 'INVALID_CONTENT',
    clinicalText: 'Do not index this value'
  });

  assert.equal(
    tracked.exceptions[0].properties.correlationId,
    'case-123'
  );
  assert.equal(
    tracked.exceptions[0].properties.phase,
    'extract_documents'
  );
  assert.equal(
    Object.hasOwn(tracked.exceptions[0].properties, 'clinicalText'),
    false
  );
});

test('keeps the request payload out of the exception message', () => {
  insights.error({
    message: 'Unknown error in processMultimodalInput',
    error: 'Cosmos unavailable',
    endpoint: 'processMultimodalInput',
    stack: 'Error: Cosmos unavailable\n    at handler',
    requestInfo: { userAgent: 'agent/1.0', origin: 'https://client.test' },
    requestData: { text: 'Do not index this value' }
  });

  assert.equal(
    tracked.exceptions[0].exception.message,
    'Unknown error in processMultimodalInput | Cosmos unavailable'
  );
  assert.match(tracked.exceptions[0].exception.stack, /at handler/);
  assert.doesNotMatch(
    tracked.exceptions[0].exception.message,
    /Do not index this value|agent\/1\.0/
  );
});

test('sends event dimensions as strings and metrics as measurements', () => {
  insights.trackEvent('MultimodalAnalysisCompleted', {
    correlationId: 'case-123',
    summarized: false,
    tenantId: null
  }, {
    durationMs: 1234,
    totalImages: 2,
    notANumber: 'nope'
  });

  assert.deepEqual(tracked.events[0].properties, {
    correlationId: 'case-123',
    summarized: 'false'
  });
  assert.deepEqual(tracked.events[0].measurements, {
    durationMs: 1234,
    totalImages: 2
  });
});
