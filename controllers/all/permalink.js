'use strict';

const permalinkService = require('../../services/permalinkService');

class PermalinkController {
  async createPermalink(req, res) {
    try {
      const { medicalDescription, anonymizedDescription, diagnoses, lang, createdDate, myuuid } = req.body;

      // Validar datos requeridos
      if (!medicalDescription || !anonymizedDescription || !diagnoses || !lang || !createdDate) {
        return res.status(400).json({
          success: false,
          message: 'Faltan datos requeridos: medicalDescription, anonymizedDescription, diagnoses, lang, createdDate'
        });
      }

      if (!myuuid) {
        return res.status(400).json({
          success: false,
          message: 'Se requiere myuuid en el body'
        });
      }

      const permalinkData = {
        medicalDescription,
        anonymizedDescription,
        diagnoses: Array.isArray(diagnoses) ? diagnoses.slice(0, 10) : diagnoses, // Limitar a top 10
        lang,
        createdDate
      };

      const result = await permalinkService.createPermalink(permalinkData, myuuid);

      res.status(201).json(result);
    } catch (error) {
      console.error('Error en createPermalink:', error);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor al crear permalink'
      });
    }
  }

  async getPermalink(req, res) {
    try {
      const { id } = req.params;

      if (!id) {
        return res.status(400).json({
          success: false,
          message: 'Se requiere el ID del permalink'
        });
      }

      const result = await permalinkService.getPermalink(id);

      if (!result.success) {
        return res.status(404).json(result);
      }

      res.status(200).json(result);
    } catch (error) {
      console.error('Error en getPermalink:', error);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor al obtener permalink'
      });
    }
  }
}

module.exports = new PermalinkController(); 