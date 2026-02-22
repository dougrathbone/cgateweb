const mqtt = require('mqtt');
const { EventEmitter } = require('events');
const { createLogger } = require('./logger');
const { createErrorHandler } = require('./errorHandler');
const { 
    MQTT_TOPIC_PREFIX_WRITE,
    MQTT_TOPIC_STATUS,
    MQTT_PAYLOAD_STATUS_ONLINE,
    MQTT_PAYLOAD_STATUS_OFFLINE,
    MQTT_ERROR_AUTH
} = require('./constants');

/**
 * Manages MQTT broker connection and message handling for the C-Bus bridge.
 * 
 * This class provides a high-level interface for MQTT operations including:
 * - Connection management with automatic reconnection
 * - Message publishing and subscription
 * - Status publishing for Home Assistant integration
 * - Error handling and logging
 * 
 * @extends EventEmitter
 * @emits 'connected' - When successfully connected to MQTT broker
 * @emits 'disconnected' - When disconnected from MQTT broker
 * @emits 'message' - When a message is received from subscribed topics
 * @emits 'error' - When MQTT errors occur
 */
class MqttManager extends EventEmitter {
    /**
     * Creates a new MQTT manager instance.
     * 
     * @param {Object} settings - Configuration settings
     * @param {string} settings.mqtt - MQTT broker URL (e.g., 'mqtt://localhost:1883')
     * @param {string} [settings.mqttusername] - MQTT username for authentication
     * @param {string} [settings.mqttpassword] - MQTT password for authentication
     */
    constructor(settings) {
        super();
        this.settings = settings;
        this.client = null;
        this.connected = false;
        this._intentionalDisconnect = false;
        this.logger = createLogger({ component: 'MqttManager' });
        this.errorHandler = createErrorHandler('MqttManager');
    }

    /**
     * Connects to the MQTT broker.
     * 
     * Establishes connection with the configured MQTT broker using the settings
     * provided during construction. If a client already exists, it will be
     * disconnected first.
     * 
     * @throws {Error} When connection fails or broker is unreachable
     */
    connect() {
        if (this.client) {
            this.logger.info(`MQTT client already exists. Disconnecting first.`);
            this.disconnect();
        }

        this._intentionalDisconnect = false;

        const mqttUrl = this._buildMqttUrl();
        const connectOptions = this._buildConnectOptions();

        this.logger.info(`Connecting to MQTT Broker: ${mqttUrl}`);
        
        this.client = mqtt.connect(mqttUrl, connectOptions);
        
        this.client.on('connect', () => this._handleConnect());
        this.client.on('close', () => this._handleClose());
        this.client.on('error', (err) => this._handleError(err));
        this.client.on('message', (topic, message) => this._handleMessage(topic, message));
        
        return this;
    }

    disconnect() {
        this._intentionalDisconnect = true;
        if (this.client) {
            if (this.connected) {
                try {
                    this.client.publish(MQTT_TOPIC_STATUS, MQTT_PAYLOAD_STATUS_OFFLINE, { retain: true, qos: 1 });
                } catch (_e) {
                    // Best effort - don't block shutdown if publish fails
                }
            }
            this.client.removeAllListeners();
            this.client.end();
            this.client = null;
        }
        this.connected = false;
    }

    /**
     * Publishes a message to an MQTT topic.
     * 
     * @param {string} topic - The MQTT topic to publish to
     * @param {string} payload - The message payload to publish
     * @param {Object} [options={}] - MQTT publish options (qos, retain, etc.)
     * @param {number} [options.qos=0] - Quality of Service level (0, 1, or 2)
     * @param {boolean} [options.retain=false] - Whether to retain the message
     * @returns {boolean} True if publish succeeded, false otherwise
     */
    publish(topic, payload, options = {}) {
        if (!this.client || !this.connected) {
            this.logger.warn(`Cannot publish to MQTT: not connected`);
            return false;
        }

        try {
            this.client.publish(topic, payload, options);
            return true;
        } catch (error) {
            this.logger.error(`Error publishing to MQTT:`, { error });
            return false;
        }
    }

    subscribe(topic, callback) {
        if (!this.client || !this.connected) {
            this.logger.warn(`Cannot subscribe to MQTT: not connected`);
            return false;
        }

        this.client.subscribe(topic, callback);
        return true;
    }

    _buildMqttUrl() {
        const raw = this.settings.mqtt || 'localhost:1883';
        
        // If URL already has a protocol, use it directly
        if (/^mqtts?:\/\//.test(raw)) {
            return raw;
        }
        
        // Parse "host:port" format and add appropriate protocol
        const mqttParts = raw.split(':');
        const mqttHost = mqttParts[0] || 'localhost';
        const mqttPort = mqttParts[1] || '1883';
        const protocol = this.settings.mqttUseTls ? 'mqtts' : 'mqtt';
        return `${protocol}://${mqttHost}:${mqttPort}`;
    }

    _buildConnectOptions() {
        const options = {
            reconnectPeriod: 5000,
            connectTimeout: 30000,
            will: {
                topic: MQTT_TOPIC_STATUS,
                payload: MQTT_PAYLOAD_STATUS_OFFLINE,
                qos: 1,
                retain: true
            }
        };

        if (this.settings.mqttusername && typeof this.settings.mqttusername === 'string') {
            options.username = this.settings.mqttusername;
            
            if (this.settings.mqttpassword && typeof this.settings.mqttpassword === 'string') {
                options.password = this.settings.mqttpassword;
            }
        }

        // TLS options for mqtts:// connections
        if (this.settings.mqttCaFile || this.settings.mqttCertFile || this.settings.mqttKeyFile) {
            const fs = require('fs');
            if (this.settings.mqttCaFile) {
                options.ca = fs.readFileSync(this.settings.mqttCaFile);
            }
            if (this.settings.mqttCertFile) {
                options.cert = fs.readFileSync(this.settings.mqttCertFile);
            }
            if (this.settings.mqttKeyFile) {
                options.key = fs.readFileSync(this.settings.mqttKeyFile);
            }
        }

        if (this.settings.mqttRejectUnauthorized === false) {
            options.rejectUnauthorized = false;
        }

        return options;
    }

    _handleConnect() {
        this.connected = true;
        this.logger.info(`CONNECTED TO MQTT BROKER: ${this.settings.mqtt}`);
        
        // Publish online status
        this.publish(MQTT_TOPIC_STATUS, MQTT_PAYLOAD_STATUS_ONLINE, { retain: true, qos: 1 });
        
        // Subscribe to command topics
        this.subscribe(`${MQTT_TOPIC_PREFIX_WRITE}/#`, (err) => {
            if (err) {
                this.logger.error(`MQTT Subscription error:`, { error: err });
            } else {
                this.logger.info(`Subscribed to MQTT topic: ${MQTT_TOPIC_PREFIX_WRITE}/#`);
            }
        });
        
        this.emit('connect');
    }

    _handleClose() {
        this.connected = false;
        
        if (this._intentionalDisconnect) {
            this.logger.info('MQTT Client closed (intentional disconnect).');
        } else {
            this.logger.warn('MQTT Client closed. Library will attempt reconnection.');
        }
        
        this.emit('close');
    }

    _handleError(err) {
        this.connected = false;
        
        if (err.code === MQTT_ERROR_AUTH) {
            const brokerUrl = this.settings.mqtt || '(not configured)';
            const hasUsername = !!this.settings.mqttusername;
            const isAddon = !!process.env.SUPERVISOR_TOKEN;

            this.logger.error('');
            this.logger.error('==========================================================');
            this.logger.error('  MQTT AUTHENTICATION FAILED');
            this.logger.error('==========================================================');
            this.logger.error(`  Broker: ${brokerUrl}`);
            this.logger.error(`  Username provided: ${hasUsername ? 'yes' : 'NO'}`);
            this.logger.error('');
            if (!hasUsername) {
                this.logger.error('  No MQTT credentials were configured.');
                if (isAddon) {
                    this.logger.error('  To fix this in Home Assistant:');
                    this.logger.error('    1. Go to Settings > Add-ons > C-Gate Web Bridge > Configuration');
                    this.logger.error('    2. Set mqtt_username and mqtt_password');
                    this.logger.error('    3. Use the same credentials as your Mosquitto broker addon');
                    this.logger.error('    4. Restart the C-Gate Web Bridge addon');
                } else {
                    this.logger.error('  To fix this:');
                    this.logger.error('    1. Edit your settings.js file');
                    this.logger.error('    2. Set exports.mqttusername and exports.mqttpassword');
                    this.logger.error('    3. Restart cgateweb');
                }
            } else {
                this.logger.error('  Credentials were provided but the broker rejected them.');
                this.logger.error('  Check that the username and password are correct.');
            }
            this.logger.error('==========================================================');
            this.logger.error('');

            this.errorHandler.handle(err, {
                brokerUrl,
                hasUsername
            }, 'MQTT authentication', true); // Fatal error
        } else {
            this.errorHandler.handle(err, {
                brokerUrl: this.settings.mqtt,
                connected: this.connected,
                errorCode: err.code
            }, 'MQTT connection');
        }
        
        this.emit('error', err);
    }

    _handleMessage(topic, message) {
        const payload = message.toString();
        this.emit('message', topic, payload);
    }

    // Logging methods that can be overridden
}

module.exports = MqttManager;