const { ServiceBusClient, ServiceBusAdministrationClient } = require("@azure/service-bus");
const config = require('../config');
const { v4: uuidv4 } = require('uuid');

// Configuración de Service Bus
const connectionString = config.serviceBusConnectionString;
const queueName = "diagnosis-queue";

const REGION_MAPPING = {
  asia: 'India',
  europe: 'Suiza',
  northamerica: 'EastUS',
  southamerica: 'EastUS',
  africa: 'Suiza',
  oceania: 'India',
  other: 'EastUS'
};

const REGION_CAPACITY = {
  EastUS: 420,
  India: 428,
  Suiza: 428,
  WestUS: 857
};

/*const REGION_CAPACITY = {
  EastUS: 293,
  India: 300,
  Japan: 300,
  Suiza: 300,
  Swedencentral: 191,
  WestUS: 600
};*/

// Tiempo promedio de procesamiento por solicitud en segundos
const AVG_PROCESSING_TIME = 10;

class QueueService {
  constructor() {
    this.sbClient = new ServiceBusClient(connectionString);
    this.adminClient = new ServiceBusAdministrationClient(connectionString);
    this.ticketStatus = new Map();
    this.regionQueues = new Map();
    this.activeRequests = {};
    Object.keys(REGION_CAPACITY).forEach(region => {
      this.regionQueues.set(region, { activeRequests: 0, queueLength: 0 });
      this.activeRequests[region] = 0;
    });
    this.initialize();
    this.startMessageProcessing();
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
  async addToQueue(data, requestInfo) {
    try {
      const region = this.getRegionFromTimezone(data.timezone);
      
      // Generamos un nuevo ticketId
      const ticketId = data.myuuid; // Usamos el myuuid como ticketId para mantener consistencia
      
      // Crear el mensaje con la estructura necesaria
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
        applicationProperties: {
          requestType: 'diagnosis',
          priority: 1,
          region: region,
          ticketId: ticketId
        }
      };

      // Crear un sender específico para la región
      const sender = this.sbClient.createSender(`${queueName}-${region}`);
      await sender.sendMessages(message);
      await sender.close();

      // Obtener el estado actual de la cola para esta región
      const queueStatus = await this.getRegionQueueStatus(region);

      // Guardar el estado inicial del ticket
      await this.updateTicketStatus(ticketId, {
        status: 'queued',
        region: region,
        position: queueStatus.queueLength,
        timestamp: Date.now()
      });
      
      return {
        ticketId,
        region,
        queuePosition: queueStatus.queueLength,
        estimatedWaitTime: queueStatus.queueLength * AVG_PROCESSING_TIME
      };

    } catch (error) {
      console.error('Error adding to queue:', error);
      throw error;
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
      // Cada instancia crea receivers para cada región
      for (const region of Object.keys(REGION_CAPACITY)) {
        const receiver = this.sbClient.createReceiver(`${queueName}-${region}`);
        
        receiver.subscribe({
          processMessage: async (message) => {
            // Usar bind para mantener el contexto correcto de 'this'
            await this.processMessage.bind(this)(message, receiver);
          },
          processError: async (args) => {
            console.error(`Error en el procesamiento de la cola ${region}:`, args.error);
          }
        });
      }
    } catch (error) {
      console.error('Error iniciando el procesamiento de mensajes:', error);
    }
  }

  async saveResult(ticketId, result) {
    try {
      // Validar que tenemos un resultado válido
      if (!result || !result.data) {
        console.error('Invalid result data for ticket:', ticketId);
        return;
      }

      // Guardar el resultado completo en el estado del ticket
      await this.updateTicketStatus(ticketId, {
        status: 'completed',
        data: result  // Guardar el resultado completo
      });

    } catch (error) {
      console.error('Error guardando resultado:', error);
      throw error;
    }
  }

  async updateTicketStatus(ticketId, status) {
    try {
      // Aquí implementar la lógica para actualizar el estado
      // Puede ser en una tabla de Azure Storage, Redis, etc.
      // Por ahora usaremos un Map en memoria (solo para desarrollo)
      if (!this.ticketStatus) {
        this.ticketStatus = new Map();
      }
      this.ticketStatus.set(ticketId, status);
    } catch (error) {
      console.error('Error actualizando estado del ticket:', error);
      throw error;
    }
  }

  async getTicketStatus(ticketId, timezone) {
    try {
      // Si tenemos el estado del ticket en memoria
      if (this.ticketStatus && this.ticketStatus.has(ticketId)) {
        const status = this.ticketStatus.get(ticketId);
        
        if (status.status === 'completed' && status.data) {
          return {
            result: 'success',
            status: 'completed',
            data: status.data
          };
        }
      }

      // Si no tenemos el estado en memoria o no está completado,
      // buscamos en la región correspondiente
      const region = timezone ? this.getRegionFromTimezone(timezone) : null;
      let queueStatus;

      if (region) {
        // Si tenemos timezone, buscamos solo en esa región
        queueStatus = await this.getRegionQueueStatus(region);
        if (queueStatus.queueLength > 0) {
          return {
            result: 'success',
            status: 'queued',
            position: queueStatus.queueLength,
            estimatedWaitTime: Math.ceil(queueStatus.queueLength * AVG_PROCESSING_TIME / 60), // en minutos
            region: region,
            utilizationPercentage: (queueStatus.queueLength / REGION_CAPACITY[region]) * 100
          };
        }
      } else {
        // Si no tenemos timezone, buscamos en todas las regiones
        for (const [currentRegion, capacity] of Object.entries(REGION_CAPACITY)) {
          queueStatus = await this.getRegionQueueStatus(currentRegion);
          if (queueStatus.queueLength > 0) {
            return {
              result: 'success',
              status: 'queued',
              position: queueStatus.queueLength,
              estimatedWaitTime: Math.ceil(queueStatus.queueLength * AVG_PROCESSING_TIME / 60), // en minutos
              region: currentRegion,
              utilizationPercentage: (queueStatus.queueLength / capacity) * 100
            };
          }
        }
      }

      // Si no encontramos el ticket en ninguna cola, asumimos que está en procesamiento
      return {
        result: 'success',
        status: 'processing',
        message: 'Request is being processed'
      };
    } catch (error) {
      console.error('Error getting ticket status:', error);
      throw error;
    }
  }

  async close() {
    try {
      await this.sender?.close();
      await this.receiver?.close();
      await this.sbClient?.close();
    } catch (error) {
      console.error('Error closing Service Bus client:', error);
    }
  }

  async processMessage(message, receiver) {
    const region = message.applicationProperties.region;
    const ticketId = message.body.myuuid; // Usar myuuid como ticketId
    
    try {
      console.log(`Procesando mensaje: ${ticketId}`);
      
      // Importar openaiazure dinámicamente dentro de la función
      const openaiazure = require('./openaiazure');
      
      // Actualizar el estado del ticket a 'processing'
      await this.updateTicketStatus(ticketId, {
        status: 'processing',
        message: 'Request is being processed',
        region: region,
        timestamp: Date.now()
      });

      // Incrementar el contador de peticiones activas
      this.activeRequests[region]++;

      try {
        const result = await openaiazure.processOpenAIRequest(message.body, message.requestInfo);
        
        // Guardar el resultado y marcar el mensaje como completado
        await this.updateTicketStatus(ticketId, {
          status: 'completed',
          data: result,
          region: region,
          timestamp: Date.now()
        });

        await receiver.completeMessage(message);
      } finally {
        // Asegurarnos de decrementar el contador incluso si hay error
        this.activeRequests[region]--;
      }

    } catch (error) {
      console.error('Error processing message:', error);
      
      try {
        // Actualizar el estado del ticket a 'error'
        await this.updateTicketStatus(ticketId, {
          status: 'error',
          message: 'An error occurred while processing the request',
          region: region,
          timestamp: Date.now(),
          error: error.message
        });

        // Solo intentar abandonar el mensaje si el receiver está disponible
        if (receiver && message.lockToken) {
          await receiver.abandonMessage(message);
        }
      } catch (abandonError) {
        console.error('Error abandoning message:', abandonError);
      }
    }
  }
}

// Exportar una instancia de QueueService en lugar de la clase
const queueServiceInstance = new QueueService();

module.exports = queueServiceInstance;