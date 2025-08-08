const CBusEvent = require('./cbusEvent');
const { createLogger } = require('./logger');
const {
    LOG_PREFIX,
    WARN_PREFIX,
    ERROR_PREFIX,
    CGATE_RESPONSE_OBJECT_STATUS,
    CGATE_RESPONSE_TREE_START,
    CGATE_RESPONSE_TREE_DATA,
    CGATE_RESPONSE_TREE_END
} = require('./constants');

/**
 * Handles processing of C-Gate command responses.
 * 
 * This class processes responses from the C-Gate command connection,
 * parsing response lines and routing them to appropriate handlers
 * for object status updates, tree data, and error responses.
 */
class CommandResponseProcessor {
    /**
     * Creates a new CommandResponseProcessor instance.
     * 
     * @param {Object} options - Configuration options
     * @param {Object} options.eventPublisher - EventPublisher instance for publishing events
     * @param {Object} options.haDiscovery - HaDiscovery instance for handling tree responses
     * @param {Function} options.onObjectStatus - Callback for object status events
     * @param {Object} [options.logger] - Logger instance (optional)
     */
    constructor({ eventPublisher, haDiscovery, onObjectStatus, logger }) {
        this.eventPublisher = eventPublisher;
        this.haDiscovery = haDiscovery;
        this.onObjectStatus = onObjectStatus;
        this.logger = logger || createLogger({ 
            component: 'CommandResponseProcessor', 
            level: 'info',
            enabled: true 
        });
    }

    /**
     * Processes command data by parsing lines and routing responses.
     * 
     * @param {string} line - Command response line to process
     */
    processLine(line) {
        this.logger.info(`${LOG_PREFIX} C-Gate Recv (Cmd): ${line}`);

        try {
            const parsedResponse = this._parseCommandResponseLine(line);
            if (!parsedResponse) return;

            this._processCommandResponse(parsedResponse.responseCode, parsedResponse.statusData);
        } catch (e) {
            this.logger.error(`${ERROR_PREFIX} Error processing command data line:`, e, `Line: ${line}`); 
        }
    }

    /**
     * Parses a C-Gate command response line into response code and status data.
     * 
     * @param {string} line - Raw response line from C-Gate
     * @returns {Object|null} Parsed response with responseCode and statusData, or null if invalid
     */
    _parseCommandResponseLine(line) {
        let responseCode = '';
        let statusData = '';
        const hyphenIndex = line.indexOf('-');

        if (hyphenIndex > -1 && line.length > hyphenIndex + 1) {
            // C-Gate format: "200-OK" or "300-//PROJECT/254/56/1: level=255"
            responseCode = line.substring(0, hyphenIndex).trim();
            statusData = line.substring(hyphenIndex + 1).trim();
        } else {
            // Alternative format: "200 OK" (space-separated)
            const spaceParts = line.split(' ');
            responseCode = spaceParts[0].trim();
            if (spaceParts.length > 1) {
                 statusData = spaceParts.slice(1).join(' ').trim();
            }
        }
        
        // C-Gate response codes are 3-digit numbers starting with 1-6 (like HTTP status codes)
        if (!responseCode || !/^[1-6]\d{2}$/.test(responseCode)) {
             this.logger.info(`${LOG_PREFIX} Skipping invalid command response line: ${line}`);
             return null; 
        }

        return { responseCode, statusData };
    }

    /**
     * Routes parsed command responses to appropriate handlers.
     * 
     * @param {string} responseCode - 3-digit C-Gate response code
     * @param {string} statusData - Response data/payload
     */
    _processCommandResponse(responseCode, statusData) {
        switch (responseCode) {
            case CGATE_RESPONSE_OBJECT_STATUS:
                this._processCommandObjectStatus(statusData);
                break;
            case CGATE_RESPONSE_TREE_START:
                this.haDiscovery.handleTreeStart(statusData);
                break;
            case CGATE_RESPONSE_TREE_DATA:
                this.haDiscovery.handleTreeData(statusData);
                break;
            case CGATE_RESPONSE_TREE_END:
                this.haDiscovery.handleTreeEnd(statusData);
                break;
            default:
                if (responseCode.startsWith('4') || responseCode.startsWith('5')) {
                    this._processCommandErrorResponse(responseCode, statusData);
                } else {
                    this.logger.info(`${LOG_PREFIX} Unhandled C-Gate response ${responseCode}: ${statusData}`);
                }
        }
    }

    /**
     * Processes object status responses from C-Gate commands.
     * 
     * @param {string} statusData - Object status data from C-Gate
     */
    _processCommandObjectStatus(statusData) {
        const event = new CBusEvent(`${CGATE_RESPONSE_OBJECT_STATUS} ${statusData}`);
        if (event.isValid()) {
            this.eventPublisher.publishEvent(event, '(Cmd)');
            if (this.onObjectStatus) {
                this.onObjectStatus(event);
            }
        } else {
            this.logger.warn(`${WARN_PREFIX} Could not parse object status: ${statusData}`);
        }
    }

    /**
     * Processes error responses from C-Gate commands.
     * 
     * @param {string} responseCode - Error response code (4xx or 5xx)
     * @param {string} statusData - Error details from C-Gate
     */
    _processCommandErrorResponse(responseCode, statusData) {
        const baseMessage = `${ERROR_PREFIX} C-Gate Command Error ${responseCode}:`;
        let hint = '';

        switch (responseCode) {
            case '400': hint = ' (Bad Request/Syntax Error)'; break;
            case '401': hint = ' (Unauthorized - Check Credentials/Permissions)'; break;
            case '404': hint = ' (Not Found - Check Object Path)'; break;
            case '406': hint = ' (Not Acceptable - Invalid Parameter Value)'; break;
            case '500': hint = ' (Internal Server Error)'; break;
            case '503': hint = ' (Service Unavailable)'; break;
        }

        const detail = statusData ? statusData : 'No details provided';
        this.logger.error(`${baseMessage}${hint} - ${detail}`);
    }
}

module.exports = CommandResponseProcessor;
