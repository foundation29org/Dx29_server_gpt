'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function stubModule(modulePath, exports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = { id: resolvedPath, filename: resolvedPath, loaded: true, exports };
}

const mongoose = require('mongoose');
stubModule('../db_connect', mongoose);

const state = {
  anonymize: null,
  anonymizeCalls: [],
  costRecords: [],
  errors: []
};

stubModule('../services/anonymizeService', {
  anonymizeText: async (...args) => {
    state.anonymizeCalls.push(args);
    if (state.anonymize instanceof Error) throw state.anonymize;
    return state.anonymize;
  }
});
stubModule('../services/costTrackingService', {
  saveSimpleOperationCostBestEffort: async (...args) => {
    state.costRecords.push(args);
  }
});
stubModule('../services/insights', {
  error: (payload) => state.errors.push(payload),
  trackEvent: () => {}
});

const savedDocuments = [];
const updates = [];
const findQueries = [];

const Permalink = require('../models/permalink');
Permalink.prototype.save = async function saveStub() {
  await this.validate();
  savedDocuments.push(this.toObject());
  return this;
};
Permalink.updateOne = async (filter, update) => {
  updates.push({ filter, update });
  return { acknowledged: true };
};
Permalink.findOne = async (query) => {
  findQueries.push(query);
  return null;
};

const CostTracking = require('../models/costTracking');
const permalinkController = require('../controllers/all/permalink');
const permalinkService = require('../services/permalinkService');

const MYUUID = '12345678-1234-1234-1234-123456789abc';

function reset() {
  state.anonymize = null;
  state.anonymizeCalls.length = 0;
  state.costRecords.length = 0;
  state.errors.length = 0;
  savedDocuments.length = 0;
  updates.length = 0;
  findQueries.length = 0;
}

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

function validBody(overrides = {}) {
  return {
    medicalDescription: 'Fiebre de 3 días y tos.',
    diagnoses: [{ name: 'Gripe' }],
    lang: 'es',
    myuuid: MYUUID,
    timezone: 'Europe/Madrid',
    ...overrides
  };
}

async function create(body, headers = {}) {
  const res = createRes();
  await permalinkController.createPermalink({ body, headers }, res);
  return res;
}

// Espera a que termine el trabajo en segundo plano que lanza el controlador.
const flushBackground = async () => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
};

test('sin texto (diagnóstico solo con imagen) guarda el permalink y no llama al anonimizador', async () => {
  reset();
  const res = await create(validBody({ medicalDescription: '' }));
  await flushBackground();

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.success, true);
  assert.equal(savedDocuments.length, 1);
  assert.equal(savedDocuments[0].medicalDescription, '');
  assert.equal(savedDocuments[0].anonymizedDescription, '');
  assert.equal(state.anonymizeCalls.length, 0);
  assert.equal(updates.length, 0);
});

test('el id es aleatorio, de 22 caracteres, y no depende de myuuid ni de la fecha del cliente', async () => {
  reset();
  state.anonymize = { hasPersonalInfo: false, anonymizationFailed: false, htmlText: 'x', usage: null };
  const body = validBody({ createdDate: '2026-10-14T09:55:15.000Z' });
  const first = await create(body);
  const second = await create(body);
  await flushBackground();

  assert.match(first.body.permalinkId, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(first.body.permalinkId, second.body.permalinkId);
  // La fecha la pone el servidor, no el cliente.
  assert.notEqual(savedDocuments[0].createdDate.toISOString(), '2026-10-14T09:55:15.000Z');
});

test('el texto se guarda después y nunca en la creación', async () => {
  reset();
  state.anonymize = { hasPersonalInfo: false, anonymizationFailed: false, htmlText: 'Fiebre de 3 días y tos.', usage: null };
  const res = await create(validBody(), { 'x-tenant-id': 'dxgpt-prod', 'x-subscription-id': 'sub-web' });

  assert.equal(savedDocuments[0].medicalDescription, '');
  await flushBackground();

  const [description, timezone, tenantId, subscriptionId, myuuid, model] = state.anonymizeCalls[0];
  assert.equal(description, 'Fiebre de 3 días y tos.');
  assert.equal(timezone, 'Europe/Madrid');
  assert.equal(tenantId, 'dxgpt-prod');
  assert.equal(subscriptionId, 'sub-web');
  assert.equal(myuuid, MYUUID);
  assert.equal(model, 'gpt54mini');
  assert.deepEqual(updates, [{
    filter: { permalinkId: res.body.permalinkId },
    update: { $set: { medicalDescription: 'Fiebre de 3 días y tos.' } }
  }]);
});

test('sin zona horaria (clientes anteriores) anonimiza en Europa', async () => {
  reset();
  state.anonymize = { hasPersonalInfo: false, anonymizationFailed: false, htmlText: 'x', usage: null };
  const body = validBody();
  delete body.timezone;
  await create(body);
  await flushBackground();
  assert.equal(state.anonymizeCalls[0][1], 'Europe/Madrid');
});

test('responde antes de llamar al anonimizador', async () => {
  reset();
  state.anonymize = { hasPersonalInfo: false, anonymizationFailed: false, htmlText: 'Fiebre de 3 días y tos.', usage: null };
  const res = await create(validBody());
  assert.equal(res.statusCode, 201);
  assert.equal(state.anonymizeCalls.length, 0);
  await flushBackground();
  assert.equal(state.anonymizeCalls.length, 1);
});

test('con la petición del cliente anterior mantiene el aviso si el texto ya iba enmascarado', async () => {
  reset();
  state.anonymize = { hasPersonalInfo: false, anonymizationFailed: false, htmlText: 'Paciente ****, fiebre.', usage: null };
  await create({
    medicalDescription: 'Paciente ****, fiebre.',
    anonymizedDescription: 'Paciente <span style="background-color: black; display: inline-block; width:4em;">&nbsp;</span>, fiebre.',
    diagnoses: [{ name: 'Gripe' }],
    lang: 'es',
    createdDate: '2026-11-27T10:00:00.000Z',
    myuuid: MYUUID
  });
  await flushBackground();
  assert.deepEqual(updates[0].update, {
    $set: { medicalDescription: 'Paciente ****, fiebre.', anonymized: true }
  });
});

test('con la petición del cliente anterior sin datos tapados no pone el aviso', async () => {
  reset();
  state.anonymize = { hasPersonalInfo: false, anonymizationFailed: false, htmlText: 'Fiebre.', usage: null };
  await create({
    medicalDescription: 'Fiebre.',
    anonymizedDescription: 'Fiebre.',
    diagnoses: [{ name: 'Gripe' }],
    lang: 'es',
    createdDate: '2026-11-27T10:00:00.000Z',
    myuuid: MYUUID
  });
  await flushBackground();
  assert.deepEqual(updates[0].update, { $set: { medicalDescription: 'Fiebre.' } });
});

test('si el anonimizador cambia el texto sin marcar nada, no guarda ningún texto', async () => {
  reset();
  state.anonymize = { hasPersonalInfo: false, anonymizationFailed: false, htmlText: 'Paciente ***, fiebre.', usage: null };
  await permalinkService.storeAnonymizedDescription('abcdefghijklmnopqrstuv', 'Paciente Juan, fiebre.', {
    timezone: 'Europe/Madrid', myuuid: MYUUID, lang: 'es'
  });
  assert.equal(updates.length, 0);
});

test('los cambios de espacios o saltos de línea no cuentan como texto cambiado', async () => {
  reset();
  state.anonymize = { hasPersonalInfo: false, anonymizationFailed: false, htmlText: 'Fiebre de 3 días.\nTos seca.', usage: null };
  await permalinkService.storeAnonymizedDescription('abcdefghijklmnopqrstuv', '  Fiebre de  3 días. \r\nTos seca.\n', {
    timezone: 'Europe/Madrid', myuuid: MYUUID, lang: 'es'
  });
  assert.deepEqual(updates[0].update, { $set: { medicalDescription: '  Fiebre de  3 días. \r\nTos seca.\n' } });
});

test('si falla el guardado del texto lo registra sin el texto y no rompe', async () => {
  reset();
  state.anonymize = { hasPersonalInfo: true, anonymizationFailed: false, htmlText: 'Paciente [ANON-4], fiebre.', usage: null };
  const originalUpdateOne = Permalink.updateOne;
  Permalink.updateOne = async () => { throw new Error('mongo caído'); };
  try {
    await permalinkService.storeAnonymizedDescription('abcdefghijklmnopqrstuv', 'Paciente Juan, fiebre.', {
      timezone: 'Europe/Madrid', myuuid: MYUUID, lang: 'es'
    });
  } finally {
    Permalink.updateOne = originalUpdateOne;
  }
  assert.equal(state.errors.length, 1);
  assert.ok(!JSON.stringify(state.errors).includes('Juan'));
});

test('con datos personales guarda solo el texto enmascarado y marca el aviso', async () => {
  reset();
  state.anonymize = {
    hasPersonalInfo: true,
    anonymizationFailed: false,
    htmlText: 'Paciente [ANON-4], fiebre.',
    usage: null
  };
  await permalinkService.storeAnonymizedDescription('abcdefghijklmnopqrstuv', 'Paciente Juan, fiebre.', {
    timezone: 'Europe/Madrid', myuuid: MYUUID, lang: 'es'
  });

  assert.deepEqual(updates[0].update, {
    $set: { medicalDescription: 'Paciente ****, fiebre.', anonymized: true }
  });
});

test('si el cliente ya lo enmascaró, mantiene el aviso aunque el anonimizador no vea nada nuevo', async () => {
  reset();
  state.anonymize = { hasPersonalInfo: false, anonymizationFailed: false, htmlText: 'Paciente ****, fiebre.', usage: null };
  await create(validBody({ medicalDescription: 'Paciente ****, fiebre.', anonymized: true }));
  await flushBackground();
  assert.deepEqual(updates[0].update, {
    $set: { medicalDescription: 'Paciente ****, fiebre.', anonymized: true }
  });
});

test('getPermalink devuelve el aviso', async () => {
  reset();
  const originalFindOne = Permalink.findOne;
  Permalink.findOne = async () => ({
    medicalDescription: 'Paciente ****, fiebre.',
    anonymizedDescription: '',
    anonymized: true,
    diagnoses: [{ name: 'Gripe' }],
    lang: 'es',
    createdDate: new Date('2026-11-27T10:00:00Z')
  });
  try {
    const res = createRes();
    await permalinkController.getPermalink({ params: { id: 'abcdefghijklmnopqrstuv' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.anonymized, true);
    assert.equal(res.body.data.medicalDescription, 'Paciente ****, fiebre.');
  } finally {
    Permalink.findOne = originalFindOne;
  }
});

test('si la anonimización viene vacía no guarda ningún texto', async () => {
  reset();
  state.anonymize = { hasPersonalInfo: false, anonymizationFailed: true, htmlText: '', usage: { prompt_tokens: 10, completion_tokens: 0 } };
  await permalinkService.storeAnonymizedDescription('abcdefghijklmnopqrstuv', 'Paciente Juan, fiebre.', {
    timezone: 'Europe/Madrid', myuuid: MYUUID, lang: 'es'
  });
  assert.equal(updates.length, 0);
  assert.equal(state.costRecords.length, 1);
  assert.equal(state.costRecords[0][2].success, false);
  assert.equal(state.costRecords[0][3], 'error');
});

test('si el anonimizador falla no guarda texto y el log no lo lleva', async () => {
  reset();
  state.anonymize = new Error('timeout');
  await permalinkService.storeAnonymizedDescription('abcdefghijklmnopqrstuv', 'Paciente Juan, fiebre.', {
    timezone: 'Europe/Madrid', tenantId: 'dxgpt-prod', myuuid: MYUUID, lang: 'es'
  });
  assert.equal(updates.length, 0);
  assert.equal(state.errors.length, 1);
  assert.ok(!JSON.stringify(state.errors).includes('Juan'));
});

test('el coste se registra como operación permalink y el modelo lo acepta', async () => {
  reset();
  state.anonymize = {
    hasPersonalInfo: false,
    anonymizationFailed: false,
    htmlText: 'Fiebre.',
    usage: { prompt_tokens: 120, completion_tokens: 10 }
  };
  await permalinkService.storeAnonymizedDescription('abcdefghijklmnopqrstuv', 'Fiebre.', {
    timezone: 'Europe/Madrid', tenantId: 'dxgpt-prod', subscriptionId: 'sub-web', myuuid: MYUUID, lang: 'es'
  });

  assert.equal(state.costRecords.length, 1);
  const [data, operation, stage] = state.costRecords[0];
  assert.equal(operation, 'permalink');
  assert.equal(stage.name, 'anonymization');
  assert.equal(stage.model, 'gpt54mini');
  assert.equal(data.subscriptionId, 'sub-web');

  const record = new CostTracking({
    myuuid: data.myuuid,
    tenantId: data.tenantId,
    subscriptionId: data.subscriptionId,
    operation,
    model: stage.model,
    lang: data.lang,
    timezone: data.timezone,
    stages: [stage],
    totalCost: stage.cost,
    totalTokens: stage.tokens,
    descriptionLength: data.description.length,
    status: 'success'
  });
  await record.validate();
});

test('rechaza peticiones fuera de las cotas', async () => {
  const cases = {
    'sin medicalDescription': validBody({ medicalDescription: undefined }),
    'medicalDescription demasiado largo': validBody({ medicalDescription: 'a'.repeat(10001) }),
    'diagnoses no es lista': validBody({ diagnoses: { name: 'Gripe' } }),
    'diagnoses vacío': validBody({ diagnoses: [] }),
    'diagnóstico que no es objeto': validBody({ diagnoses: ['Gripe'] }),
    'diagnoses demasiado grande': validBody({ diagnoses: [{ name: 'a'.repeat(100001) }] }),
    'lang demasiado largo': validBody({ lang: 'abcdefghi' }),
    'myuuid que no es UUID': validBody({ myuuid: 'abc' }),
    'timezone que no es texto': validBody({ timezone: 5 }),
    'anonymized que no es booleano': validBody({ anonymized: 'true' }),
    'cuerpo que no es objeto': null
  };
  for (const [name, body] of Object.entries(cases)) {
    reset();
    const res = await create(body);
    assert.equal(res.statusCode, 400, name);
    assert.equal(savedDocuments.length, 0, name);
  }
});

test('guarda como mucho diez diagnósticos', async () => {
  reset();
  const diagnoses = Array.from({ length: 15 }, (_, i) => ({ name: `D${i}` }));
  await create(validBody({ medicalDescription: '', diagnoses }));
  assert.equal(savedDocuments[0].diagnoses.length, 10);
});

test('getPermalink no consulta Mongo con un id mal formado', async () => {
  reset();
  for (const id of ['abc', 'a'.repeat(33), '../../x', '{"$ne":null}']) {
    const res = createRes();
    await permalinkController.getPermalink({ params: { id } }, res);
    assert.equal(res.statusCode, 404, id);
  }
  assert.equal(findQueries.length, 0);
});

test('getPermalink sigue aceptando los ids antiguos de 16 caracteres', async () => {
  reset();
  const res = createRes();
  await permalinkController.getPermalink({ params: { id: '0123456789abcdef' } }, res);
  assert.deepEqual(findQueries, [{ permalinkId: '0123456789abcdef' }]);
  assert.equal(res.statusCode, 404);
});
