const { isIP } = require('node:net');
const rateLimit = require('express-rate-limit');
const insights = require('../services/insights')

function getHeader(req, name) {
    return req.headers[name.toLowerCase()];
}

// Una sola IP, sin puerto ni lista. ::ffff:1.2.3.4 se queda en 1.2.3.4.
function singleIp(value) {
    if (Array.isArray(value)) {
        return value.length === 1 ? singleIp(value[0]) : null;
    }
    if (typeof value !== 'string') {
        return null;
    }
    const candidate = value.trim();
    if (!candidate || candidate.includes(',')) {
        return null;
    }
    if (isIP(candidate) === 0) {
        return null;
    }
    const mapped = candidate.toLowerCase().startsWith('::ffff:')
        ? candidate.slice('::ffff:'.length)
        : '';
    if (mapped && isIP(mapped) === 4) {
        return mapped;
    }
    return candidate;
}

// Con trust proxy = 1, req.ip es el último salto (el front de App Service,
// la misma IP para todo el mundo). La IP del visitante llega en X-Client-IP,
// que APIM escribe pisando lo que mandara el cliente. Sin esa cabecera se usa
// la primera IP válida de X-Forwarded-For: en este despliegue es el visitante,
// porque los saltos de Azure y Cloudflare llevan puerto y no son una IP.
function clientIp(req) {
    const fromGateway = singleIp(getHeader(req, 'x-client-ip'));
    if (fromGateway) {
        return fromGateway;
    }

    const forwarded = getHeader(req, 'x-forwarded-for');
    if (typeof forwarded === 'string') {
        for (const part of forwarded.split(',')) {
            const ip = singleIp(part);
            if (ip) {
                return ip;
            }
        }
    }

    return singleIp(req.socket?.remoteAddress || req.connection?.remoteAddress) ||
        'unknown';
}

// Rate limiter para DxGPT interno (mantiene configuración actual)
const needsLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 100, // límite por IP
    message: {
        success: false,
        message: 'Too many requests, please try again later.'
    },
    keyGenerator: function (req) {
        return clientIp(req);
    },
    handler: (req, res, next, options) => {
        console.warn('Rate limit exceeded:', {
            ip: clientIp(req),
            timestamp: new Date()
        });
        let infoError = {
            ip: clientIp(req),
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
        const ip = clientIp(req);
        
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
            ip: clientIp(req),
            timestamp: new Date()
        });
        let infoError = {
            tenantId: getHeader(req, 'x-tenant-id'),
            myuuid: req.body?.myuuid || req.query?.myuuid,
            ip: clientIp(req),
            message: options.message
        }
        insights.error(infoError);
        res.status(429).json(options.message);
    }
});

// Middleware inteligente que selecciona el rate limiter apropiado
const smartLimiter = (req, res, next) => {
    // Docker eval (NODE_ENV=local): una sola IP NAT, 2 HTTP por caso
    // (negotiate + analyze) y a veces dos runners en paralelo. El tope
    // de producto 100/15min no aplica a estas pruebas.
    if (process.env.NODE_ENV === 'local') {
        return next();
    }

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

const healthLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutos
    max: 310, // límite por IP
    message: {
        success: false,
        message: 'Too many requests to /health, please try again later'
    },
    keyGenerator: function (req) {
        return clientIp(req);
    },
    handler: (req, res, next, options) => {
        console.warn('Rate limit exceeded for /health:', {
            ip: clientIp(req),
            timestamp: new Date()
        });
        let infoError = {
            ip: clientIp(req),
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