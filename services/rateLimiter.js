const rateLimit = require('express-rate-limit');
const insights = require('../services/insights')

const needsLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 100, // límite por IP
    message: {
        success: false,
        message: 'Too many requests, please try again later.'
    },
    keyGenerator: function (req) {
        return req.headers['x-forwarded-for'] || 
               req.connection.remoteAddress || 
               req.ip || 
               '127.0.0.1';
    },
    handler: (req, res, next, options) => {
        console.warn('Rate limit exceeded:', {
            ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip || '127.0.0.1',
            timestamp: new Date()
        });
        let infoError = {
            ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip || '127.0.0.1',
            message: options.message
        }
        insights.error(infoError);
        res.status(429).json(options.message);
    }
});

const healthLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutos
    max: 310, // límite por IP
    message: {
        success: false,
        message: 'Too many requests to /health, please try again later'
    },
    keyGenerator: function (req) {
        return req.headers['x-forwarded-for'] || 
               req.connection.remoteAddress || 
               req.ip || 
               '127.0.0.1';
    },
    handler: (req, res, next, options) => {
        console.warn('Rate limit exceeded for /health:', {
            ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip || '127.0.0.1',
            timestamp: new Date()
        });
        let infoError = {
            ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip || '127.0.0.1',
            message: options.message
        }
        insights.error(infoError);
        res.status(429).json(options.message);
    }
});

const globalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 100, // máximo 100 requests por IP por minuto
  message: 'Too many requests from this IP, please try again later.',
  handler: (req, res, next, options) => {
    console.warn('Rate limit exceeded:', {
      ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip || '127.0.0.1',
      timestamp: new Date()
    });
    let infoError = {
        ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip || '127.0.0.1',
        message: options.message
    }
    insights.error(infoError);
    res.status(429).json(options.message);
  }
});



module.exports = { needsLimiter, healthLimiter, globalLimiter };