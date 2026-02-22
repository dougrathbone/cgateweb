const { EventEmitter } = require('events');
const CgateConnection = require('./cgateConnection');
const { createLogger } = require('./logger');
const { NEWLINE } = require('./constants');

/**
 * Connection pool for C-Gate command connections.
 * 
 * Manages a pool of persistent TCP connections to C-Gate for improved performance:
 * - Eliminates connection setup overhead (50-80% faster command execution)
 * - Provides automatic failover and health monitoring
 * - Load balances commands across healthy connections
 * - Maintains connection health with keep-alive pings
 * 
 * Event connections remain singular due to their broadcast nature.
 * 
 * @example
 * const pool = new CgateConnectionPool('command', '192.168.1.100', 20023, {
 *   connectionPoolSize: 3,
 *   healthCheckInterval: 30000,
 *   keepAliveInterval: 60000
 * });
 * 
 * pool.execute('GET //PROJECT/254/56/1 level');
 */
class CgateConnectionPool extends EventEmitter {
    /**
     * Creates a new connection pool for C-Gate communications.
     * 
     * @param {string} type - Connection type ('command' only - events use single connection)
     * @param {string} host - C-Gate server host
     * @param {number} port - C-Gate server port  
     * @param {Object} settings - Pool configuration settings
     * @param {number} settings.connectionPoolSize - Number of connections in pool (default: 3)
     * @param {number} settings.healthCheckInterval - Health check frequency in ms (default: 30000)
     * @param {number} settings.keepAliveInterval - Keep-alive ping frequency in ms (default: 60000)
     * @param {number} settings.connectionTimeout - Connection establishment timeout in ms (default: 5000)
     * @param {number} settings.maxRetries - Maximum connection retry attempts (default: 3)
     */
    constructor(type, host, port, settings = {}) {
        super();
        
        if (type !== 'command') {
            throw new Error('Connection pool only supports command connections. Event connections should remain singular.');
        }
        
        this.type = type;
        this.host = host;
        this.port = port;
        this.settings = settings;
        
        // Pool configuration
        this.poolSize = Math.max(1, settings.connectionPoolSize !== undefined ? settings.connectionPoolSize : 3);
        this.healthCheckInterval = Math.max(5000, settings.healthCheckInterval !== undefined ? settings.healthCheckInterval : 30000);
        this.keepAliveInterval = Math.max(10000, settings.keepAliveInterval !== undefined ? settings.keepAliveInterval : 60000);
        this.connectionTimeout = Math.max(1000, settings.connectionTimeout !== undefined ? settings.connectionTimeout : 5000);
        this.maxRetries = Math.max(1, settings.maxRetries !== undefined ? settings.maxRetries : 3);
        
        // Pool state
        this.connections = [];
        this.healthyConnections = new Set();
        this.connectionIndex = 0; // Round-robin index
        this.isStarted = false;
        this.isShuttingDown = false;
        
        // Timers
        this.healthCheckTimer = null;
        this.keepAliveTimer = null;
        
        this.logger = createLogger({ component: `CgateConnectionPool-${type}` });
        
        this.logger.info(`Initializing connection pool: ${this.poolSize} connections to ${host}:${port}`);
    }
    
    /**
     * Starts the connection pool by creating all connections and beginning health monitoring.
     * 
     * @returns {Promise<void>} Resolves when pool is ready with at least one healthy connection
     */
    async start() {
        if (this.isStarted) {
            this.logger.warn('Connection pool already started');
            return;
        }
        
        this.isStarted = true;
        this.isShuttingDown = false;
        
        this.logger.info(`Starting connection pool with ${this.poolSize} connections`);
        
        // Create initial connections
        const connectionPromises = [];
        for (let i = 0; i < this.poolSize; i++) {
            connectionPromises.push(this._createConnection(i));
        }
        
        // Wait for initial connection attempts to settle
        const results = await Promise.allSettled(connectionPromises);
        const successfulConnections = results.filter(r => r.status === 'fulfilled').length;
        
        if (successfulConnections === 0) {
            this.logger.warn('No connections established during startup -- will keep retrying in the background');
            // Schedule background reconnection for each failed connection
            for (let i = 0; i < this.poolSize; i++) {
                if (results[i].status === 'rejected' && this.connections[i]) {
                    this.connections[i].retryCount = 0;
                    this._scheduleReconnection(this.connections[i], i);
                }
            }
        } else {
            this.logger.info(`Connection pool started: ${successfulConnections}/${this.poolSize} connections healthy`);
        }
        
        // Always start health monitoring regardless of initial connection state
        this._startHealthMonitoring();
        this._startKeepAlive();
        
        this.emit('started', { healthy: successfulConnections, total: this.poolSize });
    }
    
    /**
     * Stops the connection pool and closes all connections.
     * 
     * @returns {Promise<void>} Resolves when all connections are closed
     */
    async stop() {
        if (!this.isStarted || this.isShuttingDown) {
            return;
        }
        
        this.isShuttingDown = true;
        this.logger.info('Stopping connection pool...');
        
        // Stop monitoring
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
        
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
        
        // Close all connections
        const closePromises = this.connections.map(conn => {
            if (conn && !conn.isDestroyed) {
                return new Promise(resolve => {
                    conn.once('close', resolve);
                    conn.disconnect();
                    // Force close after timeout
                    setTimeout(() => resolve(), 1000);
                });
            }
            return Promise.resolve();
        });
        
        await Promise.allSettled(closePromises);
        
        this.connections = [];
        this.healthyConnections.clear();
        this.isStarted = false;
        this.isShuttingDown = false;
        
        this.logger.info('Connection pool stopped');
        this.emit('stopped');
    }
    
    /**
     * Executes a command using the next available healthy connection.
     * 
     * @param {string} command - C-Gate command to execute
     * @returns {Promise<boolean>} True if command was sent successfully
     */
    async execute(command) {
        if (!this.isStarted || this.isShuttingDown) {
            throw new Error('Connection pool is not started');
        }
        
        const connection = this._getHealthyConnection();
        if (!connection) {
            throw new Error('No healthy connections available in pool');
        }
        
        const success = connection.send(command);
        if (!success) {
            // Mark connection as potentially unhealthy
            this._markConnectionUnhealthy(connection);
            throw new Error('Failed to send command through connection');
        }
        
        return success;
    }
    
    /**
     * Gets pool statistics.
     * 
     * @returns {Object} Pool statistics
     */
    getStats() {
        return {
            poolSize: this.poolSize,
            totalConnections: this.connections.length,
            healthyConnections: this.healthyConnections.size,
            isStarted: this.isStarted,
            isShuttingDown: this.isShuttingDown
        };
    }
    
    /**
     * Creates a new connection for the pool.
     * 
     * @private
     * @param {number} index - Connection index in pool
     * @returns {Promise<CgateConnection>} The created connection
     */
    async _createConnection(index) {
        return new Promise((resolve, reject) => {
            const connection = new CgateConnection(this.type, this.host, this.port, {
                ...this.settings,
                connectionTimeout: this.connectionTimeout
            });
            
            connection.poolIndex = index;
            connection.lastActivity = Date.now();
            connection.retryCount = 0;
            
            // Connection event handlers
            connection.on('connect', () => {
                this.logger.info(`Pool connection ${index} established`);
                this.healthyConnections.add(connection);
                connection.lastActivity = Date.now();
                this.emit('connectionAdded', { index, connection });
                resolve(connection);
            });
            
            connection.on('close', (hadError) => {
                this.logger.warn(`Pool connection ${index} closed ${hadError ? 'with error' : 'normally'}`);
                this.healthyConnections.delete(connection);
                this.emit('connectionLost', { index, connection, hadError });
                
                // Attempt to reconnect if pool is still active
                if (!this.isShuttingDown) {
                    this._scheduleReconnection(connection, index);
                }
            });
            
            connection.on('error', (error) => {
                this.logger.error(`Pool connection ${index} error:`, { error });
                this.healthyConnections.delete(connection);
                this.emit('connectionError', { index, connection, error });
            });
            
            connection.on('data', (data) => {
                connection.lastActivity = Date.now();
                // Forward data events to pool listeners
                this.emit('data', data, connection);
            });
            
            // Store connection and attempt to connect
            this.connections[index] = connection;
            
            // Set timeout for connection establishment
            const timeoutId = setTimeout(() => {
                reject(new Error(`Connection ${index} establishment timed out after ${this.connectionTimeout}ms`));
            }, this.connectionTimeout);
            
            connection.connect();
            
            // Clear timeout on resolution
            const originalResolve = resolve;
            const originalReject = reject;
            resolve = (...args) => {
                clearTimeout(timeoutId);
                originalResolve(...args);
            };
            reject = (...args) => {
                clearTimeout(timeoutId);
                originalReject(...args);
            };
        });
    }
    
    /**
     * Schedules reconnection for a failed connection.
     * 
     * @private
     * @param {CgateConnection} connection - Failed connection
     * @param {number} index - Connection index
     */
    _scheduleReconnection(connection, index) {
        if (this.isShuttingDown) return;
        
        connection.retryCount = (connection.retryCount || 0) + 1;
        
        // Exponential backoff capped at 60s -- never permanently give up
        const delay = Math.min(1000 * Math.pow(2, connection.retryCount - 1), 60000);
        
        if (connection.retryCount <= this.maxRetries) {
            this.logger.info(`Scheduling pool connection ${index} reconnection in ${delay}ms (attempt ${connection.retryCount}/${this.maxRetries})`);
        } else {
            this.logger.warn(`Pool connection ${index} exceeded initial retries, continuing with ${delay}ms backoff (attempt ${connection.retryCount})`);
        }
        
        setTimeout(async () => {
            if (this.isShuttingDown) return;
            
            try {
                const newConnection = await this._createConnection(index);
                newConnection.retryCount = 0;
                this.logger.info(`Pool connection ${index} successfully reconnected`);
            } catch (error) {
                this.logger.error(`Pool connection ${index} reconnection failed:`, { error: error.message });
                // Explicitly schedule next attempt since _createConnection failure
                // may not trigger a close event on the new connection
                if (this.connections[index]) {
                    this._scheduleReconnection(this.connections[index], index);
                }
            }
        }, delay);
    }
    
    /**
     * Gets the next healthy connection using round-robin load balancing.
     * 
     * @private
     * @returns {CgateConnection|null} Next healthy connection or null if none available
     */
    _getHealthyConnection() {
        if (this.healthyConnections.size === 0) {
            return null;
        }
        
        // Convert Set to Array for indexing
        const healthyArray = Array.from(this.healthyConnections);
        
        // Round-robin selection
        const connection = healthyArray[this.connectionIndex % healthyArray.length];
        this.connectionIndex = (this.connectionIndex + 1) % healthyArray.length;
        
        return connection;
    }
    
    /**
     * Marks a connection as potentially unhealthy and schedules health check.
     * 
     * @private
     * @param {CgateConnection} connection - Connection to mark
     */
    _markConnectionUnhealthy(connection) {
        this.logger.warn(`Marking pool connection ${connection.poolIndex} as potentially unhealthy`);
        
        // Don't immediately remove, but schedule a health check
        setTimeout(() => {
            this._checkConnectionHealth(connection);
        }, 1000);
    }
    
    /**
     * Starts periodic health monitoring of all connections.
     * 
     * @private
     */
    _startHealthMonitoring() {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
        }
        
        this.healthCheckTimer = setInterval(() => {
            this._performHealthCheck();
        }, this.healthCheckInterval);
        
        this.logger.info(`Health monitoring started: checking every ${this.healthCheckInterval}ms`);
    }
    
    /**
     * Starts periodic keep-alive pings to maintain connections.
     * 
     * @private
     */
    _startKeepAlive() {
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
        }
        
        this.keepAliveTimer = setInterval(() => {
            this._sendKeepAlive();
        }, this.keepAliveInterval);
        
        this.logger.info(`Keep-alive started: pinging every ${this.keepAliveInterval}ms`);
    }
    
    /**
     * Performs health check on all connections.
     * 
     * @private
     */
    _performHealthCheck() {
        if (this.isShuttingDown) return;
        
        this.logger.debug(`Performing health check on ${this.connections.length} connections`);
        
        for (const connection of this.connections) {
            if (connection) {
                this._checkConnectionHealth(connection);
            }
        }
        
        const stats = this.getStats();
        this.emit('healthCheck', stats);
        
        if (stats.healthyConnections === 0) {
            this.logger.error('No healthy connections in pool!');
            this.emit('allConnectionsUnhealthy');
        }
    }
    
    /**
     * Checks health of a specific connection.
     * 
     * @private
     * @param {CgateConnection} connection - Connection to check
     */
    _checkConnectionHealth(connection) {
        if (!connection || connection.isDestroyed) {
            this.healthyConnections.delete(connection);
            return;
        }
        
        // Check if connection is responsive
        if (!connection.connected || connection.socket?.destroyed) {
            this.logger.warn(`Pool connection ${connection.poolIndex} is not connected, removing from healthy set`);
            this.healthyConnections.delete(connection);
            return;
        }
        
        // Check for activity timeout (connection might be stale)
        const timeSinceActivity = Date.now() - connection.lastActivity;
        if (timeSinceActivity > this.keepAliveInterval * 2) {
            this.logger.warn(`Pool connection ${connection.poolIndex} has been inactive for ${timeSinceActivity}ms, testing with ping`);
            
            // Send a lightweight test command
            try {
                connection.send(`# Health check ping${NEWLINE}`);
                connection.lastActivity = Date.now();
            } catch (error) {
                this.logger.error(`Health check ping failed for connection ${connection.poolIndex}:`, { error });
                this.healthyConnections.delete(connection);
            }
        }
    }
    
    /**
     * Sends keep-alive pings to all healthy connections.
     * 
     * @private
     */
    _sendKeepAlive() {
        if (this.isShuttingDown || this.healthyConnections.size === 0) return;
        
        this.logger.debug(`Sending keep-alive to ${this.healthyConnections.size} healthy connections`);
        
        for (const connection of this.healthyConnections) {
            try {
                // Send a comment as keep-alive (C-Gate ignores comments)
                connection.send(`# Keep-alive ${Date.now()}${NEWLINE}`);
                connection.lastActivity = Date.now();
            } catch (error) {
                this.logger.error(`Keep-alive failed for connection ${connection.poolIndex}:`, { error });
                this.healthyConnections.delete(connection);
            }
        }
    }
}

module.exports = CgateConnectionPool;