const ClientConfig = require('../models/clientconfig');
const insights = require('../services/insights');

async function shouldSaveToBlobOld({ tenantId, subscriptionKeyHash }) {
    const clientId = tenantId || subscriptionKeyHash;
    if (!clientId) return true; // Por defecto, guardar
  
    const config = await ClientConfig.findOne({ clientId });
    return config ? config.saveToBlob : true; // true por defecto
  }

async function shouldSaveToBlob({ tenantId, subscriptionKeyHash }) {
  const clientId = tenantId || subscriptionKeyHash;
  if (!clientId) {
    insights.error({
      message: "No tenantId ni subscriptionKeyHash proporcionados",
      tenantId,
      subscriptionKeyHash
    });
    return false; // No guardar si no hay identificador de cliente
  }

  const config = await ClientConfig.findOne({ clientId });
  if (!config) {
    return false; // No guardar si no existe configuración
  }

  // Decidir según el producto
  switch (config.product) {
    case 'premium':
      return true; // Guardar por defecto para productos premium
    case 'basic':
      return false; // No guardar por defecto para productos basic
    default:
      return config.saveToBlob; // Usar la configuración explícita si existe
  }
}

module.exports = { shouldSaveToBlob }; 