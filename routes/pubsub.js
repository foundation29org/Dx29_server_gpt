const express = require('express');
const router = express.Router();
const pubsubService = require('../services/pubsubService');
const insights = require('../services/insights');

// Endpoint para negociación - generar token de acceso para cliente
router.post('/negotiate', async (req, res) => {
  try {
    const userId = req.body.myuuid;
    
    if (!userId) {
      return res.status(400).json({
        error: 'myuuid is required'
      });
    }

    // Validar formato UUID
    if (!/^[0-9a-fA-F-]{36}$/.test(userId)) {
      return res.status(400).json({
        error: 'Invalid UUID format'
      });
    }

    const token = await pubsubService.getClientAccessToken(userId);
    
    res.json({
      url: token.url,
      accessToken: token.token,
      userId: userId,
      hubName: 'diagnose'
    });

  } catch (error) {
    console.error('Error in /negotiate:', error);
    insights.error({
      message: 'Error generating PubSub token',
      error: error.message,
      userId: req.body.myuuid,
      endpoint: '/pubsub/negotiate'
    });
    
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to generate access token'
    });
  }
});

// Endpoint para verificar estado de conexión
router.get('/status/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const isConnected = await pubsubService.isUserConnected(userId);
    
    res.json({
      userId: userId,
      connected: isConnected
    });
  } catch (error) {
    console.error('Error checking connection status:', error);
    res.status(500).json({
      error: 'Failed to check connection status'
    });
  }
});

module.exports = router; 