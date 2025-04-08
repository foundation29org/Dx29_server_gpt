const { ServiceBusClient, ServiceBusAdministrationClient } = require("@azure/service-bus");
const config = require('../config');
const Ticket = require('../models/ticket');
const insights = require('../services/insights');
const Metrics = require('../models/metrics');
const metricsService = require('./metricsService');

// Configuración de Service Bus
const connectionString = config.serviceBusConnectionString;
const queueName = "diagnosis-queue";

const REGION_MAPPING = {
  asia: 'India',
  europe: 'Suiza',
  northamerica: 'WestUS',
  southamerica: 'WestUS',
  africa: 'WestUS',
  oceania: 'Japan',
  other: 'WestUS'
};

const REGION_CAPACITY = config.REGION_CAPACITY;

// Tiempo promedio de procesamiento por solicitud en segundos
const AVG_PROCESSING_TIME = 10;

// Función auxiliar para delay con backoff exponencial
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class QueueService {
  constructor() {
    if (!connectionString) {
      throw new Error('Service Bus connection string is required');
    }

    // 1. Inicializar estructuras de datos
    this.receivers = new Map();
    this.regionQueues = new Map();
    this.activeRequests = {};
    this.ticketStatus = new Map();

    // 2. Inicializar las colas por región
    Object.keys(REGION_CAPACITY).forEach(region => {
      this.regionQueues.set(region, { activeRequests: 0, queueLength: 0 });
      this.activeRequests[region] = 0;
    });

    // 3. Inicializar Service Bus
    this.sbClient = new ServiceBusClient(connectionString);
    this.adminClient = new ServiceBusAdministrationClient(connectionString);

    // 4. Iniciar el procesamiento de mensajes
    this.startMessageProcessing().catch(error => {
      console.error('Error starting message processing:', error);
    });

    // 5. Manejar el cierre graceful
    process.on('SIGTERM', () => this.handleShutdown());
    process.on('SIGINT', () => this.handleShutdown());

    // Inicializar con manejo de errores
    this.initialize().catch(error => {
      console.error('Error initializing QueueService:', error);
      insights.error({
        message: 'Error initializing QueueService',
        error: error.message
      });
      throw error;
    });

    // Iniciar tareas periódicas
    this.startPeriodicTasks();
  }

  validateConfiguration() {
    if (!REGION_CAPACITY || Object.keys(REGION_CAPACITY).length === 0) {
      throw new Error('REGION_CAPACITY configuration is required');
    }
    if (!REGION_MAPPING || Object.keys(REGION_MAPPING).length === 0) {
      throw new Error('REGION_MAPPING configuration is required');
    }
  }

  startPeriodicTasks() {
    // Limpieza de tickets antiguos
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldTickets().catch(error => {
        console.error('Error in cleanup task:', error);
        insights.error({
          message: 'Error in cleanup task',
          error: error.message
        });
      });
    }, 6 * 60 * 60 * 1000); // Cada 6 horas

    // Health check periódico
    setInterval(() => {
      this.checkHealth().catch(async (error) => {
        console.error('Error in health check:', error);
        insights.error({
          message: 'Error in health check',
          error: error.message
        });
        try {
          await serviceEmail.sendMailErrorGPTIP(
            'es',
            'Error in health check',
            error.message,
            null
          );
        } catch (emailError) {
          console.log('Fail sending email');
          insights.error(emailError);
        }
      });
    }, 5 * 60 * 1000); // Cada 5 minutos
  }

  async initialize() {
    try {
      // Crear una cola para cada región si no existe
      for (const region of Object.keys(REGION_CAPACITY)) {
        const regionQueueName = `${queueName}-${region}`;
        const queueExists = await this.adminClient.queueExists(regionQueueName);
        
        if (!queueExists) {
          await this.adminClient.createQueue(regionQueueName, {
            maxSizeInMegabytes: 1024,
            defaultMessageTimeToLive: 'PT1H',
            lockDuration: 'PT30S',
            maxDeliveryCount: 3,
            enablePartitioning: false,
            enableBatchedOperations: true
          });
          console.log(`Cola ${regionQueueName} creada exitosamente`);
        }
      }
    } catch (error) {
      console.error('Error inicializando Service Bus:', error);
      throw error;
    }
  }

  async getRegionQueueStatus(region) {
    try {
      // Obtener las propiedades de runtime de la cola para esta región
      const runtimeProperties = await this.adminClient.getQueueRuntimeProperties(`${queueName}-${region}`);
      
      return {
        activeRequests: runtimeProperties.activeMessageCount,
        scheduledRequests: runtimeProperties.scheduledMessageCount,
        queueLength: runtimeProperties.activeMessageCount + runtimeProperties.scheduledMessageCount
      };
    } catch (error) {
      console.error(`Error getting queue status for region ${region}:`, error);
      return { activeRequests: 0, scheduledRequests: 0, queueLength: 0 };
    }
  }

  async getBestRegion() {
    let bestRegion = null;
    let lowestLoad = Infinity;

    for (const [region, capacity] of Object.entries(REGION_CAPACITY)) {
      const queueStatus = await this.getRegionQueueStatus(region);
      const currentLoad = queueStatus.queueLength / capacity;
      
      if (currentLoad < lowestLoad) {
        lowestLoad = currentLoad;
        bestRegion = region;
      }
    }

    return bestRegion;
  }

  async getRegionsStatus() {
    const status = [];
    
    for (const [region, capacity] of Object.entries(REGION_CAPACITY)) {
      const queueStatus = await this.getRegionQueueStatus(region);
      
      status.push({
        region,
        activeRequests: queueStatus.activeRequests,
        queueLength: queueStatus.queueLength,
        capacity,
        estimatedWaitTime: queueStatus.queueLength * AVG_PROCESSING_TIME
      });
    }

    return status;
  }

  // Obtener la región basada en timezone
  getRegionFromTimezone(timezone) {
    const tz = timezone?.split('/')[0]?.toLowerCase();
    const region = (() => {
      if (tz?.includes('america')) return 'northamerica';
      if (tz?.includes('europe')) return 'europe';
      if (tz?.includes('asia')) return 'asia';
      if (tz?.includes('africa')) return 'africa';
      if (tz?.includes('australia') || tz?.includes('pacific')) return 'oceania';
      return 'other';
    })();
    return REGION_MAPPING[region];
  }

  // Obtener propiedades de una región específica
  async getRegionQueueProperties(region) {
    return {
      activeMessageCount: this.activeRequests[region] + this.regionQueues.get(region).queueLength,
      capacity: REGION_CAPACITY[region],
      utilizationPercentage: ((this.activeRequests[region] + this.regionQueues.get(region).queueLength) / REGION_CAPACITY[region]) * 100
    };
  }

  // Modificar getQueueProperties para trabajar con una región específica
  async getQueueProperties(timezone) {
    const region = this.getRegionFromTimezone(timezone);
    return await this.getRegionQueueProperties(region);
  }

  // Añadir a la cola de la región específica
  async addToQueue(data, requestInfo, model) {
    let sender;
    try {
      const region = this.getRegionFromTimezone(data.timezone);
      console.log('Adding to queue for region:', data.timezone);
      
      const ticketId = data.myuuid;
      console.log('Processing ticket:', ticketId);

      // Crear el mensaje
      const message = {
        body: {
          description: data.description,
          myuuid: data.myuuid,
          operation: data.operation,
          lang: data.lang,
          diseases_list: data.diseases_list,
          timestamp: new Date().toISOString(),
          timezone: data.timezone,
          region: region
        },
        requestInfo: requestInfo,
        model: model,
        applicationProperties: {
          requestType: 'diagnosis',
          priority: 1,
          region: region,
          ticketId: ticketId
        }
      };

      // Crear sender y enviar mensaje
      sender = this.sbClient.createSender(`${queueName}-${region}`);
      console.log('Sending message to queue...');
      await sender.sendMessages(message);
      console.log('Message sent successfully');

      // Obtener estado de la cola
      const queueStatus = await this.getRegionQueueStatus(region);
      console.log('Queue status:', queueStatus);

      // Crear el ticket en la base de datos
      const ticket = await this.updateTicketStatus(ticketId, {
        status: 'queued',
        region: region,
        position: queueStatus.queueLength,
        timestamp: Date.now()
      });
      console.log('Ticket created in database:', ticket);

      // Preparar la respuesta
      const response = {
        ticketId,
        region,
        queuePosition: queueStatus.queueLength,
        estimatedWaitTime: queueStatus.queueLength * AVG_PROCESSING_TIME
      };

      console.log('Preparing queue response:', response);
      
      // Cerrar el sender antes de retornar
      if (sender) {
        await sender.close();
        console.log('Sender closed successfully');
      }

      return response;

    } catch (error) {
      console.error('Error adding to queue:', error);
      // Si hay un error, intentar actualizar el estado del ticket a error
      try {
        await this.updateTicketStatus(data.myuuid, {
          status: 'error',
          error: error.message,
          timestamp: Date.now()
        });
      } catch (updateError) {
        console.error('Error updating ticket status:', updateError);
      }
      throw error;
    } finally {
      // Asegurarse de que el sender se cierre incluso si hay un error
      if (sender) {
        try {
          await sender.close();
          console.log('Sender closed in finally block');
        } catch (closeError) {
          console.error('Error closing sender:', closeError);
        }
      }
    }
  }

  // Registrar una petición activa en una región específica
  async registerActiveRequest(timezone) {
    const region = this.getRegionFromTimezone(timezone);
    this.activeRequests[region]++;
    return region;
  }

  // Liberar una petición activa en una región específica
  async releaseActiveRequest(region) {
    if (this.activeRequests[region] > 0) {
      this.activeRequests[region]--;
    }
  }

  async getQueueProperties() {
    try {
      let totalActiveMessages = 0;
      let totalCapacity = 0;

      // Sumar las capacidades totales y mensajes activos de todas las regiones
      for (const [region, capacity] of Object.entries(REGION_CAPACITY)) {
        const regionQueueName = `${queueName}-${region}`;
        const queueExists = await this.adminClient.queueExists(regionQueueName);
        
        if (!queueExists) {
          await this.initialize();
        }

        // Obtiene el estado real de la cola y las peticiones activas
        const runtimeProperties = await this.adminClient.getQueueRuntimeProperties(regionQueueName);
        const regionInfo = this.regionQueues.get(region) || { activeRequests: 0, queueLength: 0 };
        
        totalActiveMessages += runtimeProperties.activeMessageCount + 
                             runtimeProperties.scheduledMessageCount +
                             (this.activeRequests[region] || 0); // Usar activeRequests del objeto
        totalCapacity += capacity;
      }

      // Calcular el porcentaje de utilización total
      const utilizationPercentage = (totalActiveMessages / totalCapacity) * 100;

      return {
        activeMessageCount: totalActiveMessages,
        totalCapacity: totalCapacity,
        utilizationPercentage: utilizationPercentage
      };
    } catch (error) {
      console.error('Error getting queue properties:', error);
      throw error;
    }
  }

  async startMessageProcessing() {
    try {
      console.log('Starting message processing...');
      for (const region of Object.keys(REGION_CAPACITY)) {
        const receiver = this.sbClient.createReceiver(`${queueName}-${region}`);
        this.receivers.set(region, receiver);
        
        receiver.subscribe({
          processMessage: async (message) => {
            await this.processMessage(message, receiver);
          },
          processError: async (args) => {
            console.error(`Error en el procesamiento de la cola ${region}:`, args.error);
          }
        });

        console.log(`Message processing started for region ${region}`);
      }
      console.log('Message processing started for all regions');
    } catch (error) {
      console.error('Error starting message processing:', error);
      throw error;
    }
  }

  async updateTicketStatus(ticketId, status) {
    console.log('Attempting to update ticket status:', { ticketId, status });

    try {
      const updateData = {
        ticketId,
        ...status,
        timestamp: new Date()
      };

      console.log('Update data prepared:', updateData.ticketId);

      // Usar findOneAndUpdate para actualizar o crear si no existe
      const ticket = await Ticket.findOneAndUpdate(
        { ticketId },
        { $set: updateData },
        { 
          new: true,          // Retorna el documento actualizado
          upsert: true,       // Crea si no existe
          runValidators: true // Ejecuta validadores del esquema
        }
      );

      console.log('Database operation completed. Ticket:', ticket.ticketId);

      // También mantener en memoria para acceso rápido
      if (!this.ticketStatus) {
        this.ticketStatus = new Map();
      }
      this.ticketStatus.set(ticketId, status);

      if (!ticket) {
        throw new Error('Failed to create/update ticket in database');
      }

      console.log('Ticket successfully updated in database:', ticket.ticketId);
      return ticket;

    } catch (error) {
      console.error('Error updating ticket status:', {
        ticketId,
        status,
        error: error.message,
        stack: error.stack
      });
      insights.error({
        message: 'Error updating ticket status',
        ticketId,
        error: error.message
      });
      throw error;
    }
  }

  async getTicketStatus(ticketId) {
    try {
      const ticket = await Ticket.findOne({ ticketId });
      
      if (!ticket) {
        return {
          result: 'error',
          message: 'Ticket not found'
        };
      }

      if (ticket.status === 'completed') {
        return {
          result: 'success',
          status: 'completed',
          data: ticket.result || ticket.data
        };
      } else if (ticket.status === 'error') {
        return {
          result: 'error',
          status: 'error',
          message: ticket.error || 'An error occurred processing your request'
        };
      } else {
        // Obtener la posición actualizada
        const currentPosition = await this.getCurrentPosition(ticket.region, ticketId);
        return {
          result: 'queued',
          status: 'processing',
          position: currentPosition,
          estimatedWaitTime: Math.ceil(currentPosition * AVG_PROCESSING_TIME / 60)
        };
      }
    } catch (error) {
      console.error('Error getting ticket status:', error);
      return {
        result: 'error',
        message: 'Error retrieving ticket status'
      };
    }
  }

  async close() {
    console.log('Iniciando cierre de recursos...');
    
    try {
      // Detener procesamiento de mensajes
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        console.log('Cleanup interval detenido');
      }

      // Cerrar receivers
      const receiverClosePromises = [];
      for (const [region, receiver] of this.receivers.entries()) {
        receiverClosePromises.push(
          receiver.close()
            .then(() => console.log(`Receiver cerrado para región ${region}`))
            .catch(error => {
              console.error(`Error cerrando receiver para región ${region}:`, error);
              insights.error({
                message: `Error cerrando receiver`,
                region,
                error: error.message
              });
            })
        );
      }

      // Esperar a que todos los receivers se cierren
      await Promise.allSettled(receiverClosePromises);

      // Cerrar cliente de Service Bus
      if (this.sbClient) {
        await this.sbClient.close();
        console.log('Service Bus client cerrado');
      }

      // Limpiar estructuras de datos
      this.ticketStatus?.clear();
      this.regionQueues?.clear();
      this.receivers?.clear();
      this.activeRequests = {};

      console.log('Todos los recursos liberados correctamente');
    } catch (error) {
      console.error('Error durante el cierre de recursos:', error);
      insights.error({
        message: 'Error durante el cierre de recursos',
        error: error.message
      });
      
      // Intentar limpieza forzada
      this.forceCleanup();
    }
  }

  forceCleanup() {
    console.log('Iniciando limpieza forzada...');
    try {
      this.ticketStatus?.clear();
      this.regionQueues?.clear();
      this.receivers?.clear();
      this.activeRequests = {};
      this.sbClient = null;
      console.log('Limpieza forzada completada');
    } catch (error) {
      console.error('Error en limpieza forzada:', error);
      insights.error({
        message: 'Error en limpieza forzada',
        error: error.message
      });
    }
  }

  async processMessageWithRetry(message, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const openaiazure = require('./openaiazure');
        const result = await openaiazure.processOpenAIRequest(message.body, message.requestInfo, message.model);
        return result;
      } catch (error) {
        if (!this.isRecoverableError(error) || attempt === maxRetries) {
          throw error;
        }
        const backoffTime = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
        console.log(`Reintentando en ${backoffTime}ms...`);
        await delay(backoffTime);
      }
    }
  }

  isRecoverableError(error) {
    // Lista de códigos de error recuperables
    const recoverableErrors = [
      'ETIMEDOUT',
      'ECONNRESET',
      'ECONNREFUSED',
      'EAGAIN',
      'EBUSY',
      'NETWORK_ERROR',
      'RATE_LIMIT_EXCEEDED',
      '429', // Too Many Requests
      '503', // Service Unavailable
      '504'  // Gateway Timeout
    ];

    // Verificar el código de error
    if (error.code && recoverableErrors.includes(error.code)) {
      return true;
    }

    // Verificar el status code si es un error de HTTP
    if (error.response && error.response.status) {
      return recoverableErrors.includes(error.response.status.toString());
    }

    // Verificar mensajes específicos de error
    const recoverableMessages = [
      'timeout',
      'rate limit',
      'too many requests',
      'service unavailable',
      'gateway timeout',
      'network error',
      'connection reset',
      'connection refused'
    ];

    return recoverableMessages.some(msg => 
      error.message.toLowerCase().includes(msg)
    );
  }

  // Modificar processMessage para reflejar el cambio
  async processMessage(message, receiver) {
    try {
      this.validateMessage(message);
      
      const region = message.applicationProperties.region;
      const ticketId = message.body.myuuid;
      const startTime = Date.now();

      try {
        const result = await this.processMessageWithRetry(message);
        
        // Completar el mensaje
        await receiver.completeMessage(message);

        const processingTime = Date.now() - startTime;
        const queueStatus = await this.getRegionQueueStatus(region);

        // Registrar métricas detalladas
        await metricsService.recordMetric(region, {
          period: 'minute',
          messagesProcessed: 1,
          messagesFailed: 0,
          averageProcessingTime: processingTime,
          queueLength: queueStatus.queueLength,
          utilizationPercentage: (queueStatus.queueLength / REGION_CAPACITY[region]) * 100
        });

        // Actualizar el ticket
        await this.updateTicketStatus(ticketId, {
          status: 'completed',
          result: result,
          region: region,
          timestamp: Date.now(),
          processingTime
        });

        console.log('Message processed successfully:', {
          region,
          status: 'success',
          processingTime,
          queueLength: queueStatus.queueLength
        });

      } catch (error) {
        console.error('Error processing message:', error);
        
        const queueStatus = await this.getRegionQueueStatus(region);
        
        // Registrar métricas de error
        await metricsService.recordMetric(region, {
          period: 'minute',
          messagesProcessed: 0,
          messagesFailed: 1,
          queueLength: queueStatus.queueLength,
          utilizationPercentage: (queueStatus.queueLength / REGION_CAPACITY[region]) * 100
        });

        await this.updateTicketStatus(ticketId, {
          status: 'error',
          error: error.message,
          region: region,
          timestamp: Date.now(),
          processingTime: Date.now() - startTime
        });
        
        if (!error.message.includes('already settled')) {
          await receiver.abandonMessage(message);
        }
      }
    } catch (error) {
      console.error('Fatal error in processMessage:', error);
    }
  }

  // Añadir nuevo método para actualizar posiciones
  async updateQueuePositions(region) {
    try {
      // Obtener tickets sin ordenar
      const queuedTickets = await Ticket.find({
        region: region,
        status: { $in: ['queued', 'processing'] }
      });

      // Ordenar en memoria
      const sortedTickets = queuedTickets.sort((a, b) => 
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

      // Actualizar posiciones
      for (let i = 0; i < sortedTickets.length; i++) {
        const ticket = sortedTickets[i];
        if (ticket.position !== i + 1) {
          await Ticket.updateOne(
            { ticketId: ticket.ticketId },
            { 
              $set: { 
                position: i + 1,
                estimatedWaitTime: (i + 1) * AVG_PROCESSING_TIME
              }
            }
          );
          console.log(`Updated position for ticket ${ticket.ticketId} to ${i + 1}`);
        }
      }

      return sortedTickets.length;
    } catch (error) {
      console.error('Error updating queue positions:', error);
      return 0;
    }
  }

  // Método auxiliar para obtener la posición actual
  async getCurrentPosition(region, ticketId) {
    try {
      // Obtener todos los tickets en cola sin ordenar
      const queuedTickets = await Ticket.find({
        region: region,
        status: { $in: ['queued', 'processing'] }
      });

      // Ordenar en memoria por timestamp
      const sortedTickets = queuedTickets.sort((a, b) => 
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

      const position = sortedTickets.findIndex(t => t.ticketId === ticketId) + 1;
      return position > 0 ? position : 1;
    } catch (error) {
      console.error('Error getting current position:', error);
      return 1;
    }
  }

  async getAllRegionsStatus() {
    try {
      const regionsStatus = {};
      
      for (const [region, capacity] of Object.entries(REGION_CAPACITY)) {
        const regionQueueName = `${queueName}-${region}`;
        const runtimeProperties = await this.adminClient.getQueueRuntimeProperties(regionQueueName);
        
        regionsStatus[region] = {
          capacity: capacity,
          activeRequests: this.activeRequests[region] || 0,
          queuedMessages: runtimeProperties.activeMessageCount,
          scheduledMessages: runtimeProperties.scheduledMessageCount,
          totalActiveMessages: (this.activeRequests[region] || 0) + 
                             runtimeProperties.activeMessageCount + 
                             runtimeProperties.scheduledMessageCount,
          utilizationPercentage: (((this.activeRequests[region] || 0) + 
                                runtimeProperties.activeMessageCount + 
                                runtimeProperties.scheduledMessageCount) / capacity) * 100,
          estimatedWaitTime: Math.ceil(((this.activeRequests[region] || 0) + 
                                     runtimeProperties.activeMessageCount) * AVG_PROCESSING_TIME / 60) // en minutos
        };
      }

      return {
        timestamp: new Date().toISOString(),
        regions: regionsStatus,
        global: {
          totalCapacity: Object.values(REGION_CAPACITY).reduce((a, b) => a + b, 0),
          totalActiveRequests: Object.values(this.activeRequests).reduce((a, b) => a + b, 0),
          totalQueuedMessages: Object.values(regionsStatus).reduce((a, b) => a + b.queuedMessages, 0),
          globalUtilizationPercentage: Object.values(regionsStatus)
            .reduce((acc, region) => acc + region.totalActiveMessages, 0) / 
            Object.values(REGION_CAPACITY).reduce((a, b) => a + b, 0) * 100
        }
      };
    } catch (error) {
      console.error('Error getting regions status:', error);
      throw error;
    }
  }

  async cleanupOldTickets() {
    try {
      // Eliminar tickets completados o con error más antiguos de 24 horas
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      
      await Ticket.deleteMany({
        status: { $in: ['completed', 'error'] },
        timestamp: { $lt: oneDayAgo }
      });

      // Limpiar también la memoria caché
      if (this.ticketStatus) {
        for (const [ticketId, status] of this.ticketStatus.entries()) {
          if (['completed', 'error'].includes(status.status) && 
              status.timestamp < oneDayAgo) {
            this.ticketStatus.delete(ticketId);
          }
        }
      }
    } catch (error) {
      console.error('Error cleaning up old tickets:', error);
      insights.error({
        message: 'Error cleaning up old tickets',
        error: error.message
      });
    }
  }

  // Modificar getSystemStatus para quitar la referencia al circuit breaker
  async getSystemStatus(req, res) {
    try {
      const status = await this.getAllRegionsStatus();

      return res.status(200).send({
        result: 'success',
        data: {
          currentStatus: {
            timestamp: status.timestamp,
            regions: status.regions,
            global: status.global
          },
          lastUpdate: new Date().toISOString()
        }
      });
    } catch (error) {
      console.error('Error getting system status:', error);
      return res.status(500).send({
        result: 'error',
        message: 'Error getting system status'
      });
    }
  }

  validateMessage(message) {
    if (!message) {
      throw new Error('Message is required');
    }
    if (!message.body) {
      throw new Error('Message body is required');
    }
    if (!message.body.myuuid) {
      throw new Error('Message myuuid is required');
    }
    if (!message.applicationProperties?.region) {
      throw new Error('Message region is required');
    }
    if (!REGION_CAPACITY[message.applicationProperties.region]) {
      throw new Error(`Invalid region: ${message.applicationProperties.region}`);
    }
    return true;
  }

  async checkHealth() {
    const health = {
        status: 'checking',
        checks: {},
        timestamp: new Date().toISOString()
    };

    try {
        // Verificar conexión Service Bus
        health.checks.servicebus = await this.checkServiceBusConnection();
        
        // Verificar estado de colas
        health.checks.queues = await this.checkQueuesHealth();

        // Verificar estado de métricas
        health.checks.metrics = await this.checkMetricsHealth();

        // Determinar estado general
        const allChecksHealthy = 
            health.checks.servicebus.status === 'healthy' &&
            Object.values(health.checks.queues)
                .every(queue => queue.status === 'healthy') &&
            health.checks.metrics.status === 'healthy';

        health.status = allChecksHealthy ? 'healthy' : 'unhealthy';

        // Añadir información adicional
        health.summary = {
            servicebus: health.checks.servicebus.status,
            metrics: health.checks.metrics.status,
            queues: Object.entries(health.checks.queues).reduce((acc, [region, status]) => {
                acc[region] = status.status;
                return acc;
            }, {})
        };

        // Añadir información específica de métricas para el cliente
        if (health.checks.metrics.count !== undefined) {
            health.checks.metrics.metricsLastHour = health.checks.metrics.count;
        }

    } catch (error) {
        health.status = 'error';
        health.error = error.message;
        console.error('Error checking health:', error);
    }

    return health;
  }

  async checkServiceBusConnection() {
    try {
      // Intentar una operación simple
      await this.adminClient.getQueueRuntimeProperties(`${queueName}-${Object.keys(REGION_CAPACITY)[0]}`);
      return { status: 'healthy' };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message
      };
    }
  }

  async checkQueuesHealth() {
    const queuesHealth = {};
    
    for (const region of Object.keys(REGION_CAPACITY)) {
      try {
        const status = await this.getRegionQueueStatus(region);
        queuesHealth[region] = {
          status: 'healthy',
          activeMessages: status.activeRequests,
          queuedMessages: status.queueLength
        };
      } catch (error) {
        queuesHealth[region] = {
          status: 'unhealthy',
          error: error.message
        };
      }
    }

    return queuesHealth;
  }

  async checkMetricsHealth() {
    try {
        const lastHour = new Date(Date.now() - 60 * 60 * 1000);
        
        // Verificar si Metrics está disponible
        if (!Metrics || typeof Metrics.find !== 'function') {
            console.error('Metrics model not properly initialized');
            return {
                status: 'unhealthy',
                error: 'Metrics service not properly initialized',
                count: 0,
                metricsLastHour: 0
            };
        }

        // Usar find().count() en lugar de countDocuments
        const metricsCount = await Metrics.find({
            timestamp: { $gte: lastHour }
        }).count();

        const status = metricsCount >= 0 ? 'healthy' : 'warning';
        console.log('Metrics health check:', { status, count: metricsCount });

        return {
            status,
            message: metricsCount > 0 ? 
                `Metrics system healthy, ${metricsCount} records in the last hour` : 
                'No metrics recorded in the last hour',
            count: metricsCount,
            metricsLastHour: metricsCount
        };
    } catch (error) {
        console.error('Error checking metrics health:', error);
        return {
            status: 'unhealthy',
            error: error.message || 'Unknown error checking metrics health',
            count: 0,
            metricsLastHour: 0
        };
    }
  }

  async handleShutdown() {
    console.log('Iniciando cierre graceful...');
    try {
        await this.close();
        process.exit(0);
    } catch (error) {
        console.error('Error durante el cierre:', error);
        process.exit(1);
    }
  }
}

// Exportar una instancia de QueueService en lugar de la clase
const queueServiceInstance = new QueueService();

module.exports = queueServiceInstance;