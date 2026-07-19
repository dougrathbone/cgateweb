// @ts-check
const CBusEvent = require('./cbusEvent');
const { createLogger } = require('./logger');
const {
    CGATE_RESPONSE_OBJECT_STATUS,
    CGATE_RESPONSE_TREE_START,
    CGATE_RESPONSE_TREE_DATA,
    CGATE_RESPONSE_TREE_END,
    CGATE_RESPONSE_SYSTEM_EVENT,
    CGATE_RESPONSE_NETWORK_SYNC_OK
} = require('./constants');

// Strips C-Gate's leading async-event timestamp ("20260504-193110.569 ").
const CGATE_TIMESTAMP_PREFIX = /^\d{8}-\d{6}\.\d+\s+/;
// Extracts the numeric network id from a C-Gate object path "//PROJECT/254 ...".
const CGATE_NETWORK_PATH = /\/\/[^/]+\/(\d+)\b/;

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
     * @param {Function} [options.onCommandError] - Callback for C-Gate command error responses
     * @param {Function} [options.onNetworkState] - Callback for network-level interface/state readings: (networkId, reading) => void
     * @param {Object} [options.logger] - Logger instance (optional)
     */
    constructor({ eventPublisher, haDiscovery, onObjectStatus, onCommandError, onNetworkState, logger }) {
        this.eventPublisher = eventPublisher;
        this._haDiscovery = haDiscovery || null;
        this._pendingTreeMessages = [];
        this._maxPendingTreeMessages = 500;
        this.onObjectStatus = onObjectStatus;
        this.onCommandError = onCommandError || null;
        // Called for network-level interface/state responses
        // ("//PROJECT/254: InterfaceState=running"), used to track CNI/PCI
        // connectivity. Signature: (networkId, { interfaceState?|state? }).
        this.onNetworkState = onNetworkState || null;
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
        // Strip a leading C-Gate timestamp (e.g. "20260504-193110.569 ").
        // Asynchronous notifications enabled by EVENT ON arrive on the command
        // port with this prefix; without stripping it the hyphen-first split
        // below would land in the date instead of the response code.
        const stripped = (line || '').replace(CGATE_TIMESTAMP_PREFIX, '');

        // C-Gate response codes are exactly 3 digits at the start of the line,
        // followed by either '-' (e.g. "200-OK") or ' ' (e.g. "742 //PROJECT
        // /254 ... Network created ..."), or end-of-string. Pinning to
        // positions 0-2 avoids mis-parsing payloads with later hyphens (UUIDs).
        const trimmed = stripped.trim();
        const responseCode = trimmed.substring(0, 3);
        if (trimmed.length < 3 || !this._isValidResponseCode(responseCode)) {
            this.logger.debug(`Skipping non-response line: ${line}`);
            return null;
        }
        const separator = trimmed.charAt(3);
        if (separator && separator !== '-' && separator !== ' ') {
            // Position 3 must be the start of the data section, not another
            // digit (which would mean the "code" is part of a 4+ digit number).
            this.logger.debug(`Skipping non-response line: ${line}`);
            return null;
        }
        // Strip the separator and any surrounding whitespace.
        const statusData = trimmed.substring(3).replace(/^\s*-?\s*/, '');
        return { responseCode, statusData: statusData.trim() };
    }

    _isValidResponseCode(responseCode) {
        if (!responseCode || responseCode.length !== 3) {
            return false;
        }
        // C-Gate codes span 1xx-9xx: 1xx informational, 2xx success, 3xx
        // multi-line (tree), 4xx/5xx errors, 7xx/8xx async system events
        // (network created, connection events), 9xx job lifecycle.
        const c0 = responseCode.charCodeAt(0);
        const c1 = responseCode.charCodeAt(1);
        const c2 = responseCode.charCodeAt(2);
        return c0 >= 49 && c0 <= 57 && c1 >= 48 && c1 <= 57 && c2 >= 48 && c2 <= 57;
    }

    /**
     * Routes parsed command responses to appropriate handlers.
     * 
     * @param {string} responseCode - 3-digit C-Gate response code
     * @param {string} statusData - Response data/payload
     */
    _processCommandResponse(responseCode, statusData) {
        // Forward all responses to the network discovery handler if one is active.
        // If the handler claims the response (returns true), skip default routing —
        // this avoids logging an ERROR for the 4xx that auto-discovery already handled.
        if (this.networkDiscoveryHandler) {
            if (this.networkDiscoveryHandler(responseCode, statusData) === true) {
                return;
            }
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
            case CGATE_RESPONSE_SYSTEM_EVENT:
                this._processSystemEvent(statusData);
                break;
            case CGATE_RESPONSE_NETWORK_SYNC_OK:
                this._processNetworkSyncComplete(statusData);
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
     * Processes async system event lines (response code 742). C-Gate emits
     * these for tag/network changes; we route two sub-types to HaDiscovery:
     *
     *   "Network created"  — a network has finished loading; refresh discovery
     *                        immediately rather than waiting on the v1.8.1
     *                        retry backoff.
     *   "Network removed" / "Network deleted" — a network is gone; clear all
     *                        retained HA Discovery config topics for it so the
     *                        entities don't linger in HA forever.
     *
     * Example payload:
     *   "//12LESLIE/254 c2211b00-... Network created type=cni address=..."
     */
    _processSystemEvent(statusData) {
        const data = statusData || '';
        const lifecycle = data.match(/Network (created|removed|deleted)/i);
        if (!lifecycle) {
            this.logger.debug(`C-Gate system event 742 (no action): ${data}`);
            return;
        }
        const pathMatch = data.match(CGATE_NETWORK_PATH);
        if (!pathMatch) {
            this.logger.debug(`C-Gate system event 742 (${lifecycle[1]}, but no network id parsed): ${data}`);
            return;
        }
        if (!this._haDiscovery) return;

        const networkId = pathMatch[1];
        if (/created/i.test(lifecycle[1])) {
            this._haDiscovery.handleNetworkCreated(networkId);
        } else {
            this._haDiscovery.handleNetworkRemoved(networkId);
        }
    }

    /**
     * Processes async "Network sync ok" events (response code 762). C-Gate
     * emits one when a network finishes synchronising with the C-Bus
     * interface; the tree is only fully populated after that point, so HA
     * Discovery re-fetches it to pick up groups that were still empty
     * (unsynced) at startup (issue #25).
     *
     * Example payload: "//PROJECT/254 Network sync ok"
     */
    _processNetworkSyncComplete(statusData) {
        const data = statusData || '';
        const pathMatch = data.match(CGATE_NETWORK_PATH);
        if (!pathMatch) {
            this.logger.debug(`C-Gate sync complete event 762 (no network id parsed): ${data}`);
            return;
        }
        if (!this._haDiscovery) return;

        this._haDiscovery.handleNetworkSyncComplete(pathMatch[1]);
    }

    /**
     * Processes object status responses from C-Gate commands.
     *
     * @param {string} statusData - Object status data from C-Gate
     */
    _processCommandObjectStatus(statusData) {
        // Network-level interface/state responses ("//PROJECT/254: InterfaceState=running",
        // "//PROJECT/254: State=ok") have no group address and are not CBusEvents —
        // route them to the network-interface monitor before attempting event parsing.
        const netState = this._parseNetworkStateStatus(statusData);
        if (netState) {
            if (this.onNetworkState) this.onNetworkState(netState.networkId, netState.reading);
            return;
        }

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
     * Parses a network-level interface/state status response, e.g.
     *   "//5COGAN/254: InterfaceState=running"
     *   "//5COGAN/254: State=ok"
     * Distinguished from object (group) status by having no group address after
     * the network id. Returns { networkId, reading } or null.
     *
     * @private
     */
    _parseNetworkStateStatus(statusData) {
        const m = /^\/\/[^/]+\/(\d+):\s*(InterfaceState|State)=(\S+)\s*$/.exec(statusData || '');
        if (!m) return null;
        const [, networkId, key, value] = m;
        const reading = key === 'InterfaceState' ? { interfaceState: value } : { state: value };
        return { networkId, reading };
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
