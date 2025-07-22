const { WebPubSubServiceClient } = require('@azure/web-pubsub');
const config = require('../config');

class PubSubService {
  constructor() {
    this.client = new WebPubSubServiceClient(
      config.AZURE_WEB_PUBSUB_CONNECTION_STRING, 
      'diagnose' // hub name
    );
  }

  // Generar token de acceso para cliente
  async getClientAccessToken(userId, expirationTimeInMinutes = 60) {
    try {
      const token = await this.client.getClientAccessToken({
        userId: userId,
        roles: ['webpubsub.sendToGroup', 'webpubsub.joinLeaveGroup'],
        expirationTimeInMinutes: expirationTimeInMinutes
      });
      return token;
    } catch (error) {
      console.error('Error generating client access token:', error);
      throw error;
    }
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
      console.error(`Error sending progress to user ${userId}:`, error);
      // No lanzar error para no interrumpir el proceso principal
    }
  }

  // Enviar resultado final exitoso
  async sendResult(userId, result) {
    try {
      await this.client.sendToUser(userId, {
        type: 'result',
        status: 'success',
        data: result,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error(`Error sending result to user ${userId}:`, error);
      throw error;
    }
  }

  // Enviar error al cliente
  async sendError(userId, error, errorCode = null) {
    try {
      await this.client.sendToUser(userId, {
        type: 'error',
        status: 'error',
        message: error.message || error,
        code: errorCode,
        timestamp: new Date().toISOString()
      });
    } catch (sendError) {
      console.error(`Error sending error to user ${userId}:`, sendError);
    }
  }

  // Enviar notificación de que el proceso fue encolado
  async sendQueued(userId, queueInfo) {
    try {
      await this.client.sendToUser(userId, {
        type: 'queued',
        status: 'queued',
        queueInfo: queueInfo,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error(`Error sending queued notification to user ${userId}:`, error);
    }
  }

  // Verificar si un usuario está conectado
  async isUserConnected(userId) {
    try {
      const response = await this.client.userExists(userId);
      return response;
    } catch (error) {
      console.error(`Error checking if user ${userId} is connected:`, error);
      return false;
    }
  }

  // Cerrar conexión de un usuario
  async closeUserConnection(userId, reason = 'Process completed') {
    try {
      await this.client.closeUserConnections(userId, reason);
    } catch (error) {
      console.error(`Error closing connection for user ${userId}:`, error);
    }
  }
}

module.exports = new PubSubService();