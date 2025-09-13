const fs = require('fs');
const { Logger } = require('../logger');

/**
 * Home Assistant specific integrations and optimizations
 */
class HAIntegration {
    constructor() {
        this.logger = new Logger({ component: 'HAIntegration' });
        this._isAddon = null;
        this._haApiToken = null;
        this._ingressUrl = null;
    }

    /**
     * Check if running as Home Assistant addon
     */
    isHomeAssistantAddon() {
        if (this._isAddon !== null) {
            return this._isAddon;
        }

        // Check for HA addon environment indicators
        const hasHAToken = !!process.env.SUPERVISOR_TOKEN;
        const hasHAIngress = !!process.env.INGRESS_SESSION;
        const hasDataDir = fs.existsSync('/data');
        const hasOptionsFile = fs.existsSync('/data/options.json');

        this._isAddon = hasHAToken && hasDataDir && hasOptionsFile;
        
        if (this._isAddon) {
            this.logger.info('Detected Home Assistant addon environment');
        }

        return this._isAddon;
    }

    /**
     * Get Home Assistant API configuration
     */
    getHAApiConfig() {
        if (!this.isHomeAssistantAddon()) {
            return null;
        }

        return {
            token: process.env.SUPERVISOR_TOKEN,
            baseUrl: process.env.SUPERVISOR_HOST ? `http://${process.env.SUPERVISOR_HOST}` : 'http://supervisor',
            ingressUrl: process.env.INGRESS_URL,
            ingressEntry: process.env.INGRESS_ENTRY
        };
    }

    /**
     * Optimize logging for Home Assistant addon environment
     */
    optimizeLogging() {
        if (!this.isHomeAssistantAddon()) {
            return;
        }

        // In HA addon environment, we want:
        // 1. No timestamp prefixes (HA handles timestamping)
        // 2. Simplified format for better integration with HA logs
        // 3. Proper log level mapping to HA's logging system

        const originalConsoleLog = console.log;
        const originalConsoleWarn = console.warn;
        const originalConsoleError = console.error;
        const originalConsoleDebug = console.debug;

        // Override console methods to provide cleaner HA addon logging
        console.log = (...args) => {
            const message = args.join(' ');
            // Remove timestamp if present (HA adds its own)
            const cleanMessage = message.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\s+/, '');
            originalConsoleLog(cleanMessage);
        };

        console.warn = (...args) => {
            const message = args.join(' ');
            const cleanMessage = message.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\s+/, '');
            originalConsoleWarn(cleanMessage);
        };

        console.error = (...args) => {
            const message = args.join(' ');
            const cleanMessage = message.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\s+/, '');
            originalConsoleError(cleanMessage);
        };

        console.debug = (...args) => {
            const message = args.join(' ');
            const cleanMessage = message.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\s+/, '');
            originalConsoleDebug(cleanMessage);
        };

        this.logger.info('Optimized logging for Home Assistant addon environment');
    }

    /**
     * Set up ingress support for web interface
     */
    setupIngress() {
        if (!this.isHomeAssistantAddon()) {
            return null;
        }

        const ingressUrl = process.env.INGRESS_URL;
        const ingressEntry = process.env.INGRESS_ENTRY;

        if (ingressUrl || ingressEntry) {
            this.logger.info(`Ingress support enabled - URL: ${ingressUrl}, Entry: ${ingressEntry}`);
            
            return {
                ingressUrl,
                ingressEntry,
                basePath: ingressEntry || '/'
            };
        }

        return null;
    }

    /**
     * Get addon health status for Home Assistant monitoring
     */
    getAddonHealth() {
        if (!this.isHomeAssistantAddon()) {
            return null;
        }

        // Return basic health information that HA can monitor
        return {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            version: require('../../package.json').version,
            environment: 'homeassistant-addon',
            uptime: process.uptime()
        };
    }

    /**
     * Initialize all HA-specific optimizations
     */
    initialize() {
        if (!this.isHomeAssistantAddon()) {
            this.logger.debug('Not running in Home Assistant addon environment, skipping HA optimizations');
            return {
                isAddon: false,
                optimizationsApplied: []
            };
        }

        const optimizations = [];

        // Apply logging optimizations
        this.optimizeLogging();
        optimizations.push('logging');

        // Set up ingress if available
        const ingressConfig = this.setupIngress();
        if (ingressConfig) {
            optimizations.push('ingress');
        }

        this.logger.info(`Home Assistant optimizations applied: ${optimizations.join(', ')}`);

        return {
            isAddon: true,
            optimizationsApplied: optimizations,
            apiConfig: this.getHAApiConfig(),
            ingressConfig,
            health: this.getAddonHealth()
        };
    }
}

module.exports = HAIntegration;
