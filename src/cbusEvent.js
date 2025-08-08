const { createLogger } = require('./logger');
const { EVENT_REGEX, CGATE_RESPONSE_OBJECT_STATUS } = require('./constants');

/**
 * Represents a C-Bus event received from the C-Gate server.
 * 
 * C-Bus events follow the format: "lighting on 254/56/4" or "lighting ramp 254/56/4 128"
 * Where:
 * - lighting = device type (lighting, trigger, etc.)
 * - on/ramp = action being performed
 * - 254/56/4 = network/application/group address
 * - 128 = optional level value (0-255)
 * 
 * This class parses these events and provides structured access to the components.
 * 
 * @example
 * const event = new CBusEvent("lighting on 254/56/4");
 * console.log(event.getDeviceType()); // "lighting"
 * console.log(event.getAction()); // "on"
 * console.log(event.getNetwork()); // "254"
 */
class CBusEvent {
    /**
     * Creates a new CBusEvent instance by parsing a C-Gate event string.
     * 
     * @param {string|Buffer} eventString - The raw event string from C-Gate
     */
    constructor(eventString) {
        // Handle both Buffer and string inputs
        const eventStr = Buffer.isBuffer(eventString) ? eventString.toString() : eventString;
        this._rawEvent = eventStr ? eventStr.trim() : '';
        this._parsed = false;
        this._deviceType = null;
        this._action = null;
        this._address = null;
        this._level = null;
        this._levelRaw = null; // Raw level value for tests
        this._network = null;
        this._application = null;
        this._group = null;
        this._isValid = false;
        this._logger = createLogger({ component: 'CBusEvent' });

        if (this._rawEvent) {
            this._parse();
        } else {
            // Handle empty input
            this._logger.warn(`Empty C-Bus event data`);
            this._parsed = true;
            this._isValid = false;
        }
    }

    _parse() {
        try {
            // Handle status response code (300) differently
            if (this._rawEvent.startsWith(CGATE_RESPONSE_OBJECT_STATUS)) {
                this._parseStatusResponse();
                return;
            }

            // Use regex to parse standard events
            const match = this._rawEvent.match(EVENT_REGEX);
            if (!match) {
                // Not a recognizable event format
                this._logger.warn(`Could not parse C-Bus event: ${this._rawEvent}`);
                this._isValid = false;
                return;
            }

            this._deviceType = match[1] || null;
            this._action = match[2] || null;
            this._address = match[3] || null;
            this._levelRaw = match[4] ? parseInt(match[4], 10) : null;
            this._level = this._levelRaw;

            // Parse address into components
            if (this._address) {
                const addressParts = this._address.split('/');
                if (addressParts.length === 3) {
                    this._network = addressParts[0];
                    this._application = addressParts[1];
                    this._group = addressParts[2];
                    this._isValid = true;
                } else {
                    this._logger.warn(`Invalid C-Bus address format: ${this._address}`);
                    this._isValid = false;
                }
            } else {
                this._logger.warn(`Missing address in C-Bus event: ${this._rawEvent}`);
                this._isValid = false;
            }

            this._parsed = true;
        } catch (error) {
            this._logger.error(`Error parsing C-Bus event: ${this._rawEvent}`, { error });
            this._isValid = false;
            this._parsed = true;
        }
    }

    _parseStatusResponse() {
        // Example: 300 //PROJECT/254/56/1: level=255
        // Extract level information from status responses
        const levelMatch = this._rawEvent.match(/level=(\d+)/);
        if (levelMatch) {
            this._levelRaw = parseInt(levelMatch[1], 10);
            this._level = this._levelRaw;
        }

        // Extract address from status response
        const addressMatch = this._rawEvent.match(/\/\/\w+\/(\d+\/\d+\/\d+):/);
        if (addressMatch) {
            this._address = addressMatch[1];
            const addressParts = this._address.split('/');
            if (addressParts.length === 3) {
                this._network = addressParts[0];
                this._application = addressParts[1];
                this._group = addressParts[2];
                this._isValid = true;
            }
        } else {
            // Invalid status response format
            this._logger.warn(`Invalid status response format: ${this._rawEvent}`);
            this._isValid = false;
        }

        if (this._isValid) {
            this._deviceType = 'lighting'; // Assume lighting for status responses
            this._action = (this._level !== null && this._level > 0) ? 'on' : 'off';
        }
        this._parsed = true;
    }

    /**
     * Checks if the event was successfully parsed and is valid.
     * 
     * @returns {boolean} True if the event has valid C-Bus format and addressing
     */
    isValid() {
        return this._isValid;
    }

    /**
     * Checks if the event has been processed (parsed or failed to parse).
     * 
     * @returns {boolean} True if parsing has been attempted
     */
    isParsed() {
        return this._parsed;
    }

    /**
     * Gets the C-Bus device type from the event.
     * 
     * @returns {string|null} Device type like "lighting", "trigger", etc., or null if invalid
     */
    getDeviceType() {
        return this._deviceType;
    }

    /**
     * Gets the action being performed on the device.
     * 
     * @returns {string|null} Action like "on", "off", "ramp", etc., or null if invalid
     */
    getAction() {
        return this._action;
    }

    /**
     * Gets the full C-Bus address in network/application/group format.
     * 
     * @returns {string|null} Full address like "254/56/4", or null if invalid
     */
    getAddress() {
        return this._address;
    }

    /**
     * Gets the raw level value from the event (for ramp commands).
     * 
     * @returns {number|null} Level value (0-255) or null if not present/invalid
     */
    getLevel() {
        return this._level;
    }

    /**
     * Gets the C-Bus network number from the address.
     * 
     * @returns {string|null} Network number (e.g., "254") or null if invalid
     */
    getNetwork() {
        return this._network;
    }

    /**
     * Gets the C-Bus application number from the address.
     * 
     * @returns {string|null} Application number (e.g., "56" for lighting) or null if invalid
     */
    getApplication() {
        return this._application;
    }

    /**
     * Gets the C-Bus group number from the address.
     * 
     * @returns {string|null} Group number (e.g., "4") or null if invalid
     */
    getGroup() {
        return this._group;
    }

    /**
     * Gets the original raw event string that was parsed.
     * 
     * @returns {string} The original event string from C-Gate
     */
    getRawEvent() {
        return this._rawEvent;
    }

    toString() {
        if (!this._isValid) {
            return `Invalid CBusEvent: ${this._rawEvent}`;
        }
        return `CBusEvent[${this._deviceType} ${this._action} ${this._address}${this._level !== null ? ` level=${this._level}` : ''}]`;
    }
}

module.exports = CBusEvent;