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

const { detectLanguageSmart } = require('../services/languageDetect');

test.beforeEach(() => {
  state.detectCalls = [];
  state.llmCalls = 0;
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
