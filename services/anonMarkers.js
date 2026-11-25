'use strict';

// Marcadores [ANON-N] del anonimizador, con N = caracteres tapados. N lo escribe el
// modelo, pero el prompt le pide conservar los [ANON-N] que ya traiga el texto, así
// que también lo puede poner el usuario: sin tope, [ANON-400000000] crea una cadena
// de cientos de MB. El tope es el mismo que aplica SafePipe en la web.
const MAX_MASK_LENGTH = 40;
const ANON_MARKER = /\[ANON-(\d+)\]/g;

function maskLength(digits) {
  const length = parseInt(digits, 10);
  return Math.min(Math.max(length || 1, 1), MAX_MASK_LENGTH);
}

// Texto plano: cada marcador pasa a N veces maskChar ('*' o '█'). Sin texto lanza,
// como el .replace() de antes: si la traducción no devuelve nada, la petición falla
// en vez de seguir con una descripción anonimizada vacía.
function maskAnonMarkers(text, maskChar) {
  if (typeof text !== 'string') throw new TypeError('maskAnonMarkers expects a string');
  return text.replace(ANON_MARKER, (marker, digits) => maskChar.repeat(maskLength(digits)));
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// HTML para anonymizedTextHtml: el texto va escapado, porque los clientes de la API
// lo insertan como HTML y la web lo vuelve a filtrar con SafePipe. Los marcadores
// no llevan caracteres que se escapen, así que se sustituyen después.
function anonMarkersToHtml(text) {
  if (!text || typeof text !== 'string') return '';
  return escapeHtml(text)
    .replace(ANON_MARKER, (marker, digits) =>
      `<span style="background-color: black; display: inline-block; width:${maskLength(digits)}em;">&nbsp;</span>`)
    .replace(/\n/g, '<br>');
}

module.exports = {
  MAX_MASK_LENGTH,
  maskAnonMarkers,
  anonMarkersToHtml
};
