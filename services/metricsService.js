const Metrics = require('../models/metrics');
const { MODEL_CAPACITY } = require('../config');

class MetricsService {
    constructor() {
        this.metricsBuffer = new Map();
        this.startPeriodicUpdate();
    }

    async recordMetric(region, model, data) {
        try {
            const metric = await Metrics.create({
                region,
                model,
                timestamp: new Date(),
                period: 'minute',
                ...data
            });
            console.log(`Metric recorded for ${model}-${region}:`, metric);
            return metric;
        } catch (error) {
            console.error('Error recording metric:', error);
            throw error;
        }
    }

    async getRegionMetrics(region, model, timeRange = 60) {
        try {
            const since = new Date(Date.now() - timeRange * 60 * 1000);
            return await Metrics.find({
                region,
                model,
                timestamp: { $gte: since }
            }).sort({ timestamp: -1 });
        } catch (error) {
            console.error(`Error getting metrics for ${model}-${region}:`, error);
            return [];
        }
    }

    async updateQueueMetrics(region, model, queueLength, activeRequests) {
        try {
            const capacity = MODEL_CAPACITY[model]?.[region] || 0;
            const utilizationPercentage = capacity > 0 ? 
                ((queueLength + activeRequests) / capacity) * 100 : 0;

            await this.recordMetric(region, model, {
                queueLength,
                activeRequests,
                utilizationPercentage
            });
        } catch (error) {
            console.error(`Error updating queue metrics for ${model}-${region}:`, error);
        }
    }

    startPeriodicUpdate() {
        // Actualizar métricas cada minuto
        setInterval(async () => {
            try {
                for (const [model, regions] of Object.entries(MODEL_CAPACITY)) {
                    for (const region of Object.keys(regions)) {
                        const metrics = await this.getRegionMetrics(region, model);
                        console.log(`Updated metrics for ${model}-${region}:`, metrics.length);
                    }
                }
            } catch (error) {
                console.error('Error in periodic metrics update:', error);
            }
        }, 60 * 1000);
    }

    async checkHealth() {
        try {
            const lastHour = new Date(Date.now() - 60 * 60 * 1000);
            const metricsCount = await Metrics.countDocuments({
                timestamp: { $gte: lastHour }
            });

            return {
                status: metricsCount > 0 ? 'healthy' : 'healthy',
                message: metricsCount > 0 ? 
                    'Metrics being recorded normally' : 
                    'No metrics recorded in the last hour',
                count: metricsCount
            };
        } catch (error) {
            console.error('Error checking metrics health:', error);
            return {
                status: 'unhealthy',
                error: error.message
            };
        }
    }
}

module.exports = new MetricsService(); 