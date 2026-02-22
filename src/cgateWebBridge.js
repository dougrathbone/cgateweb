const { EventEmitter } = require('events');
const CgateConnection = require('./cgateConnection');
const CgateConnectionPool = require('./cgateConnectionPool');
const MqttManager = require('./mqttManager');
const HaDiscovery = require('./haDiscovery');
const ThrottledQueue = require('./throttledQueue');
const CBusEvent = require('./cbusEvent');
const MqttCommandRouter = require('./mqttCommandRouter');
const ConnectionManager = require('./connectionManager');
const EventPublisher = require('./eventPublisher');
const CommandResponseProcessor = require('./commandResponseProcessor');
const DeviceStateManager = require('./deviceStateManager');
const LabelLoader = require('./labelLoader');
const WebServer = require('./webServer');
const { createLogger } = require('./logger');
const { LineProcessor } = require('./lineProcessor');
const {
    CGATE_CMD_GET,
    CGATE_PARAM_LEVEL,
    NEWLINE
} = require('./constants');

/**
 * Main bridge class that connects C-Gate (Clipsal C-Bus automation system) to MQTT.
 * 
 * This class orchestrates communication between:
 * - C-Gate server (Clipsal's C-Bus automation gateway)
 * - MQTT broker (for Home Assistant and other automation systems)
 * - Home Assistant discovery protocol
 * 
 * The bridge translates between C-Bus events and MQTT messages, enabling
 * bidirectional control of C-Bus devices through MQTT.
 * 
 * @example
 * const bridge = new CgateWebBridge({
 *   mqtt: 'mqtt://localhost:1883',
 *   cbusip: '192.168.1.100',
 *   cbuscommandport: 20023,
 *   cbuseventport: 20024,
 *   cbusname: 'SHAC'
 * });
 * bridge.start();
 */
class CgateWebBridge {
    /**
     * Creates a new CgateWebBridge instance.
     * 
     * @param {Object} settings - Configuration settings for the bridge
     * @param {string} settings.mqtt - MQTT broker URL (e.g., 'mqtt://localhost:1883')
     * @param {string} settings.cbusip - C-Gate server IP address
     * @param {number} settings.cbuscommandport - C-Gate command port (typically 20023)
     * @param {number} settings.cbuseventport - C-Gate event port (typically 20024)
     * @param {string} settings.cbusname - C-Gate project name
     * @param {Function} [mqttClientFactory=null] - Factory for creating MQTT clients (for testing)
     * @param {Function} [commandSocketFactory=null] - Factory for command sockets (for testing)
     * @param {Function} [eventSocketFactory=null] - Factory for event sockets (for testing)
     */
    constructor(settings, mqttClientFactory = null, commandSocketFactory = null, eventSocketFactory = null) {
        // Merge with default settings
        const { defaultSettings } = require('./defaultSettings');
        this.settings = { ...defaultSettings, ...settings };
        this.logger = createLogger({ 
            component: 'bridge', 
            level: this.settings.log_level || (this.settings.logging ? 'info' : 'warn'),
            enabled: true 
        });

        // Store factory references for test compatibility
        this.mqttClientFactory = mqttClientFactory;
        this.commandSocketFactory = commandSocketFactory;
        this.eventSocketFactory = eventSocketFactory;
        
        // Connection managers
        this.mqttManager = new MqttManager(this.settings);
        
        // Use connection pool for commands (performance optimization)
        // Event connection remains singular due to its broadcast nature
        this.commandConnectionPool = new CgateConnectionPool('command', this.settings.cbusip, this.settings.cbuscommandport, this.settings);
        this.eventConnection = new CgateConnection('event', this.settings.cbusip, this.settings.cbuseventport, this.settings);
        
        // Maintain backward compatibility - expose first connection from pool
        this.commandConnection = null; // Will be set after pool starts

        // Connection manager to coordinate all connections
        this.connectionManager = new ConnectionManager({
            mqttManager: this.mqttManager,
            commandConnectionPool: this.commandConnectionPool,
            eventConnection: this.eventConnection
        }, this.settings);
        
        // Service modules (haDiscovery will be initialized after pool starts)
        this.haDiscovery = null;
        
        // C-Gate command queue with throttling to avoid overwhelming serial protocol
        const queueOptions = { maxSize: this.settings.maxQueueSize || 1000 };
        this.cgateCommandQueue = new ThrottledQueue(
            (command) => this._sendCgateCommand(command),
            this.settings.messageinterval,
            'C-Gate Command Queue',
            queueOptions
        );

        // Device state manager for coordinating device state between components
        this.deviceStateManager = new DeviceStateManager({
            settings: this.settings,
            logger: this.logger
        });

        // MQTT command router
        this.mqttCommandRouter = new MqttCommandRouter({
            cbusname: this.settings.cbusname,
            ha_discovery_enabled: this.settings.ha_discovery_enabled,
            internalEventEmitter: this.deviceStateManager.getEventEmitter(),
            cgateCommandQueue: this.cgateCommandQueue
        });

        // Per-connection line processors to prevent data interleaving across pool connections.
        // Each TCP connection gets its own processor so partial reads on one connection
        // don't corrupt lines being assembled on another.
        this.commandLineProcessors = new Map();
        this.eventLineProcessor = new LineProcessor();
        this.periodicGetAllInterval = null;
        this._lastInitTime = 0;

        // MQTT options
        this._mqttOptions = this.settings.retainreads ? { retain: true, qos: 0 } : { qos: 0 };

        // Event publisher for MQTT messages -- publishes directly without throttling.
        // MQTT QoS 0 publishes are near-instant TCP buffer writes; the mqtt library
        // handles its own buffering and flow control.
        this.eventPublisher = new EventPublisher({
            settings: this.settings,
            publishFn: (topic, payload, options) => this.mqttManager.publish(topic, payload, options),
            mqttOptions: this._mqttOptions,
            logger: this.logger
        });

        // Command response processor for handling C-Gate command responses
        this.commandResponseProcessor = new CommandResponseProcessor({
            eventPublisher: this.eventPublisher,
            haDiscovery: null, // Will be set after haDiscovery is initialized
            onObjectStatus: (event) => this.deviceStateManager.updateLevelFromEvent(event),
            logger: this.logger
        });

        // Label loader for custom device names
        this.labelLoader = new LabelLoader(this.settings.cbus_label_file || null);
        this.labelLoader.load();

        // Web server for label editing UI
        const ingressBasePath = process.env.INGRESS_ENTRY || '';
        this.webServer = new WebServer({
            port: this.settings.web_port || 8080,
            basePath: ingressBasePath,
            labelLoader: this.labelLoader,
            getStatus: () => this._getBridgeStatus()
        });

        this._setupEventHandlers();
    }

    _setupEventHandlers() {
        // Connection manager handles all connection state coordination
        this.connectionManager.on('allConnected', () => {
            this._handleAllConnected();
        });

        // Set first connection for backward compatibility when pool starts
        this.commandConnectionPool.on('started', () => {
            const firstConnection = this.commandConnectionPool.connections[0];
            this.commandConnection = firstConnection;
        });

        // Reset line processor when a pool connection is replaced (reconnect)
        // to avoid stale partial-line buffers from the old connection
        this.commandConnectionPool.on('connectionAdded', ({ index }) => {
            const existing = this.commandLineProcessors.get(index);
            if (existing) {
                existing.close();
                this.commandLineProcessors.delete(index);
            }
        });

        // MQTT message routing
        this.mqttManager.on('message', (topic, payload) => this.mqttCommandRouter.routeMessage(topic, payload));

        // Data processing handlers - pass connection for per-connection line processing
        this.commandConnectionPool.on('data', (data, connection) => this._handleCommandData(data, connection));
        this.eventConnection.on('data', (data) => this._handleEventData(data));

        // MQTT command router event handlers
        this.mqttCommandRouter.on('haDiscoveryTrigger', () => {
            if (this.haDiscovery) {
                this.haDiscovery.trigger();
            }
        });
        this.mqttCommandRouter.on('treeRequest', (networkId) => {
            if (this.haDiscovery) {
                this.haDiscovery.treeNetwork = networkId;
            }
        });
    }

    /**
     * Starts the bridge by connecting to MQTT broker and C-Gate server.
     * 
     * This method initiates connections to:
     * - MQTT broker (for receiving commands and publishing events)
     * - C-Gate command port (for sending commands to C-Bus devices)
     * - C-Gate event port (for receiving C-Bus device events)
     * 
     * @returns {CgateWebBridge} Returns this instance for method chaining
     */
    async start() {
        this.logger.info('Starting cgateweb bridge');
        
        // Start label file watcher for hot-reload
        this._onLabelsChanged = (labelData) => {
            this.logger.info(`Labels reloaded (${labelData.labels.size} labels), re-triggering HA Discovery`);
            if (this.haDiscovery) {
                this.haDiscovery.updateLabels(labelData);
                this.haDiscovery.trigger();
            }
        };
        this.labelLoader.on('labels-changed', this._onLabelsChanged);
        this.labelLoader.watch();

        // Start web server
        try {
            await this.webServer.start();
        } catch (err) {
            this.logger.warn(`Web server failed to start: ${err.message}`);
        }
        
        // Start all connections via connection manager
        await this.connectionManager.start();
        
        return this;
    }

    /**
     * Stops the bridge and cleans up all resources.
     * 
     * This method:
     * - Clears any running periodic tasks
     * - Empties message queues
     * - Disconnects from MQTT broker and C-Gate server
     * - Resets connection state
     */
    async stop() {
        this.log(`Stopping cgateweb bridge...`);
        
        // Clear periodic tasks
        if (this.periodicGetAllInterval) {
            clearInterval(this.periodicGetAllInterval);
            this.periodicGetAllInterval = null;
        }

        // Stop label file watcher and remove listener
        if (this._onLabelsChanged) {
            this.labelLoader.removeListener('labels-changed', this._onLabelsChanged);
            this._onLabelsChanged = null;
        }
        this.labelLoader.unwatch();

        // Stop web server
        await this.webServer.close();

        // Clear queues
        this.cgateCommandQueue.clear();

        // Clean up line processors
        for (const processor of this.commandLineProcessors.values()) {
            processor.close();
        }
        this.commandLineProcessors.clear();
        this.eventLineProcessor.close();

        // Shut down device state manager
        this.deviceStateManager.shutdown();

        // Disconnect all connections via connection manager
        await this.connectionManager.stop();
    }

    _handleAllConnected() {
        const now = Date.now();
        if (now - this._lastInitTime < 10000) {
            this.log(`ALL CONNECTED (duplicate within 10s, skipping re-initialization)`);
            return;
        }
        this._lastInitTime = now;
        this.log(`ALL CONNECTED - Initializing services...`);

        // Trigger initial get all
        if (this.settings.getallnetapp && this.settings.getallonstart) {
            this.log(`Getting all initial values for ${this.settings.getallnetapp}...`);
            this.cgateCommandQueue.add(`${CGATE_CMD_GET} //${this.settings.cbusname}/${this.settings.getallnetapp}/* ${CGATE_PARAM_LEVEL}${NEWLINE}`);
        }

        // Setup periodic get all
        if (this.settings.getallnetapp && this.settings.getallperiod) {
            if (this.periodicGetAllInterval) {
                clearInterval(this.periodicGetAllInterval);
            }
            this.log(`Starting periodic 'get all' every ${this.settings.getallperiod} seconds.`);
            this.periodicGetAllInterval = setInterval(() => {
                this.log(`Getting all periodic values for ${this.settings.getallnetapp}...`);
                this.cgateCommandQueue.add(`${CGATE_CMD_GET} //${this.settings.cbusname}/${this.settings.getallnetapp}/* ${CGATE_PARAM_LEVEL}${NEWLINE}`);
            }, this.settings.getallperiod * 1000);
        }
        
        // Initialize haDiscovery after pool starts, with label data
        if (!this.haDiscovery) {
            this.haDiscovery = new HaDiscovery(
                this.settings,
                (topic, payload, options) => this.mqttManager.publish(topic, payload, options),
                (command) => this._sendCgateCommand(command),
                this.labelLoader.getLabelData()
            );
            this.commandResponseProcessor.haDiscovery = this.haDiscovery;
        }
        
        // Trigger HA Discovery
        if (this.settings.ha_discovery_enabled) {
            this.haDiscovery.trigger();
        }
    }

    // MQTT message handling now delegated to MqttCommandRouter



    _handleCommandData(data, connection) {
        const key = connection.poolIndex !== undefined ? connection.poolIndex : connection;
        let processor = this.commandLineProcessors.get(key);
        if (!processor) {
            processor = new LineProcessor();
            this.commandLineProcessors.set(key, processor);
        }
        processor.processData(data, (line) => {
            this.commandResponseProcessor.processLine(line);
        });
    }



    _handleEventData(data) {
        this.eventLineProcessor.processData(data, (line) => {
            this._processEventLine(line);
        });
    }

    _processEventLine(line) {
        if (line.startsWith('#')) {
            this.log(`Ignoring comment from event port:`, line);
            return;
        }

        this.log(`C-Gate Recv (Evt): ${line}`);

        try {
            const event = new CBusEvent(line);
            if (event.isValid()) {
                this.eventPublisher.publishEvent(event, '(Evt)');
                this.deviceStateManager.updateLevelFromEvent(event);
            } else {
                this.warn(`Could not parse event line: ${line}`);
            }
        } catch (e) {
            this.error(`Error processing event data line:`, e, `Line: ${line}`);
        }
    }



    // Event publishing now delegated to EventPublisher

    async _sendCgateCommand(command) {
        try {
            await this.commandConnectionPool.execute(command);
        } catch (error) {
            this.logger.error('Failed to send C-Gate command:', { command, error });
        }
    }

    /**
     * Logs an informational message.
     * 
     * @param {string} message - The message to log
     * @param {Object} [meta={}] - Additional metadata for structured logging
     */
    log(message, meta = {}) {
        this.logger.info(message, meta);
    }

    /**
     * Logs a warning message.
     * 
     * @param {string} message - The warning message to log
     * @param {Object} [meta={}] - Additional metadata for structured logging
     */
    warn(message, meta = {}) {
        this.logger.warn(message, meta);
    }

    /**
     * Logs an error message.
     * 
     * @param {string} message - The error message to log
     * @param {Object} [meta={}] - Additional metadata for structured logging
     */
    error(message, meta = {}) {
        this.logger.error(message, meta);
    }

    _getBridgeStatus() {
        return {
            version: require('../package.json').version,
            uptime: process.uptime(),
            connections: {
                mqtt: this.mqttManager.isConnected ? this.mqttManager.isConnected() : 'unknown',
                commandPool: this.commandConnectionPool ? 'active' : 'inactive',
                event: this.eventConnection ? 'active' : 'inactive'
            },
            discovery: this.haDiscovery ? {
                count: this.haDiscovery.discoveryCount,
                labelStats: this.haDiscovery.labelStats
            } : null
        };
    }

    // Legacy method compatibility for tests
    _connectMqtt() {
        return this.mqttManager.connect();
    }

    _connectCommandSocket() {
        return this.commandConnection.connect();
    }

    _connectEventSocket() {
        return this.eventConnection.connect();
    }


}

module.exports = CgateWebBridge;