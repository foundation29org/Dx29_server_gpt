'use strict';

const crypto = require('crypto');
const Permalink = require('../models/permalink');

class PermalinkService {
  generatePermalinkId(clientUuid, createdDate) {
    // Crear un hash único combinando el UUID del cliente y la fecha de creación
    const data = `${clientUuid}-${createdDate}`;
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    // Tomar los primeros 16 caracteres para un ID más corto
    return hash.substring(0, 16);
  }

  async createPermalink(permalinkData, clientUuid) {
    try {
      // Generar ID único combinando UUID del cliente y fecha de creación
      const permalinkId = this.generatePermalinkId(clientUuid, permalinkData.createdDate);
      
      // Guardar directamente en MongoDB
      const permalink = new Permalink({
        permalinkId,
        medicalDescription: permalinkData.medicalDescription,
        anonymizedDescription: permalinkData.anonymizedDescription,
        diagnoses: permalinkData.diagnoses,
        lang: permalinkData.lang,
        createdDate: permalinkData.createdDate,
        myuuid: clientUuid
      });
      
      await permalink.save();
      
      return {
        success: true,
        permalinkId,
        message: 'Permalink creado exitosamente'
      };
    } catch (error) {
      console.error('Error al crear permalink:', error);
      throw error;
    }
  }

  async getPermalink(permalinkId) {
    try {
      // Buscar en MongoDB
      const permalink = await Permalink.findOne({ permalinkId });
      
      if (!permalink) {
        return {
          success: false,
          message: 'Permalink no encontrado'
        };
      }
      
      // Devolver los datos del permalink
      return {
        success: true,
        data: {
          medicalDescription: permalink.medicalDescription,
          anonymizedDescription: permalink.anonymizedDescription,
          diagnoses: permalink.diagnoses,
          lang: permalink.lang,
          createdDate: permalink.createdDate
        }
      };
    } catch (error) {
      console.error('Error al obtener permalink:', error);
      throw error;
    }
  }
}

module.exports = new PermalinkService(); 