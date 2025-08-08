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

        // Check required string settings with helpful error messages
        for (const setting of requiredStringSettings) {
            if (!settings[setting] || typeof settings[setting] !== 'string') {
                const suggestions = this._getSuggestion(setting);
                errors.push(`'${setting}' must be a non-empty string${suggestions ? '. ' + suggestions : ''}`);
            }
        }

        // Check required number settings with helpful error messages
        for (const setting of requiredNumberSettings) {
            if (typeof settings[setting] !== 'number' || settings[setting] <= 0) {
                const suggestions = this._getSuggestion(setting);
                errors.push(`'${setting}' must be a positive number${suggestions ? '. ' + suggestions : ''}`);
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

    /**
     * Get helpful suggestions for common configuration errors
     * @private
     */
    _getSuggestion(setting) {
        const suggestions = {
            'mqtt': 'Example: "localhost:1883" or "mqtt.home.local:1883"',
            'cbusip': 'The IP address of your C-Gate server, e.g., "192.168.1.100"',
            'cbusname': 'The name of your C-Bus project as configured in C-Gate',
            'cbuscommandport': 'Default is 20023 for C-Gate command interface',
            'cbuseventport': 'Default is 20025 for C-Gate event interface',
            'messageinterval': 'Recommended value is 200ms to avoid overwhelming C-Gate'
        };
        return suggestions[setting] || null;
    }

    /**
     * Validate and provide configuration setup guidance
     */
    validateSetup(settings) {
        const issues = [];
        const recommendations = [];

        // Check if this looks like a first-time setup
        if (!settings || Object.keys(settings).length === 0) {
            return {
                isFirstTime: true,
                message: 'No configuration found. Run "npm run setup" to create settings.js from template.'
            };
        }

        // Check for common misconfigurations
        if (settings.cbusip === 'your-cgate-ip') {
            recommendations.push('Update cbusip to match your actual C-Gate server IP address');
        }

        if (settings.mqtt === 'localhost:1883' && process.env.NODE_ENV === 'production') {
            recommendations.push('Consider updating MQTT broker address for production deployment');
        }

        if (settings.cbusname === 'CLIPSAL') {
            recommendations.push('Update cbusname to match your actual C-Bus project name');
        }

        // Check for development vs production settings
        if (process.env.NODE_ENV === 'production') {
            if (!settings.mqttusername || !settings.mqttpassword) {
                issues.push('MQTT authentication is recommended for production environments');
            }
        }

        return {
            isFirstTime: false,
            issues,
            recommendations,
            isValid: issues.length === 0
        };
    }
}

// Create default validator instance
const defaultValidator = new SettingsValidator();

module.exports = {
    SettingsValidator,
    validate: (settings) => defaultValidator.validate(settings),
    validateWithWarnings: (settings) => defaultValidator.validateWithWarnings(settings),
    validateSetup: (settings) => defaultValidator.validateSetup(settings),
    createValidator: (options) => new SettingsValidator(options)
};