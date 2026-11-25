'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_MASK_LENGTH, maskAnonMarkers, anonMarkersToHtml } = require('../services/anonMarkers');

const span = (width) =>
  `<span style="background-color: black; display: inline-block; width:${width}em;">&nbsp;</span>`;

test('tapa cada marcador con tantos caracteres como indica', () => {
  assert.equal(maskAnonMarkers('Paciente [ANON-4], 45 años', '*'), 'Paciente ****, 45 años');
  assert.equal(maskAnonMarkers('[ANON-3] y [ANON-2]', '█'), '███ y ██');
});

test('acota N entre 1 y 40 aunque el número sea enorme', () => {
  assert.equal(maskAnonMarkers('[ANON-400000000]', '*'), '*'.repeat(MAX_MASK_LENGTH));
  assert.equal(maskAnonMarkers(`[ANON-${'9'.repeat(5000)}]`, '*'), '*'.repeat(MAX_MASK_LENGTH));
  assert.equal(maskAnonMarkers('[ANON-0]', '*'), '*');
  assert.equal(anonMarkersToHtml('[ANON-400000000]'), span(MAX_MASK_LENGTH));
});

test('el HTML escapa el texto y conserva los bloques y los saltos de línea', () => {
  assert.equal(
    anonMarkersToHtml('<img src=x onerror=alert(1)> [ANON-5]\nPCR > 10 & "K" <5 d\'Ors'),
    `&lt;img src=x onerror=alert(1)&gt; ${span(5)}<br>PCR &gt; 10 &amp; &quot;K&quot; &lt;5 d&#39;Ors`
  );
});

test('un span escrito en el texto no pasa como bloque de redacción', () => {
  const html = anonMarkersToHtml(`texto ${span(3)}`);
  assert.doesNotMatch(html, /<span/);
});

test('sin texto: el HTML queda vacío y el enmascarado lanza, como antes', () => {
  assert.equal(maskAnonMarkers('', '*'), '');
  assert.throws(() => maskAnonMarkers(undefined, '*'), TypeError);
  assert.equal(anonMarkersToHtml(null), '');
  assert.equal(anonMarkersToHtml(42), '');
});
