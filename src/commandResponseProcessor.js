const CBusEvent = require('./cbusEvent');
const { createLogger } = require('./logger');
const {
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
    constructor({ eventPublisher, haDiscovery, onObjectStatus, onCommandError, logger }) {
        this.eventPublisher = eventPublisher;
        this._haDiscovery = haDiscovery || null;
        this._pendingTreeMessages = [];
        this._maxPendingTreeMessages = 500;
        this.onObjectStatus = onObjectStatus;
        this.onCommandError = onCommandError || null;
        this.logger = logger || createLogger({
            component: 'CommandResponseProcessor',
            level: 'info',
            enabled: true
        });
        // Optional handler called for every parsed response during network discovery.
        // Set by BridgeInitializationService._discoverNetworks() and cleared when done.
        this.networkDiscoveryHandler = null;
    }

    get haDiscovery() {
        return this._haDiscovery;
    }

    set haDiscovery(value) {
        this._haDiscovery = value;
        if (value && this._pendingTreeMessages.length > 0) {
            this.logger.info(`Replaying ${this._pendingTreeMessages.length} buffered tree response(s) after HA Discovery initialized`);
            for (const { code, data } of this._pendingTreeMessages) {
                if (code === CGATE_RESPONSE_TREE_START) value.handleTreeStart(data);
                else if (code === CGATE_RESPONSE_TREE_DATA) value.handleTreeData(data);
                else if (code === CGATE_RESPONSE_TREE_END) value.handleTreeEnd(data);
            }
            this._pendingTreeMessages = [];
        }
    }

    /**
     * Processes command data by parsing lines and routing responses.
     * 
     * @param {string} line - Command response line to process
     */
    processLine(line) {
        if (this.logger.isLevelEnabled && this.logger.isLevelEnabled('debug')) {
            this.logger.debug(`C-Gate Recv (Cmd): ${line}`);
        }

        try {
            const parsedResponse = this._parseCommandResponseLine(line);
            if (!parsedResponse) return;

            this._processCommandResponse(parsedResponse.responseCode, parsedResponse.statusData);
        } catch (e) {
            this.logger.error(`Error processing command data line:`, e, `Line: ${line}`); 
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
            const firstSpace = line.indexOf(' ');
            if (firstSpace === -1) {
                responseCode = line.trim();
            } else {
                responseCode = line.substring(0, firstSpace).trim();
                statusData = line.substring(firstSpace + 1).trim();
            }
        }
        
        if (!this._isValidResponseCode(responseCode)) {
             this.logger.debug(`Skipping non-response line: ${line}`);
             return null; 
        }

        return { responseCode, statusData };
    }

    _isValidResponseCode(responseCode) {
        if (!responseCode || responseCode.length !== 3) {
            return false;
        }
        const c0 = responseCode.charCodeAt(0);
        const c1 = responseCode.charCodeAt(1);
        const c2 = responseCode.charCodeAt(2);
        return c0 >= 49 && c0 <= 54 && c1 >= 48 && c1 <= 57 && c2 >= 48 && c2 <= 57;
    }

    /**
     * Routes parsed command responses to appropriate handlers.
     * 
     * @param {string} responseCode - 3-digit C-Gate response code
     * @param {string} statusData - Response data/payload
     */
    _processCommandResponse(responseCode, statusData) {
        // Forward all responses to the network discovery handler if one is active.
        if (this.networkDiscoveryHandler) {
            this.networkDiscoveryHandler(responseCode, statusData);
        }

        switch (responseCode) {
            case CGATE_RESPONSE_OBJECT_STATUS:
                this._processCommandObjectStatus(statusData);
                break;
            case CGATE_RESPONSE_TREE_START:
                if (this._haDiscovery) {
                    this._haDiscovery.handleTreeStart(statusData);
                } else if (this._pendingTreeMessages.length < this._maxPendingTreeMessages) {
                    this.logger.debug(`Buffering tree start (HA Discovery not yet initialized)`);
                    this._pendingTreeMessages.push({ code: CGATE_RESPONSE_TREE_START, data: statusData });
                }
                break;
            case CGATE_RESPONSE_TREE_DATA:
                if (this._haDiscovery) {
                    this._haDiscovery.handleTreeData(statusData);
                } else if (this._pendingTreeMessages.length < this._maxPendingTreeMessages) {
                    this._pendingTreeMessages.push({ code: CGATE_RESPONSE_TREE_DATA, data: statusData });
                }
                break;
            case CGATE_RESPONSE_TREE_END:
                if (this._haDiscovery) {
                    this._haDiscovery.handleTreeEnd(statusData);
                } else if (this._pendingTreeMessages.length < this._maxPendingTreeMessages) {
                    this._pendingTreeMessages.push({ code: CGATE_RESPONSE_TREE_END, data: statusData });
                }
                break;
            default:
                if (responseCode.startsWith('4') || responseCode.startsWith('5')) {
                    this._processCommandErrorResponse(responseCode, statusData);
                } else if (responseCode === '200' || responseCode === '201') {
                    this.logger.debug(`C-Gate info ${responseCode}: ${statusData}`);
                } else {
                    this.logger.debug(`Unhandled C-Gate response ${responseCode}: ${statusData}`);
                }
        }
    }

    /**
     * Processes object status responses from C-Gate commands.
     * 
     * @param {string} statusData - Object status data from C-Gate
     */
    _processCommandObjectStatus(statusData) {
        const event = new CBusEvent(statusData, { statusDataOnly: true });
        if (event.isValid()) {
            this.eventPublisher.publishEvent(event, '(Cmd)');
            if (this.onObjectStatus) {
                this.onObjectStatus(event);
            }
        } else {
            this.logger.warn(`Could not parse object status: ${statusData}`);
        }
    }

    /**
     * Processes error responses from C-Gate commands.
     * 
     * @param {string} responseCode - Error response code (4xx or 5xx)
     * @param {string} statusData - Error details from C-Gate
     */
    _processCommandErrorResponse(responseCode, statusData) {
        const baseMessage = `C-Gate Command Error ${responseCode}:`;
        let hint = '';

        let isWarn = false;
        switch (responseCode) {
            case '400': hint = ' (Bad Request/Syntax Error)'; break;
            case '401': hint = ' (Object Not Found or Unauthorized)'; isWarn = true; break;
            case '404': hint = ' (Not Found - Check Object Path)'; isWarn = true; break;
            case '406': hint = ' (Not Acceptable - Invalid Parameter Value)'; break;
            case '500': hint = ' (Internal Server Error)'; break;
            case '503': hint = ' (Service Unavailable)'; break;
        }

        const detail = statusData ? statusData : 'No details provided';
        const message = `${baseMessage}${hint} - ${detail}`;
        if (isWarn) {
            this.logger.warn(message);
        } else {
            this.logger.error(message);
        }

        if (this.onCommandError) {
            this.onCommandError(responseCode, statusData);
        }
    }
}

module.exports = CommandResponseProcessor;
