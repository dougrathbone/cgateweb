const { EVENT_REGEX, CGATE_RESPONSE_OBJECT_STATUS, ERROR_PREFIX } = require('./constants');

class CBusEvent {
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

        if (this._rawEvent) {
            this._parse();
        } else {
            // Handle empty input
            console.warn(`${ERROR_PREFIX} Empty C-Bus event data`);
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
                console.warn(`${ERROR_PREFIX} Could not parse C-Bus event: ${this._rawEvent}`);
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
                    console.warn(`${ERROR_PREFIX} Invalid C-Bus address format: ${this._address}`);
                    this._isValid = false;
                }
            } else {
                console.warn(`${ERROR_PREFIX} Missing address in C-Bus event: ${this._rawEvent}`);
                this._isValid = false;
            }

            this._parsed = true;
        } catch (error) {
            console.error(`${ERROR_PREFIX} Error parsing C-Bus event: ${this._rawEvent}`, error);
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
        }

        this._deviceType = 'lighting'; // Assume lighting for status responses
        this._action = (this._level !== null && this._level > 0) ? 'on' : 'off';
        this._parsed = true;
    }

    isValid() {
        return this._isValid;
    }

    isParsed() {
        return this._parsed;
    }

    // Method names matching test expectations
    DeviceType() {
        return this._deviceType;
    }

    Action() {
        return this._action;
    }

    Address() {
        return this._address;
    }

    Level() {
        // Return percentage level (0-100) as string to match test expectations
        if (this._levelRaw !== null) {
            return Math.round((this._levelRaw / 255) * 100).toString();
        }
        // Handle on/off actions when no raw level is available
        if (this._action === 'on') {
            return '100';
        }
        if (this._action === 'off') {
            return '0';
        }
        return '0';
    }

    Host() {
        return this._network;
    }

    Group() {
        return this._application;
    }

    Device() {
        return this._group;
    }

    // Keep new-style getters for internal use
    getDeviceType() {
        return this._deviceType;
    }

    getAction() {
        return this._action;
    }

    getAddress() {
        return this._address;
    }

    getLevel() {
        return this._level;
    }

    getNetwork() {
        return this._network;
    }

    getApplication() {
        return this._application;
    }

    getGroup() {
        return this._group;
    }

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