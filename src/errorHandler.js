const { createLogger } = require('./logger');

/**
 * Centralized error handling utilities for consistent error management
 */
class ErrorHandler {
    constructor(component) {
        this.logger = createLogger(component);
        this.component = component;
    }

    /**
     * Handle and log an error with context
     * @param {Error} error - The error to handle
     * @param {Object} context - Additional context about the error
     * @param {string} action - What action was being performed when error occurred
     * @param {boolean} fatal - Whether this should terminate the process
     */
    handle(error, context = {}, action = null, fatal = false) {
        const errorContext = {
            component: this.component,
            action: action,
            errorName: error.name || 'Error',
            errorMessage: error.message,
            stack: error.stack,
            ...context
        };

        this.logger.error(`Error ${action ? `during ${action}` : 'occurred'}:`, errorContext);

        if (fatal) {
            this.logger.error('Fatal error detected, terminating process', { component: this.component });
            process.exit(1);
        }
    }

    /**
     * Handle connection-related errors with automatic retry logic
     * @param {Error} error - Connection error
     * @param {Object} context - Connection context (host, port, etc.)
     * @param {Function} retryCallback - Function to call for retry
     * @param {number} retryCount - Current retry attempt
     * @param {number} maxRetries - Maximum retry attempts
     */
    handleConnectionError(error, context = {}, retryCallback = null, retryCount = 0, maxRetries = 3) {
        const isRetryable = this._isRetryableError(error);
        const shouldRetry = isRetryable && retryCount < maxRetries && retryCallback;

        this.handle(error, {
            ...context,
            retryCount,
            maxRetries,
            isRetryable,
            willRetry: shouldRetry
        }, 'connection attempt');

        if (shouldRetry) {
            const delay = this._calculateRetryDelay(retryCount);
            this.logger.info(`Retrying connection in ${delay}ms`, { 
                component: this.component, 
                attempt: retryCount + 1,
                maxRetries 
            });
            setTimeout(() => retryCallback(), delay);
        }

        return !shouldRetry; // Returns true if no more retries will be attempted
    }

    /**
     * Handle validation errors with detailed field information
     * @param {Error} error - Validation error
     * @param {Object} data - The data that failed validation
     * @param {string} field - Specific field that failed (if applicable)
     */
    handleValidationError(error, data = {}, field = null) {
        this.handle(error, {
            field,
            dataKeys: Object.keys(data),
            validationType: 'input'
        }, 'validation');
    }

    /**
     * Handle parsing errors with input context
     * @param {Error} error - Parsing error
     * @param {string} input - The input that failed to parse
     * @param {string} expectedFormat - What format was expected
     */
    handleParsingError(error, input = '', expectedFormat = null) {
        this.handle(error, {
            inputLength: input.length,
            inputPreview: input.substring(0, 100), // First 100 chars for debugging
            expectedFormat
        }, 'parsing');
    }

    /**
     * Wrap async functions with standardized error handling
     * @param {Function} asyncFn - The async function to wrap
     * @param {string} action - Description of what the function does
     * @param {Object} context - Additional context for errors
     * @returns {Function} - Wrapped function
     */
    wrapAsync(asyncFn, action, context = {}) {
        return async (...args) => {
            try {
                return await asyncFn.apply(this, args);
            } catch (error) {
                this.handle(error, context, action);
                throw error; // Re-throw so caller can decide how to proceed
            }
        };
    }

    /**
     * Create a promise that rejects after a timeout
     * @param {number} timeoutMs - Timeout in milliseconds
     * @param {string} operation - Description of the operation
     * @returns {Promise} - Promise that rejects on timeout
     */
    createTimeoutPromise(timeoutMs, operation = 'operation') {
        return new Promise((_, reject) => {
            setTimeout(() => {
                const error = new Error(`${operation} timed out after ${timeoutMs}ms`);
                error.code = 'TIMEOUT';
                reject(error);
            }, timeoutMs);
        });
    }

    /**
     * Check if an error is retryable (network issues, temporary failures)
     * @private
     */
    _isRetryableError(error) {
        const retryableCodes = ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH'];
        const retryableMessages = ['timeout', 'network', 'connection'];
        
        return retryableCodes.includes(error.code) || 
               retryableMessages.some(msg => error.message.toLowerCase().includes(msg));
    }

    /**
     * Calculate exponential backoff delay for retries
     * @private
     */
    _calculateRetryDelay(retryCount) {
        const baseDelay = 1000; // 1 second
        const maxDelay = 30000; // 30 seconds
        const delay = Math.min(baseDelay * Math.pow(2, retryCount), maxDelay);
        // Add jitter to prevent thundering herd
        return delay + Math.random() * 1000;
    }
}

/**
 * Factory function to create error handlers for different components
 */
function createErrorHandler(component) {
    return new ErrorHandler(component);
}

module.exports = { ErrorHandler, createErrorHandler };
