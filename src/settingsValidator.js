const { createLogger } = require('./logger');

/**
 * Centralized settings validation utility for cgateweb
 */
class SettingsValidator {
    constructor(options = {}) {
        this.logger = createLogger({ component: 'SettingsValidator' });
        this.exitOnError = options.exitOnError !== false; // Default to true
    }

    /**
     * Validate core required settings
     * @param {Object} settings - Settings object to validate
     * @returns {boolean} - True if all validations pass
     */
    validate(settings) {
        const errors = [];
        
        // Required string settings
        const requiredStringSettings = [
            'mqtt', 'cbusname', 'cbusip'
        ];
        
        // Required number settings
        const requiredNumberSettings = [
            'cbuscommandport', 'cbuseventport', 'messageinterval'
        ];

        // Check required string settings
        for (const setting of requiredStringSettings) {
            if (!settings[setting] || typeof settings[setting] !== 'string') {
                errors.push(`'${setting}' must be a non-empty string`);
            }
        }

        // Check required number settings
        for (const setting of requiredNumberSettings) {
            if (typeof settings[setting] !== 'number' || settings[setting] <= 0) {
                errors.push(`'${setting}' must be a positive number`);
            }
        }

        // Additional specific validations
        this._validateMqttSetting(settings, errors);
        this._validatePortSettings(settings, errors);
        this._validateHomeAssistantSettings(settings, errors);

        // Handle validation results
        if (errors.length > 0) {
            this.logger.error('Invalid configuration detected:');
            errors.forEach(error => this.logger.error(`  - ${error}`));
            
            if (this.exitOnError) {
                process.exit(1);
            }
            return false;
        }

        this.logger.info('Settings validation passed');
        return true;
    }

    /**
     * Validate MQTT-specific settings
     * @private
     */
    _validateMqttSetting(settings, errors) {
        if (settings.mqtt === null || settings.mqtt === undefined) {
            errors.push('MQTT broker address is required');
            return;
        }

        // Check MQTT format (should be host:port or mqtt://host:port)
        if (typeof settings.mqtt === 'string') {
            const mqttPattern = /^(mqtt:\/\/)?[\w.-]+:\d+$/;
            if (!mqttPattern.test(settings.mqtt)) {
                errors.push('MQTT broker address should be in format "host:port" or "mqtt://host:port"');
            }
        }
    }

    /**
     * Validate port settings
     * @private
     */
    _validatePortSettings(settings, errors) {
        const ports = ['cbuscommandport', 'cbuseventport'];
        
        for (const portSetting of ports) {
            const port = settings[portSetting];
            if (typeof port === 'number' && (port < 1 || port > 65535)) {
                errors.push(`${portSetting} must be between 1 and 65535`);
            }
        }

        // Check for port conflicts
        if (settings.cbuscommandport === settings.cbuseventport) {
            errors.push('C-Gate command port and event port cannot be the same');
        }
    }

    /**
     * Validate Home Assistant discovery settings
     * @private
     */
    _validateHomeAssistantSettings(settings, errors) {
        if (settings.ha_discovery_enabled) {
            if (!settings.ha_discovery_prefix || typeof settings.ha_discovery_prefix !== 'string') {
                errors.push('ha_discovery_prefix must be a non-empty string when HA discovery is enabled');
            }

            if (settings.ha_discovery_networks && !Array.isArray(settings.ha_discovery_networks)) {
                errors.push('ha_discovery_networks must be an array when specified');
            }
        }
    }

    /**
     * Validate settings with warnings for optional but recommended settings
     * @param {Object} settings - Settings to validate
     */
    validateWithWarnings(settings) {
        const isValid = this.validate(settings);
        
        // Check for recommended settings
        this._checkRecommendedSettings(settings);
        
        return isValid;
    }

    /**
     * Check for recommended but optional settings
     * @private
     */
    _checkRecommendedSettings(settings) {
        // Warn about authentication
        if (!settings.cgateusername && !settings.cgatepassword) {
            this.logger.warn('C-Gate authentication not configured - this may be required for some installations');
        }
        
        if (!settings.mqttusername && !settings.mqttpassword) {
            this.logger.warn('MQTT authentication not configured - ensure your MQTT broker allows anonymous connections');
        }

        // Warn about getall settings
        if (!settings.getallnetapp) {
            this.logger.warn('getallnetapp not configured - device state synchronization will be limited');
        }

        // Warn about Home Assistant discovery
        if (!settings.ha_discovery_enabled) {
            this.logger.info('Home Assistant discovery is disabled - devices will need manual configuration');
        }
    }
}

// Create default validator instance
const defaultValidator = new SettingsValidator();

module.exports = {
    SettingsValidator,
    validate: (settings) => defaultValidator.validate(settings),
    validateWithWarnings: (settings) => defaultValidator.validateWithWarnings(settings),
    createValidator: (options) => new SettingsValidator(options)
};