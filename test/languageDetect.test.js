'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const state = { detectCalls: [], llmCalls: 0 };

const aiUtilsPath = require.resolve('../services/aiUtils');
require.cache[aiUtilsPath] = {
  id: aiUtilsPath,
  filename: aiUtilsPath,
  loaded: true,
  exports: {
    detectLanguageWithRetry: async (text) => {
      state.detectCalls.push(text);
      return 'pt';
    },
    callAiWithFailover: async () => {
      state.llmCalls += 1;
      throw new Error('not expected');
    }
  }
};

const localPath = require.resolve('../services/localLanguageDetect');
require.cache[localPath] = {
  id: localPath,
  filename: localPath,
  loaded: true,
  exports: {
    detectLanguageLocal: async () => state.localResult
  }
};

const { detectLanguageSmart, detectLanguageLocalOrAzure } = require('../services/languageDetect');

test.beforeEach(() => {
  state.detectCalls = [];
  state.llmCalls = 0;
  state.localResult = null;
});

test('uses the local detector without calling Azure or the LLM when it is sure', async () => {
  state.localResult = 'fr';
  const result = await detectLanguageSmart('Mal de tête et fièvre depuis trois jours', 'es');
  assert.equal(result.lang, 'fr');
  assert.equal(result.modelUsed, 'local_detect');
  assert.equal(result.azureCharsBilled, 0);
  assert.equal(state.detectCalls.length, 0);
  assert.equal(state.llmCalls, 0);
});

test('local-or-Azure helper bills Azure characters only when Azure is used', async () => {
  state.localResult = 'de';
  assert.deepEqual(await detectLanguageLocalOrAzure('Kopfschmerzen seit drei Tagen', 'es'), { lang: 'de', azureCharsBilled: 0 });
  state.localResult = null;
  const text = 'Dor de cabeça e febre há três dias';
  assert.deepEqual(await detectLanguageLocalOrAzure(text, 'es'), { lang: 'pt', azureCharsBilled: text.length });
});

test('uses the page language for text too short to detect', async () => {
  for (const text of ['', '   ', 'dolor']) {
    const result = await detectLanguageSmart(text, 'es');
    assert.equal(result.lang, 'es');
    assert.equal(result.modelUsed, 'fallback_hint');
  }
  assert.equal(state.detectCalls.length, 0);
  assert.equal(state.llmCalls, 0);
});

test('falls back to English when there is no page language', async () => {
  const result = await detectLanguageSmart('', undefined);
  assert.equal(result.lang, 'en');
});

test('still detects the language of a normal description', async () => {
  const result = await detectLanguageSmart('Dor de cabeça e febre há três dias', 'es');
  assert.equal(result.lang, 'pt');
  assert.equal(state.detectCalls.length, 1);
});
