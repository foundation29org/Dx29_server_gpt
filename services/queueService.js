const { ServiceBusClient, ServiceBusAdministrationClient } = require("@azure/service-bus");
const config = require('../config');
const Ticket = require('../models/ticket');
const insights = require('../services/insights');
const Metrics = require('../models/metrics');
const metricsService = require('./metricsService');

// Configuración de Service Bus
function clean(s) {
  return s.replace(/[\r\n"' ]/g, '');
}
const namespace = clean(config.serviceBusName);
const key       = clean(config.serviceBusKey);
const connectionString = `Endpoint=sb://${namespace}.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=${key}`;
const baseQueueName = "diagnosis-queue";

const REGION_MAPPING = {
  asia: 'India',        // Redirigir a India para gpt4o
  europe: 'Sweden',      // Europa
  northamerica: 'WestUS', // Estados Unidos
  southamerica: 'WestUS', // Redirigir a Estados Unidos
  africa: 'Sweden',      // Redirigir a Europa
  oceania: 'Japan',     // Redirigir a Japan para gpt4o
  other: 'WestUS'       // Redirigir a Estados Unidos
};

// Configuración de tiempos de procesamiento por modelo (en segundos)
const MODEL_PROCESSING_TIMES = {
  gpt4o: 15,    // 15 segundos 
  o3: 60,       // 1 minuto
  gpt5nano: 25, // 25 segundos
  gpt5mini: 40, // 40 segundos
  gpt5: 45, // 45 segundos
};

// Función helper para obtener el tiempo de procesamiento de un modelo
function getProcessingTime(model) {
  return MODEL_PROCESSING_TIMES[model] || MODEL_PROCESSING_TIMES.gpt4o; // fallback a gpt4o
}

// Función para obtener la región específica según el modelo y timezone
function getRegionFromTimezoneAndModel(timezone, model) {
  const tz = timezone?.split('/')[0]?.toLowerCase();
  const availableRegions = MODEL_CAPACITY[model];
  if (!availableRegions) {
    throw new Error(`Model ${model} not supported`);
  }

  // Lógica especial para gpt5nano
  if (model === 'gpt5nano') {
    if (
      tz?.includes('america') ||
      tz?.includes('asia')
    ) {
      return 'EastUS';
    }
    return 'Sweden'; // Europa, África, Oceanía, etc.
  }
  if (model === 'gpt5mini' || model === 'gpt5') {
    if (tz?.includes('asia')) {
      return 'India';
    }
    if (tz?.includes('america')) {
      return 'EastUS';
    }
    if (tz?.includes('africa') || tz?.includes('australia') || tz?.includes('pacific') || tz?.includes('oceania')) {
      return 'Japan';
    }
    return 'Sweden';
  }

  // Para gpt4o y o3, usar todas las regiones disponibles según continente
  const region = (() => {
    if (tz?.includes('america')) return 'northamerica';
    if (tz?.includes('europe')) return 'europe';
    if (tz?.includes('asia')) return 'asia';
    if (tz?.includes('africa')) return 'africa';
    if (tz?.includes('australia') || tz?.includes('pacific')) return 'oceania';
    return 'EastUS';
  })();

 // Usar REGION_MAPPING para traducir a la región real
 return REGION_MAPPING[region] || Object.keys(availableRegions)[0];
}

const MODEL_CAPACITY = config.MODEL_CAPACITY;

// Función auxiliar para delay con backoff exponencial
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class QueueService {
  constructor() {
    if (!connectionString) {
      throw new Error('Service Bus connection string is required');
    }

    // 1. Inicializar estructuras de datos por modelo
    this.receivers = new Map(); // Map<`${model}-${region}`, receiver>
    this.regionQueues = new Map(); // Map<`${model}-${region}`, queueInfo>
    this.activeRequests = {}; // {[`${model}-${region}`]: number}
    this.ticketStatus = new Map();

    // 2. Inicializar las colas por modelo y región
    this.initializeQueuesByModel();

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

  initializeQueuesByModel() {
    // Inicializar colas para cada modelo y región
    for (const [model, capacities] of Object.entries(MODEL_CAPACITY)) {
      for (const [region, capacity] of Object.entries(capacities)) {
        const queueKey = `${model}-${region}`;
        this.regionQueues.set(queueKey, { activeRequests: 0, queueLength: 0 });
        this.activeRequests[queueKey] = 0;
      }
    }
  }

  // Obtener nombre de cola para modelo y región
  getQueueName(model, region) {
    return `${baseQueueName}-${model}-${region}`;
  }

  // Obtener clave de cola para modelo y región
  getQueueKey(model, region) {
    return `${model}-${region}`;
  }

  validateConfiguration() {
    if (!MODEL_CAPACITY || Object.keys(MODEL_CAPACITY).length === 0) {
      throw new Error('MODEL_CAPACITY configuration is required');
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
      // Crear una cola para cada modelo y región si no existe
      for (const [model, capacities] of Object.entries(MODEL_CAPACITY)) {
        for (const [region, capacity] of Object.entries(capacities)) {
          const queueName = this.getQueueName(model, region);
          const queueExists = await this.adminClient.queueExists(queueName);
          
          if (!queueExists) {
            await this.adminClient.createQueue(queueName, {
              maxSizeInMegabytes: 1024,
              defaultMessageTimeToLive: 'PT1H',
              lockDuration: 'PT30S',
              maxDeliveryCount: 3,
              enablePartitioning: false,
              enableBatchedOperations: true
            });
            console.log(`Cola ${queueName} creada exitosamente`);
          }
        }
      }
    } catch (error) {
      console.error('Error inicializando Service Bus:', error);
      throw error;
    }
  }

  async getRegionQueueStatus(model, region) {
    try {
      const queueName = this.getQueueName(model, region);
      const runtimeProperties = await this.adminClient.getQueueRuntimeProperties(queueName);
      
      return {
        activeRequests: runtimeProperties.activeMessageCount,
        scheduledRequests: runtimeProperties.scheduledMessageCount,
        queueLength: runtimeProperties.activeMessageCount + runtimeProperties.scheduledMessageCount
      };
    } catch (error) {
      console.error(`Error getting queue status for ${model}-${region}:`, error);
      return { activeRequests: 0, scheduledRequests: 0, queueLength: 0 };
    }
  }

  async getBestRegion(model) {
    let bestRegion = null;
    let lowestLoad = Infinity;

    const capacities = MODEL_CAPACITY[model];
    if (!capacities) {
      throw new Error(`Model ${model} not supported`);
    }

    for (const [region, capacity] of Object.entries(capacities)) {
      const queueStatus = await this.getRegionQueueStatus(model, region);
      const queueKey = this.getQueueKey(model, region);
      const activeRequests = this.activeRequests[queueKey] || 0;
      const currentLoad = (queueStatus.queueLength + activeRequests) / capacity;
      
      if (currentLoad < lowestLoad) {
        lowestLoad = currentLoad;
        bestRegion = region;
      }
    }

    return bestRegion;
  }

  async getRegionsStatus(model) {
    const status = [];
    const capacities = MODEL_CAPACITY[model];
    
    if (!capacities) {
      throw new Error(`Model ${model} not supported`);
    }
    
    for (const [region, capacity] of Object.entries(capacities)) {
      const queueStatus = await this.getRegionQueueStatus(model, region);
      const queueKey = this.getQueueKey(model, region);
      const activeRequests = this.activeRequests[queueKey] || 0;
      
      status.push({
        region,
        model,
        activeRequests: activeRequests,
        queueLength: queueStatus.queueLength,
        capacity,
        estimatedWaitTime: (queueStatus.queueLength + activeRequests) * getProcessingTime(model)
      });
    }

    return status;
  }

  // Obtener la región basada en timezone y modelo
  getRegionFromTimezone(timezone, model = 'gpt4o') {
    return getRegionFromTimezoneAndModel(timezone, model);
  }

  // Obtener propiedades de una región específica para un modelo
  async getRegionQueueProperties(model, region) {
    const queueKey = this.getQueueKey(model, region);
    const queueInfo = this.regionQueues.get(queueKey) || { activeRequests: 0, queueLength: 0 };
    const capacity = MODEL_CAPACITY[model]?.[region] || 0;
    
    return {
      activeMessageCount: this.activeRequests[queueKey] + queueInfo.queueLength,
      capacity: capacity,
      utilizationPercentage: capacity > 0 ? ((this.activeRequests[queueKey] + queueInfo.queueLength) / capacity) * 100 : 0
    };
  }

  // Obtener propiedades de cola basadas en timezone y modelo
  async getQueueProperties(timezone, model) {
    const region = this.getRegionFromTimezone(timezone, model);
    return await this.getRegionQueueProperties(model, region);
  }

  // Añadir a la cola específica del modelo
  async addToQueue(data, requestInfo, model) {
    try {
      const region = this.getRegionFromTimezone(data.timezone, model);
      const queueName = this.getQueueName(model, region);
      const queueKey = this.getQueueKey(model, region);
      
      // Verificar si ya existe un ticket activo con el mismo myuuid
      const existingTicket = await Ticket.findOne({ myuuid: data.myuuid });
      
      if (existingTicket) {
        // Si el ticket existe y está activo (queued o processing), devolver el existente
        if (existingTicket.status === 'queued' || existingTicket.status === 'processing') {
          console.log(`Ticket activo encontrado para myuuid ${data.myuuid}, devolviendo existente`);
          
          // Obtener posición en la cola
          const position = await this.getCurrentPosition(model, region, data.myuuid);
          const estimatedWaitTime = position * getProcessingTime(model);

          return {
            ticketId: data.myuuid,
            queuePosition: position,
            estimatedWaitTime: estimatedWaitTime,
            region: region,
            model: model
          };
        } else {
          // Si el ticket está completado o con error, eliminar el anterior y crear uno nuevo
          console.log(`Ticket anterior encontrado para myuuid ${data.myuuid} con status ${existingTicket.status}, eliminando y creando nuevo`);
          await Ticket.deleteOne({ myuuid: data.myuuid });
        }
      }
      
      // Crear nuevo ticket
      const ticket = new Ticket({
        myuuid: data.myuuid,
        status: 'queued',
        region: region,
        model: model,
        timestamp: Date.now(),
        requestData: data,
        requestInfo: requestInfo
      });
      await ticket.save();

      // Añadir mensaje a la cola
      const sender = this.sbClient.createSender(queueName);
      const message = {
        body: {
          description: data.description,
          myuuid: data.myuuid,
          operation: 'find disease',
          lang: data.lang,
          diseases_list: data.diseases_list,
          timestamp: new Date().toISOString(),
          timezone: data.timezone,
          region: region,
          tenantId: data.tenantId,
          subscriptionId: data.subscriptionId,
          requestInfo: requestInfo,
          model: model,
          iframeParams: data.iframeParams || {}
        },
        applicationProperties: {
          requestType: 'diagnosis',
          priority: 1,
          ticketId: data.myuuid
        }
      };
      await sender.sendMessages(message);
      await sender.close();

      // Actualizar estado de la cola
      const queueInfo = this.regionQueues.get(queueKey);
      if (queueInfo) {
        queueInfo.queueLength++;
      }

      // Obtener posición en la cola
      const position = await this.getCurrentPosition(model, region, data.myuuid);
      const estimatedWaitTime = position * getProcessingTime(model);

      return {
        ticketId: data.myuuid,
        queuePosition: position,
        estimatedWaitTime: estimatedWaitTime,
        region: region,
        model: model
      };

    } catch (error) {
      console.error('Error adding to queue:', error);
      insights.error({
        message: 'Error adding to queue',
        error: error.message,
        model: model,
        data: data
      });
      throw error;
    }
  }

  // Registrar una petición activa en una región específica para un modelo
  async registerActiveRequest(timezone, model) {
    const region = this.getRegionFromTimezone(timezone, model);
    const queueKey = this.getQueueKey(model, region);
    this.activeRequests[queueKey]++;
    return { region, model, queueKey };
  }

  // Liberar una petición activa en una región específica para un modelo
  async releaseActiveRequest(region, model) {
    const queueKey = this.getQueueKey(model, region);
    if (this.activeRequests[queueKey] > 0) {
      this.activeRequests[queueKey]--;
    }
  }

  async startMessageProcessing() {
    try {
      console.log('Starting message processing...');
      
      // Crear receivers para cada modelo y región
      for (const [model, capacities] of Object.entries(MODEL_CAPACITY)) {
        for (const [region, capacity] of Object.entries(capacities)) {
          const queueName = this.getQueueName(model, region);
          const receiver = this.sbClient.createReceiver(queueName);
          const receiverKey = this.getQueueKey(model, region);
          
          this.receivers.set(receiverKey, receiver);
          
          receiver.subscribe({
            processMessage: async (message) => {
              await this.processMessage(message, receiver, model, region);
            },
            processError: async (args) => {
              console.error(`Error en el procesamiento de la cola ${model}-${region}:`, args.error);
            }
          });

          console.log(`Message processing started for ${model}-${region}`);
        }
      }
      console.log('Message processing started for all models and regions');
    } catch (error) {
      console.error('Error starting message processing:', error);
      throw error;
    }
  }

  async updateTicketStatus(ticketId, status) {
    console.log('Attempting to update ticket status:', { ticketId, status });

    try {
      const updateData = {
        ...status,
        timestamp: new Date()
      };

      console.log('Update data prepared:', ticketId);

      // Usar findOneAndUpdate para actualizar o crear si no existe
      const ticket = await Ticket.findOneAndUpdate(
        { myuuid: ticketId },
        { $set: updateData },
        { 
          new: true,          // Retorna el documento actualizado
          upsert: true,       // Crea si no existe
          runValidators: true // Ejecuta validadores del esquema
        }
      );

      console.log('Database operation completed. Ticket:', ticket.myuuid);

      // También mantener en memoria para acceso rápido
      if (!this.ticketStatus) {
        this.ticketStatus = new Map();
      }
      this.ticketStatus.set(ticketId, status);

      if (!ticket) {
        throw new Error('Failed to create/update ticket in database');
      }

      console.log('Ticket successfully updated in database:', ticket.myuuid);
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
      const ticket = await Ticket.findOne({ myuuid: ticketId });
      
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
        const currentPosition = await this.getCurrentPosition(ticket.model, ticket.region, ticketId);
        return {
          result: 'queued',
          status: 'processing',
          position: currentPosition,
          estimatedWaitTime: Math.ceil(currentPosition * getProcessingTime(ticket.model) / 60)
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

  async processMessageWithRetry(message, region, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const helpDiagnose = require('./helpDiagnose');
        const result = await helpDiagnose.processAIRequest(message.body, message.body.requestInfo, message.body.model, region);
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
  async processMessage(message, receiver, model, region) {
    try {
      this.validateMessage(message);
      
      const startTime = Date.now();

      try {
        const result = await this.processMessageWithRetry(message, region);
        
        // Completar el mensaje
        await receiver.completeMessage(message);

        const processingTime = Date.now() - startTime;
        const queueStatus = await this.getRegionQueueStatus(model, region);

        // Registrar métricas detalladas
        await metricsService.recordMetric(region, model, {
          period: 'minute',
          messagesProcessed: 1,
          messagesFailed: 0,
          averageProcessingTime: processingTime,
          queueLength: queueStatus.queueLength,
          utilizationPercentage: (queueStatus.queueLength / MODEL_CAPACITY[model][region]) * 100
        });

        // Actualizar el ticket
        await this.updateTicketStatus(message.body.myuuid, {
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
        
        const queueStatus = await this.getRegionQueueStatus(model, region);
        
        // Registrar métricas de error
        await metricsService.recordMetric(region, model, {
          period: 'minute',
          messagesProcessed: 0,
          messagesFailed: 1,
          queueLength: queueStatus.queueLength,
          utilizationPercentage: (queueStatus.queueLength / MODEL_CAPACITY[model][region]) * 100
        });

        await this.updateTicketStatus(message.body.myuuid, {
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
  async updateQueuePositions(model, region) {
    try {
      // Obtener tickets sin ordenar para el modelo y región específicos
      const queuedTickets = await Ticket.find({
        region: region,
        model: model,
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
            { myuuid: ticket.myuuid },
            { 
              $set: { 
                position: i + 1,
                estimatedWaitTime: (i + 1) * getProcessingTime(model)
              }
            }
          );
          console.log(`Updated position for ticket ${ticket.myuuid} to ${i + 1}`);
        }
      }

      return sortedTickets.length;
    } catch (error) {
      console.error('Error updating queue positions:', error);
      return 0;
    }
  }

  // Método auxiliar para obtener la posición actual
  async getCurrentPosition(model, region, ticketId) {
    try {
     
      const queuedTickets = await Ticket.find({
        region: region,
        model: model,
        status: { $in: ['queued', 'processing'] }
      });

      // Ordenar en memoria por timestamp
      const sortedTickets = queuedTickets.sort((a, b) => 
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

      const position = sortedTickets.findIndex(t => t.myuuid === ticketId) + 1;
      return position > 0 ? position : 1;
    } catch (error) {
      console.error('Error getting current position:', error);
      return 1;
    }
  }

  async getAllRegionsStatus() {
    try {
      const allModelsStatus = {};
      
      // Obtener estado para cada modelo
      for (const [model, capacities] of Object.entries(MODEL_CAPACITY)) {
        const modelStatus = {};
        
        for (const [region, capacity] of Object.entries(capacities)) {
          const queueName = this.getQueueName(model, region);
          const queueKey = this.getQueueKey(model, region);
          
          try {
            const runtimeProperties = await this.adminClient.getQueueRuntimeProperties(queueName);
            const activeRequests = this.activeRequests[queueKey] || 0;
            const queuedMessages = runtimeProperties.activeMessageCount;
            const scheduledMessages = runtimeProperties.scheduledMessageCount;
            const totalActiveMessages = activeRequests + queuedMessages + scheduledMessages;
            
            modelStatus[region] = {
              capacity: capacity,
              activeRequests: activeRequests,
              queuedMessages: queuedMessages,
              scheduledMessages: scheduledMessages,
              totalActiveMessages: totalActiveMessages,
              utilizationPercentage: capacity > 0 ? (totalActiveMessages / capacity) * 100 : 0,
              estimatedWaitTime: Math.ceil((activeRequests + queuedMessages) * getProcessingTime(model) / 60) // en minutos
            };
          } catch (error) {
            console.error(`Error getting queue status for ${model}-${region}:`, error);
            modelStatus[region] = {
              capacity: capacity,
              activeRequests: 0,
              queuedMessages: 0,
              scheduledMessages: 0,
              totalActiveMessages: 0,
              utilizationPercentage: 0,
              estimatedWaitTime: 0
            };
          }
        }
        
        allModelsStatus[model] = modelStatus;
      }

      // Calcular estadísticas globales
      const globalStats = this.calculateGlobalStats(allModelsStatus);

      return {
        timestamp: new Date().toISOString(),
        models: allModelsStatus,
        global: globalStats
      };
    } catch (error) {
      console.error('Error getting all regions status:', error);
      throw error;
    }
  }

  calculateGlobalStats(allModelsStatus) {
    let totalCapacity = 0;
    let totalActiveRequests = 0;
    let totalQueuedMessages = 0;
    let totalScheduledMessages = 0;

    for (const [model, regions] of Object.entries(allModelsStatus)) {
      for (const [region, stats] of Object.entries(regions)) {
        totalCapacity += stats.capacity;
        totalActiveRequests += stats.activeRequests;
        totalQueuedMessages += stats.queuedMessages;
        totalScheduledMessages += stats.scheduledMessages;
      }
    }

    const totalActiveMessages = totalActiveRequests + totalQueuedMessages + totalScheduledMessages;
    const globalUtilizationPercentage = totalCapacity > 0 ? (totalActiveMessages / totalCapacity) * 100 : 0;

    return {
      totalCapacity,
      totalActiveRequests,
      totalQueuedMessages,
      totalScheduledMessages,
      totalActiveMessages,
      globalUtilizationPercentage
    };
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
            models: status.models,
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
    if (!message.body.region) {
      throw new Error('Message region is required');
    }
    if (!message.body.model) {
      throw new Error('Message model is required');
    }
    
    const model = message.body.model;
    const region = message.body.region;
    
    if (!MODEL_CAPACITY[model] || !MODEL_CAPACITY[model][region]) {
      throw new Error(`Invalid model-region combination: ${model}-${region}`);
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
            queues: Object.entries(health.checks.queues).reduce((acc, [queueKey, status]) => {
                acc[queueKey] = status.status;
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
      // Intentar una operación simple con la primera cola disponible
      const firstModel = Object.keys(MODEL_CAPACITY)[0];
      const firstRegion = Object.keys(MODEL_CAPACITY[firstModel])[0];
      const queueName = this.getQueueName(firstModel, firstRegion);
      
      await this.adminClient.getQueueRuntimeProperties(queueName);
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
    
    for (const [model, capacities] of Object.entries(MODEL_CAPACITY)) {
      for (const [region, capacity] of Object.entries(capacities)) {
        const queueKey = this.getQueueKey(model, region);
        
        try {
          const status = await this.getRegionQueueStatus(model, region);
          const activeRequests = this.activeRequests[queueKey] || 0;
          
          queuesHealth[queueKey] = {
            status: 'healthy',
            activeMessages: activeRequests,
            queuedMessages: status.queueLength,
            capacity: capacity
          };
        } catch (error) {
          queuesHealth[queueKey] = {
            status: 'unhealthy',
            error: error.message
          };
        }
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
        }).countDocuments();

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