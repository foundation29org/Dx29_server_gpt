'use strict';

const crypto = require('crypto');
const Permalink = require('../models/permalink');
const { anonymizeText } = require('./anonymizeService');
const { maskAnonMarkers } = require('./anonMarkers');
const { calculatePrice } = require('./costUtils');
const CostTrackingService = require('./costTrackingService');
const insights = require('./insights');

const ANONYMIZATION_MODEL = 'gpt54mini';
// Los de antes del 27-11-2026 son 16 caracteres hexadecimales; los nuevos, 22 en base64url.
const PERMALINK_ID_PATTERN = /^[A-Za-z0-9_-]{16,32}$/;

// El anonimizador recorta y puede cambiar saltos de línea o espacios: eso no cuenta.
function normalizeText(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .trim();
}

function sameText(a, b) {
  return normalizeText(a) === normalizeText(b);
}

class PermalinkService {
  // 128 bits aleatorios: quien tiene el id ve el permalink, así que no puede deducirse.
  generatePermalinkId() {
    return crypto.randomBytes(16).toString('base64url');
  }

  isValidPermalinkId(id) {
    return typeof id === 'string' && PERMALINK_ID_PATTERN.test(id);
  }

  // Se guarda sin texto: el texto lo añade storeAnonymizedDescription cuando el
  // anonimizador termina, para no retrasar la respuesta (el navegador solo deja
  // abrir el menú de compartir unos segundos después del clic).
  async createPermalink({ diagnoses, lang, myuuid }) {
    const permalinkId = this.generatePermalinkId();

    const permalink = new Permalink({
      permalinkId,
      medicalDescription: '',
      anonymizedDescription: '',
      diagnoses,
      lang,
      createdDate: new Date(),
      myuuid
    });

    await permalink.save();

    return {
      success: true,
      permalinkId,
      message: 'Permalink creado exitosamente'
    };
  }

  // Solo se guarda lo que ha pasado por el anonimizador: con datos personales, el texto
  // enmascarado; sin ellos, el original. Ningún texto si falla, si no devuelve nada o si
  // cambia el texto sin marcar nada (no se sabe qué ha quitado ni si ha dejado algo).
  // alreadyAnonymized: el cliente ya enmascaró lo que encontró el diagnóstico, así que
  // aquí no se ve nada nuevo, pero el permalink debe seguir avisando de que se tapó.
  async storeAnonymizedDescription(permalinkId, description, context, { alreadyAnonymized = false } = {}) {
    const startMs = Date.now();
    try {
      const result = await anonymizeText(
        description,
        context.timezone,
        context.tenantId,
        context.subscriptionId,
        context.myuuid,
        ANONYMIZATION_MODEL
      );
      this.saveAnonymizationCost(result, context, Date.now() - startMs, description);

      const update = {};
      if (result.hasPersonalInfo) {
        update.medicalDescription = maskAnonMarkers(result.htmlText, '*');
        update.anonymized = true;
      } else if (!result.anonymizationFailed && sameText(result.htmlText, description)) {
        update.medicalDescription = description;
        if (alreadyAnonymized) update.anonymized = true;
      }

      if (Object.keys(update).length > 0) {
        await Permalink.updateOne({ permalinkId }, { $set: update });
      }
    } catch (error) {
      insights.error({
        message: 'Error anonymizing permalink description',
        error: error?.message,
        code: error?.code,
        operation: 'permalinkAnonymization',
        tenantId: context.tenantId,
        myuuid: context.myuuid
      });
    }
  }

  // El registro de coste solo guarda la longitud de la descripción, no el texto.
  saveAnonymizationCost(result, context, durationMs, description) {
    if (!result?.usage) return;
    const price = calculatePrice(result.usage, ANONYMIZATION_MODEL);
    void CostTrackingService.saveSimpleOperationCostBestEffort(
      {
        myuuid: context.myuuid,
        tenantId: context.tenantId,
        subscriptionId: context.subscriptionId,
        lang: context.lang,
        timezone: context.timezone,
        description
      },
      'permalink',
      {
        name: 'anonymization',
        cost: price.totalCost,
        tokens: { input: price.inputTokens, output: price.outputTokens, total: price.totalTokens },
        model: ANONYMIZATION_MODEL,
        duration: durationMs,
        success: !result.anonymizationFailed
      },
      result.anonymizationFailed ? 'error' : 'success'
    );
  }

  async getPermalink(permalinkId) {
    const permalink = this.isValidPermalinkId(permalinkId)
      ? await Permalink.findOne({ permalinkId })
      : null;

    if (!permalink) {
      return {
        success: false,
        message: 'Permalink no encontrado'
      };
    }

    return {
      success: true,
      data: {
        medicalDescription: permalink.medicalDescription,
        anonymizedDescription: permalink.anonymizedDescription,
        anonymized: permalink.anonymized === true,
        diagnoses: permalink.diagnoses,
        lang: permalink.lang,
        createdDate: permalink.createdDate
      }
    };
  }
}

module.exports = new PermalinkService();
