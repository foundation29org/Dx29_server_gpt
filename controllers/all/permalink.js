'use strict';

const permalinkService = require('../../services/permalinkService');
const insights = require('../../services/insights');

// /diagnose admite 8.000 caracteres; el margen es para el texto ya enmascarado.
const MAX_DESCRIPTION_CHARS = 10000;
const MAX_DIAGNOSES = 10;
// Los diez diagnósticos ocupan unos 8.000 caracteres de mediana y 31.000 como máximo.
const MAX_DIAGNOSES_JSON_CHARS = 100000;
const MAX_TIMEZONE_CHARS = 64;
const UUID_PATTERN = /^[0-9a-fA-F-]{36}$/;

function getHeader(req, name) {
  return req.headers?.[name.toLowerCase()];
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Sin zona horaria (clientes anteriores al 27-11-2026) se anonimiza en Europa,
// la región más restrictiva.
const DEFAULT_TIMEZONE = 'Europe/Madrid';

// Los clientes anteriores no mandan `anonymized`: el aviso salía si anonymizedDescription
// tenía algo y no era igual que el texto. Ninguno de los dos campos se guarda.
function textWasAnonymized({ anonymized, anonymizedDescription, medicalDescription }) {
  if (anonymized !== undefined) return anonymized === true;
  return typeof anonymizedDescription === 'string' && anonymizedDescription !== '' &&
    anonymizedDescription !== medicalDescription;
}

// anonymizedDescription y createdDate se ignoran: el servidor anonimiza el texto
// y pone la fecha. Los clientes anteriores aún los envían.
function validateCreateRequest(body) {
  if (!isPlainObject(body)) return 'El cuerpo debe ser un objeto JSON';
  const { medicalDescription, diagnoses, lang, myuuid, timezone, anonymized } = body;

  // En análisis solo con imagen no hay texto del paciente: llega "" y es válido.
  if (typeof medicalDescription !== 'string') return 'medicalDescription debe ser texto';
  if (medicalDescription.length > MAX_DESCRIPTION_CHARS) {
    return `medicalDescription no puede pasar de ${MAX_DESCRIPTION_CHARS} caracteres`;
  }
  if (!Array.isArray(diagnoses) || diagnoses.length === 0) return 'diagnoses debe ser una lista no vacía';
  if (!diagnoses.slice(0, MAX_DIAGNOSES).every(isPlainObject)) return 'Cada diagnóstico debe ser un objeto';
  if (JSON.stringify(diagnoses.slice(0, MAX_DIAGNOSES)).length > MAX_DIAGNOSES_JSON_CHARS) {
    return 'diagnoses es demasiado grande';
  }
  if (typeof lang !== 'string' || lang.length < 2 || lang.length > 8) return 'lang debe tener entre 2 y 8 caracteres';
  if (typeof myuuid !== 'string' || !UUID_PATTERN.test(myuuid)) return 'myuuid debe ser un UUID';
  if (timezone !== undefined && (typeof timezone !== 'string' || timezone.length > MAX_TIMEZONE_CHARS)) {
    return 'timezone no es válido';
  }
  if (anonymized !== undefined && typeof anonymized !== 'boolean') return 'anonymized debe ser true o false';
  return null;
}

class PermalinkController {
  async createPermalink(req, res) {
    try {
      const invalidReason = validateCreateRequest(req.body);
      if (invalidReason) {
        return res.status(400).json({ success: false, message: invalidReason });
      }

      const { medicalDescription, diagnoses, lang, myuuid, timezone } = req.body;
      const result = await permalinkService.createPermalink({
        diagnoses: diagnoses.slice(0, MAX_DIAGNOSES),
        lang,
        myuuid
      });

      res.status(201).json(result);

      // Después de responder: anonymizeText hace trabajo síncrono antes de su primer
      // await, y el navegador solo deja compartir unos segundos después del clic.
      if (medicalDescription.trim()) {
        const context = {
          timezone: timezone || DEFAULT_TIMEZONE,
          tenantId: getHeader(req, 'x-tenant-id'),
          subscriptionId: getHeader(req, 'x-subscription-id'),
          myuuid,
          lang
        };
        const alreadyAnonymized = textWasAnonymized(req.body);
        setImmediate(() => {
          void permalinkService.storeAnonymizedDescription(result.permalinkId, medicalDescription, context, { alreadyAnonymized });
        });
      }
    } catch (error) {
      insights.error({
        message: 'Error creating permalink',
        error: error.message,
        operation: 'createPermalink',
        myuuid: req.body?.myuuid
      });
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor al crear permalink'
      });
    }
  }

  async getPermalink(req, res) {
    try {
      const result = await permalinkService.getPermalink(req.params.id);

      if (!result.success) {
        return res.status(404).json(result);
      }

      res.status(200).json(result);
    } catch (error) {
      // Sin el id: quien lo tiene puede abrir el permalink
      insights.error({
        message: 'Error getting permalink',
        error: error.message,
        operation: 'getPermalink'
      });
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor al obtener permalink'
      });
    }
  }
}

module.exports = new PermalinkController();
