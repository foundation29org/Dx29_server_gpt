'use strict';

const DiagnoseSession = require('../models/diagnoseSession');

class DiagnoseSessionService {
    /**
     * Guarda una pregunta de diagnóstico en la base de datos
     * @param {Object} questionData - Datos de la pregunta
     * @returns {Promise<Object>} - Sesión guardada
     */
    async saveQuestion(questionData) {
        try {
            const session = await DiagnoseSession.create({
                ...questionData,
                timestamp: new Date()
            });
            
            console.log('✅ Pregunta de diagnóstico guardada:', session._id);
            return session;
        } catch (error) {
            console.error('❌ Error guardando pregunta de diagnóstico:', error.message);
            throw error;
        }
    }

    /**
     * Guarda una sesión completa de diagnóstico en la base de datos
     * @param {Object} sessionData - Datos completos de la sesión
     * @returns {Promise<Object>} - Sesión guardada
     */
    async saveSession(sessionData) {
        try {
            const session = await DiagnoseSession.create({
                ...sessionData,
                timestamp: new Date()
            });
            
            console.log('✅ Sesión de diagnóstico guardada:', session._id);
            return session;
        } catch (error) {
            console.error('❌ Error guardando sesión de diagnóstico:', error.message);
            throw error;
        }
    }

    /**
     * Obtiene todas las sesiones de un usuario específico
     * @param {String} myuuid - UUID del usuario
     * @param {Number} limit - Límite de resultados
     * @returns {Promise<Array>} - Lista de sesiones
     */
    async getSessionsByUser(myuuid, limit = 50) {
        try {
            return await DiagnoseSession.find({ myuuid })
                .sort({ timestamp: -1 })
                .limit(limit);
        } catch (error) {
            console.error('❌ Error obteniendo sesiones del usuario:', error.message);
            throw error;
        }
    }

    /**
     * Obtiene sesiones por tenant y subscription
     * @param {String} tenantId - ID del tenant
     * @param {String} subscriptionId - ID de la suscripción
     * @param {Number} limit - Límite de resultados
     * @returns {Promise<Array>} - Lista de sesiones
     */
    async getSessionsByTenant(tenantId, subscriptionId, limit = 100) {
        try {
            return await DiagnoseSession.find({ 
                tenantId, 
                subscriptionId 
            })
                .sort({ timestamp: -1 })
                .limit(limit);
        } catch (error) {
            console.error('❌ Error obteniendo sesiones del tenant:', error.message);
            throw error;
        }
    }

    /**
     * Obtiene estadísticas de sesiones
     * @param {String} tenantId - ID del tenant (opcional)
     * @param {String} subscriptionId - ID de la suscripción (opcional)
     * @param {Date} startDate - Fecha de inicio (opcional)
     * @param {Date} endDate - Fecha de fin (opcional)
     * @returns {Promise<Object>} - Estadísticas
     */
    async getSessionStats(tenantId = null, subscriptionId = null, startDate = null, endDate = null) {
        try {
            const query = {};
            
            if (tenantId) query.tenantId = tenantId;
            if (subscriptionId) query.subscriptionId = subscriptionId;
            if (startDate || endDate) {
                query.timestamp = {};
                if (startDate) query.timestamp.$gte = startDate;
                if (endDate) query.timestamp.$lte = endDate;
            }

            const stats = await DiagnoseSession.aggregate([
                { $match: query },
                {
                    $group: {
                        _id: null,
                        totalSessions: { $sum: 1 },
                        successSessions: {
                            $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] }
                        },
                        errorSessions: {
                            $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] }
                        },
                        avgProcessingTime: { $avg: '$processingTime' },
                        diagnosticQueries: {
                            $sum: { $cond: [{ $eq: ['$answer.queryType', 'diagnostic'] }, 1, 0] }
                        }
                    }
                }
            ]);

            return stats[0] || {
                totalSessions: 0,
                successSessions: 0,
                errorSessions: 0,
                avgProcessingTime: 0,
                diagnosticQueries: 0
            };
        } catch (error) {
            console.error('❌ Error obteniendo estadísticas de sesiones:', error.message);
            throw error;
        }
    }

    /**
     * Elimina sesiones antiguas (más de X días)
     * @param {Number} daysOld - Días de antigüedad
     * @returns {Promise<Number>} - Número de sesiones eliminadas
     */
    async cleanupOldSessions(daysOld = 90) {
        try {
            const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
            const result = await DiagnoseSession.deleteMany({
                timestamp: { $lt: cutoffDate }
            });
            
            console.log(`✅ Eliminadas ${result.deletedCount} sesiones antiguas (más de ${daysOld} días)`);
            return result.deletedCount;
        } catch (error) {
            console.error('❌ Error limpiando sesiones antiguas:', error.message);
            throw error;
        }
    }
}

module.exports = new DiagnoseSessionService(); 