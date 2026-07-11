const fs = require('fs');
const { Logger } = require('../logger');
const EnvironmentDetector = require('./EnvironmentDetector');
const { defaultSettings } = require('../defaultSettings');
const { DEFAULT_ADDON_LABEL_FILE, DEFAULT_ADDON_DATA_LABEL_FILE } = require('../constants');
const { isPortInRange, isValidCgateProjectName, isValidCgateUsername, isValidCgatePassword } = require('./validationRules');
const { applyAddonOptionMap } = require('./addonOptionMap');

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
            throw new Error(`Failed to parse addon options: ${error.message}`, { cause: error });
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
                    'Set ALLOW_DEFAULT_FALLBACK=true to continue with defaults.',
                    { cause: error }
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

        applyAddonOptionMap(config, options);

        // mqtt_reject_unauthorized only maps when explicitly false (default stays true)
        if (options.mqtt_reject_unauthorized === false) {
            config.mqttRejectUnauthorized = false;
        }

        // Network auto-discovery setting
        config.autoDiscoverNetworks = options.auto_discover_networks !== undefined
            ? options.auto_discover_networks === true
            : true;

        // Track whether getall_networks and ha_discovery_networks were explicitly configured
        config._getall_networks_explicit = !!(options.getall_networks && Array.isArray(options.getall_networks) && options.getall_networks.length > 0);
        config._ha_discovery_networks_explicit = !!(options.ha_discovery_networks && Array.isArray(options.ha_discovery_networks) && options.ha_discovery_networks.length > 0);

        // C-Bus monitoring settings
        if (options.getall_networks && Array.isArray(options.getall_networks) && options.getall_networks.length > 0) {
            config.getallnetapp = `${options.getall_networks[0]}/56`;
            config.getall_networks = options.getall_networks;
        }

        if (Array.isArray(options.getall_app_periods) && options.getall_app_periods.length > 0) {
            // HA addon format: [{app_id: "56", period_sec: 3600}, ...]
            const periods = {};
            for (const entry of options.getall_app_periods) {
                if (entry.app_id !== null && entry.app_id !== undefined && entry.period_sec !== null && entry.period_sec !== undefined) {
                    periods[String(entry.app_id)] = entry.period_sec;
                }
            }
            config.getall_app_periods = periods;
        } else if (options.getall_app_periods && typeof options.getall_app_periods === 'object' && !Array.isArray(options.getall_app_periods)) {
            // standalone settings.js format: {"56": 3600, ...}
            const periods = {};
            for (const [key, value] of Object.entries(options.getall_app_periods)) {
                periods[String(key)] = value;
            }
            config.getall_app_periods = periods;
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

            applyAddonOptionMap(config, options, { haDiscovery: true });

            if (options.ha_discovery_scene_enabled !== undefined && options.ha_discovery_scene_enabled !== null) {
                config.ha_discovery_scene_enabled = options.ha_discovery_scene_enabled !== false;
            }

            if (Array.isArray(options.ha_discovery_auto_type_cover_keywords) && options.ha_discovery_auto_type_cover_keywords.length > 0) {
                config.ha_discovery_auto_type_cover_keywords = options.ha_discovery_auto_type_cover_keywords
                    .filter((k) => typeof k === 'string' && k.trim() !== '');
            }
        }

        // keep_alive sets both command-pool and event-connection intervals
        if (options.connection_keep_alive_interval_sec !== undefined) {
            config.keepAliveInterval = options.connection_keep_alive_interval_sec * 1000;
            config.eventConnectionKeepAliveInterval = options.connection_keep_alive_interval_sec * 1000;
        }

        // Fresh installs must default to a writable path so the first Import
        // creates the file rather than erroring (GitHub #3). /share is excluded —
        // mounted read-only in the add-on.
        if (options.cbus_label_file) {
            config.cbus_label_file = options.cbus_label_file;
        } else {
            const autoDetectPaths = [DEFAULT_ADDON_LABEL_FILE, DEFAULT_ADDON_DATA_LABEL_FILE];
            for (const p of autoDetectPaths) {
                if (fs.existsSync(p)) {
                    config.cbus_label_file = p;
                    this.logger.info(`Auto-detected label file: ${p}`);
                    break;
                }
            }
            if (!config.cbus_label_file) {
                config.cbus_label_file = DEFAULT_ADDON_LABEL_FILE;
                this.logger.info(`Using default label file path: ${DEFAULT_ADDON_LABEL_FILE} (will be created on first save)`);
            }
        }

        // In addon mode the HA ingress proxy connects from outside the container's
        // loopback interface, so the web server must bind to all interfaces.
        config.web_bind_host = '0.0.0.0';
        if (Array.isArray(options.web_allowed_origins)) {
            config.web_allowed_origins = options.web_allowed_origins.filter((origin) => typeof origin === 'string' && origin.trim() !== '');
        }

        return config;
    }

    /**
     * Convert settings.js exports to standardized format
     * @private
     */
    _convertSettingsToStandardFormat(settings) {
        const config = { ...settings };

        // Warn about unrecognized settings keys (likely typos)
        const knownKeys = new Set(Object.keys(defaultSettings));
        // Also accept keys that are set internally or by ConfigLoader, plus the
        // legacy snake_case alias for network auto-discovery.
        const internalKeys = new Set(['_environment', 'autoDiscoverNetworks', 'auto_discover_networks', 'cgate_mode', 'cgate_install_source']);
        for (const key of Object.keys(config)) {
            if (!knownKeys.has(key) && !internalKeys.has(key)) {
                this.logger.warn(`Unknown setting "${key}" in settings.js — check for typos. This key will be ignored by defaults.`);
            }
        }

        // Bridge the legacy snake_case `auto_discover_networks` to the camelCase
        // key the runtime reads, so standalone configs using either form work.
        if (config.auto_discover_networks !== undefined && config.autoDiscoverNetworks === undefined) {
            config.autoDiscoverNetworks = config.auto_discover_networks === true
                || config.auto_discover_networks === 'true';
        }
        delete config.auto_discover_networks;

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

        if (typeof config.eventPublishCoalesce === 'string') {
            config.eventPublishCoalesce = config.eventPublishCoalesce.toLowerCase() === 'true';
        }

        // Coerce here too: this guards live HVAC writes, so a string like "false"
        // (e.g. from an env var) must not stay truthy and silently enable control.
        if (typeof config.cbus_aircon_control_enabled === 'string') {
            config.cbus_aircon_control_enabled = config.cbus_aircon_control_enabled.toLowerCase() === 'true';
        }

        return config;
    }

    /**
     * Get default configuration
     * @private
     */
    _getDefaultConfig() {
        const { defaultSettings } = require('../defaultSettings');
        return {
            ...defaultSettings,
            cbusip: '127.0.0.1',
            cbuscommandport: 20023,
            cbuseventport: 20025,
            cbusname: 'HOME',
            mqtt: '127.0.0.1:1883',
            messageinterval: 200,
            logging: false,
            ha_discovery_enabled: false,
            ha_discovery_prefix: 'homeassistant',
            web_bind_host: '127.0.0.1',
            web_allow_unauthenticated_mutations: false,
            _environment: {
                type: 'default',
                loadedAt: new Date().toISOString()
            }
        };
    }

    /**
     * Get a safe default configuration for startup fallback.
     * @returns {Object} Default configuration object
     */
    getDefaultConfig() {
        return this._getDefaultConfig();
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
        } else if (!isValidCgateProjectName(configToValidate.cbusname)) {
            errors.push('C-Gate project name (cbusname) must be 1-32 characters of letters, digits, or underscore');
        }

        const hasCgateUser = configToValidate.cgateusername
            && typeof configToValidate.cgateusername === 'string'
            && configToValidate.cgateusername.trim() !== '';
        if (hasCgateUser) {
            if (!isValidCgateUsername(configToValidate.cgateusername.trim())) {
                errors.push('C-Gate username (cgateusername) must be 1-32 characters of letters, digits, or underscore');
            }
            if (!isValidCgatePassword(configToValidate.cgatepassword)) {
                errors.push('C-Gate password (cgatepassword) must be 1-64 printable ASCII characters with no spaces or control characters');
            }
        }

        if (configToValidate.cbuscommandport && (typeof configToValidate.cbuscommandport === 'number') && !isPortInRange(configToValidate.cbuscommandport)) {
            errors.push('C-Gate command port must be between 1 and 65535');
        }

        if (configToValidate.cbuseventport && (typeof configToValidate.cbuseventport === 'number') && !isPortInRange(configToValidate.cbuseventport)) {
            errors.push('C-Gate event port must be between 1 and 65535');
        }

        if (configToValidate.messageinterval && (configToValidate.messageinterval < 10 || configToValidate.messageinterval > 10000)) {
            warnings.push('Message interval should be between 10 and 10000 milliseconds');
        }

        if (configToValidate.commandMinIntervalMs && (configToValidate.commandMinIntervalMs < 1 || configToValidate.commandMinIntervalMs > 1000)) {
            warnings.push('commandMinIntervalMs should be between 1 and 1000 milliseconds');
        }

        if (configToValidate.eventPublishDedupWindowMs && (configToValidate.eventPublishDedupWindowMs < 0 || configToValidate.eventPublishDedupWindowMs > 60000)) {
            warnings.push('eventPublishDedupWindowMs should be between 0 and 60000 milliseconds');
        }

        if (configToValidate.eventPublishDedupMaxEntries && configToValidate.eventPublishDedupMaxEntries < 100) {
            warnings.push('eventPublishDedupMaxEntries should be at least 100');
        }

        if (configToValidate.topicCacheMaxEntries && configToValidate.topicCacheMaxEntries < 100) {
            warnings.push('topicCacheMaxEntries should be at least 100');
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
