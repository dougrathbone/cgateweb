// @ts-check
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
        const hasDataDir = fs.existsSync('/data');
        const hasOptionsFile = fs.existsSync('/data/options.json');

        this._isAddon = hasHAToken && hasDataDir && hasOptionsFile;
        
        if (this._isAddon) {
            this.logger.info('Detected Home Assistant addon environment');
        }

        return this._isAddon;
    }

    /**
     * Optimize logging for Home Assistant addon environment
     */
    optimizeLogging() {
        if (!this.isHomeAssistantAddon()) {
            return;
        }

        // Home Assistant timestamps every line itself, so a timestamp we
        // print is a duplicate one the user has to read past. Strip a leading
        // ISO timestamp from anything that goes to the console.
        //
        // Four identical wrappers, one per level, is what this was; the only
        // thing that varied was which original function to call.
        const ISO_TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\s+/;
        for (const level of ['log', 'warn', 'error', 'debug']) {
            const original = console[level];
            console[level] = (...args) => original(args.join(' ').replace(ISO_TIMESTAMP_PREFIX, ''));
        }

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
            // Do not log INGRESS_URL / INGRESS_ENTRY — both embed the HA ingress
            // session token in the path and would leak into Supervisor logs.
            this.logger.info('Ingress support enabled');
            
            return {
                ingressUrl,
                ingressEntry,
                basePath: ingressEntry || '/'
            };
        }

        return null;
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
            ingressConfig
        };
    }
}

module.exports = HAIntegration;
