'use strict';

// Detección de idioma local y gratuita. Azure Translator cobra la detección por
// carácter y la mayoría de textos son cortos, así que primero se pregunta a dos
// detectores independientes (tinyld y eld). Solo se da por buena la respuesta si
// ambos coinciden y eld la marca como fiable; en cualquier otro caso devuelve
// null y quien llama usa Azure como hasta ahora (idiomas dudosos, textos cortos,
// mezclas, idiomas que Azure no traduce, etc.).
//
// Medido contra textos reales de producción (frente al idioma que había
// detectado Azure): resuelve en local entre el 83% (preguntas generales) y el 88%
// (mezcla de flujos) de los textos, con un 99,6-99,9% de coincidencia. Los textos
// que mezclan idiomas (hinglish, indonesio o tagalo con términos en inglés) son la
// debilidad: en preguntas generales unos 5 de cada 136 textos de hinglish se siguen
// leyendo como inglés. franc se descartó: confunde portugués con gallego y ruso con
// serbio, lo que solo restaba cobertura.

const SUPPORTED = require('./translatorSupported.json');
const NORMALIZE = require('./langNormalize.json');

// Por debajo de esto los detectores fallan (p. ej. "Acute diarrhea" → ro) y
// Azure cuesta una fracción de céntimo, así que no se usan.
const MIN_LOCAL_DETECT_CHARS = 30;

// El inglés es la etiqueta a la que caen los textos mezclados (hinglish, indonesio
// o tagalo con términos médicos en inglés): ambos detectores coinciden en "en"
// aunque el texto no lo sea. Para aceptar "en" se exige además que eld lo puntúe
// con claridad. Medido sobre 4.756 preguntas generales reales, con 0,70 el hinglish
// mal detectado baja de 24 a 5 de 136 y solo el 3,7% del inglés pasa a Azure.
const MIN_ENGLISH_SCORE = 0.70;

// Idiomas en los que la etiqueta local no basta para elegir el código de Azure
// (chino simplificado/tradicional, serbio cirílico/latino, etc.): los resuelve Azure.
// Se compara con el código ya normalizado (zh pasa a zh-Hans en langNormalize.json).
const AMBIGUOUS_SCRIPT_LANGS = new Set(['zh', 'zh-Hans', 'zh-Hant', 'sr', 'mn', 'iu']);

// Los detectores solo necesitan una muestra: con más texto no ganan acierto y
// gastarían CPU del servidor con descripciones enormes.
const MAX_DETECT_CHARS = 4000;

// Si la carga falla (p. ej. dependencia ausente en el despliegue) no se reintenta
// en cada petición: se espera antes de volver a probar y mientras tanto manda Azure.
const RETRY_LOAD_AFTER_MS = 5 * 60 * 1000;

let engine = null;
let enginePromise = null;
let nextLoadAttemptAt = 0;

function loadEngine() {
  if (!enginePromise) {
    if (Date.now() < nextLoadAttemptAt) return Promise.resolve(null);
    enginePromise = (async () => {
      const [tinyld, eldModule] = await Promise.all([import('tinyld'), import('eld')]);
      const eld = eldModule.eld || eldModule.default;
      await eld.load('small');
      engine = { tinyDetectAll: tinyld.detectAll, eld };
      return engine;
    })().catch((error) => {
      enginePromise = null;
      nextLoadAttemptAt = Date.now() + RETRY_LOAD_AFTER_MS;
      console.warn('Local language detection unavailable, using Azure:', error.message);
      return null;
    });
  }
  return enginePromise;
}

function canonical(code) {
  const lower = String(code || '').toLowerCase();
  if (!lower || lower === 'und') return null;
  if (lower === 'nb' || lower === 'nn' || lower === 'no') return 'nb';
  return NORMALIZE[lower] || lower;
}

function cleanForDetection(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\[ANON-\d+\]/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\d*_#=\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DETECT_CHARS);
}

/**
 * @param {string} text
 * @returns {Promise<string|null>} Código de idioma como lo devuelve Azure (es, pt, fil, nb...)
 *   o null si no hay acuerdo suficiente y hay que usar Azure.
 */
async function detectLanguageLocal(text) {
  const cleaned = cleanForDetection(text);
  if (cleaned.length < MIN_LOCAL_DETECT_CHARS) return null;

  // Hasta que los modelos estén cargados (arranque) se usa Azure, sin esperar.
  if (!engine) {
    loadEngine();
    return null;
  }

  try {
    const tinyCode = canonical(engine.tinyDetectAll(cleaned)[0]?.lang);
    const eldResult = engine.eld.detect(cleaned);
    const eldCode = canonical(eldResult.language);

    if (!tinyCode || tinyCode !== eldCode || !eldResult.isReliable()) return null;
    if (tinyCode === 'en' && (eldResult.getScores()[eldResult.language] || 0) < MIN_ENGLISH_SCORE) return null;
    if (AMBIGUOUS_SCRIPT_LANGS.has(tinyCode)) return null;
    // Un idioma que Azure no traduce se resuelve por la ruta de siempre (acaba en 'en').
    if (!SUPPORTED[tinyCode]) return null;
    return tinyCode;
  } catch (_) {
    return null;
  }
}

// Calienta los modelos al arrancar para que ninguna petición espere la carga.
loadEngine();

module.exports = { detectLanguageLocal, warmUpLocalDetector: loadEngine, MIN_LOCAL_DETECT_CHARS };
