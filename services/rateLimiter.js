const rateLimit = require('express-rate-limit');
const insights = require('../services/insights')

// Rate limiter para DxGPT interno (mantiene configuración actual)
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

// Rate limiter para clientes externos y tráfico no identificado
const externalLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minuto
    max: 200, // 200 requests por minuto
    message: {
        success: false,
        message: 'Too many requests, please try again later.'
    },
    keyGenerator: function (req) {
        const tenantId = getHeader(req, 'x-tenant-id');
        const myuuid = req.body?.myuuid || req.query?.myuuid;
        const ip = req.headers['x-forwarded-for'] || 
                   req.connection.remoteAddress || 
                   req.ip || 
                   '127.0.0.1';
        
        if (myuuid) {
            // Si hay myuuid, usar sesión (con o sin tenantId)
            if (tenantId) {
                return `external_${tenantId}_${myuuid}`;
            } else {
                return `external_session_${myuuid}`;
            }
        } else if (tenantId) {
            // Solo tenantId sin myuuid
            return `external_${tenantId}`;
        } else {
            // Sin tenantId ni myuuid: usar IP
            return ip;
        }
    },
    handler: (req, res, next, options) => {
        console.warn('External rate limit exceeded:', {
            tenantId: getHeader(req, 'x-tenant-id'),
            myuuid: req.body?.myuuid || req.query?.myuuid,
            ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip || '127.0.0.1',
            timestamp: new Date()
        });
        let infoError = {
            tenantId: getHeader(req, 'x-tenant-id'),
            myuuid: req.body?.myuuid || req.query?.myuuid,
            ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip || '127.0.0.1',
            message: options.message
        }
        insights.error(infoError);
        res.status(429).json(options.message);
    }
});

// Middleware inteligente que selecciona el rate limiter apropiado
const smartLimiter = (req, res, next) => {
    const tenantId = getHeader(req, 'x-tenant-id');
    
    // Lista de tenant IDs internos de DxGPT
    const internalTenants = ['dxgpt-local', 'dxgpt-prod', 'dxgpt-dev'];
    
    if (tenantId && internalTenants.includes(tenantId)) {
        // Tráfico interno DxGPT - usa needsLimiter (100/15min por IP)
        return needsLimiter(req, res, next);
    } else {
        // Cualquier otro caso (tenants externos, sin tenantId, etc.) - usa externalLimiter
        // externalLimiter maneja automáticamente:
        // - Con tenantId + myuuid: 200/min por sesión
        // - Con solo tenantId: 200/min por tenant
        // - Sin tenantId: 200/min por IP
        return externalLimiter(req, res, next);
    }
};

function getHeader(req, name) {
    return req.headers[name.toLowerCase()];
}

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



module.exports = { 
    needsLimiter, 
    healthLimiter,
    smartLimiter, 
    externalLimiter
};