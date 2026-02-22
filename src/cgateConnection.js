const net = require('net');
const { EventEmitter } = require('events');
const { createLogger } = require('./logger');
const { 
    CGATE_CMD_EVENT_ON, 
    CGATE_CMD_LOGIN, 
    NEWLINE 
} = require('./constants');

class CgateConnection extends EventEmitter {
    constructor(type, host, port, settings = {}) {
        super();
        this.type = type; // 'command' or 'event'
        this.host = host;
        this.port = port;
        this.settings = settings;
        
        this.socket = null;
        this.connected = false;
        this.reconnectAttempts = 0;
        this.reconnectTimeout = null;
        this.maxReconnectAttempts = 10;
        this.reconnectInitialDelay = settings.reconnectinitialdelay || 1000;
        this.reconnectMaxDelay = settings.reconnectmaxdelay || 60000;
        this.logger = createLogger({ component: `CgateConnection-${type}` });
        
        // Pool support properties
        this.poolIndex = -1;
        this.lastActivity = Date.now();
        this.retryCount = 0;
        this.isDestroyed = false;
    }

    connect() {
        if (this.socket && !this.socket.destroyed) {
            this.logger.info(`${this.type} socket already exists and is not destroyed. Destroying it first.`);
            this.socket.destroy();
        }

        this.logger.info(`Connecting to C-Gate ${this.type} port: ${this.host}:${this.port}`);
        
        this.socket = net.createConnection(this.port, this.host);
        
        this.socket.on('connect', () => this._handleConnect());
        this.socket.on('close', (hadError) => this._handleClose(hadError));
        this.socket.on('error', (err) => this._handleError(err));
        this.socket.on('data', (data) => this._handleData(data));
        
        return this;
    }

    disconnect() {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        
        if (this.socket && !this.socket.destroyed) {
            this.socket.removeAllListeners();
            this.socket.destroy();
        }
        
        this.socket = null;
        this.connected = false;
        this.reconnectAttempts = 0;
        this.isDestroyed = true;
    }

    send(data) {
        if (!this.socket || this.socket.destroyed || !this.connected) {
            this.logger.warn(`Cannot send data on ${this.type} socket: not connected`);
            return false;
        }

        try {
            this.socket.write(data);
            this.lastActivity = Date.now(); // Update activity timestamp for pool health monitoring
            return true;
        } catch (error) {
            this.logger.error(`Error writing to ${this.type} socket:`, { error });
            return false;
        }
    }

    _handleConnect() {
        this.connected = true;
        this.reconnectAttempts = 0;
        
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        
        this.logger.info(`CONNECTED TO C-GATE ${this.type.toUpperCase()} PORT: ${this.host}:${this.port}`);
        
        // Send initial commands for command connection
        if (this.type === 'command') {
            this._sendInitialCommands();
        }
        
        this.emit('connect');
    }

    _handleClose(hadError) {
        this.connected = false;
        
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket = null;
        }
        
        this.logger.warn(`${this.type.toUpperCase()} PORT DISCONNECTED${hadError ? ' with error' : ''}`);
        this.emit('close', hadError);
        
        // Schedule reconnection
        this._scheduleReconnect();
    }

    _handleError(err) {
        this.logger.error(`C-Gate ${this.type} Socket Error:`, { error: err });
        this.connected = false;
        
        if (this.socket && !this.socket.destroyed) {
            this.socket.destroy();
        }
        this.socket = null;
        
        this.emit('error', err);
    }

    _handleData(data) {
        this.lastActivity = Date.now(); // Update activity timestamp for pool health monitoring
        // Emit raw data for processing by parent classes
        this.emit('data', data);
    }

    _sendInitialCommands() {
        try {
            if (this.socket && !this.socket.destroyed) {
                // 1. Enable events
                const eventCmd = CGATE_CMD_EVENT_ON + NEWLINE;
                this.socket.write(eventCmd);
                this.logger.info(`C-Gate Sent: ${CGATE_CMD_EVENT_ON}`);
                
                // 2. Send LOGIN if credentials provided
                const user = this.settings.cgateusername;
                const pass = this.settings.cgatepassword;
                if (user && typeof user === 'string' && user.trim() !== '' && typeof pass === 'string') {
                    const loginCmd = `${CGATE_CMD_LOGIN} ${user.trim()} ${pass}${NEWLINE}`;
                    this.logger.info(`Sending LOGIN command for user '${user.trim()}'...`);
                    this.socket.write(loginCmd);
                }
            } else {
                this.logger.warn(`Command socket not available to send initial commands (EVENT ON / LOGIN).`);
            }
        } catch (e) {
            this.logger.error(`Error sending initial commands (EVENT ON / LOGIN):`, { error: e });
            this._handleError(e);
        }
    }

    _scheduleReconnect() {
        if (this.reconnectTimeout) {
            return; // Already scheduled
        }

        // Exponential backoff, capped at reconnectMaxDelay -- never permanently give up
        const delay = Math.min(
            this.reconnectInitialDelay * Math.pow(2, this.reconnectAttempts),
            this.reconnectMaxDelay
        );

        this.reconnectAttempts++;
        
        if (this.reconnectAttempts <= this.maxReconnectAttempts) {
            this.logger.info(`Scheduling ${this.type} reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);
        } else {
            this.logger.warn(`${this.type} connection exceeded initial retries, continuing with ${delay}ms backoff (attempt ${this.reconnectAttempts})`);
        }

        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = null;
            this.connect();
        }, delay);
    }

    // Logging methods that can be overridden
}

module.exports = CgateConnection;