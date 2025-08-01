class Logger {
    constructor(options = {}) {
        this.level = options.level || 'info';
        this.component = options.component || 'cgateweb';
        this.enabled = options.enabled !== false;
        
        // Log levels (lower number = higher priority)
        this.levels = {
            error: 0,
            warn: 1, 
            info: 2,
            debug: 3
        };
        
        this.currentLevel = this.levels[this.level] || this.levels.info;
    }

    _shouldLog(level) {
        return this.enabled && this.levels[level] <= this.currentLevel;
    }

    _formatMessage(level, message, meta = {}) {
        const timestamp = new Date().toISOString();
        const levelStr = level.toUpperCase().padEnd(5);
        const componentStr = this.component ? `[${this.component}]` : '';
        
        let logLine = `${timestamp} ${levelStr} ${componentStr} ${message}`;
        
        // Add metadata if provided
        if (Object.keys(meta).length > 0) {
            const metaStr = JSON.stringify(meta);
            logLine += ` ${metaStr}`;
        }
        
        return logLine;
    }

    _log(level, message, meta = {}) {
        if (!this._shouldLog(level)) {
            return;
        }

        const formattedMessage = this._formatMessage(level, message, meta);
        
        // Use appropriate console method based on level
        switch (level) {
            case 'error':
                console.error(formattedMessage);
                break;
            case 'warn':
                console.warn(formattedMessage);
                break;
            case 'debug':
                console.debug(formattedMessage);
                break;
            default:
                console.log(formattedMessage);
        }
    }

    error(message, meta = {}) {
        this._log('error', message, meta);
    }

    warn(message, meta = {}) {
        this._log('warn', message, meta);
    }

    info(message, meta = {}) {
        this._log('info', message, meta);
    }

    debug(message, meta = {}) {
        this._log('debug', message, meta);
    }

    // Create child logger with additional context
    child(options = {}) {
        return new Logger({
            level: this.level,
            component: options.component || this.component,
            enabled: this.enabled,
            ...options
        });
    }

    // Set log level dynamically
    setLevel(level) {
        if (this.levels.hasOwnProperty(level)) {
            this.level = level;
            this.currentLevel = this.levels[level];
        }
    }
}

// Create default logger instance
const defaultLogger = new Logger();

// Export both the class and default instance
module.exports = {
    Logger,
    createLogger: (options) => new Logger(options),
    logger: defaultLogger,
    // Convenience exports for default logger
    error: (msg, meta) => defaultLogger.error(msg, meta),
    warn: (msg, meta) => defaultLogger.warn(msg, meta),
    info: (msg, meta) => defaultLogger.info(msg, meta),
    debug: (msg, meta) => defaultLogger.debug(msg, meta)
};