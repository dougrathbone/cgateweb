// @ts-check
const mqtt = require('mqtt');
const { EventEmitter } = require('events');
const { createLogger } = require('./logger');
const { createErrorHandler } = require('./errorHandler');
const { evictOldestFifo } = require('./utils');
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
     * @param {number} [settings.mqttPendingPublishMaxEntries] - Max queued retained publishes while disconnected (default: 1000)
     * @param {boolean} [settings.mqttUseTls] - Use mqtts:// when the broker URL lacks a protocol
     * @param {number} [settings.mqttReconnectPeriodMs] - MQTT reconnect interval in ms (default: 5000)
     * @param {number} [settings.mqttConnectTimeoutMs] - MQTT connect timeout in ms (default: 30000)
     * @param {string} [settings.mqttCaFile] - Path to CA certificate file for TLS
     * @param {string} [settings.mqttCertFile] - Path to client certificate file for TLS
     * @param {string} [settings.mqttKeyFile] - Path to client private key file for TLS
     * @param {boolean} [settings.mqttRejectUnauthorized] - Set false to disable TLS certificate verification
     * @param {{ type?: string }} [settings._environment] - Runtime environment descriptor (internal)
     */
    constructor(settings) {
        super();
        this.settings = settings;
        this.client = null;
        this.connected = false;
        this._connecting = false;
        this._intentionalDisconnect = false;
        this._bridgeReady = false;
        this._lastStatusPayload = null;
        this._droppedPublishCount = 0;
        this._droppedPublishWarned = false;
        // Sticky for process lifetime: first-boot publishes before MQTT connects
        // are expected (diagnostics during start()); only warn after we have
        // successfully connected at least once (true mid-session disconnect).
        this._hasConnectedOnce = false;
        this._authFailureLogged = false;

        // Pre-connect / disconnect publish queue. Retained-state publishes
        // attempted while the broker is unreachable are queued here and
        // replayed on (re)connect, so HA Discovery configs and initial state
        // values aren't silently lost during the startup race. Map semantics
        // give us newest-wins-per-topic — a stale level=0 is overwritten by a
        // fresh level=128 if both queue while disconnected. Bounded by
        // mqttPendingPublishMaxEntries (default 1000); when full, the oldest
        // entry is evicted.
        this._pendingPublishQueue = new Map();
        this._pendingPublishMaxEntries = Math.max(
            10, Number(settings && settings.mqttPendingPublishMaxEntries) || 1000
        );
        this._pendingPublishEvicted = 0;

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
        if (this._connecting) {
            this.logger.info(`MQTT connection already in progress, skipping`);
            return this;
        }
        if (this.client) {
            this.logger.info(`MQTT client already exists. Disconnecting first.`);
            this.disconnect();
        }

        this._connecting = true;
        this._intentionalDisconnect = false;

        const mqttUrl = this._buildMqttUrl();
        const connectOptions = this._buildConnectOptions();

        this.logger.info(`Connecting to MQTT Broker: ${mqttUrl}`);

        this.client = mqtt.connect(mqttUrl, connectOptions);

        this.client.on('connect', () => this._handleConnect());
        this.client.on('close', () => this._handleClose());
        this.client.on('error', (err) => this._handleError(err));
        this.client.on('message', (topic, message, packet) => this._handleMessage(topic, message, packet));

        return this;
    }

    disconnect() {
        this._connecting = false;
        this._intentionalDisconnect = true;
        this._bridgeReady = false;
        if (this.client) {
            if (this.connected) {
                try {
                    this._publishStatus(MQTT_PAYLOAD_STATUS_OFFLINE);
                } catch {
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
     * @param {0|1|2} [options.qos=0] - Quality of Service level (0, 1, or 2)
     * @param {boolean} [options.retain=false] - Whether to retain the message
     * @returns {boolean} True if publish succeeded, false otherwise
     */
    publish(topic, payload, options = {}) {
        if (!this.client || !this.connected) {
            this._droppedPublishCount++;
            if (options && options.retain) {
                this._enqueueRetainedPublish(topic, payload, options);
            }
            if (!this._droppedPublishWarned) {
                const msg = 'MQTT not connected; queueing retained publishes for replay on reconnect (further drops suppressed)';
                if (this._hasConnectedOnce) {
                    this.logger.warn(msg);
                } else {
                    this.logger.debug(msg);
                }
                this._droppedPublishWarned = true;
            }
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

    _enqueueRetainedPublish(topic, payload, options) {
        // Newest-wins per topic — a fresh value supersedes a stale one queued
        // earlier in the same disconnect window.
        this._pendingPublishQueue.delete(topic);
        this._pendingPublishQueue.set(topic, { payload, options });

        // Bounded queue: evict the oldest entry when over the cap. Map
        // iteration is insertion order so the first key is the oldest.
        if (this._pendingPublishQueue.size > this._pendingPublishMaxEntries) {
            evictOldestFifo(this._pendingPublishQueue);
            this._pendingPublishEvicted += 1;
        }
    }

    _flushPendingPublishes() {
        if (this._pendingPublishQueue.size === 0) return;
        const entries = [...this._pendingPublishQueue.entries()];
        this._pendingPublishQueue.clear();
        let succeeded = 0;
        for (const [topic, { payload, options }] of entries) {
            try {
                this.client.publish(topic, payload, options);
                succeeded += 1;
            } catch (error) {
                this.logger.error(`Error replaying queued MQTT publish for ${topic}:`, { error });
            }
        }
        this.logger.info(`MQTT reconnected; replayed ${succeeded} queued retained publish(es)`);
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
        /** @type {import('mqtt').IClientOptions} */
        const options = {
            reconnectPeriod: this.settings.mqttReconnectPeriodMs || 5000,
            connectTimeout: this.settings.mqttConnectTimeoutMs || 30000,
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
            const readCertFile = (filePath, label) => {
                try {
                    return fs.readFileSync(filePath);
                } catch (e) {
                    throw new Error(`Failed to read MQTT TLS ${label} file "${filePath}": ${e.message}`, { cause: e });
                }
            };
            if (this.settings.mqttCaFile) {
                options.ca = readCertFile(this.settings.mqttCaFile, 'CA certificate');
            }
            if (this.settings.mqttCertFile) {
                options.cert = readCertFile(this.settings.mqttCertFile, 'client certificate');
            }
            if (this.settings.mqttKeyFile) {
                options.key = readCertFile(this.settings.mqttKeyFile, 'private key');
            }
        }

        if (this.settings.mqttRejectUnauthorized === false) {
            options.rejectUnauthorized = false;
            this.logger.warn(
                'MQTT TLS certificate verification is disabled (mqttRejectUnauthorized=false). ' +
                'Connections are vulnerable to man-in-the-middle attacks. Prefer mqttCaFile with a trusted CA, or keep verification enabled.'
            );
        }

        return options;
    }

    _handleConnect() {
        this._connecting = false;
        this.connected = true;
        this._hasConnectedOnce = true;
        this._authFailureLogged = false;
        this.logger.info(`CONNECTED TO MQTT BROKER: ${this.settings.mqtt}`);

        if (this._pendingPublishEvicted > 0) {
            this.logger.warn(
                `MQTT publish queue exceeded max entries while disconnected; ${this._pendingPublishEvicted} oldest retained publish(es) evicted before flush`
            );
            this._pendingPublishEvicted = 0;
        }
        if (this._droppedPublishCount > 0) {
            const queued = this._pendingPublishQueue.size;
            this.logger.info(
                `MQTT reconnected; ${this._droppedPublishCount} publish(es) attempted while disconnected, ${queued} queued for replay`
            );
            this._droppedPublishCount = 0;
        }
        this._droppedPublishWarned = false;

        this._publishStatus(this._bridgeReady ? MQTT_PAYLOAD_STATUS_ONLINE : MQTT_PAYLOAD_STATUS_OFFLINE);
        this._flushPendingPublishes();
        
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
        this._connecting = false;
        this.connected = false;
        this._bridgeReady = false;
        
        if (this._intentionalDisconnect) {
            this.logger.info('MQTT Client closed (intentional disconnect).');
        } else {
            this.logger.warn('MQTT Client closed. Library will attempt reconnection.');
        }
        
        this.emit('close');
    }

    _isAddonMode() {
        return (this.settings && this.settings._environment && this.settings._environment.type === 'addon')
            || !!process.env.SUPERVISOR_TOKEN;
    }

    _handleError(err) {
        this.connected = false;
        
        if (err.code === MQTT_ERROR_AUTH) {
            const brokerUrl = this.settings.mqtt || '(not configured)';
            const hasUsername = !!this.settings.mqttusername;
            const isAddon = this._isAddonMode();

            // Throttle the banner: mqtt.js will keep reconnecting and re-emitting
            // auth errors; one clear message per failure window is enough.
            if (!this._authFailureLogged) {
                this._authFailureLogged = true;
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
                        this.logger.error('    4. Save and wait — the bridge will retry without a full restart');
                    } else {
                        this.logger.error('  To fix this:');
                        this.logger.error('    1. Edit your settings.js file');
                        this.logger.error('    2. Set exports.mqttusername and exports.mqttpassword');
                        this.logger.error('    3. Restart cgateweb');
                    }
                } else {
                    this.logger.error('  Credentials were provided but the broker rejected them.');
                    this.logger.error('  Check that the username and password are correct.');
                    if (isAddon) {
                        this.logger.error('  The bridge will keep retrying; fix credentials in the add-on config.');
                    }
                }
                this.logger.error('==========================================================');
                this.logger.error('');
            }

            // Fatal in standalone (clear misconfig signal). Non-fatal in the
            // add-on so Supervisor/s6 does not restart-loop and spam logs.
            this.errorHandler.handle(err, {
                brokerUrl,
                hasUsername,
                addonMode: isAddon
            }, 'MQTT authentication', !isAddon);
        } else {
            this.errorHandler.handle(err, {
                brokerUrl: this.settings.mqtt,
                connected: this.connected,
                errorCode: err.code
            }, 'MQTT connection');
        }
        
        this.emit('error', err);
    }

    _handleMessage(topic, message, packet) {
        // Ignore retained messages on write topics — they are stale commands from a previous
        // session replayed by the broker on subscribe, and executing them would send unexpected
        // commands to C-Gate (e.g. turning off lights that are currently on).
        if (packet && packet.retain && topic.startsWith(MQTT_TOPIC_PREFIX_WRITE)) {
            this.logger.debug(`Ignoring retained write command on reconnect: ${topic}`);
            return;
        }
        const payload = message.toString();
        this.emit('message', topic, payload);
    }

    setBridgeReady(isReady, reason = 'state-change') {
        this._bridgeReady = !!isReady;
        if (!this.connected) return false;

        const payload = this._bridgeReady ? MQTT_PAYLOAD_STATUS_ONLINE : MQTT_PAYLOAD_STATUS_OFFLINE;
        this.logger.info(`Bridge readiness changed: ${payload} (${reason})`);
        return this._publishStatus(payload);
    }

    _publishStatus(payload) {
        if (!this.client || !this.connected) {
            return false;
        }
        if (this._lastStatusPayload === payload) {
            return true;
        }

        this.client.publish(MQTT_TOPIC_STATUS, payload, { retain: true, qos: 1 });
        this._lastStatusPayload = payload;
        return true;
    }

    // Logging methods that can be overridden
}

module.exports = MqttManager;