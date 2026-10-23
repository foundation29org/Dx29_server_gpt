'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectLanguageLocal, warmUpLocalDetector } = require('../services/localLanguageDetect');

test.before(async () => {
  assert.ok(await warmUpLocalDetector(), 'local detector models failed to load');
});

const CASES = [
  ['es', 'Tengo dolor de cabeza desde hace tres semanas y mareos al levantarme por la mañana.'],
  ['en', 'I have had a headache for three weeks and feel dizzy when I stand up in the morning.'],
  ['pt', 'Tenho dor de cabeça há três semanas e tonturas quando me levanto de manhã.'],
  ['fr', 'J’ai mal à la tête depuis trois semaines et des vertiges quand je me lève le matin.'],
  ['de', 'Ich habe seit drei Wochen Kopfschmerzen und mir wird schwindelig, wenn ich morgens aufstehe.'],
  ['ru', 'У меня болит голова уже три недели, и по утрам кружится голова, когда я встаю.'],
  ['hi', 'मुझे तीन हफ्तों से सिर दर्द है और सुबह उठने पर चक्कर आते हैं।']
];

for (const [expected, text] of CASES) {
  test(`detects ${expected} locally`, async () => {
    assert.equal(await detectLanguageLocal(text), expected);
  });
}

test('leaves short texts to Azure', async () => {
  assert.equal(await detectLanguageLocal('Acute diarrhea'), null);
  assert.equal(await detectLanguageLocal(''), null);
});

test('ignores masks, numbers and anonymization tags when measuring the text', async () => {
  assert.equal(await detectLanguageLocal('***** ****** ***** **** ***** **** *** ****'), null);
  assert.equal(await detectLanguageLocal('[ANON-5] 123 456 789 [ANON-3] 2026-10-23 [ANON-4]'), null);
});

test('leaves Chinese to Azure because it needs the simplified or traditional script', async () => {
  assert.equal(await detectLanguageLocal('我头痛已经三个星期了，早上起床时会头晕，请问应该怎么办。'), null);
  assert.equal(await detectLanguageLocal('我頭痛已經三個星期了，早上起床時會頭暈，請問應該怎麼辦。'), null);
  assert.equal(await detectLanguageLocal('最近三周一直头痛，起床的时候还会头晕，需要去医院检查什么？'), null);
});

test('copes with non-string input and very long texts', async () => {
  assert.equal(await detectLanguageLocal(null), null);
  assert.equal(await detectLanguageLocal({ text: 'x' }), null);
  assert.equal(await detectLanguageLocal(12345678901234567890123456789012345), null);
  const long = 'Tengo dolor de cabeza desde hace tres semanas y mareos al levantarme por la mañana. '.repeat(5000);
  assert.equal(await detectLanguageLocal(long), 'es');
});

test('does not label romanized Hindi (hinglish) or mixed text as English', async () => {
  // Hinglish: debe ir a Azure (null). Si se aceptara "hi", la instrucción de idioma
  // empujaría al alfabeto devanagari, peor que dejar que decida Azure.
  const hinglish = [
    'Mujhe teen din se bukhar hai aur body pain bhi ho raha hai, konsi medicine leni chahiye',
    'Meri age 35 hai aur mujhe sugar ki problem hai, diet kaise control karu please batao'
  ];
  for (const text of hinglish) {
    assert.equal(await detectLanguageLocal(text), null, text);
  }
  assert.notEqual(
    await detectLanguageLocal('Sakit kepala sudah tiga minggu, apakah harus cek MRI atau blood test dulu'),
    'en'
  );
});
