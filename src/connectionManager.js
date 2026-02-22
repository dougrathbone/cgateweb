const { EventEmitter } = require('events');
const { createLogger } = require('./logger');

/**
 * Manages all connections for the CgateWebBridge.
 * 
 * This class centralizes connection state management and coordination between:
 * - MQTT broker connection
 * - C-Gate command connection pool
 * - C-Gate event connection
 * 
 * It emits 'allConnected' when all connections are healthy and ready for operation.
 */
class ConnectionManager extends EventEmitter {
    /**
     * Creates a new ConnectionManager instance.
     * 
     * @param {Object} connections - Connection instances to manage
     * @param {Object} connections.mqttManager - MQTT manager instance
     * @param {Object} connections.commandConnectionPool - Command connection pool instance
     * @param {Object} connections.eventConnection - Event connection instance
     * @param {Object} settings - Configuration settings
     */
    constructor(connections, settings) {
        super();
        this.mqttManager = connections.mqttManager;
        this.commandConnectionPool = connections.commandConnectionPool;
        this.eventConnection = connections.eventConnection;
        this.settings = settings;
        
        this.logger = createLogger({ 
            component: 'connection-manager', 
            level: settings.log_level || (settings.logging ? 'info' : 'warn'),
            enabled: true 
        });

        this.allConnected = false;
        this._setupEventHandlers();
    }

    /**
     * Sets up event handlers for all managed connections.
     * @private
     */
    _setupEventHandlers() {
        // MQTT connection events
        this.mqttManager.on('connect', () => {
            this.logger.info('MQTT connected');
            this._checkAllConnected();
        });
        this.mqttManager.on('close', () => {
            this.logger.info('MQTT disconnected');
            this.allConnected = false;
        });

        // Command connection pool events
        this.commandConnectionPool.on('started', () => {
            this.logger.info('Command connection pool started');
            this._checkAllConnected();
        });
        this.commandConnectionPool.on('allConnectionsUnhealthy', () => {
            this.logger.warn('All command connections unhealthy');
            this.allConnected = false;
        });

        // Event connection events
        this.eventConnection.on('connect', () => {
            this.logger.info('Event connection connected');
            this._checkAllConnected();
        });
        this.eventConnection.on('close', () => {
            this.logger.info('Event connection disconnected');
            this.allConnected = false;
        });
        this.eventConnection.on('error', (err) => {
            this.logger.warn('Event connection error:', { error: err.message });
            this.allConnected = false;
        });
    }

    /**
     * Starts all managed connections.
     * @returns {Promise<void>}
     */
    async start() {
        this.logger.info('Starting all connections');
        
        // Start connections in parallel
        this.mqttManager.connect();
        await this.commandConnectionPool.start();
        this.eventConnection.connect();
    }

    /**
     * Stops all managed connections.
     * @returns {Promise<void>}
     */
    async stop() {
        this.logger.info('Stopping all connections');
        
        // Disconnect all connections
        this.mqttManager.disconnect();
        await this.commandConnectionPool.stop();
        this.eventConnection.disconnect();

        this.allConnected = false;
    }

    /**
     * Checks if all connections are healthy and emits 'allConnected' if so.
     * @private
     */
    _checkAllConnected() {
        const poolHealthy = this.commandConnectionPool.isStarted && 
                           this.commandConnectionPool.healthyConnections.size > 0;
        
        if (this.mqttManager.connected && 
            poolHealthy && 
            this.eventConnection.connected &&
            !this.allConnected) {
            
            this.allConnected = true;
            this.logger.info(`ALL CONNECTED`);
            this.logger.info(`Connection Successful: MQTT (${this.settings.mqtt}), C-Gate (${this.settings.cbusip}:${this.settings.cbuscommandport},${this.settings.cbuseventport}). Awaiting messages...`);
            
            // Emit event to signal that all connections are ready
            this.emit('allConnected');
        }
    }

    /**
     * Returns whether all connections are currently healthy.
     * @returns {boolean} True if all connections are healthy
     */
    get isAllConnected() {
        return this.allConnected;
    }
}

module.exports = ConnectionManager;
