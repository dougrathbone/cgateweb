const fs = require('fs');
const path = require('path');
const { Logger } = require('../logger');
const EnvironmentDetector = require('./EnvironmentDetector');

const DEFAULT_MQTT_VALUES = ['core-mosquitto:1883', '127.0.0.1:1883', undefined, null, ''];

/**
 * Loads configuration from either settings.js (standalone) or 
 * Home Assistant addon options (/data/options.json)
 */
class ConfigLoader {
    constructor(options = {}) {
        this.logger = new Logger({ component: 'ConfigLoader' });
        this.environmentDetector = options.environmentDetector || new EnvironmentDetector();
        this._cachedConfig = null;
        this._httpGet = options.httpGet || null;
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

        const config = this._convertAddonOptionsToSettings(addonOptions);
        
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
            delete require.cache[require.resolve(settingsPath)];
            
            const settings = require(settingsPath);
            this.logger.debug('Loaded settings from:', settingsPath);
            
            const config = this._convertSettingsToStandardFormat(settings);
            
            config._environment = {
                type: 'standalone',
                settingsPath,
                loadedAt: new Date().toISOString()
            };

            return config;
        } catch (error) {
            this.logger.error('Failed to load settings.js:', error.message);
            const allowFallback = String(process.env.ALLOW_DEFAULT_FALLBACK || '').toLowerCase() === 'true';
            if (!allowFallback) {
                throw new Error(
                    `Failed to load standalone settings from ${settingsPath}: ${error.message}. ` +
                    'Set ALLOW_DEFAULT_FALLBACK=true to continue with defaults.'
                );
            }
            this.logger.warn('ALLOW_DEFAULT_FALLBACK=true set; falling back to default configuration');
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

        // C-Gate mode
        config.cgate_mode = options.cgate_mode || 'remote';

        // C-Gate connection settings
        if (config.cgate_mode === 'managed') {
            config.cbusip = '127.0.0.1';
        } else {
            if (!options.cgate_host) {
                throw new Error(
                    'C-Gate host address is required when running in remote mode. ' +
                    'Please set \'cgate_host\' in the addon configuration to the IP address ' +
                    'of your C-Gate server (e.g., "192.168.1.100").'
                );
            }
            config.cbusip = options.cgate_host;
        }
        config.cbuscommandport = options.cgate_port || 20023;
        config.cbuseventport = options.cgate_event_port || 20025;
        config.cbusname = options.cgate_project || 'HOME';

        // C-Gate managed mode settings
        if (config.cgate_mode === 'managed') {
            config.cgate_install_source = options.cgate_install_source || 'download';
            config.cgate_download_url = options.cgate_download_url || '';
        }

        // MQTT settings
        config.mqtt = `${options.mqtt_host || 'core-mosquitto'}:${options.mqtt_port || 1883}`;

        if (options.mqtt_username) {
            config.mqttusername = options.mqtt_username;
        }
        if (options.mqtt_password) {
            config.mqttpassword = options.mqtt_password;
        }

        // C-Bus monitoring settings
        if (options.getall_networks && Array.isArray(options.getall_networks) && options.getall_networks.length > 0) {
            config.getallnetapp = `${options.getall_networks[0]}/56`;
        }

        if (options.getall_on_start) {
            config.getallonstart = true;
        }

        if (options.getall_period) {
            config.getallperiod = options.getall_period;
        }

        if (options.retain_reads) {
            config.retainreads = true;
        }

        config.messageinterval = options.message_interval || 200;

        const validLevels = ['error', 'warn', 'info', 'debug', 'trace'];
        config.log_level = validLevels.includes(options.log_level) ? options.log_level : 'info';
        config.logging = config.log_level === 'info' || config.log_level === 'debug' || config.log_level === 'trace';

        // Home Assistant Discovery settings
        if (options.ha_discovery_enabled) {
            config.ha_discovery_enabled = true;
            config.ha_discovery_prefix = options.ha_discovery_prefix || 'homeassistant';
            
            if (options.ha_discovery_networks && Array.isArray(options.ha_discovery_networks) && options.ha_discovery_networks.length > 0) {
                config.ha_discovery_networks = options.ha_discovery_networks;
            } else if (options.getall_networks && Array.isArray(options.getall_networks) && options.getall_networks.length > 0) {
                config.ha_discovery_networks = [...options.getall_networks];
            }
            
            if (options.ha_discovery_cover_app_id) {
                config.ha_discovery_cover_app_id = String(options.ha_discovery_cover_app_id);
            }
            
            if (options.ha_discovery_switch_app_id) {
                config.ha_discovery_switch_app_id = String(options.ha_discovery_switch_app_id);
            }
        }

        // Label file: use explicit setting, or auto-detect from common addon paths
        if (options.cbus_label_file) {
            config.cbus_label_file = options.cbus_label_file;
        } else {
            const autoDetectPaths = ['/config/cgateweb-labels.json', '/share/cgate/labels.json', '/data/labels.json'];
            for (const p of autoDetectPaths) {
                if (fs.existsSync(p)) {
                    config.cbus_label_file = p;
                    this.logger.info(`Auto-detected label file: ${p}`);
                    break;
                }
            }
        }

        if (options.web_port) {
            config.web_port = options.web_port;
        }
        if (options.web_api_key) {
            config.web_api_key = options.web_api_key;
        }

        return config;
    }

    /**
     * Convert settings.js exports to standardized format
     * @private
     */
    _convertSettingsToStandardFormat(settings) {
        const config = { ...settings };
        
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
            cbuscommandport: 20023,
            cbuseventport: 20025,
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
     * Apply auto-detected MQTT config to the loaded settings.
     * Only fills in host/credentials when not explicitly configured.
     * @param {Object} settings - The settings object to augment
     * @returns {Object} settings with MQTT fields populated (mutated in place)
     */
    async applyMqttAutoDetection(settings) {
        const mqttConfig = await this.detectMqttConfig();
        if (!mqttConfig) {
            const hasDefaultBroker = DEFAULT_MQTT_VALUES.includes(settings.mqtt);
            const missingCredentials = !settings.mqttusername || !settings.mqttpassword;
            if (hasDefaultBroker && missingCredentials) {
                this.logger.warn(
                    'MQTT auto-detection from Supervisor API failed and no MQTT credentials are configured. ' +
                    `MQTT broker "${settings.mqtt || '(not set)'}" may require authentication. ` +
                    'Set mqtt_username/mqtt_password in addon options if connection fails.'
                );
            }
            return settings;
        }

        if (!settings.mqttusername && mqttConfig.username) {
            settings.mqttusername = mqttConfig.username;
            this.logger.info('Applied auto-detected MQTT username');
        }
        if (!settings.mqttpassword && mqttConfig.password) {
            settings.mqttpassword = mqttConfig.password;
            this.logger.info('Applied auto-detected MQTT password');
        }
        if (DEFAULT_MQTT_VALUES.includes(settings.mqtt)) {
            const detectedMqtt = `${mqttConfig.host}:${mqttConfig.port}`;
            settings.mqtt = detectedMqtt;
            this.logger.info(`Applied auto-detected MQTT broker: ${detectedMqtt}`);
        }

        return settings;
    }

    /**
     * Attempt to auto-detect MQTT credentials from HA Supervisor API.
     * Returns null if not available or if detection fails.
     */
    async detectMqttConfig() {
        const supervisorToken = process.env.SUPERVISOR_TOKEN;
        if (!supervisorToken) {
            return null;
        }

        try {
            const http = this._httpGet || require('http');
            const data = await new Promise((resolve, reject) => {
                const req = http.get('http://supervisor/services/mqtt', {
                    headers: { 'Authorization': `Bearer ${supervisorToken}` }
                }, (res) => {
                    let body = '';
                    res.on('data', chunk => { body += chunk; });
                    res.on('end', () => {
                        if (res.statusCode === 200) {
                            resolve(JSON.parse(body));
                        } else {
                            reject(new Error(`Supervisor API returned ${res.statusCode}`));
                        }
                    });
                });
                req.on('error', reject);
                req.setTimeout(5000, () => { req.destroy(); reject(new Error('Timeout')); });
            });

            if (data && data.data) {
                const mqtt = data.data;
                this.logger.info('Auto-detected MQTT configuration from Supervisor API');
                return {
                    host: mqtt.host || 'core-mosquitto',
                    port: mqtt.port || 1883,
                    username: mqtt.username || null,
                    password: mqtt.password || null,
                    ssl: mqtt.ssl || false
                };
            }
        } catch (error) {
            this.logger.debug('MQTT auto-detection unavailable:', error.message);
        }

        return null;
    }

    /**
     * Validate configuration
     */
    validate(config = null) {
        const configToValidate = config || this._cachedConfig || this.load();
        const errors = [];
        const warnings = [];

        const placeholderValues = ['your-cgate-ip', 'your.cgate.ip', 'x.x.x.x'];
        if (!configToValidate.cbusip || placeholderValues.includes(configToValidate.cbusip)) {
            errors.push('C-Gate IP address (cbusip) is required');
        }

        if (!configToValidate.mqtt) {
            errors.push('MQTT broker address (mqtt) is required');
        }

        if (!configToValidate.cbusname) {
            warnings.push('C-Gate project name (cbusname) not specified, using default');
        }

        if (configToValidate.cbuscommandport && (typeof configToValidate.cbuscommandport === 'number') && (configToValidate.cbuscommandport < 1 || configToValidate.cbuscommandport > 65535)) {
            errors.push('C-Gate command port must be between 1 and 65535');
        }

        if (configToValidate.cbuseventport && (typeof configToValidate.cbuseventport === 'number') && (configToValidate.cbuseventport < 1 || configToValidate.cbuseventport > 65535)) {
            errors.push('C-Gate event port must be between 1 and 65535');
        }

        if (configToValidate.messageinterval && (configToValidate.messageinterval < 10 || configToValidate.messageinterval > 10000)) {
            warnings.push('Message interval should be between 10 and 10000 milliseconds');
        }

        // Validate C-Gate mode settings
        if (configToValidate.cgate_mode === 'managed') {
            if (configToValidate.cgate_install_source === 'upload') {
                const sharePath = '/share/cgate';
                if (fs.existsSync(sharePath)) {
                    const files = fs.readdirSync(sharePath).filter(f => f.endsWith('.zip'));
                    if (files.length === 0) {
                        warnings.push('C-Gate mode is "managed" with "upload" source, but no .zip files found in /share/cgate/');
                    }
                }
            }
        }

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
