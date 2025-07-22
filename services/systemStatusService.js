const queueService = require('./queueService');

// Modificar la función getSystemStatus
async function getSystemStatus(req, res) {
  try {
    const status = await queueService.getAllRegionsStatus();

    // Añadir información de endpoints sin exponer las URLs
    // Mostrar todas las regiones de todos los modelos
    const endpointsStatus = {};

    // Iterar sobre todos los modelos y sus regiones
    for (const [model, regions] of Object.entries(status.models)) {
      endpointsStatus[model] = {};

      for (const [region, regionStatus] of Object.entries(regions)) {
        endpointsStatus[model][region] = {
          capacity: regionStatus.capacity || 'N/A',
          utilizationPercentage: regionStatus.utilizationPercentage || 0,
          activeRequests: regionStatus.activeRequests || 0,
          queuedMessages: regionStatus.queuedMessages || 0,
          status: {
            primary: (regionStatus.activeRequests || 0) > 0 ? 'active' : 'idle',
            backup: 'standby'
          }
        };
      }
    }

    return res.status(200).send({
      result: 'success',
      data: {
        queues: {
          timestamp: status.timestamp,
          models: status.models,
          global: status.global
        },
        endpoints: endpointsStatus,
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

// Nueva función para consultar estado
async function getQueueStatus(req, res) {
  try {
    const ticketId = req.params.ticketId;
    const timezone = req.body.timezone; // Opcional: obtener timezone de query params

    if (!ticketId) {
      return res.status(400).send({
        result: 'error',
        message: 'ticketId is required'
      });
    }

    const status = await queueService.getTicketStatus(ticketId);
    return res.status(200).send(status);

  } catch (error) {
    console.error('Error getting queue status:', error);
    return res.status(500).send({
      result: 'error',
      message: 'Internal server error while checking queue status'
    });
  }
}

async function checkHealth(req, res) {
  const health = await queueService.checkHealth();
  return res.status(200).send(health);
}

module.exports = {
  getSystemStatus,
  getQueueStatus,
  checkHealth
}; 