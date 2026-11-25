const { WebPubSubServiceClient } = require('@azure/web-pubsub');
const config = require('../config');
const insights = require('./insights');
const { errorSummary } = require('./errorSummary');

class PubSubService {
  constructor() {
    this.client = new WebPubSubServiceClient(
      config.AZURE_WEB_PUBSUB_CONNECTION_STRING, 
      'diagnose' // hub name
    );
  }

  // Generar token de acceso para cliente
  async getClientAccessToken(userId, expirationTimeInMinutes = 60) {
    const token = await this.client.getClientAccessToken({
      userId: userId,
      roles: ['webpubsub.sendToGroup', 'webpubsub.joinLeaveGroup'],
      expirationTimeInMinutes: expirationTimeInMinutes
    });
    return token;
  }

  // Enviar mensaje de progreso al cliente
  async sendProgress(userId, step, message, percentage = null) {
    try {
      await this.client.sendToUser(userId, {
        type: 'progress',
        step: step,
        message: message,
        percentage: percentage,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      insights.error({
        message: 'Error sending PubSub progress',
        error: error.message,
        operation: 'pubsub.sendProgress',
        myuuid: userId
      });
      // No lanzar error para no interrumpir el proceso principal
    }
  }

  // El preprocesado de /medical/analyze. No es el diagnóstico: el cliente
  // mantiene el socket abierto y espera después el type 'result'.
  async sendPreprocessing(userId, data) {
    try {
      await this.client.sendToUser(userId, {
        type: 'preprocessing',
        status: 'ready',
        data,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      insights.error({
        message: 'Error sending PubSub preprocessing',
        error: error.message,
        operation: 'pubsub.sendPreprocessing',
        myuuid: userId
      });
    }
  }

  // Enviar resultado final exitoso
  async sendResult(userId, result) {
    await this.client.sendToUser(userId, {
      type: 'result',
      status: 'success',
      data: result,
      timestamp: new Date().toISOString()
    });
  }

  // Enviar error al cliente
  async sendError(userId, error, errorCode = null, extra = {}) {
    try {
      await this.client.sendToUser(userId, {
        type: 'error',
        status: 'error',
        message: error.message || error,
        code: errorCode,
        data: {
          message: error.message || String(error || ''),
          code: errorCode,
          type: errorCode,
          correlationId: extra.correlationId || ''
        },
        timestamp: new Date().toISOString()
      });
    } catch (sendError) {
      insights.error({
        message: 'Error sending PubSub error',
        error: sendError.message,
        operation: 'pubsub.sendError',
        myuuid: userId
      });
    }
  }

  // Verificar si un usuario está conectado
  async isUserConnected(userId) {
    try {
      const response = await this.client.userExists(userId);
      return response;
    } catch (error) {
      console.error(`Error checking if user ${userId} is connected:`, errorSummary(error));
      return false;
    }
  }

  // Cerrar conexión de un usuario
  async closeUserConnection(userId, reason = 'Process completed') {
    try {
      await this.client.closeUserConnections(userId, reason);
    } catch (error) {
      console.error(`Error closing connection for user ${userId}:`, errorSummary(error));
    }
  }
}

module.exports = new PubSubService();