const { 
    COMMAND_TOPIC_REGEX, 
    MQTT_CMD_TYPE_GETALL, 
    MQTT_CMD_TYPE_GETTREE, 
    MQTT_CMD_TYPE_SWITCH, 
    MQTT_CMD_TYPE_RAMP,
    MQTT_STATE_ON,
    MQTT_STATE_OFF,
    MQTT_COMMAND_INCREASE,
    MQTT_COMMAND_DECREASE,
    CGATE_LEVEL_MIN,
    CGATE_LEVEL_MAX,
    RAMP_STEP,
    ERROR_PREFIX
} = require('./constants');

class CBusCommand {
    constructor(topic, payload) {
        // Handle both Buffer and string inputs
        const topicStr = Buffer.isBuffer(topic) ? topic.toString() : topic;
        const payloadStr = Buffer.isBuffer(payload) ? payload.toString() : payload;
        this._topic = topicStr ? topicStr.trim() : '';
        this._payload = payloadStr ? payloadStr.trim() : '';
        this._parsed = false;
        this._isValid = false;
        this._network = null;
        this._application = null;
        this._group = null;
        this._commandType = null;
        this._level = null;
        this._rampTime = null;

        if (this._topic) {
            this._parse();
        } else {
            // Handle empty/null topic
            console.warn(`${ERROR_PREFIX} Empty MQTT command topic`);
            this._parsed = true;
            this._isValid = false;
        }
    }

    _parse() {
        try {
            const match = this._topic.match(COMMAND_TOPIC_REGEX);
            if (!match) {
                console.warn(`${ERROR_PREFIX} Invalid MQTT command topic format: ${this._topic}`);
                this._isValid = false;
                this._parsed = true;
                return;
            }

            this._network = match[1] || null;
            this._application = match[2] || null;
            this._group = match[3] || null;
            this._commandType = match[4] || null;

            // Validate command type
            const validCommandTypes = [MQTT_CMD_TYPE_GETALL, MQTT_CMD_TYPE_GETTREE, MQTT_CMD_TYPE_SWITCH, MQTT_CMD_TYPE_RAMP, 'setvalue'];
            if (!validCommandTypes.includes(this._commandType)) {
                console.warn(`${ERROR_PREFIX} Invalid MQTT command type: ${this._commandType}`);
                this._isValid = false;
                this._parsed = true;
                return;
            }

            // Parse payload based on command type
            this._parsePayload();
            
            this._isValid = true;
            this._parsed = true;
        } catch (error) {
            console.error(`${ERROR_PREFIX} Error parsing MQTT command topic: ${this._topic}`, error);
            this._isValid = false;
            this._parsed = true;
        }
    }

    _parsePayload() {
        switch (this._commandType) {
            case MQTT_CMD_TYPE_SWITCH:
                this._parseSwitchPayload();
                break;
            case MQTT_CMD_TYPE_RAMP:
                this._parseRampPayload();
                break;
            case MQTT_CMD_TYPE_GETALL:
            case MQTT_CMD_TYPE_GETTREE:
            case 'setvalue':
                // These commands don't need payload parsing
                break;
        }
    }

    _parseSwitchPayload() {
        const upperPayload = this._payload.toUpperCase();
        if (upperPayload === MQTT_STATE_ON) {
            this._level = CGATE_LEVEL_MAX;
        } else if (upperPayload === MQTT_STATE_OFF) {
            this._level = CGATE_LEVEL_MIN;
        } else {
            this._isValid = false;
        }
    }

    _parseRampPayload() {
        const upperPayload = this._payload.toUpperCase();
        
        if (upperPayload === MQTT_STATE_ON) {
            this._level = CGATE_LEVEL_MAX;
        } else if (upperPayload === MQTT_STATE_OFF) {
            this._level = CGATE_LEVEL_MIN;
        } else if (upperPayload === MQTT_COMMAND_INCREASE) {
            this._level = 'INCREASE';
        } else if (upperPayload === MQTT_COMMAND_DECREASE) {
            this._level = 'DECREASE';
        } else {
            // Try to parse as percentage or level with optional ramp time
            this._parseRampLevelAndTime();
        }
    }

    _parseRampLevelAndTime() {
        // Handle formats like "50", "50,4s", "100,2m"
        const parts = this._payload.split(',');
        const levelPart = parts[0].trim();
        const timePart = parts[1] ? parts[1].trim() : null;

        // Parse level (percentage)
        const levelValue = parseFloat(levelPart);
        if (isNaN(levelValue)) {
            this._isValid = false;
            return;
        }

        // Clamp percentage to 0-100 range
        const clampedLevel = Math.max(0, Math.min(100, levelValue));
        
        // Convert percentage to C-Gate level (0-255)
        this._level = Math.round((clampedLevel / 100) * CGATE_LEVEL_MAX);

        // Parse ramp time if provided
        if (timePart) {
            this._rampTime = timePart;
        }
    }

    isValid() {
        return this._isValid;
    }

    isParsed() {
        return this._parsed;
    }

    // Test-compatible method names
    Host() {
        return this._network;
    }

    Group() {
        return this._application || '';
    }

    Device() {
        return this._group || '';
    }

    CommandType() {
        return this._commandType;
    }

    RawLevel() {
        return this._level;
    }

    RampTime() {
        return this._rampTime;
    }

    Topic() {
        return this._topic;
    }

    Payload() {
        return this._payload;
    }

    // Additional test-expected methods
    Action() {
        return this._commandType;
    }

    Message() {
        return this._payload;
    }

    Level() {
        // Return percentage level as string, for ramp commands only
        if (this._commandType === MQTT_CMD_TYPE_RAMP && this._level !== null) {
            if (this._level === 'INCREASE' || this._level === 'DECREASE') {
                return null;
            }
            return Math.round((this._level / 255) * 100).toString();
        }
        if (this._commandType === MQTT_CMD_TYPE_SWITCH) {
            if (this._level === CGATE_LEVEL_MAX) return '100';
            if (this._level === CGATE_LEVEL_MIN) return '0';
        }
        return null;
    }

    // Keep new-style getters for internal use
    getNetwork() {
        return this._network;
    }

    getApplication() {
        return this._application;
    }

    getGroup() {
        return this._group;
    }

    getCommandType() {
        return this._commandType;
    }

    getLevel() {
        return this._level;
    }

    getRampTime() {
        return this._rampTime;
    }

    getTopic() {
        return this._topic;
    }

    getPayload() {
        return this._payload;
    }

    toString() {
        if (!this._isValid) {
            return `Invalid CBusCommand: ${this._topic} -> ${this._payload}`;
        }
        return `CBusCommand[${this._commandType} ${this._network}/${this._application}/${this._group}${this._level !== null ? ` level=${this._level}` : ''}${this._rampTime ? ` time=${this._rampTime}` : ''}]`;
    }
}

module.exports = CBusCommand;