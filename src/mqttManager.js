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
        if (this.client) {
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
        // Parse MQTT connection string (format: "host:port" or "host")  
        const mqttParts = this.settings.mqtt.split(':');
        const mqttHost = mqttParts[0] || 'localhost';
        const mqttPort = mqttParts[1] || '1883';
        return `mqtt://${mqttHost}:${mqttPort}`;
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

        // Add authentication if provided
        if (this.settings.mqttusername && typeof this.settings.mqttusername === 'string') {
            options.username = this.settings.mqttusername;
            
            if (this.settings.mqttpassword && typeof this.settings.mqttpassword === 'string') {
                options.password = this.settings.mqttpassword;
            }
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
        this.logger.debug('MQTT Close event received', { arguments });
        this.logger.warn(`MQTT Client Closed. Reconnection handled by library.`);
        
        if (this.client) {
            this.client.removeAllListeners(); 
            this.client = null;
        }
        
        this.emit('close');
    }

    _handleError(err) {
        this.connected = false; // Assume disconnected on error
        
        // Handle specific authentication error as fatal
        if (err.code === MQTT_ERROR_AUTH) {
            this.errorHandler.handle(err, {
                brokerUrl: this.settings.mqtt,
                hasUsername: !!this.settings.mqttusername
            }, 'MQTT authentication', true); // Fatal error
        } else {
            // Handle generic connection errors with context
            this.errorHandler.handle(err, {
                brokerUrl: this.settings.mqtt,
                connected: this.connected,
                errorCode: err.code
            }, 'MQTT connection');
        }
        
        // Clean up client
        if (this.client) {
            this.client.removeAllListeners();
            this.client = null;
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