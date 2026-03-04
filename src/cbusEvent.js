const { createLogger } = require('./logger');
const { EVENT_REGEX, CGATE_RESPONSE_OBJECT_STATUS } = require('./constants');

const logger = createLogger({ component: 'CBusEvent' });

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
    constructor(eventString, options = {}) {
        // Handle both Buffer and string inputs
        const eventStr = Buffer.isBuffer(eventString) ? eventString.toString() : eventString;
        this._rawEvent = eventStr ? eventStr.trim() : '';
        this._statusDataOnly = options.statusDataOnly === true;
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
        this._logger = logger;

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
            if (this._statusDataOnly) {
                this._parseStatusResponse();
                return;
            }

            // Handle status response code (300) differently
            if (this._rawEvent.startsWith(CGATE_RESPONSE_OBJECT_STATUS)) {
                this._parseStatusResponse();
                return;
            }

            if (this._parseStandardEventFastPath()) {
                this._parsed = true;
                return;
            }

            // Use regex to parse standard events
            const match = this._rawEvent.match(EVENT_REGEX);
            if (!match) {
                // Not a recognizable event format
                this._logger.warn(`Could not parse C-Bus event: ${this._rawEvent}`);
                this._isValid = false;
                this._parsed = true;
                return;
            }

            this._deviceType = match[1] || null;
            this._action = match[2] || null;
            this._address = match[3] || null;
            this._levelRaw = this._extractLeadingInt(match[4]);
            this._level = this._levelRaw;

            // Parse address into components
            if (!this._applyAddress(this._address)) {
                this._logger.warn(`Missing address in C-Bus event: ${this._rawEvent}`);
            }

            this._parsed = true;
        } catch (error) {
            this._logger.error(`Error parsing C-Bus event: ${this._rawEvent}`, { error });
            this._isValid = false;
            this._parsed = true;
        }
    }

    _parseStandardEventFastPath() {
        const firstSpace = this._rawEvent.indexOf(' ');
        if (firstSpace <= 0) return false;
        const secondSpace = this._rawEvent.indexOf(' ', firstSpace + 1);
        if (secondSpace <= firstSpace + 1) return false;

        const deviceType = this._rawEvent.slice(0, firstSpace);
        const action = this._rawEvent.slice(firstSpace + 1, secondSpace);
        if (!deviceType || !action) return false;

        const restStart = secondSpace + 1;
        if (restStart >= this._rawEvent.length) return false;
        const thirdSpace = this._rawEvent.indexOf(' ', restStart);
        const addressToken = thirdSpace === -1
            ? this._rawEvent.slice(restStart)
            : this._rawEvent.slice(restStart, thirdSpace);
        if (!addressToken) return false;

        const addressComponents = this._extractAddressComponents(addressToken);
        if (!addressComponents) return false;

        this._deviceType = deviceType;
        this._action = action;
        this._applyAddressComponents(
            addressComponents.network,
            addressComponents.application,
            addressComponents.group
        );

        if (thirdSpace !== -1 && thirdSpace + 1 < this._rawEvent.length) {
            const fourthSpace = this._rawEvent.indexOf(' ', thirdSpace + 1);
            const levelToken = fourthSpace === -1
                ? this._rawEvent.slice(thirdSpace + 1)
                : this._rawEvent.slice(thirdSpace + 1, fourthSpace);
            if (levelToken) {
                this._levelRaw = this._extractLeadingInt(levelToken);
                this._level = this._levelRaw;
            }
        }

        return true;
    }

    _extractAddress(addressToken) {
        const components = this._extractAddressComponents(addressToken);
        if (!components) return null;
        return `${components.network}/${components.application}/${components.group}`;
    }

    _extractAddressComponents(addressToken) {
        // Handle both "254/56/1" and "//PROJECT/254/56/1"
        const normalized = addressToken.startsWith('//')
            ? addressToken.slice(addressToken.indexOf('/', 2) + 1)
            : addressToken;
        if (!normalized) return null;

        const firstSlash = normalized.indexOf('/');
        if (firstSlash <= 0) return null;
        const secondSlash = normalized.indexOf('/', firstSlash + 1);
        if (secondSlash <= firstSlash + 1) return null;

        const network = normalized.slice(0, firstSlash);
        const application = normalized.slice(firstSlash + 1, secondSlash);

        let thirdPartEnd = normalized.indexOf('/', secondSlash + 1);
        if (thirdPartEnd === -1) {
            thirdPartEnd = normalized.length;
        }
        const group = normalized.slice(secondSlash + 1, thirdPartEnd);

        if (!this._isDigits(network) || !this._isDigits(application) || !this._isDigits(group)) {
            return null;
        }

        return { network, application, group };
    }

    _extractLeadingInt(value) {
        if (value === undefined || value === null) return null;
        const str = String(value);
        let end = 0;
        while (end < str.length) {
            const code = str.charCodeAt(end);
            if (code < 48 || code > 57) {
                break;
            }
            end += 1;
        }
        if (end === 0) return null;
        return parseInt(str.slice(0, end), 10);
    }

    _applyAddress(address) {
        if (!address) return false;
        const addressParts = address.split('/');
        if (addressParts.length !== 3) {
            this._logger.warn(`Invalid C-Bus address format: ${address}`);
            this._isValid = false;
            return false;
        }
        this._address = address;
        this._network = addressParts[0];
        this._application = addressParts[1];
        this._group = addressParts[2];
        this._isValid = true;
        return true;
    }

    _applyAddressComponents(network, application, group) {
        this._address = `${network}/${application}/${group}`;
        this._network = network;
        this._application = application;
        this._group = group;
        this._isValid = true;
    }

    _isDigits(value) {
        if (!value) return false;
        for (let i = 0; i < value.length; i += 1) {
            const code = value.charCodeAt(i);
            if (code < 48 || code > 57) {
                return false;
            }
        }
        return true;
    }

    _parseStatusResponse() {
        // Example: "300 //PROJECT/254/56/1: level=255"
        const markerIndex = this._rawEvent.indexOf('//');
        const colonIndex = this._rawEvent.indexOf(':', markerIndex);
        if (markerIndex !== -1 && colonIndex !== -1) {
            const addressRegion = this._rawEvent.slice(markerIndex, colonIndex);
            // Fast parse of trailing network/application/group without regex.
            const lastSlash = addressRegion.lastIndexOf('/');
            const secondSlash = lastSlash > -1 ? addressRegion.lastIndexOf('/', lastSlash - 1) : -1;
            const thirdSlash = secondSlash > -1 ? addressRegion.lastIndexOf('/', secondSlash - 1) : -1;
            if (thirdSlash > -1) {
                const network = addressRegion.slice(thirdSlash + 1, secondSlash);
                const application = addressRegion.slice(secondSlash + 1, lastSlash);
                const group = addressRegion.slice(lastSlash + 1);
                if (this._isDigits(network) && this._isDigits(application) && this._isDigits(group)) {
                    this._applyAddressComponents(network, application, group);
                }
            }
        }

        if (!this._isValid) {
            // Invalid status response format
            this._logger.warn(`Invalid status response format: ${this._rawEvent}`);
            this._isValid = false;
        }

        const levelIndex = this._rawEvent.indexOf('level=');
        if (levelIndex !== -1) {
            const levelPart = this._rawEvent.slice(levelIndex + 6);
            this._levelRaw = this._extractLeadingInt(levelPart);
            if (this._levelRaw !== null) {
                this._level = this._levelRaw;
            }
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