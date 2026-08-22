// @ts-check
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

    isLevelEnabled(level) {
        return this._shouldLog(level);
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
        
        let logLine = `${timestamp} ${coloredLevel} ${componentStr} ${this._toSingleLine(message)}`;

        // Enhanced metadata formatting for development
        if (Object.keys(meta).length > 0) {
            // Redact sensitive values (passwords, tokens, secrets) before they
            // can reach the console. Credentials flow from the environment into
            // settings, and a settings-derived object passed as meta would
            // otherwise be logged in clear text.
            const safeMeta = this._redactSensitive(meta);
            if (this.enableVerbose) {
                // Pretty print in development
                const metaStr = JSON.stringify(safeMeta, null, 2);
                logLine += `\n${metaStr}`;
            } else {
                // Compact format for production
                const metaStr = JSON.stringify(safeMeta);
                logLine += ` ${metaStr}`;
            }
        }

        return logLine;
    }

    /**
     * Accept a string (or array) as the second argument without treating it
     * as metadata. Callers historically wrote logger.warn('text:', err.message)
     * and Object.keys on a string produced per-character keys plus a stray
     * JSON blob. Fold those into the message so _toSingleLine sanitizes them.
     * @private
     */
    _coerceLogArgs(message, meta) {
        if (meta === undefined || meta === null) {
            return [message, {}];
        }
        if (typeof meta === 'object' && !Array.isArray(meta)) {
            return [message, meta];
        }
        const extra = typeof meta === 'string' ? meta : JSON.stringify(meta);
        return [`${message} ${extra}`, {}];
    }

    /**
     * Collapse a message onto one line.
     *
     * Plenty of what gets logged here started life outside the process: a
     * C-Gate response line, an MQTT topic, the message of a socket error. A
     * line break in any of those lets the remote end append what looks like a
     * whole extra log entry (CWE-117), so breaks become a visible separator
     * and the result is then stripped of anything that still parses as one.
     * Structured metadata is exempt: JSON.stringify escapes breaks already,
     * and verbose mode deliberately pretty-prints it across lines.
     */
    _toSingleLine(message) {
        const text = typeof message === 'string' ? message : String(message);
        return text.replace(/[\r\n]+/g, ' | ').replace(/\n/g, '');
    }

    /**
     * Return a copy of a metadata value with sensitive fields redacted. Recurses
     * into plain objects and arrays; non-plain objects (e.g. Error instances) are
     * left untouched so they stringify exactly as before.
     */
    _redactSensitive(value, depth = 0) {
        if (depth > 6 || value === null || typeof value !== 'object') {
            return value;
        }
        if (Array.isArray(value)) {
            return value.map((item) => this._redactSensitive(item, depth + 1));
        }
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) {
            return value;
        }
        // Null prototype: metadata is sometimes a parsed JSON body, and a
        // `__proto__` key in one would otherwise set the copy's prototype
        // instead of a property. Own keys are all kept either way.
        const redacted = Object.create(null);
        for (const [key, val] of Object.entries(value)) {
            redacted[key] = Logger.SENSITIVE_KEY_PATTERN.test(key)
                ? '[REDACTED]'
                : this._redactSensitive(val, depth + 1);
        }
        return redacted;
    }

    _log(level, message, meta = {}) {
        if (!this._shouldLog(level)) {
            return;
        }

        const [text, metadata] = this._coerceLogArgs(message, meta);
        const formattedMessage = this._formatMessage(level, text, metadata);
        
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

/**
 * Resolve the logger level from runtime settings.
 *
 * Uses schema defaults via resolveSetting so an unset log_level becomes
 * 'info'. The legacy `logging` boolean is only consulted when log_level
 * resolves to a falsy value (historic `log_level || (logging ? 'info' : 'warn')`).
 *
 * @param {Object|null|undefined} settings
 * @returns {string}
 */
function resolveLogLevelFromSettings(settings) {
    const { resolveSetting } = require('./config/schema');
    const level = resolveSetting(settings || {}, 'log_level');
    if (level) return level;
    return resolveSetting(settings || {}, 'logging') ? 'info' : 'warn';
}

// Metadata keys whose values must never be written to logs in clear text.
Logger.SENSITIVE_KEY_PATTERN = /pass|secret|token|credential|api[-_]?key|auth/i;

// Create default logger instance
const defaultLogger = new Logger();

// Export both the class and default instance
module.exports = {
    Logger,
    createLogger: (options) => new Logger(options),
    resolveLogLevelFromSettings,
    logger: defaultLogger,
    // Convenience exports for default logger
    error: (msg, meta) => defaultLogger.error(msg, meta),
    warn: (msg, meta) => defaultLogger.warn(msg, meta),
    info: (msg, meta) => defaultLogger.info(msg, meta),
    debug: (msg, meta) => defaultLogger.debug(msg, meta)
};