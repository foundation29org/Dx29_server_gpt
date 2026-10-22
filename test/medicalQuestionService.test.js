const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isHighAuthorityMedicalUrl,
  mergeAndPrioritizeSearchResults,
  resolveLanguageName,
  appendLanguageInstruction,
  cleanMedicalAnswer,
  buildSequentialSonarData,
  hasHyphenCitationRange,
  summarizeHyphenCitationRanges,
  sanitizeSourceText
} = require('../services/medicalQuestionService');
const { calculatePrice } = require('../services/costUtils');
const { aliasRoutingModel } = require('../services/aiUtils');

test('resolveLanguageName maps any valid ISO language code via Intl.DisplayNames and preserves -Latn script', () => {
  assert.equal(resolveLanguageName('es'), 'Spanish');
  assert.equal(resolveLanguageName('en-US'), 'English');
  assert.equal(resolveLanguageName('FR_fr'), 'French');
  assert.equal(resolveLanguageName('sw'), 'Swahili');
  assert.equal(resolveLanguageName('bn'), 'Bangla');
  assert.equal(resolveLanguageName('vi'), 'Vietnamese');
  assert.equal(
    resolveLanguageName('hi-Latn'),
    'Hindi written in Latin script (Romanized Hindi — do NOT use Devanagari or non-Latin script)'
  );
  assert.equal(resolveLanguageName('unknown'), null);
  assert.equal(resolveLanguageName('und'), null);
  assert.equal(resolveLanguageName(''), null);
});

test('appendLanguageInstruction appends explicit language directive when language is known', () => {
  const base = 'Answer the question.';
  assert.equal(
    appendLanguageInstruction(base, 'en'),
    "Answer the question.\n\nIMPORTANT: Write the entire answer in English, using the same writing script/alphabet as the user's question."
  );
  assert.equal(appendLanguageInstruction(base, ''), base);
});

test('cleanMedicalAnswer strips reasoning tags and code fences', () => {
  const raw = '```markdown\n<think>internal reasoning</think>\nFirst-line treatment is zinc [1].\n```';
  assert.equal(cleanMedicalAnswer(raw), 'First-line treatment is zinc [1].');
});

test('buildSequentialSonarData renumbers citations sequentially without gaps and expands comma lists', () => {
  const rawResults = [
    { title: 'Source 1', url: 'https://www.ncbi.nlm.nih.gov/1', date: '2025-01-01', snippet: 's1' },
    { title: 'Source 2', url: 'https://www.who.int/2', date: '2025-02-01', snippet: 's2' },
    { title: 'Source 3', url: 'https://www.nice.org.uk/3', date: '2025-03-01', snippet: 's3' },
    { title: 'Source 4', url: 'https://www.cdc.gov/4', date: '2025-04-01', snippet: 's4' }
  ];

  // Cita [4] primero, luego la lista [2, 4] y una cita fuera de rango [9]
  const rawAnswer = 'Claim A [4]. Claim B [2, 4] and invalid [9]. Repeat [4].';
  const { medicalAnswer, sonarData } = buildSequentialSonarData(rawAnswer, rawResults);

  assert.equal(medicalAnswer, 'Claim A [1]. Claim B [2][1] and invalid. Repeat [1].');
  assert.ok(sonarData);
  assert.equal(sonarData.hasCitations, true);
  assert.deepEqual(sonarData.citations, [
    'https://www.cdc.gov/4',
    'https://www.who.int/2'
  ]);
  assert.equal(sonarData.searchResults.length, 2);
  assert.equal(sonarData.searchResults[0].title, 'Source 4');
  assert.equal(sonarData.searchResults[1].title, 'Source 2');
});

test('buildSequentialSonarData never turns hyphen ranges into citations, even with 10 sources', () => {
  // Producción pide max_results: 10, así que results.length suele ser 10:
  // un límite por maxIndex no protegería ninguno de estos casos.
  const rawResults = Array.from({ length: 10 }, (_, i) => ({
    title: `Source ${i + 1}`,
    url: `https://www.ncbi.nlm.nih.gov/${i + 1}`,
    snippet: `s${i + 1}`
  }));

  const dose = buildSequentialSonarData('Dosis [5-10] mg [1].', rawResults);
  assert.equal(dose.medicalAnswer, 'Dosis [5-10] mg [1].');
  assert.equal(dose.sonarData.searchResults.length, 1);

  const inr = buildSequentialSonarData('INR objetivo [2-3] según guía [4–6].', rawResults);
  assert.equal(inr.medicalAnswer, 'INR objetivo [2-3] según guía [4–6].');
  assert.equal(inr.sonarData, null);
});

test('buildSequentialSonarData keeps markdown indentation when removing invalid citations', () => {
  const rawResults = [{ title: 'Source 1', url: 'https://www.cdc.gov/1', snippet: 's1' }];
  const rawAnswer = '- Item uno [1]\n  - Subitem con dato [9]\n  - Otro subitem [1]';
  const { medicalAnswer } = buildSequentialSonarData(rawAnswer, rawResults);

  assert.equal(medicalAnswer, '- Item uno [1]\n  - Subitem con dato\n  - Otro subitem [1]');
});

test('summarizeHyphenCitationRanges: withinSources false rules citations out, true does not confirm them', () => {
  assert.deepEqual(summarizeHyphenCitationRanges('INR [2-3] y guía [4–6].', 10), {
    count: 2,
    withinSources: true
  });
  assert.deepEqual(summarizeHyphenCitationRanges('Dosis [5-10] mg.', 4), {
    count: 1,
    withinSources: false
  });
  assert.deepEqual(summarizeHyphenCitationRanges('Sin rangos [1].', 10), {
    count: 0,
    withinSources: false
  });
});

test('hasHyphenCitationRange flags [4-6] style ranges and ignores comma lists and single citations', () => {
  assert.equal(hasHyphenCitationRange('Texto [4–6].'), true);
  assert.equal(hasHyphenCitationRange('Texto [1-3].'), true);
  assert.equal(hasHyphenCitationRange('Texto [1, 3] y [2].'), false);
  assert.equal(hasHyphenCitationRange(''), false);
});

test('buildSequentialSonarData returns null sonarData when no valid citations exist', () => {
  const rawResults = [{ title: 'Source 1', url: 'https://www.cdc.gov/1', snippet: 's1' }];
  const { medicalAnswer, sonarData } = buildSequentialSonarData('Plain answer without citations [9].', rawResults);
  assert.equal(medicalAnswer, 'Plain answer without citations.');
  assert.equal(sonarData, null);
});

test('calculatePrice supports gpt61sol and custom request_fee for Search API / web_search', () => {
  const price = calculatePrice(
    {
      prompt_tokens: 4000,
      completion_tokens: 1000,
      total_tokens: 5000,
      request_fee: 0.01
    },
    'gpt-6.1-sol'
  );
  assert.equal(price.model, 'gpt61sol');
  assert.equal(price.inputCost, 0.008);
  assert.equal(price.outputCost, 0.01);
  assert.equal(price.requestFee, 0.01);
  assert.equal(price.totalCost, 0.028);
});

test('aliasRoutingModel normalizes gpt-6.1-sol and gpt61sol', () => {
  assert.equal(aliasRoutingModel('gpt-6.1-sol'), 'gpt61sol');
  assert.equal(aliasRoutingModel('gpt61sol'), 'gpt61sol');
});

test('isHighAuthorityMedicalUrl recognizes PubMed, NICE, WHO, and CIMA AEMPS', () => {
  assert.equal(isHighAuthorityMedicalUrl('https://cima.aemps.es/cima/dochtml/p/39535/P_39535.html'), true);
  assert.equal(isHighAuthorityMedicalUrl('https://pubmed.ncbi.nlm.nih.gov/12345/'), true);
  assert.equal(isHighAuthorityMedicalUrl('https://www.nice.org.uk/guidance/ng28'), true);
  assert.equal(isHighAuthorityMedicalUrl('https://academic.oup.com/bja/article/1'), true);
  assert.equal(isHighAuthorityMedicalUrl('https://www.cochranelibrary.com/cdsr/doi/10.1002/1'), true);
  assert.equal(isHighAuthorityMedicalUrl('https://random-health-blog.example.com/post'), false);
});

test('isHighAuthorityMedicalUrl does not treat a lookalike suffix as the real domain', () => {
  assert.equal(isHighAuthorityMedicalUrl('https://healthgroup.com/article'), false);
  assert.equal(isHighAuthorityMedicalUrl('https://cheapdrugs.com/metamizole'), false);
  assert.equal(isHighAuthorityMedicalUrl('https://fakebmj.com/review'), false);
  assert.equal(isHighAuthorityMedicalUrl('https://essen.es/noticia'), false);
  assert.equal(isHighAuthorityMedicalUrl('https://pubmed-blog.net/post'), false);
});

test('mergeAndPrioritizeSearchResults interleaves round-robin across query buckets and prioritizes high-authority domains', () => {
  const bucketQ1 = [
    { url: 'https://cima.aemps.es/nolotil', title: 'Nolotil CIMA' },
    { url: 'https://generic-blog.com/nolotil', title: 'Blog Nolotil' },
    { url: 'https://pubmed.ncbi.nlm.nih.gov/111', title: 'PubMed Metamizole' }
  ];
  const bucketQ2 = [
    { url: 'https://cima.aemps.es/tirodril', title: 'Tirodril CIMA' },
    { url: 'https://generic-blog.com/tirodril', title: 'Blog Tirodril' },
    { url: 'https://www.ema.europa.eu/methimazole', title: 'EMA Methimazole' }
  ];

  const merged = mergeAndPrioritizeSearchResults([bucketQ1, bucketQ2], 4);
  assert.equal(merged.length, 4);
  assert.deepEqual(
    merged.map((r) => r.url),
    [
      'https://cima.aemps.es/nolotil',
      'https://cima.aemps.es/tirodril',
      'https://pubmed.ncbi.nlm.nih.gov/111',
      'https://www.ema.europa.eu/methimazole'
    ]
  );
});

test('sanitizeSourceText removes replacement characters from source snippets and titles', () => {
  assert.equal(sanitizeSourceText('If eGFR is \uFFFD45 mg/dL, \uFFFD\uFFFDEvery 2 weeks'), 'If eGFR is 45 mg/dL, Every 2 weeks');
  assert.equal(sanitizeSourceText(null), '');

  const { sonarData } = buildSequentialSonarData('Dosis baja. [1]', [
    { title: 'Guide \uFFFD2024', url: 'https://example.org/a', snippet: '\uFFFD\uFFFDGoal: 90\u2013150 mg/dL' }
  ]);
  assert.equal(sonarData.searchResults[0].title, 'Guide 2024');
  assert.equal(sonarData.searchResults[0].snippet, 'Goal: 90\u2013150 mg/dL');
});
