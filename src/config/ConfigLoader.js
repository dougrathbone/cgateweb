const fs = require('fs');
const path = require('path');
const { Logger } = require('../logger');
const EnvironmentDetector = require('./EnvironmentDetector');

/**
 * Loads configuration from either settings.js (standalone) or 
 * Home Assistant addon options (/data/options.json)
 */
class ConfigLoader {
    constructor() {
        this.logger = new Logger('ConfigLoader');
        this.environmentDetector = new EnvironmentDetector();
        this._cachedConfig = null;
    }

    /**
     * Load configuration based on detected environment
     * @param {boolean} forceReload - Force reload of configuration
     * @returns {Object} Configuration object
     */
    load(forceReload = false) {
        if (this._cachedConfig && !forceReload) {
            return this._cachedConfig;
        }

        const envInfo = this.environmentDetector.detect();
        
        this.logger.info(`Loading configuration for ${envInfo.type} environment`);

        if (envInfo.isAddon) {
            this._cachedConfig = this._loadAddonConfig(envInfo);
        } else {
            this._cachedConfig = this._loadStandaloneConfig(envInfo);
        }

        this.logger.debug('Configuration loaded successfully');
        return this._cachedConfig;
    }

    /**
     * Load configuration from Home Assistant addon options
     * @private
     */
    _loadAddonConfig(envInfo) {
        const optionsPath = envInfo.optionsPath;
        
        if (!fs.existsSync(optionsPath)) {
            throw new Error(`Addon options file not found: ${optionsPath}`);
        }

        let addonOptions;
        try {
            const optionsData = fs.readFileSync(optionsPath, 'utf8');
            addonOptions = JSON.parse(optionsData);
            this.logger.debug('Loaded addon options from:', optionsPath);
        } catch (error) {
            throw new Error(`Failed to parse addon options: ${error.message}`);
        }

        // Convert Home Assistant addon options to cgateweb settings format
        const config = this._convertAddonOptionsToSettings(addonOptions);
        
        // Add environment metadata
        config._environment = {
            type: 'addon',
            optionsPath,
            loadedAt: new Date().toISOString()
        };

        return config;
    }

    /**
     * Load configuration from standalone settings.js file
     * @private
     */
    _loadStandaloneConfig(envInfo) {
        const settingsPath = envInfo.settingsPath;
        
        if (!fs.existsSync(settingsPath)) {
            this.logger.warn(`Settings file not found: ${settingsPath}`);
            this.logger.info('Using default configuration');
            return this._getDefaultConfig();
        }

        try {
            // Clear require cache to allow hot reload
            delete require.cache[require.resolve(settingsPath)];
            
            const settings = require(settingsPath);
            this.logger.debug('Loaded settings from:', settingsPath);
            
            // Convert settings.js exports to standardized format
            const config = this._convertSettingsToStandardFormat(settings);
            
            // Add environment metadata
            config._environment = {
                type: 'standalone',
                settingsPath,
                loadedAt: new Date().toISOString()
            };

            return config;
        } catch (error) {
            this.logger.error('Failed to load settings.js:', error.message);
            this.logger.info('Falling back to default configuration');
            const defaultConfig = this._getDefaultConfig();
            defaultConfig._environment.type = 'default';
            return defaultConfig;
        }
    }

    /**
     * Convert Home Assistant addon options to cgateweb settings format
     * @private
     */
    _convertAddonOptionsToSettings(options) {
        const config = {};

        // C-Gate connection settings
        config.cbusip = options.cgate_host || '127.0.0.1';
        config.cbusport = options.cgate_port || 20023;
        config.cbuscontrolport = options.cgate_control_port || 20024;
        config.cbusname = options.cgate_project || 'HOME';

        // MQTT settings
        if (options.mqtt_host && options.mqtt_port) {
            config.mqtt = `${options.mqtt_host}:${options.mqtt_port}`;
        } else {
            config.mqtt = `${options.mqtt_host || '127.0.0.1'}:${options.mqtt_port || 1883}`;
        }

        // MQTT credentials
        if (options.mqtt_username) {
            config.mqttusername = options.mqtt_username;
        }
        if (options.mqtt_password) {
            config.mqttpassword = options.mqtt_password;
        }

        // C-Bus monitoring settings
        if (options.getall_networks && Array.isArray(options.getall_networks) && options.getall_networks.length > 0) {
            // Use first network for getallnetapp format (network/app)
            config.getallnetapp = `${options.getall_networks[0]}/56`;
            
            if (options.getall_on_start) {
                config.getallonstart = true;
            }
            
            if (options.getall_period) {
                config.getallperiod = options.getall_period;
            }
        }

        // MQTT settings
        if (options.retain_reads) {
            config.retainreads = true;
        }

        config.messageinterval = options.message_interval || 200;

        // Logging
        config.logging = options.log_level === 'debug';

        // Home Assistant Discovery settings
        if (options.ha_discovery_enabled) {
            config.ha_discovery_enabled = true;
            config.ha_discovery_prefix = options.ha_discovery_prefix || 'homeassistant';
            
            if (options.ha_discovery_networks && Array.isArray(options.ha_discovery_networks)) {
                config.ha_discovery_networks = options.ha_discovery_networks;
            }
            
            if (options.ha_discovery_cover_app_id) {
                config.ha_discovery_cover_app_id = String(options.ha_discovery_cover_app_id);
            }
            
            if (options.ha_discovery_switch_app_id) {
                config.ha_discovery_switch_app_id = String(options.ha_discovery_switch_app_id);
            }
        }

        return config;
    }

    /**
     * Convert settings.js exports to standardized format
     * @private
     */
    _convertSettingsToStandardFormat(settings) {
        // Settings.js is already in the correct format, just ensure consistency
        const config = { ...settings };
        
        // Ensure boolean values are properly typed
        if (typeof config.getallonstart === 'string') {
            config.getallonstart = config.getallonstart.toLowerCase() === 'true';
        }
        
        if (typeof config.retainreads === 'string') {
            config.retainreads = config.retainreads.toLowerCase() === 'true';
        }
        
        if (typeof config.logging === 'string') {
            config.logging = config.logging.toLowerCase() === 'true';
        }

        if (typeof config.ha_discovery_enabled === 'string') {
            config.ha_discovery_enabled = config.ha_discovery_enabled.toLowerCase() === 'true';
        }

        return config;
    }

    /**
     * Get default configuration
     * @private
     */
    _getDefaultConfig() {
        return {
            cbusip: '127.0.0.1',
            cbusport: 20023,
            cbuscontrolport: 20024,
            cbusname: 'HOME',
            mqtt: '127.0.0.1:1883',
            messageinterval: 200,
            logging: false,
            ha_discovery_enabled: false,
            ha_discovery_prefix: 'homeassistant',
            _environment: {
                type: 'default',
                loadedAt: new Date().toISOString()
            }
        };
    }

    /**
     * Validate configuration
     */
    validate(config = null) {
        const configToValidate = config || this._cachedConfig || this.load();
        const errors = [];
        const warnings = [];

        // Required settings
        if (!configToValidate.cbusip) {
            errors.push('C-Gate IP address (cbusip) is required');
        }

        if (!configToValidate.mqtt) {
            errors.push('MQTT broker address (mqtt) is required');
        }

        if (!configToValidate.cbusname) {
            warnings.push('C-Gate project name (cbusname) not specified, using default');
        }

        // Validate numeric values
        if (configToValidate.cbusport && (typeof configToValidate.cbusport === 'number') && (configToValidate.cbusport < 1 || configToValidate.cbusport > 65535)) {
            errors.push('C-Gate port must be between 1 and 65535');
        }

        if (configToValidate.cbuscontrolport && (typeof configToValidate.cbuscontrolport === 'number') && (configToValidate.cbuscontrolport < 1 || configToValidate.cbuscontrolport > 65535)) {
            errors.push('C-Gate control port must be between 1 and 65535');
        }

        if (configToValidate.messageinterval && (configToValidate.messageinterval < 10 || configToValidate.messageinterval > 10000)) {
            warnings.push('Message interval should be between 10 and 10000 milliseconds');
        }

        // Log validation results
        if (errors.length > 0) {
            this.logger.error('Configuration validation failed:', errors);
            throw new Error(`Configuration validation failed: ${errors.join(', ')}`);
        }

        if (warnings.length > 0) {
            warnings.forEach(warning => this.logger.warn(warning));
        }

        this.logger.info('Configuration validation passed');
        return true;
    }

    /**
     * Get current configuration
     */
    getConfig() {
        return this._cachedConfig || this.load();
    }

    /**
     * Reload configuration
     */
    reload() {
        this.logger.info('Reloading configuration...');
        this._cachedConfig = null;
        this.environmentDetector.reset();
        return this.load(true);
    }

    /**
     * Get environment information
     */
    getEnvironment() {
        return this.environmentDetector.getEnvironmentInfo();
    }
}

module.exports = ConfigLoader;
