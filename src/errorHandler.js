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
}

/**
 * Factory function to create error handlers for different components
 */
function createErrorHandler(component) {
    return new ErrorHandler(component);
}

module.exports = { ErrorHandler, createErrorHandler };
