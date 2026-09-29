'use strict';

const IMAGE_CLASSIFIER_MODEL = 'gpt56terra';
const IMAGE_CLASSIFIER_CONFIDENCE = 0.9;
const IMAGE_CLASSIFIER_CONCURRENCY = 2;
const IMAGE_OCR_MIN_CHARS = 20;

module.exports = {
  getImageClassifierModel: () => IMAGE_CLASSIFIER_MODEL,
  getImageClassifierConfidence: () => IMAGE_CLASSIFIER_CONFIDENCE,
  getImageClassifierConcurrency: () => IMAGE_CLASSIFIER_CONCURRENCY,
  getImageOcrMinChars: () => IMAGE_OCR_MIN_CHARS
};
