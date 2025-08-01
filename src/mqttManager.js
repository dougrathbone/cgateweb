const mqtt = require('mqtt');
const { EventEmitter } = require('events');
const { 
    LOG_PREFIX, 
    WARN_PREFIX, 
    ERROR_PREFIX, 
    MQTT_TOPIC_PREFIX_WRITE,
    MQTT_TOPIC_STATUS,
    MQTT_PAYLOAD_STATUS_ONLINE,
    MQTT_PAYLOAD_STATUS_OFFLINE,
    MQTT_ERROR_AUTH
} = require('./constants');

class MqttManager extends EventEmitter {
    constructor(settings) {
        super();
        this.settings = settings;
        this.client = null;
        this.connected = false;
    }

    connect() {
        if (this.client) {
            this.log(`${LOG_PREFIX} MQTT client already exists. Disconnecting first.`);
            this.disconnect();
        }

        const mqttUrl = this._buildMqttUrl();
        const connectOptions = this._buildConnectOptions();

        this.log(`${LOG_PREFIX} Connecting to MQTT Broker: ${mqttUrl}`);
        
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

    publish(topic, payload, options = {}) {
        if (!this.client || !this.connected) {
            this.warn(`${WARN_PREFIX} Cannot publish to MQTT: not connected`);
            return false;
        }

        try {
            this.client.publish(topic, payload, options);
            return true;
        } catch (error) {
            this.error(`${ERROR_PREFIX} Error publishing to MQTT:`, error);
            return false;
        }
    }

    subscribe(topic, callback) {
        if (!this.client || !this.connected) {
            this.warn(`${WARN_PREFIX} Cannot subscribe to MQTT: not connected`);
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
        this.log(`${LOG_PREFIX} CONNECTED TO MQTT BROKER: ${this.settings.mqtt}`);
        
        // Publish online status
        this.publish(MQTT_TOPIC_STATUS, MQTT_PAYLOAD_STATUS_ONLINE, { retain: true, qos: 1 });
        
        // Subscribe to command topics
        this.subscribe(`${MQTT_TOPIC_PREFIX_WRITE}/#`, (err) => {
            if (err) {
                this.error(`${ERROR_PREFIX} MQTT Subscription error:`, err);
            } else {
                this.log(`${LOG_PREFIX} Subscribed to MQTT topic: ${MQTT_TOPIC_PREFIX_WRITE}/#`);
            }
        });
        
        this.emit('connect');
    }

    _handleClose() {
        this.connected = false;
        this.log('[DEBUG] MQTT Close event received with arguments:', arguments);
        this.warn(`${WARN_PREFIX} MQTT Client Closed. Reconnection handled by library.`);
        
        if (this.client) {
            this.client.removeAllListeners(); 
            this.client = null;
        }
        
        this.emit('close');
    }

    _handleError(err) {
        // Handle specific authentication error
        if (err.code === MQTT_ERROR_AUTH) { 
            this.error(`${ERROR_PREFIX} MQTT Connection Error: Authentication failed. Please check username/password in settings.js.`);
            this.error(`${ERROR_PREFIX} Exiting due to fatal MQTT authentication error.`);
            
            if (this.client) {
                this.client.removeAllListeners();
                this.client = null;
            }
            
            process.exit(1); // Exit if auth fails
        } else {
            // Handle generic errors
            this.error(`${ERROR_PREFIX} MQTT Client Error:`, err);
            this.log('[DEBUG] Full MQTT error object:', err); 
            this.connected = false; // Assume disconnected on error
            
            if (this.client) {
                this.client.removeAllListeners();
                this.client = null;
            }
        }
        
        this.emit('error', err);
    }

    _handleMessage(topic, message) {
        const payload = message.toString();
        this.emit('message', topic, payload);
    }

    // Logging methods that can be overridden
    log(message, ...args) {
        console.log(message, ...args);
    }

    warn(message, ...args) {
        console.warn(message, ...args);
    }

    error(message, ...args) {
        console.error(message, ...args);
    }
}

module.exports = MqttManager;