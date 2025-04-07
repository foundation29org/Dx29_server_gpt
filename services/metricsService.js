const Metrics = require('../models/metrics');
const { REGION_CAPACITY } = require('../config');

class MetricsService {
    constructor() {
        this.metricsBuffer = new Map();
        this.startPeriodicUpdate();
    }

    async recordMetric(region, data) {
        try {
            const metric = await Metrics.create({
                region,
                timestamp: new Date(),
                period: 'minute',
                ...data
            });
            console.log(`Metric recorded for region ${region}:`, metric);
            return metric;
        } catch (error) {
            console.error('Error recording metric:', error);
            throw error;
        }
    }

    async getRegionMetrics(region, timeRange = 60) {
        try {
            const since = new Date(Date.now() - timeRange * 60 * 1000);
            return await Metrics.find({
                region,
                timestamp: { $gte: since }
            }).sort({ timestamp: -1 });
        } catch (error) {
            console.error(`Error getting metrics for region ${region}:`, error);
            return [];
        }
    }

    async updateQueueMetrics(region, queueLength, activeRequests) {
        try {
            const utilizationPercentage = 
                ((queueLength + activeRequests) / REGION_CAPACITY[region]) * 100;

            await this.recordMetric(region, {
                queueLength,
                utilizationPercentage
            });
        } catch (error) {
            console.error(`Error updating queue metrics for region ${region}:`, error);
        }
    }

    startPeriodicUpdate() {
        // Actualizar métricas cada minuto
        setInterval(async () => {
            try {
                for (const region of Object.keys(REGION_CAPACITY)) {
                    const metrics = await this.getRegionMetrics(region);
                    console.log(`Updated metrics for region ${region}:`, metrics.length);
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