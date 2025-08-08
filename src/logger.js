class Logger {
    constructor(options = {}) {
        this.component = options.component || 'cgateweb';
        this.enabled = options.enabled !== false;
        
        // Log levels (lower number = higher priority)
        this.levels = {
            error: 0,
            warn: 1, 
            info: 2,
            debug: 3,
            trace: 4 // New trace level for detailed debugging
        };
        
        // Determine log level from environment or options
        this.level = this._determineLogLevel(options.level);
        this.currentLevel = this.levels[this.level] || this.levels.info;
        
        // Development features
        this.isDevelopment = process.env.NODE_ENV !== 'production';
        this.enableColors = this.isDevelopment && process.stdout.isTTY;
        this.enableVerbose = this.isDevelopment || this.level === 'debug' || this.level === 'trace';
    }

    /**
     * Determine log level from environment variables and options
     */
    _determineLogLevel(optionLevel) {
        // Priority: explicit option > environment variable > default
        if (optionLevel) return optionLevel;
        
        const envLevel = process.env.LOG_LEVEL?.toLowerCase();
        if (envLevel && Object.prototype.hasOwnProperty.call(this.levels, envLevel)) {
            return envLevel;
        }
        
        // Default based on environment
        if (process.env.NODE_ENV === 'development') return 'debug';
        if (process.env.NODE_ENV === 'test') return 'warn';
        return 'info';
    }

    _shouldLog(level) {
        return this.enabled && this.levels[level] <= this.currentLevel;
    }

    _formatMessage(level, message, meta = {}) {
        const timestamp = new Date().toISOString();
        const levelStr = level.toUpperCase().padEnd(5);
        const componentStr = this.component ? `[${this.component}]` : '';
        
        // Apply colors in development
        let coloredLevel = levelStr;
        if (this.enableColors) {
            const colors = {
                ERROR: '\x1b[31m', // Red
                WARN:  '\x1b[33m', // Yellow  
                INFO:  '\x1b[36m', // Cyan
                DEBUG: '\x1b[90m', // Gray
                TRACE: '\x1b[90m'  // Gray
            };
            const reset = '\x1b[0m';
            coloredLevel = `${colors[level.toUpperCase()] || ''}${levelStr}${reset}`;
        }
        
        let logLine = `${timestamp} ${coloredLevel} ${componentStr} ${message}`;
        
        // Enhanced metadata formatting for development
        if (Object.keys(meta).length > 0) {
            if (this.enableVerbose) {
                // Pretty print in development
                const metaStr = JSON.stringify(meta, null, 2);
                logLine += `\n${metaStr}`;
            } else {
                // Compact format for production
                const metaStr = JSON.stringify(meta);
                logLine += ` ${metaStr}`;
            }
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
            case 'trace':
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

    trace(message, meta = {}) {
        this._log('trace', message, meta);
    }

    /**
     * Performance timing utility for development.
     * Starts a timer with the given label.
     * 
     * @param {string} label - The timer label
     */
    time(label) {
        if (this.isDevelopment) {
            console.time(`[${this.component}] ${label}`);
        }
    }

    /**
     * Performance timing utility for development.
     * Ends a timer with the given label and logs the elapsed time.
     * 
     * @param {string} label - The timer label
     */
    timeEnd(label) {
        if (this.isDevelopment) {
            console.timeEnd(`[${this.component}] ${label}`);
        }
    }

    /**
     * Creates a child logger with additional context.
     * 
     * @param {Object} [options={}] - Options for the child logger
     * @param {string} [options.component] - Override component name
     * @param {string} [options.level] - Override log level
     * @param {boolean} [options.enabled] - Override enabled state
     * @returns {Logger} A new logger instance with inherited properties
     */
    child(options = {}) {
        return new Logger({
            level: this.level,
            component: options.component || this.component,
            enabled: this.enabled,
            ...options
        });
    }

    /**
     * Sets the log level dynamically.
     * 
     * @param {string} level - The new log level ('error', 'warn', 'info', 'debug', 'trace')
     */
    setLevel(level) {
        if (Object.prototype.hasOwnProperty.call(this.levels, level)) {
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