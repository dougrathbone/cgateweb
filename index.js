const mqtt = require('mqtt'), url = require('url');
const net = require('net');
const events = require('events');
const parseString = require('xml2js').parseString;

// --- Default Settings (can be overridden by ./settings.js) ---
const defaultSettings = {
    mqtt: 'localhost:1883',
    cbusip: 'your-cgate-ip', // Default C-Gate IP address
    cbusname: 'CLIPSAL', // Default C-Gate project name
    cbuscommandport: 20023,
    cbuseventport: 20025,
    retainreads: false,
    logging: true,
    messageinterval: 200,
    getallnetapp: null, // e.g., 'Lighting' or '56'
    getallonstart: false,
    getallperiod: null, // Period in seconds
    mqttusername: null,
    mqttpassword: null,
    reconnectinitialdelay: 1000, // 1 second
    reconnectmaxdelay: 60000, // 60 seconds
    // --- HA Discovery Settings ---
    ha_discovery_enabled: false, // Default disabled
    ha_discovery_prefix: 'homeassistant', // Default HA prefix
    ha_discovery_networks: [], // Default: Discover no networks explicitly
    ha_discovery_cover_app_id: '203', // Default App ID for Enable Control (Covers)
    ha_discovery_switch_app_id: null, // Default: Don't discover switches
    ha_discovery_relay_app_id: null, // Default: Don't discover relays
    ha_discovery_pir_app_id: null // Default: Don't discover PIR motion sensors
};

// --- Load User Settings ---
let userSettings = {};
try {
    userSettings = require('./settings.js');
    // Optional: Log success if needed for debugging
    // console.log(`${LOG_PREFIX} Loaded settings from ./settings.js`);
} catch (e) {
    // Log an error if settings file is missing or fails to load/parse
    if (e.code === 'MODULE_NOT_FOUND') {
        // Specific error for missing file
        console.error(`${ERROR_PREFIX} Configuration file ./settings.js not found. Using default settings.`);
    } else {
        // Generic error for other issues (e.g., syntax error in settings.js)
        console.error(`${ERROR_PREFIX} Error loading ./settings.js: ${e.message}. Using default settings.`);
    }
    // We keep userSettings as {} and merge with defaults later.
}

// --- Constants ---
const LOG_PREFIX = '[INFO]';
const WARN_PREFIX = '[WARN]';
const ERROR_PREFIX = '[ERROR]';
const DEFAULT_CBUS_APP_LIGHTING = '56'; // Standard C-Bus Lighting Application ID

// MQTT Topics & Payloads
const MQTT_TOPIC_PREFIX_CBUS = 'cbus';
const MQTT_TOPIC_PREFIX_READ = `${MQTT_TOPIC_PREFIX_CBUS}/read`;
const MQTT_TOPIC_PREFIX_WRITE = `${MQTT_TOPIC_PREFIX_CBUS}/write`;
const MQTT_TOPIC_SUFFIX_STATE = 'state';
const MQTT_TOPIC_SUFFIX_LEVEL = 'level';
const MQTT_TOPIC_SUFFIX_TREE = 'tree';
const MQTT_TOPIC_STATUS = 'hello/cgateweb';
const MQTT_PAYLOAD_STATUS_ONLINE = 'Online';
const MQTT_TOPIC_MANUAL_TRIGGER = `${MQTT_TOPIC_PREFIX_WRITE}/bridge/announce`;
const MQTT_STATE_ON = 'ON';
const MQTT_STATE_OFF = 'OFF';
const MQTT_COMMAND_INCREASE = 'INCREASE';
const MQTT_COMMAND_DECREASE = 'DECREASE';

// C-Gate Commands & Parameters
const CGATE_CMD_ON = 'ON';
const CGATE_CMD_OFF = 'OFF';
const CGATE_CMD_RAMP = 'RAMP';
const CGATE_CMD_GET = 'GET';
const CGATE_CMD_TREEXML = 'TREEXML';
const CGATE_CMD_EVENT_ON = 'EVENT ON';
const CGATE_PARAM_LEVEL = 'level';
const CGATE_LEVEL_MIN = 0;
const CGATE_LEVEL_MAX = 255;
const RAMP_STEP = Math.round(CGATE_LEVEL_MAX * 0.1); // Approx 10% step for INCREASE/DECREASE

// C-Gate Responses
const CGATE_RESPONSE_OBJECT_STATUS = '300';
const CGATE_RESPONSE_TREE_START = '343';
const CGATE_RESPONSE_TREE_END = '344';
const CGATE_RESPONSE_TREE_DATA = '347';

// MQTT Command Types (from topic)
const MQTT_CMD_TYPE_GETALL = 'getall';
const MQTT_CMD_TYPE_GETTREE = 'gettree';
const MQTT_CMD_TYPE_SWITCH = 'switch';
const MQTT_CMD_TYPE_RAMP = 'ramp';

// Home Assistant Discovery
const HA_COMPONENT_LIGHT = 'light';
const HA_COMPONENT_COVER = 'cover';
const HA_COMPONENT_SWITCH = 'switch';
const HA_DISCOVERY_SUFFIX = 'config';
const HA_DEVICE_CLASS_SHUTTER = 'shutter';
const HA_DEVICE_CLASS_OUTLET = 'outlet';
const HA_DEVICE_VIA = 'cgateweb_bridge';
const HA_DEVICE_MANUFACTURER = 'Clipsal C-Bus via cgateweb';
const HA_MODEL_LIGHTING = 'Lighting Group';
const HA_MODEL_COVER = 'Enable Control Group (Cover)';
const HA_MODEL_SWITCH = 'Enable Control Group (Switch)';
const HA_MODEL_RELAY = 'Enable Control Group (Relay)';
const HA_MODEL_PIR = 'PIR Motion Sensor'; // Added PIR Model
const HA_ORIGIN_NAME = 'cgateweb';
const HA_ORIGIN_SW_VERSION = '0.1.0'; // TODO: Replace with dynamic version
const HA_ORIGIN_SUPPORT_URL = 'https://github.com/dougrathbone/cgateweb';

// System
const MQTT_ERROR_AUTH = 5; // MQTT CONNACK code 5: Not authorized
const NEWLINE = '\n';

// Regex for Parsing
// Matches: <DeviceType> <Action> <Net/App/Group> [<Level>]
// Assumes single spaces as separators for main parts.
// Captures: 1:DeviceType, 2:Action, 3:Address(Net/App/Group), 4:Optional Level
// Updated to optionally handle //PROJECT/ prefix in address part from some event streams
// Further refined regex structure for robustness
const EVENT_REGEX = /^(\w+)\s+(\w+)\s+(?:(?:\/\/\w+\/)?(\d+\/\d+\/\d+))(?:\s+(\d+))?/;
// Matches: cbus/write/<Net>/<App>/<Group>/<CommandType>
// Allows empty Net/App/Group parts.
// Captures: 1:Net, 2:App, 3:Group, 4:CommandType
const COMMAND_TOPIC_REGEX = /^cbus\/write\/(\w*)\/(\w*)\/(\w*)\/(\w+)/; // Corrected: Escaped forward slashes

// Throttled Queue Implementation
// Ensures messages are sent to C-Gate/MQTT broker with a minimum interval.
class ThrottledQueue {
    constructor(processFn, intervalMs, name = 'Queue') {
        if (typeof processFn !== 'function') {
            throw new Error(`processFn for ${name} must be a function`);
        }
        if (typeof intervalMs !== 'number' || intervalMs <= 0) {
            throw new Error(`intervalMs for ${name} must be a positive number`);
        }
        this._processFn = processFn;
        this._intervalMs = intervalMs;
        this._queue = [];
        this._interval = null; // Use interval timer ID again
        this._name = name;
        this._isProcessing = false; // Still useful to prevent concurrency issues
    }

    add(item) {
        this._queue.push(item);
        // Start processing if not already running and interval not set
        if (this._interval === null && !this._isProcessing) {
            // Process immediately if possible
            this._process();
            // Start interval if queue still has items
            if (this._queue.length > 0 && this._interval === null) {
                this._interval = setInterval(() => this._process(), this._intervalMs);
            }
        }
    }

    _process() {
        if (this._isProcessing) return; // Prevent re-entrancy

        if (this._queue.length === 0) {
            // Stop interval if queue is empty
            if (this._interval !== null) {
                clearInterval(this._interval);
                this._interval = null;
            }
            return;
        }

        this._isProcessing = true;
        const item = this._queue.shift();

        try {
            this._processFn(item);
        } catch (error) {
            console.error(`${ERROR_PREFIX} Error processing ${this._name} item:`, error, "Item:", item);
        } finally {
            this._isProcessing = false;
            // If queue is now empty, ensure interval is cleared
            if (this._queue.length === 0 && this._interval !== null) {
                 clearInterval(this._interval);
                 this._interval = null;
             }
            // If queue not empty but interval got cleared somehow, restart it
             else if (this._queue.length > 0 && this._interval === null) {
                 this._interval = setInterval(() => this._process(), this._intervalMs);
             }
        }
    }

    get length() {
        return this._queue.length;
    }

    isEmpty() {
        return this._queue.length === 0;
    }

    clear() {
        this._queue = [];
        if (this._interval !== null) {
            clearInterval(this._interval);
            this._interval = null;
        }
        this._isProcessing = false; // Reset flag
    }
}

// Represents a C-Bus event received from C-Gate (usually event port, or 300- responses)
class CBusEvent {
    constructor(data) {
        const dataStr = data.toString();
        // Initialize properties
        this._isValid = false;
        this._deviceType = null;
        this._action = null;
        this._host = null;
        this._group = null;
        this._device = null;
        this._levelRaw = null;
        
        try {
            // 1. Split by double space first to isolate main event part
            const mainPartStr = dataStr.split("  ")[0];
            // 2. Split main part by one or more whitespace chars, filter empty strings
            const mainParts = mainPartStr.split(/\s+/).filter(part => part !== '');

            if (mainParts.length < 3) {
                throw new Error(`Not enough parts after splitting by space (found ${mainParts.length})`);
            }

            this._deviceType = mainParts[0];
            this._action = mainParts[1];
            
            // 3. Identify potential address part
            let addressPartRaw = mainParts[2];
            
            // Strip trailing # comments from address part if present
            const hashIndex = addressPartRaw.indexOf('#');
            if (hashIndex !== -1) {
                addressPartRaw = addressPartRaw.substring(0, hashIndex);
            }
            
            let addressPartSimple = addressPartRaw;

            // 4. Handle optional //PROJECT/ prefix
            if (addressPartRaw.startsWith('//')) {
                const pathParts = addressPartRaw.split('/');
                if (pathParts.length >= 5) { // e.g., ['', '', project, net, app, group]
                    // Reconstruct NET/APP/GROUP from expected indices
                    addressPartSimple = `${pathParts[3]}/${pathParts[4]}/${pathParts[5]}`;
                } else {
                    throw new Error(`Invalid full path format: ${addressPartRaw}`);
                }
            }

            // 5. Split the simple address
            const addressParts = addressPartSimple.split('/');
            if (addressParts.length !== 3) {
                throw new Error(`Address part does not contain 3 components: ${addressPartSimple}`);
            }
            
            // 6. Extract host, group, device
            this._host = addressParts[0];
            this._group = addressParts[1];
            this._device = addressParts[2];

            // 7. Parse optional level (specifically from index 3)
            if (mainParts.length > 3) {
                const levelStr = mainParts[3];
                if (!isNaN(parseInt(levelStr))) {
                    this._levelRaw = parseInt(levelStr, 10);
                }
            } // Ignore parts beyond index 3
            
            // 8. Basic Validation
            // Check if essential parts are present AND deviceType/action look like valid words
            const typeValid = this._deviceType && /^[a-zA-Z0-9]+$/.test(this._deviceType);
            const actionValid = this._action && /^[a-zA-Z0-9]+$/.test(this._action);
            const addressValid = this._host && this._group && this._device;

            if (typeValid && actionValid && addressValid) {
                this._isValid = true;
            } else {
                throw new Error('Missing essential parts or invalid characters after parsing');
            }

        } catch (error) {
            // Ensure properties are null if any error occurred
            this._isValid = false;
            this._deviceType = null;
            this._action = null;
            this._host = null;
            this._group = null;
            this._device = null;
            this._levelRaw = null;
            // Optionally log the parsing error itself for debugging
            // console.error(`[DEBUG] CBusEvent Parsing Error: ${error.message}`);
        }

        // Log warning only if parsing ultimately failed
        if (!this._isValid) {
            console.warn(`${WARN_PREFIX} Malformed C-Bus Event data:`, dataStr);
        }
    }

    isValid() {
        return this._isValid;
    }

    DeviceType() { return this._deviceType; } // e.g., 'lighting', 'trigger'
    Action() { return this._action; }       // e.g., 'on', 'off', 'ramp'
    Host() { return this._host; }           // C-Bus Network number (e.g., '254')
    Group() { return this._group; }          // C-Bus Application number (e.g., '56')
    Device() { return this._device; }        // C-Bus Group Address (e.g., '10')

    // Calculate level (0-100%)
    // Translates 'on' to 100, 'off' to 0, or scales raw level (0-255) to percentage.
    Level() {
        // C-Gate events use lowercase actions (e.g., 'on', 'off')
        if (this._action === CGATE_CMD_ON.toLowerCase()) return "100";
        if (this._action === CGATE_CMD_OFF.toLowerCase()) return "0";
        // If raw level was parsed (e.g., from ramp event), calculate percentage
        if (this._levelRaw !== null) {
            return Math.round(this._levelRaw * 100 / CGATE_LEVEL_MAX).toString();
        }
        // Default to 0 if action is not on/off and no raw level is available
        return "0"; 
    }
}

// Represents a command received via MQTT to be sent to C-Gate.
class CBusCommand {
    constructor(topic, message) {
        // Initialize properties
        this._isValid = false;
        this._host = null;
        this._group = null;
        this._device = null;
        this._commandType = null;
        this._action = null; // Often same as commandType
        this._message = ''; // Original MQTT payload

        if (!topic) {
            console.warn(`${WARN_PREFIX} Malformed C-Bus Command: Topic is null or empty.`);
            return; // Exit constructor early
        }
        
        const topicStr = topic.toString();
        const messageStr = message ? message.toString() : ''; // Ensure message is a string
        
        // Attempt to parse topic using regex
        const match = topicStr.match(COMMAND_TOPIC_REGEX);

        if (match) {
            this._host = match[1]; // Can be empty
            this._group = match[2]; // Can be empty
            this._device = match[3]; // Can be empty
            this._commandType = match[4];
            this._action = match[4]; // Default action to command type, can be refined
            this._message = messageStr;
            this._isValid = true;
            // Future validation could check if host/group/device are numeric if expected for command type
        } else {
            // Log warning if topic doesn't match expected format
            console.warn(`${WARN_PREFIX} Malformed C-Bus Command topic:`, topicStr);
            // Properties already initialized to null/defaults
        }
    }

    isValid() {
        return this._isValid;
    }

    Host() { return this._host; }
    Group() { return this._group; }
    Device() { return this._device; }
    CommandType() { return this._commandType; } // e.g., 'switch', 'ramp', 'getall'
    Action() { return this._action; } // Currently same as CommandType, may differ later
    Message() { return this._message; } // Raw payload from MQTT

    // Calculates the command level (0-100%) based on MQTT payload.
    // Used primarily for determining state for non-C-Gate purposes, C-Gate needs RawLevel (0-255).
    Level() {
        if (!this._isValid) return null;
        // Handle explicit ON/OFF in the message (for switch or ramp)
        if (this._message.toUpperCase() === MQTT_STATE_ON) return "100";
        if (this._message.toUpperCase() === MQTT_STATE_OFF) return "0";
        // Handle direct level setting in message (e.g., "50" or "50,2s")
        if (this._commandType === MQTT_CMD_TYPE_RAMP || this._commandType === MQTT_CMD_TYPE_SWITCH) {
            const messageParts = this._message.split(',');
            const levelPart = parseInt(messageParts[0]);
            if (!isNaN(levelPart)) {
                // Clamp level to 0-100
                const clampedLevel = Math.max(0, Math.min(100, levelPart));
                return clampedLevel.toString(); // Return the percentage directly
            }
        }
        // If Action itself is ON/OFF (e.g., from a topic like .../switch ON)
        // This part seems redundant with the message check above, review if needed.
        // if (this._action === "on") return "100";
        // if (this._action === "off") return "0";

        return null; // Cannot determine level
    }

    // Calculates the raw C-Gate level (0-255) needed for RAMP commands.
    RawLevel() {
        if (!this._isValid) return null;
        if (this._message.toUpperCase() === MQTT_STATE_ON) return CGATE_LEVEL_MAX;
        if (this._message.toUpperCase() === MQTT_STATE_OFF) return CGATE_LEVEL_MIN;

        if (this._commandType === MQTT_CMD_TYPE_RAMP) {
            const messageParts = this._message.split(',');
            const levelPart = parseInt(messageParts[0]);
            if (!isNaN(levelPart)) {
                const percentage = Math.max(0, Math.min(100, levelPart));
                return Math.round(percentage * CGATE_LEVEL_MAX / 100);
            }
        }
        return null; // Cannot determine raw level
    }

    // Extracts ramp time (e.g., "2s") from MQTT payload if present.
    RampTime() {
        if (!this._isValid || this._commandType !== MQTT_CMD_TYPE_RAMP) return null;
        const messageParts = this._message.split(',');
        if (messageParts.length > 1) {
            return messageParts[1].trim(); // e.g., "2s", "1m"
        }
        return null;
    }
}

// Main Bridge Class: Handles connections, data flow between MQTT and C-Gate.
class CgateWebBridge {
    constructor(userSettings = {}, mqttClientFactory, commandSocketFactory, eventSocketFactory) {
        // Merge user settings with defaults
        this.settings = { ...defaultSettings, ...userSettings }; 
        
        // --- Validate Settings --- 
        if (!this._validateSettings()) {
             // Error logged in _validateSettings
             // Consider exiting if critical settings are missing/invalid
             console.error("FATAL: Invalid settings detected. Exiting.");
             process.exit(1); // Exit if validation fails
        }
        
        // --- Process Validated Settings --- 
        // Ensure specific settings have correct types after merge
        if (!Array.isArray(this.settings.ha_discovery_networks)) {
            this.warn('[WARN] ha_discovery_networks in settings is not an array, defaulting to [].');
            this.settings.ha_discovery_networks = [];
        }
        // Ensure App IDs are strings for consistent comparison (or null)
        this.settings.ha_discovery_cover_app_id = this.settings.ha_discovery_cover_app_id !== null 
            ? String(this.settings.ha_discovery_cover_app_id) 
            : null;
        this.settings.ha_discovery_switch_app_id = this.settings.ha_discovery_switch_app_id !== null 
            ? String(this.settings.ha_discovery_switch_app_id) 
            : null;
        this.settings.ha_discovery_relay_app_id = this.settings.ha_discovery_relay_app_id !== null
            ? String(this.settings.ha_discovery_relay_app_id)
            : null;
        this.settings.ha_discovery_pir_app_id = this.settings.ha_discovery_pir_app_id !== null
            ? String(this.settings.ha_discovery_pir_app_id)
            : null;

        // Assign connection factories (use defaults if not provided - allows testing mocks)
        this.mqttClientFactory = mqttClientFactory || (() => {
            // Log entry into the factory
            this.log('[DEBUG] mqttClientFactory called.'); 
            
            const brokerUrl = 'mqtt://' + (this.settings.mqtt || 'localhost:1883');
            const mqttConnectOptions = {};
            if (this.settings.mqttusername && this.settings.mqttpassword) {
                mqttConnectOptions.username = this.settings.mqttusername;
                mqttConnectOptions.password = this.settings.mqttpassword;
            }
            // Log connection details just before attempting connection
            this.log(`${LOG_PREFIX} Attempting mqtt.connect to ${brokerUrl} with options:`, JSON.stringify(mqttConnectOptions));
            
            // Wrap connect in try-catch for immediate errors
            try {
                const client = mqtt.connect(brokerUrl, mqttConnectOptions);
                if (!client) {
                     // This case should ideally not happen with mqtt.js, but check defensively
                     this.error('[ERROR] mqtt.connect returned null/undefined without throwing.');
                     return null; // Or handle error appropriately
                }
                 this.log('[DEBUG] mqtt.connect call successful, client object created.');
                return client;
            } catch (e) {
                this.error('[ERROR] Synchronous error during mqtt.connect:', e);
                // Log the full error for more details
                this.log('[DEBUG] Full synchronous MQTT connect error object:', e);
                 return null; // Prevent bridge from proceeding with a null client
            }
        });
        this.commandSocketFactory = commandSocketFactory || (() => new net.Socket());
        this.eventSocketFactory = eventSocketFactory || (() => new net.Socket());

        // Configure MQTT publish options (e.g., retain flag)
        this._mqttOptions = {};
        if (this.settings.retainreads === true) {
            this._mqttOptions.retain = true;
        }

        // Initialize state variables
        this.client = null;                 // MQTT client instance
        this.commandSocket = null;          // C-Gate command socket instance
        this.eventSocket = null;            // C-Gate event socket instance
        this.clientConnected = false;       // MQTT connection status flag
        this.commandConnected = false;      // C-Gate command port status flag
        this.eventConnected = false;        // C-Gate event port status flag
        this.commandBuffer = "";           // Buffer for partial data from command socket
        this.eventBuffer = "";             // Buffer for partial data from event socket
        this.treeBuffer = "";             // Buffer for accumulating TREEXML data
        this.treeNetwork = null;            // Network ID context for current TREEXML
        this.internalEventEmitter = new events.EventEmitter(); // Used for ramp increase/decrease
        this.internalEventEmitter.setMaxListeners(20); // Increase listener limit
        this.periodicGetAllInterval = null; // Timer ID for periodic GETALL
        this.commandReconnectTimeout = null; // Timer ID for command socket reconnect
        this.eventReconnectTimeout = null;   // Timer ID for event socket reconnect
        this.commandReconnectAttempts = 0;  // Counter for command socket reconnect attempts
        this.eventReconnectAttempts = 0;    // Counter for event socket reconnect attempts
        this.hasVerifiedProjectName = false; // Flag to track if we\'ve checked the C-Gate project name

        // Initialize Throttled Queues
        this.mqttPublishQueue = new ThrottledQueue(
            this._processMqttPublish.bind(this),
            this.settings.messageinterval,
            'MQTT Publish'
        );
        this.cgateCommandQueue = new ThrottledQueue(
            this._processCgateCommand.bind(this),
            this.settings.messageinterval,
            'C-Gate Command'
        );

        this.log(`${LOG_PREFIX} CgateWebBridge initialized.`);
    }

    // --- Settings Validation Helper ---
    _validateSettings() {
        const s = this.settings;
        let isValid = true;
        const logError = (setting, expectedType, receivedValue) => {
            this.error(`${ERROR_PREFIX} Invalid setting: \'${setting}\'. Expected ${expectedType}, but received: ${JSON.stringify(receivedValue)} (Type: ${typeof receivedValue})`);
            isValid = false;
        };

        // Required String Settings
        ['mqtt', 'cbusip', 'cbusname'].forEach(key => {
            if (typeof s[key] !== 'string' || s[key].trim() === '') {
                logError(key, 'non-empty string', s[key]);
            }
        });

        // Required Positive Number Settings
        ['cbuscommandport', 'cbuseventport', 'messageinterval', 'reconnectinitialdelay', 'reconnectmaxdelay'].forEach(key => {
            if (typeof s[key] !== 'number' || s[key] <= 0) {
                logError(key, 'positive number', s[key]);
            }
        });

        // Optional Number (or null)
        if (s.getallperiod !== null && (typeof s.getallperiod !== 'number' || s.getallperiod <= 0)) {
            logError('getallperiod', 'positive number or null', s.getallperiod);
        }

        // Boolean Settings
        ['retainreads', 'logging', 'getallonstart', 'ha_discovery_enabled'].forEach(key => {
            if (typeof s[key] !== 'boolean') {
                logError(key, 'boolean', s[key]);
            }
        });
        
        // HA Discovery Settings
        if (s.ha_discovery_enabled) {
            if (typeof s.ha_discovery_prefix !== 'string' || s.ha_discovery_prefix.trim() === '') {
                logError('ha_discovery_prefix', 'non-empty string when ha_discovery_enabled is true', s.ha_discovery_prefix);
            }
            if (!Array.isArray(s.ha_discovery_networks)) {
                logError('ha_discovery_networks', 'array', s.ha_discovery_networks);
            } else {
                // Optional: Check if array elements are valid network IDs (strings/numbers)
                s.ha_discovery_networks.forEach((net, index) => {
                    if (typeof net !== 'string' && typeof net !== 'number') {
                         this.error(`${ERROR_PREFIX} Invalid network ID at index ${index} in ha_discovery_networks: ${JSON.stringify(net)}`);
                         isValid = false;
                    }
                });
            }
            // App IDs can be string or null
            ['ha_discovery_cover_app_id', 'ha_discovery_switch_app_id', 'ha_discovery_relay_app_id', 'ha_discovery_pir_app_id'].forEach(key => {
                 if (s[key] !== null && typeof s[key] !== 'string' && typeof s[key] !== 'number') { // Allow number initially, constructor converts
                     logError(key, 'string, number, or null', s[key]);
                 }
             });
        }
        
        // Basic format checks (optional but helpful)
        // Simple check for host:port format in mqtt setting
        if (isValid && typeof s.mqtt === 'string' && !s.mqtt.includes(':')) {
             this.warn(`${WARN_PREFIX} Setting \'mqtt\' (${s.mqtt}) does not appear to include a port (host:port).`);
             // Don\'t mark as invalid, just warn
        }
        // Simple IP check (doesn\'t cover all edge cases like 0.0.0.0)
        const ipRegex = /^((25[0-5]|(2[0-4]|1\d|[1-9]|)\d)\.?\b){4}$/;
         if (isValid && typeof s.cbusip === 'string' && !ipRegex.test(s.cbusip)) {
             this.warn(`${WARN_PREFIX} Setting \'cbusip\' (${s.cbusip}) does not look like a valid IPv4 address.`);
              // Don\'t mark as invalid, just warn
         }

        return isValid;
    }

    // --- Logging Helpers ---
    log(message, ...args) {
        if (this.settings.logging === true) {
            console.log(message, ...args);
        }
    }
    warn(message, ...args) {
        // Always log warnings
        console.warn(message, ...args);
    }
    error(message, ...args) {
        // Always log errors
        console.error(message, ...args);
    }

    // --- Connection Management ---

    // Starts the bridge: initiates connections to MQTT and C-Gate.
    start() {
        this.log('[DEBUG] Entering start() method...'); // ADDED
        this.log(`${LOG_PREFIX} Starting CgateWebBridge...`);
        // Log connection targets
        this.log(`${LOG_PREFIX} Attempting connections: MQTT (${this.settings.mqtt}), C-Gate (${this.settings.cbusip}:${this.settings.cbuscommandport},${this.settings.cbuseventport})...`);
        // Initiate connections
        this.log('[DEBUG] Calling _connectMqtt()...'); // ADDED
        this._connectMqtt();
        this.log('[DEBUG] Calling _connectCommandSocket()...'); // ADDED
        this._connectCommandSocket();
        this.log('[DEBUG] Calling _connectEventSocket()...'); // ADDED
        this._connectEventSocket();
        // Note: Initial actions like GETALL or HA Discovery are triggered 
        // from _checkAllConnected after all connections succeed.
        this.log('[DEBUG] Exiting start() method.'); // ADDED
    }

    // Stops the bridge: disconnects clients, clears timers and queues.
    stop() {
        this.log(`${LOG_PREFIX} Stopping CgateWebBridge...`);

        // Stop any pending reconnect attempts
        if (this.commandReconnectTimeout) clearTimeout(this.commandReconnectTimeout);
        if (this.eventReconnectTimeout) clearTimeout(this.eventReconnectTimeout);
        this.commandReconnectTimeout = null;
        this.eventReconnectTimeout = null;

        // Stop periodic GETALL timer
        if (this.periodicGetAllInterval) clearInterval(this.periodicGetAllInterval);
        this.periodicGetAllInterval = null;

        // Clear processing queues
        this.mqttPublishQueue.clear();
        this.cgateCommandQueue.clear();

        // Disconnect MQTT client cleanly
        if (this.client) {
            try {
                this.client.end(true); // Force close, ignore offline queue
            } catch (e) {
                this.error("Error closing MQTT client:", e);
            }
            this.client = null; // Release reference
        }

        // Destroy C-Gate sockets immediately
        if (this.commandSocket) {
            try {
                this.commandSocket.destroy();
            } catch (e) {
                this.error("Error destroying command socket:", e);
            }
            this.commandSocket = null; // Release reference
        }
        if (this.eventSocket) {
            try {
                this.eventSocket.destroy();
            } catch (e) {
                this.error("Error destroying event socket:", e);
            }
            this.eventSocket = null; // Release reference
        }

        // Prevent memory leaks from internal emitter
        this.internalEventEmitter.removeAllListeners();

        // Reset connection status flags
        this.clientConnected = false;
        this.commandConnected = false;
        this.eventConnected = false;

        this.log(`${LOG_PREFIX} CgateWebBridge stopped.`);
    }

    // Establishes connection to the MQTT broker.
    _connectMqtt() {
        this.log('[DEBUG] Entering _connectMqtt() method...'); // ADDED
        // Prevent multiple simultaneous connection attempts
        this.log('[DEBUG] Checking if this.client exists...'); // ADDED
        if (this.client) {
            this.log('[DEBUG] _connectMqtt: this.client already exists, returning.'); // ADDED
            this.log("MQTT client already exists or connection attempt in progress.");
            return;
        }
        this.log(`${LOG_PREFIX} Connecting to MQTT: ${this.settings.mqtt}`);
        // Create client using the factory
        this.client = this.mqttClientFactory(); 

        // --- Add Check: Ensure client object was created --- 
        if (!this.client) {
            this.error('[ERROR] MQTT client factory failed to return a valid client object. Cannot attach listeners or proceed with MQTT connection.');
            // Optionally: Schedule a retry or enter a failed state?
            // For now, returning prevents crashing on listener attachment.
            return; 
        }
        // --- End Check ---

        this.log('[DEBUG] _connectMqtt: Attaching listeners...'); // ADDED
        // Ensure previous listeners are removed if this is a reconnect attempt
        // where the client object might have been recreated.
        this.client.removeAllListeners();

        // Attach event listeners for the MQTT client lifecycle
        this.client.on('connect', this._handleMqttConnect.bind(this));
        this.client.on('message', this._handleMqttMessage.bind(this));
        this.client.on('close', this._handleMqttClose.bind(this));
        this.client.on('error', this._handleMqttError.bind(this));
        this.client.on('offline', () => { this.warn(`${WARN_PREFIX} MQTT Client Offline.`); });
        this.client.on('reconnect', () => { this.log(`${LOG_PREFIX} MQTT Client Reconnecting...`); });
        this.log('[DEBUG] _connectMqtt: Listeners attached.'); // ADDED
    }

    // Establishes connection to the C-Gate command port.
    _connectCommandSocket() {
        // Prevent multiple simultaneous connection attempts
        if (this.commandSocket && this.commandSocket.connecting) {
            this.log("Command socket connection attempt already in progress.");
            return;
        }

        // Clean up existing socket if reconnecting
        if (this.commandSocket) {
            this.commandSocket.removeAllListeners();
            this.commandSocket.destroy();
            this.commandSocket = null;
        }

        this.log(`${LOG_PREFIX} Connecting to C-Gate Command Port: ${this.settings.cbusip}:${this.settings.cbuscommandport} (Attempt ${this.commandReconnectAttempts + 1})`);
        // Create socket using the factory
        this.commandSocket = this.commandSocketFactory(); 

        // Attach event listeners for the command socket
        this.commandSocket.on('connect', this._handleCommandConnect.bind(this));
        this.commandSocket.on('data', this._handleCommandData.bind(this));
        this.commandSocket.on('close', this._handleCommandClose.bind(this));
        this.commandSocket.on('error', this._handleCommandError.bind(this));

        // Initiate connection
        try {
            this.commandSocket.connect(this.settings.cbuscommandport, this.settings.cbusip);
        } catch (e) {
            this.error("Error initiating command socket connection:", e);
            this._handleCommandError(e); // Treat initiation error like a connection error
        }
    }

    // Establishes connection to the C-Gate event port.
    _connectEventSocket() {
        // Prevent multiple simultaneous connection attempts
        if (this.eventSocket && this.eventSocket.connecting) {
            this.log("Event socket connection attempt already in progress.");
            return;
        }

        // Clean up existing socket if reconnecting
        if (this.eventSocket) {
            this.eventSocket.removeAllListeners();
            this.eventSocket.destroy();
            this.eventSocket = null;
        }

        this.log(`${LOG_PREFIX} Connecting to C-Gate Event Port: ${this.settings.cbusip}:${this.settings.cbuseventport} (Attempt ${this.eventReconnectAttempts + 1})`);
        // Create socket using the factory
        this.eventSocket = this.eventSocketFactory(); 

        // Attach event listeners for the event socket
        this.eventSocket.on('connect', this._handleEventConnect.bind(this));
        this.eventSocket.on('data', this._handleEventData.bind(this));
        this.eventSocket.on('close', this._handleEventClose.bind(this));
        this.eventSocket.on('error', this._handleEventError.bind(this));

        // Initiate connection
        try {
            this.eventSocket.connect(this.settings.cbuseventport, this.settings.cbusip);
        } catch (e) {
            this.error("Error initiating event socket connection:", e);
            this._handleEventError(e); // Treat initiation error like a connection error
        }
    }

    // Schedules a reconnect attempt for a C-Gate socket ('command' or 'event')
    // Uses exponential backoff strategy.
    _scheduleReconnect(socketType) {
        let delay;
        let attempts;
        let connectFn;
        let timeoutProp;
        let currentTimeout;

        // Determine parameters based on socket type
        if (socketType === 'command') {
            // Don\'t schedule if already connected or connecting
            if (this.commandConnected || (this.commandSocket && this.commandSocket.connecting)) return;
            this.log(`[DEBUG] Incrementing command attempts from ${this.commandReconnectAttempts}`);
            this.commandReconnectAttempts++;
            attempts = this.commandReconnectAttempts;
            connectFn = this._connectCommandSocket.bind(this);
            timeoutProp = 'commandReconnectTimeout';
            currentTimeout = this.commandReconnectTimeout;
        } else { // event
            // Don\'t schedule if already connected or connecting
            if (this.eventConnected || (this.eventSocket && this.eventSocket.connecting)) return;
            this.log(`[DEBUG] Incrementing event attempts from ${this.eventReconnectAttempts}`);
            this.eventReconnectAttempts++;
            attempts = this.eventReconnectAttempts;
            connectFn = this._connectEventSocket.bind(this);
            timeoutProp = 'eventReconnectTimeout';
            currentTimeout = this.eventReconnectTimeout;
        }

        // Calculate delay using exponential backoff, capped at max delay
        delay = Math.min(this.settings.reconnectinitialdelay * Math.pow(2, attempts - 1), this.settings.reconnectmaxdelay);

        this.log(`[DEBUG] Scheduling ${socketType} reconnect: attempt=${attempts}, delay=${delay}ms`);
        this.log(`${LOG_PREFIX} ${socketType.toUpperCase()} PORT RECONNECTING in ${Math.round(delay/1000)}s (attempt ${attempts})...`);

         // Clear any previous pending reconnect timeout for this socket type
         if (currentTimeout) {
             clearTimeout(currentTimeout);
         }

        // Schedule the reconnect attempt
        this[timeoutProp] = setTimeout(connectFn, delay);
    }

    // --- Event Handlers ---

    // Handles successful MQTT connection.
    _handleMqttConnect() {
        this.clientConnected = true;
        this.log(`${LOG_PREFIX} CONNECTED TO MQTT: ${this.settings.mqtt}`);
        // Publish online status (non-retained)
        this.mqttPublishQueue.add({ topic: MQTT_TOPIC_STATUS, payload: MQTT_PAYLOAD_STATUS_ONLINE, options: { retain: false } });

        // Subscribe to the command topic branch
        this.client.subscribe(`${MQTT_TOPIC_PREFIX_WRITE}/#`, (err) => {
            if (err) {
                this.error(`${ERROR_PREFIX} MQTT Subscription error:`, err);
            } else {
                this.log(`${LOG_PREFIX} Subscribed to MQTT topic: ${MQTT_TOPIC_PREFIX_WRITE}/#`);
            }
        });
        this._checkAllConnected(); // Check if all connections are now established
    }

    // Handles MQTT client disconnection.
    _handleMqttClose() {
        this.clientConnected = false;
        // Log any arguments passed to the close handler
        this.log('[DEBUG] MQTT Close event received with arguments:', arguments);
        this.warn(`${WARN_PREFIX} MQTT Client Closed. Reconnection handled by library.`);
        // Nullify client to allow library/logic to attempt reconnection
        if (this.client) {
            this.client.removeAllListeners(); 
            this.client = null;
        }
        // Note: The mqtt.js library typically handles automatic reconnection.
    }

    // Handles MQTT client errors.
    _handleMqttError(err) {
        // Handle specific authentication error
        if (err.code === MQTT_ERROR_AUTH) { 
            this.error(`${ERROR_PREFIX} MQTT Connection Error: Authentication failed. Please check username/password in settings.js.`);
            this.error(`${ERROR_PREFIX} Exiting due to fatal MQTT authentication error.`);
            if (this.client) {
                this.client.removeAllListeners();
                this.client = null;
            }
            process.exit(1); // Exit if auth fails
        } else {
            // Handle generic errors
            this.error(`${ERROR_PREFIX} MQTT Client Error:`, err);
            // Log the full error object for more details
            this.log('[DEBUG] Full MQTT error object:', err); 
            this.clientConnected = false; // Assume disconnected on error
            if (this.client) {
                this.client.removeAllListeners();
                this.client = null;
            }
            // Potentially trigger explicit reconnect if library doesn\'t handle it
        }
    }

    // Handles successful connection to C-Gate command port.
    _handleCommandConnect() {
        this.commandConnected = true;
        this.commandReconnectAttempts = 0; // Reset attempts on successful connect
        // Clear any pending reconnect timeout
        if (this.commandReconnectTimeout) clearTimeout(this.commandReconnectTimeout);
        this.commandReconnectTimeout = null;
        this.log(`${LOG_PREFIX} CONNECTED TO C-GATE COMMAND PORT: ${this.settings.cbusip}:${this.settings.cbuscommandport}`);
        // Enable events from the C-Gate command interface
        try {
            if (this.commandSocket && !this.commandSocket.destroyed) {
                const commandString = CGATE_CMD_EVENT_ON + NEWLINE;
                this.commandSocket.write(commandString);
                this.log(`${LOG_PREFIX} C-Gate Sent: ${commandString.trim()} (Directly on connect)`);
            } else {
                this.warn(`${WARN_PREFIX} Command socket not available to send initial EVENT ON.`);
            }
        } catch (e) {
            this.error(`${ERROR_PREFIX} Error sending initial EVENT ON:`, e);
        }
        this._checkAllConnected(); // Check if all connections are now established
    }

    // Handles disconnection from C-Gate command port.
    _handleCommandClose(hadError) {
        this.commandConnected = false;
        if (this.commandSocket) {
            this.commandSocket.removeAllListeners();
            this.commandSocket = null; // Nullify on close
        }
        this.warn(`${WARN_PREFIX} COMMAND PORT DISCONNECTED${hadError ? ' with error' : ''}`);
        this._scheduleReconnect('command'); // Attempt to reconnect
    }

    // Handles errors on the C-Gate command socket.
    _handleCommandError(err) {
        this.error(`${ERROR_PREFIX} C-Gate Command Socket Error:`, err);
        this.commandConnected = false; // Assume disconnected on error
        // Ensure socket is destroyed and nulled on error
        if (this.commandSocket && !this.commandSocket.destroyed) {
            this.commandSocket.destroy(); 
        }
        this.commandSocket = null;
        // The \'close\' event should ideally follow, triggering _scheduleReconnect.
        // If not, manual scheduling might be needed here, but can lead to duplicates.
    }

    // Handles successful connection to C-Gate event port.
    _handleEventConnect() {
        this.eventConnected = true;
        this.eventReconnectAttempts = 0; // Reset attempts
        if (this.eventReconnectTimeout) clearTimeout(this.eventReconnectTimeout);
        this.eventReconnectTimeout = null;
        this.log(`${LOG_PREFIX} CONNECTED TO C-GATE EVENT PORT: ${this.settings.cbusip}:${this.settings.cbuseventport}`);
        this._checkAllConnected(); // Check if all connections are now established
    }

    // Handles disconnection from C-Gate event port.
    _handleEventClose(hadError) {
        this.eventConnected = false;
        if (this.eventSocket) {
            this.eventSocket.removeAllListeners();
            this.eventSocket = null; // Nullify on close
        }
        this.warn(`${WARN_PREFIX} EVENT PORT DISCONNECTED${hadError ? ' with error' : ''}`);
        this._scheduleReconnect('event'); // Attempt to reconnect
    }

    // Handles errors on the C-Gate event socket.
    _handleEventError(err) {
        this.error(`${ERROR_PREFIX} C-Gate Event Socket Error:`, err);
        this.eventConnected = false; // Assume disconnected
        // Ensure socket is destroyed and nulled
        if (this.eventSocket && !this.eventSocket.destroyed) {
            this.eventSocket.destroy(); 
        }
        this.eventSocket = null;
        // \'close\' event should follow and trigger reconnect.
    }

    // Checks if all connections (MQTT, C-Gate Command, C-Gate Event) are active.
    // If so, triggers initial state fetches and HA discovery.
    _checkAllConnected() {
        if (this.clientConnected && this.commandConnected && this.eventConnected) {
            this.log(`${LOG_PREFIX} ALL CONNECTED`);
            this.log(`${LOG_PREFIX} Connection Successful: MQTT (${this.settings.mqtt}), C-Gate (${this.settings.cbusip}:${this.settings.cbuscommandport},${this.settings.cbuseventport}). Awaiting messages...`);

            // --- Trigger Initial Get All --- 
            if (this.settings.getallnetapp && this.settings.getallonstart) {
                this.log(`${LOG_PREFIX} Getting all initial values for ${this.settings.getallnetapp}...`);
                this.cgateCommandQueue.add(`${CGATE_CMD_GET} //${this.settings.cbusname}/${this.settings.getallnetapp}/* ${CGATE_PARAM_LEVEL}${NEWLINE}`); // Standardize newline
            }

            // --- Trigger Periodic Get All --- 
            if (this.settings.getallnetapp && this.settings.getallperiod) {
                 if (this.periodicGetAllInterval) {
                      clearInterval(this.periodicGetAllInterval);
                 }
                this.log(`${LOG_PREFIX} Starting periodic 'get all' every ${this.settings.getallperiod} seconds.`);
                this.periodicGetAllInterval = setInterval(() => {
                    this.log(`${LOG_PREFIX} Getting all periodic values for ${this.settings.getallnetapp}...`);
                    this.cgateCommandQueue.add(`${CGATE_CMD_GET} //${this.settings.cbusname}/${this.settings.getallnetapp}/* ${CGATE_PARAM_LEVEL}${NEWLINE}`); // Standardize newline
                }, this.settings.getallperiod * 1000);
            }
            
            // --- Trigger HA Discovery (if enabled) ---
            if (this.settings.ha_discovery_enabled) {
                this._triggerHaDiscovery();
            }
        }
    }
    
    // Triggers the process of fetching network structure (TREEXML) for HA Discovery.
    // Determines which networks to query based on settings.
    _triggerHaDiscovery() {
        this.log(`${LOG_PREFIX} HA Discovery enabled, querying network trees...`);
        let networksToDiscover = this.settings.ha_discovery_networks;
        
        // If specific networks aren\'t configured, attempt to use the network 
        // from the getallnetapp setting (if specified).
        if (networksToDiscover.length === 0 && this.settings.getallnetapp) {
            const networkIdMatch = String(this.settings.getallnetapp).match(/^(\d+)/); // Match network ID
            if (networkIdMatch) {
                this.log(`${LOG_PREFIX} No HA discovery networks configured, using network from getallnetapp: ${networkIdMatch[1]}`);
                networksToDiscover = [networkIdMatch[1]];
            } else {
                this.warn(`${WARN_PREFIX} No HA discovery networks configured and could not determine network from getallnetapp (${this.settings.getallnetapp}). HA Discovery will not run.`);
                return;
            }
        } else if (networksToDiscover.length === 0) {
             this.warn(`${WARN_PREFIX} No HA discovery networks configured. HA Discovery will not run.`);
             return;
        }
        
        // Queue TREEXML command for each network to be discovered.
        networksToDiscover.forEach(networkId => {
            if (networkId) {
                this.log(`${LOG_PREFIX} Queuing TREEXML for network ${networkId} for HA Discovery.`);
                // The response (344) will trigger _publishHaDiscoveryFromTree via _handleCommandData
                this.cgateCommandQueue.add(`${CGATE_CMD_TREEXML} ${networkId}${NEWLINE}`);
            } else {
                this.warn(`${WARN_PREFIX} Invalid network ID found in ha_discovery_networks: ${networkId}`);
            }
        });
    }

    // --- Queue Processors ---

    // Processes the MQTT publish queue.
    _processMqttPublish(msg) {
        if (this.clientConnected && this.client) {
            try {
                this.client.publish(msg.topic, msg.payload, msg.options);
                this.log(`${LOG_PREFIX} MQTT Published to ${msg.topic}: ${msg.payload}`);
            } catch (e) {
                this.error(`${ERROR_PREFIX} Error publishing MQTT message:`, e, msg);
            }
        } else {
            this.warn(`${WARN_PREFIX} MQTT client not connected. Dropping message:`, msg);
            // Optional: Implement retry or persistent queue logic here
        }
    }

    // Processes the C-Gate command queue.
    _processCgateCommand(commandString) {
        if (this.commandConnected && this.commandSocket) {
            try {
                // Log the command being sent
                this.log(`${LOG_PREFIX} C-Gate Send -> : ${commandString.trim()}`); 
                this.commandSocket.write(commandString);
                // Original log confirms it was sent, keep for consistency?
                // this.log(`${LOG_PREFIX} C-Gate Sent: ${commandString.trim()}`);
            } catch (e) {
                this.error(`${ERROR_PREFIX} Error writing to C-Gate command socket:`, e, commandString.trim());
            }
        } else {
            this.warn(`${WARN_PREFIX} C-Gate command socket not connected. Dropping command:`, commandString.trim());
            // Optional: Implement retry logic
        }
    }

    // --- Data Handling ---

    // Main handler for incoming MQTT messages on subscribed topics.
    // Parses the command and dispatches to specific handlers.
    _handleMqttMessage(topic, messageBuffer) {
        const message = messageBuffer.toString();
        this.log(`${LOG_PREFIX} MQTT received on ${topic}: ${message}`);

        // --- Handle manual discovery trigger ---
        if (topic === MQTT_TOPIC_MANUAL_TRIGGER) {
            this._handleManualDiscoveryTrigger();
            return; // Don\'t process as CBusCommand
        }

        // Parse the topic/message into a command object
        const command = new CBusCommand(topic, message);
        if (!command.isValid()) {
            this.warn(`${WARN_PREFIX} Ignoring invalid MQTT command on topic ${topic}`);
            return;
        }

        // Construct C-Bus path (e.g., //PROJECT/NET/APP/GROUP)
        const cbusPath = this._buildCbusPath(command, topic);
        if (!cbusPath) {
            return; // Error logged in _buildCbusPath if path invalid for command type
        }

        // Dispatch to specific handlers based on command type
        try {
            switch (command.CommandType()) {
                case MQTT_CMD_TYPE_GETTREE:
                    this._handleMqttGetTree(command);
                    break;
                case MQTT_CMD_TYPE_GETALL:
                    this._handleMqttGetAll(cbusPath); // Only path needed
                    break;
                case MQTT_CMD_TYPE_SWITCH:
                    this._handleMqttSwitch(command, cbusPath, message);
                    break;
                case MQTT_CMD_TYPE_RAMP:
                    this._handleMqttRamp(command, cbusPath, message, topic); // Pass topic for logging
                    break;
                default:
                    this.warn(`${WARN_PREFIX} Unknown MQTT command type received: ${command.CommandType()}`);
            }
        } catch (e) {
            this.error(`${ERROR_PREFIX} Error processing MQTT message:`, e, `Topic: ${topic}, Message: ${message}`);
        }
    }

    // --- MQTT Message Handlers (Refactored) ---

    // Handles the manual HA discovery trigger message.
    _handleManualDiscoveryTrigger() {
        if (this.settings.ha_discovery_enabled) {
            this.log(`${LOG_PREFIX} Manual HA Discovery triggered via MQTT.`);
            this._triggerHaDiscovery();
        } else {
            this.warn(`${WARN_PREFIX} Manual HA Discovery trigger received, but feature is disabled in settings.`);
        }
    }

    // Constructs the C-Bus destination path (e.g., //PROJECT/NET/APP/GROUP).
    // Returns null if the path is invalid for the given command type.
    _buildCbusPath(command, topic) {
        let cbusPath = `//${this.settings.cbusname}/${command.Host()}/${command.Group()}/`;
        if (command.Device()) {
            cbusPath += command.Device();
        } else {
            // Handle commands that don't require a device ID
            if (command.CommandType() === MQTT_CMD_TYPE_GETALL) {
                cbusPath = `//${this.settings.cbusname}/${command.Host()}/${command.Group()}/*`;
            } else if (command.CommandType() === MQTT_CMD_TYPE_GETTREE) {
                // gettree doesn't use cbusPath in the command, host is used directly
                return cbusPath; // Return base path just in case, though not used for command
            } else {
                // Assume other commands require a device, log warning and return null
                this.warn(`${WARN_PREFIX} MQTT command on topic ${topic} requires device ID but none found.`);
                return null;
            }
        }
        return cbusPath;
    }

    // Handles MQTT 'gettree' command.
    // Queues a TREEXML command to C-Gate.
    _handleMqttGetTree(command) {
        this.treeNetwork = command.Host(); // Store network for context when response arrives
        this.cgateCommandQueue.add(`${CGATE_CMD_TREEXML} ${command.Host()}${NEWLINE}`);
    }

    // Handles MQTT 'getall' command.
    // Queues a GET command for all devices under the specified path.
    _handleMqttGetAll(cbusPath) {
        this.cgateCommandQueue.add(`${CGATE_CMD_GET} ${cbusPath} ${CGATE_PARAM_LEVEL}${NEWLINE}`);
    }

    // Handles MQTT 'switch' command (ON/OFF).
    // Queues an ON or OFF command to C-Gate.
    _handleMqttSwitch(command, cbusPath, message) {
        if (message.toUpperCase() === MQTT_STATE_ON) {
            this.cgateCommandQueue.add(`${CGATE_CMD_ON} ${cbusPath}${NEWLINE}`);
        } else if (message.toUpperCase() === MQTT_STATE_OFF) {
            this.cgateCommandQueue.add(`${CGATE_CMD_OFF} ${cbusPath}${NEWLINE}`);
        } else {
            this.warn(`${WARN_PREFIX} Invalid payload for switch command: ${message}`);
        }
    }

    // Handles MQTT 'ramp' command (ON/OFF/INCREASE/DECREASE/level[,time]).
    // Queues the appropriate ON/OFF/RAMP or GET+RAMP command to C-Gate.
    _handleMqttRamp(command, cbusPath, message, topic) {
        // Ramp commands require a device ID
        if (!command.Device()) {
            // Warning already logged in _buildCbusPath if path construction failed there
            // Add specific warning here if path was built but command handler needs device
            this.warn(`${WARN_PREFIX} Ramp command requires device ID on topic ${topic}`);
            return;
        }

        const rampAction = message.toUpperCase();
        const levelAddress = `${command.Host()}/${command.Group()}/${command.Device()}`; // For event emitter

        switch (rampAction) {
            case MQTT_COMMAND_INCREASE:
                 // Queue helper to get current level then send RAMP
                this._queueRampIncreaseDecrease(cbusPath, levelAddress, RAMP_STEP, CGATE_LEVEL_MAX, "INCREASE");
                break;

            case MQTT_COMMAND_DECREASE:
                 // Queue helper to get current level then send RAMP
                this._queueRampIncreaseDecrease(cbusPath, levelAddress, -RAMP_STEP, CGATE_LEVEL_MIN, "DECREASE");
                break;

            case MQTT_STATE_ON:
                this.cgateCommandQueue.add(`${CGATE_CMD_ON} ${cbusPath}${NEWLINE}`);
                break;
            case MQTT_STATE_OFF:
                this.cgateCommandQueue.add(`${CGATE_CMD_OFF} ${cbusPath}${NEWLINE}`);
                break;
            default:
                // Handle percentage level command (e.g., "50" or "75,3s")
                const rawLevel = command.RawLevel(); // Calculates 0-255 value from message % 
                const rampTime = command.RampTime();
                if (rawLevel !== null) {
                    let rampCmd = `${CGATE_CMD_RAMP} ${cbusPath} ${rawLevel}`;
                    if (rampTime) {
                        rampCmd += ` ${rampTime}`;
                    }
                    this.cgateCommandQueue.add(rampCmd + NEWLINE);
                } else {
                    this.warn(`${WARN_PREFIX} Invalid payload for ramp command: ${message}`);
                }
        }
    }

    // Helper for queuing INCREASE/DECREASE ramp commands.
    // Sets up a one-time listener for the current level (triggered by a GET command)
    // before sending the calculated RAMP command.
    _queueRampIncreaseDecrease(cbusPath, levelAddress, step, limit, actionName) {
        // Use event emitter to get current level first
        this.internalEventEmitter.once(MQTT_TOPIC_SUFFIX_LEVEL, (address, currentLevel) => {
            if (address === levelAddress) {
                const currentLevelNum = parseInt(currentLevel);
                if (!isNaN(currentLevelNum)) {
                    let newLevel = currentLevelNum + step;
                    // Clamp to limits (0 or 255)
                    newLevel = (step > 0) ? Math.min(limit, newLevel) : Math.max(limit, newLevel);
                    this.cgateCommandQueue.add(`${CGATE_CMD_RAMP} ${cbusPath} ${newLevel}${NEWLINE}`);
                } else {
                    this.warn(`${WARN_PREFIX} Could not parse current level for ${actionName}: ${currentLevel}`);
                }
            }
        });
        // Queue the GET command to trigger the level event
        this.cgateCommandQueue.add(`${CGATE_CMD_GET} ${cbusPath} ${CGATE_PARAM_LEVEL}${NEWLINE}`);
    }

    // --- Command/Event Socket Data Handlers (Refactored Below) ---

    // Main handler for data received on the C-Gate command socket.
    // Processes the data buffer line by line.
    _handleCommandData(data) {
        this.commandBuffer += data.toString();
        let newlineIndex;

        while ((newlineIndex = this.commandBuffer.indexOf(NEWLINE)) > -1) {
            const line = this.commandBuffer.substring(0, newlineIndex).trim();
            this.commandBuffer = this.commandBuffer.substring(newlineIndex + 1);

            if (!line) continue; // Skip empty lines

            this.log(`${LOG_PREFIX} C-Gate Recv (Cmd): ${line}`);

            try {
                // Parse the line into response code and status data
                const parsedResponse = this._parseCommandResponseLine(line);
                if (!parsedResponse) continue; // Skip if line couldn\'t be parsed

                // Process the response based on the code
                this._processCommandResponse(parsedResponse.responseCode, parsedResponse.statusData);

            } catch (e) {
                this.error(`${ERROR_PREFIX} Error processing command data line:`, e, `Line: ${line}`); 
            }
        }
    }

    // Parses a single line from the command socket response.
    // Handles hyphenated (e.g., 300-, 343-, 347-, 344-) and space-separated (e.g., 300 level=) formats.
    // Returns { responseCode, statusData } or null if invalid.
    _parseCommandResponseLine(line) {
        let responseCode = '';
        let statusData = '';
        const hyphenIndex = line.indexOf('-');

        if (hyphenIndex > -1 && line.length > hyphenIndex + 1) {
            // Handle hyphenated responses (300-, 343-, 347-, 344-)
            responseCode = line.substring(0, hyphenIndex).trim();
            statusData = line.substring(hyphenIndex + 1).trim();
        } else {
            // Handle space-separated responses (300 level=, 4xx, 5xx, 200 OK)
            const spaceParts = line.split(' ');
            responseCode = spaceParts[0].trim();
            // Reconstruct statusData if there are multiple parts after code
            if (spaceParts.length > 1) {
                 statusData = spaceParts.slice(1).join(' ').trim();
            }
        }
        
        // Basic validation of response code format
        if (!responseCode || !/^[1-6]\d{2}$/.test(responseCode)) {
             this.log(`${LOG_PREFIX} Skipping invalid command response line: ${line}`);
             return null; 
        }

        return { responseCode, statusData };
    }

    // Dispatches command responses to specific handlers based on response code.
    _processCommandResponse(responseCode, statusData) {
        switch (responseCode) {
            case CGATE_RESPONSE_OBJECT_STATUS: // 300
                this._processCommandObjectStatus(statusData);
                break;
            case CGATE_RESPONSE_TREE_START: // 343
                this._processCommandTreeStart(statusData);
                break;
            case CGATE_RESPONSE_TREE_DATA: // 347
                this._processCommandTreeData(statusData);
                break;
            case CGATE_RESPONSE_TREE_END: // 344
                this._processCommandTreeEnd(statusData);
                break;
            default:
                if (responseCode.startsWith('4') || responseCode.startsWith('5')) {
                    this._processCommandErrorResponse(responseCode, statusData);
                } else {
                    // Log other unhandled responses if needed
                     this.log(`${LOG_PREFIX} Unhandled command response code ${responseCode}: ${statusData}`);
                }
        }
    }

    // Handles 300 Object Status responses from command socket.
    // Can be a level report (e.g., '... level=128') or other event forwarded by C-Gate.
    _processCommandObjectStatus(statusData) {
        // Regex to match the full path level report: //PROJECT/NET/APP/GROUP level=VALUE
        const levelMatchWithProject = statusData.match(/(\/\/.*?\/.*?\/.*?\/.*?)\s+level=(\d+)/);
        // Regex to match the short path level report: NET/APP/GROUP: level=VALUE
        const levelMatchShort = statusData.match(/(\d+\/\d+\/\d+):\s+level=(\d+)/);

        if (levelMatchWithProject) {
            const fullAddress = levelMatchWithProject[1]; 
            const levelValue = parseInt(levelMatchWithProject[2]);
            const addressParts = fullAddress.split('/'); // ['', '', project, network, app, group]
            
            if (addressParts.length >= 6) {
                const receivedProjectName = addressParts[2];
                const netAddr = addressParts[3];
                const appAddr = addressParts[4];
                const groupAddr = addressParts[5];
                const simpleAddr = `${netAddr}/${appAddr}/${groupAddr}`;
                
                // --- Check Project Name (only once) ---
                if (!this.hasVerifiedProjectName) {
                    if (receivedProjectName === this.settings.cbusname) {
                        this.log(`${LOG_PREFIX} Confirmed C-Gate Project Name: \'${receivedProjectName}\'.`);
                    } else {
                        this.error(`${ERROR_PREFIX} C-GATE PROJECT NAME MISMATCH! Expected \'${this.settings.cbusname}\' (from settings.js) but received \'${receivedProjectName}\' from C-Gate. Commands may fail.`);
                    }
                    this.hasVerifiedProjectName = true; // Only check once
                }
                // --- End Project Name Check ---
                
                this._publishLevelUpdate(simpleAddr, levelValue, '(Cmd/Get)');
            } else {
                this.warn(`${WARN_PREFIX} Could not parse address from command data (level report): ${fullAddress}`);
            }
            
        } else if (levelMatchShort) {
            const simpleAddr = levelMatchShort[1]; // e.g., "254/56/0"
            const levelValue = parseInt(levelMatchShort[2]);

            // Check if parsing produced valid numbers
            if (!isNaN(levelValue)) {
                this._publishLevelUpdate(simpleAddr, levelValue, '(Cmd/Get-Short)');
            } else {
                 this.warn(`${WARN_PREFIX} Could not parse level value from short command data: ${statusData}`);
            }

        } else {
            // If not a level report, try parsing as a standard C-Bus event
            // (e.g., if C-Gate forwards an event like 'lighting on ...' via the command socket)
            const event = new CBusEvent(statusData);
            if (event.isValid()) {
                this._publishEvent(event, '(Cmd/Event)'); // Publish to MQTT
                this._emitLevelFromEvent(event); // Emit internally for ramp logic
            } else {
                // Log if it couldn\'t be parsed as any known format
                this.log(`${LOG_PREFIX} Unhandled status response (300) from command port: ${statusData}`);
            }
        }
    }
    
    // --- Helper for publishing level updates ---
    // Consolidates the logic used by both level report formats in _processCommandObjectStatus
    _publishLevelUpdate(simpleAddr, levelValue, logSource = '') {
        const levelPercent = Math.round(levelValue * 100 / CGATE_LEVEL_MAX).toString();
        const topicBase = `${MQTT_TOPIC_PREFIX_READ}/${simpleAddr}`; // For MQTT publishing

        // Emit internal event for potential ramp increase/decrease logic
        this.internalEventEmitter.emit(MQTT_TOPIC_SUFFIX_LEVEL, simpleAddr, levelValue);

        // Publish state and level to MQTT
        if (levelValue === CGATE_LEVEL_MIN) {
            this.log(`${LOG_PREFIX} C-Bus Status ${logSource}: ${simpleAddr} OFF (0%)`);
            this.mqttPublishQueue.add({ topic: `${topicBase}/${MQTT_TOPIC_SUFFIX_STATE}`, payload: MQTT_STATE_OFF, options: this._mqttOptions });
            this.mqttPublishQueue.add({ topic: `${topicBase}/${MQTT_TOPIC_SUFFIX_LEVEL}`, payload: '0', options: this._mqttOptions });
        } else {
            this.log(`${LOG_PREFIX} C-Bus Status ${logSource}: ${simpleAddr} ON (${levelPercent}%)`);
            this.mqttPublishQueue.add({ topic: `${topicBase}/${MQTT_TOPIC_SUFFIX_STATE}`, payload: MQTT_STATE_ON, options: this._mqttOptions });
            this.mqttPublishQueue.add({ topic: `${topicBase}/${MQTT_TOPIC_SUFFIX_LEVEL}`, payload: levelPercent, options: this._mqttOptions });
        }
    }

    // Handles 343 Tree Start responses from command socket.
    // Initializes the tree buffer and stores the network context.
    _processCommandTreeStart(statusData) {
        this.treeBuffer = '';
        this.treeNetwork = statusData || this.treeNetwork; // Use statusData if provided, else keep existing
        this.log(`${LOG_PREFIX} Started receiving TreeXML for network ${this.treeNetwork || 'unknown'}...`);
    }

    // Handles 347 Tree Data responses, appending to the tree buffer.
    _processCommandTreeData(statusData) {
        this.treeBuffer += statusData + NEWLINE;
    }

    // Handles 344 Tree End responses.
    // Parses the completed tree buffer XML using xml2js.
    // Publishes the parsed tree to MQTT and triggers HA discovery.
    _processCommandTreeEnd(statusData) {
        // Note: statusData for 344 usually contains the network ID, but we use the stored this.treeNetwork
        this.log(`${LOG_PREFIX} Finished receiving TreeXML. Network: ${this.treeNetwork || 'unknown'}. Size: ${this.treeBuffer.length} bytes. Parsing...`);
        const networkForTree = this.treeNetwork; // Capture before clearing
        const treeXmlData = this.treeBuffer;
        
        // Clear buffer and network context immediately
        this.treeBuffer = ''; 
        this.treeNetwork = null; 

        if (!networkForTree || !treeXmlData) {
             this.warn(`${WARN_PREFIX} Received TreeXML end (344) but no buffer or network context was set.`); 
             return;
        }

        // Log before parsing
        this.log(`${LOG_PREFIX} Starting XML parsing for network ${networkForTree}...`);
        const startTime = Date.now();

        parseString(treeXmlData, { explicitArray: false }, (err, result) => { 
            const duration = Date.now() - startTime;
            if (err) {
                this.error(`${ERROR_PREFIX} Error parsing TreeXML for network ${networkForTree} (took ${duration}ms):`, err);
            } else {
                this.log(`${LOG_PREFIX} Parsed TreeXML for network ${networkForTree} (took ${duration}ms)`);
                // Publish standard tree topic
                this.mqttPublishQueue.add({ 
                    topic: `${MQTT_TOPIC_PREFIX_READ}/${networkForTree}///${MQTT_TOPIC_SUFFIX_TREE}`,
                    payload: JSON.stringify(result),
                    options: this._mqttOptions 
                });
                
                // Trigger HA Discovery if enabled for this network
                const allowedNetworks = this.settings.ha_discovery_networks.map(String);
                if (this.settings.ha_discovery_enabled && allowedNetworks.includes(String(networkForTree))) {
                    this._publishHaDiscoveryFromTree(networkForTree, result);
                }
            }
        });
    }

    // Handles 4xx/5xx Error responses from command socket.
    _processCommandErrorResponse(responseCode, statusData) {
        this.error(`${ERROR_PREFIX} C-Gate Command Error Response: ${responseCode} ${statusData}`);
    }

    // Main handler for data received on the C-Gate event socket.
    // Processes the data buffer line by line.
    _handleEventData(data) {
        this.eventBuffer += data.toString();
        let newlineIndex;

        while ((newlineIndex = this.eventBuffer.indexOf(NEWLINE)) > -1) {
            const line = this.eventBuffer.substring(0, newlineIndex).trim();
            this.eventBuffer = this.eventBuffer.substring(newlineIndex + 1);

            if (!line) continue; // Skip empty lines

            this._processEventLine(line);
        }
    }

    // Processes a single line from the event socket.
    // Parses as a CBusEvent and triggers MQTT publishing and internal level emit.
    _processEventLine(line) {
         // Handle comments (lines starting with #)
         if (line.startsWith('#')) {
             this.log(`${LOG_PREFIX} Ignoring comment from event port:`, line);
             return;
         }

         this.log(`${LOG_PREFIX} C-Gate Recv (Evt): ${line}`);

         try {
             // Event port usually sends status updates directly, e.g., "lighting on NET/APP/GROUP"
             const event = new CBusEvent(line);
             if (event.isValid()) {
                 this._publishEvent(event, '(Evt)');
                 // Emit level based on parsed event action/level
                 this._emitLevelFromEvent(event);
             } else {
                 this.warn(`${WARN_PREFIX} Could not parse event line: ${line}`);
             }
         } catch (e) {
             this.error(`${ERROR_PREFIX} Error processing event data line:`, e, `Line: ${line}`);
         }
    }

    // Helper to emit the internal 'level' event based on a parsed CBusEvent.
    // This is primarily used by the INCREASE/DECREASE ramp command logic 
    // to get the current level before calculating the new ramp target.
    _emitLevelFromEvent(event) {
        // Do not emit level events for PIR sensors
        if (event.Group() === this.settings.ha_discovery_pir_app_id) {
            return;
        }
        
        const simpleAddr = `${event.Host()}/${event.Group()}/${event.Device()}`;
        let levelValue = null;
        // Try to get raw level first (most accurate for ramp)
        if (event._levelRaw !== null) {
            levelValue = event._levelRaw;
        } else if (event.Action() === CGATE_CMD_ON.toLowerCase()) {
            levelValue = CGATE_LEVEL_MAX;
        } else if (event.Action() === CGATE_CMD_OFF.toLowerCase()) {
            levelValue = CGATE_LEVEL_MIN;
        }

        if (levelValue !== null) {
            this.internalEventEmitter.emit(MQTT_TOPIC_SUFFIX_LEVEL, simpleAddr, levelValue);
        } else {
            this.log(`${LOG_PREFIX} Could not determine level value for event:`, event);
        }
    }

    // Helper to publish state and level MQTT messages based on a parsed CBusEvent.
    // Determines ON/OFF state based on the calculated level (0-100%).
    _publishEvent(event, source = '') {
        if (!event || !event.isValid()) {
            return;
        }
        const topicBase = `${MQTT_TOPIC_PREFIX_READ}/${event.Host()}/${event.Group()}/${event.Device()}`;
        const levelPercent = event.Level(); // Get 0-100 level
        const isPirSensor = event.Group() === this.settings.ha_discovery_pir_app_id;

        // Determine state based on level or action (ON/OFF)
        // For PIR, simple ON/OFF action is sufficient
        let state;
        if (isPirSensor) {
            state = (event.Action() === CGATE_CMD_ON.toLowerCase()) ? MQTT_STATE_ON : MQTT_STATE_OFF;
        } else {
             state = (levelPercent !== null && parseInt(levelPercent) > 0) ? MQTT_STATE_ON : MQTT_STATE_OFF;
        }
       
        this.log(`${LOG_PREFIX} C-Bus Status ${source}: ${event.Host()}/${event.Group()}/${event.Device()} ${state}` + (isPirSensor ? '' : ` (${levelPercent || '0'}%)`));

        // Publish state 
        this.mqttPublishQueue.add({ topic: `${topicBase}/${MQTT_TOPIC_SUFFIX_STATE}`, payload: state, options: this._mqttOptions });
        
        // Publish level ONLY if it\'s NOT a PIR sensor
        if (!isPirSensor) {
            this.mqttPublishQueue.add({ topic: `${topicBase}/${MQTT_TOPIC_SUFFIX_LEVEL}`, payload: levelPercent || '0', options: this._mqttOptions });
        }
    }

    // --- HA Discovery Methods ---
    
    // Generates and publishes Home Assistant MQTT discovery messages 
    // based on parsed TreeXML data for a specific network.
    _publishHaDiscoveryFromTree(networkId, treeData) {
        this.log(`${LOG_PREFIX} Generating HA Discovery messages for network ${networkId}...`);
        const startTime = Date.now();
        
        // Basic validation of the parsed tree data structure
        // Replace optional chaining for compatibility
        const networkData = treeData && treeData.Network && treeData.Network.Interface && treeData.Network.Interface.Network;
        if (!networkData || networkData.NetworkNumber !== String(networkId)) {
             this.warn(`${WARN_PREFIX} TreeXML for network ${networkId} seems malformed or doesn\'t match expected structure.`);
             return;
        }

        // Ensure units is an array, even if only one unit exists or none
        let units = networkData.Unit || [];
        if (!Array.isArray(units)) {
            units = [units];
        }
        
        const lightingAppId = DEFAULT_CBUS_APP_LIGHTING; 
        const coverAppId = this.settings.ha_discovery_cover_app_id;
        const switchAppId = this.settings.ha_discovery_switch_app_id;
        const relayAppId = this.settings.ha_discovery_relay_app_id;
        const pirAppId = this.settings.ha_discovery_pir_app_id; // Get PIR App ID
        let discoveryCount = 0;

        // Helper function to generate and publish discovery payloads for EnableControl groups.
        // Handles Covers, Switches, Relays, and PIRs based on configured App IDs and prioritization.
        const processEnableControl = (enableControlData) => {
            if (!enableControlData || !enableControlData.Group) return; 

            const appAddress = enableControlData.ApplicationAddress;
            const groups = Array.isArray(enableControlData.Group)
                            ? enableControlData.Group
                            : [enableControlData.Group]; 

            groups.forEach(group => {
                const groupId = group.GroupAddress;
                if (groupId === undefined || groupId === null || groupId === '') {
                    this.warn(`${WARN_PREFIX} Skipping EnableControl group in HA Discovery due to missing/invalid GroupAddress (App: ${appAddress})...`, group);
                    return;
                }
                const groupLabel = group.Label;
                let discovered = false; // Flag to ensure only one type is discovered per group

                // --- Check for Cover --- 
                if (coverAppId && appAddress === coverAppId) {
                    const finalLabel = groupLabel || `CBus Cover ${networkId}/${coverAppId}/${groupId}`;
                    const uniqueId = `cgateweb_${networkId}_${coverAppId}_${groupId}`;
                    const discoveryTopic = `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_COVER}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`;
                    const payload = { 
                        name: finalLabel,
                        unique_id: uniqueId,
                        state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${coverAppId}/${groupId}/${MQTT_TOPIC_SUFFIX_STATE}`,
                        command_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${coverAppId}/${groupId}/${MQTT_CMD_TYPE_SWITCH}`,
                        payload_open: MQTT_STATE_ON,
                        payload_close: MQTT_STATE_OFF,
                        state_open: MQTT_STATE_ON,
                        state_closed: MQTT_STATE_OFF,
                        qos: 0,
                        retain: true,
                        device_class: HA_DEVICE_CLASS_SHUTTER,
                        device: { 
                            identifiers: [uniqueId],
                            name: finalLabel,
                            manufacturer: HA_DEVICE_MANUFACTURER,
                            model: HA_MODEL_COVER,
                            via_device: HA_DEVICE_VIA
                        },
                        origin: { 
                            name: HA_ORIGIN_NAME,
                            sw_version: HA_ORIGIN_SW_VERSION,
                            support_url: HA_ORIGIN_SUPPORT_URL
                        }
                    };
                    this.mqttPublishQueue.add({ topic: discoveryTopic, payload: JSON.stringify(payload), options: { retain: true, qos: 0 } });
                    discoveryCount++;
                    discovered = true;
                }

                // --- Check for Switch --- 
                if (!discovered && switchAppId && appAddress === switchAppId) {
                    const finalLabel = groupLabel || `CBus Switch ${networkId}/${switchAppId}/${groupId}`;
                    const uniqueId = `cgateweb_${networkId}_${switchAppId}_${groupId}`;
                    const discoveryTopic = `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_SWITCH}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`;
                    const payload = { 
                        name: finalLabel,
                        unique_id: uniqueId,
                        state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${switchAppId}/${groupId}/${MQTT_TOPIC_SUFFIX_STATE}`,
                        command_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${switchAppId}/${groupId}/${MQTT_CMD_TYPE_SWITCH}`,
                        payload_on: MQTT_STATE_ON,
                        payload_off: MQTT_STATE_OFF,
                        state_on: MQTT_STATE_ON,
                        state_off: MQTT_STATE_OFF,
                        qos: 0,
                        retain: true,
                        device: { 
                            identifiers: [uniqueId],
                            name: finalLabel,
                            manufacturer: HA_DEVICE_MANUFACTURER,
                            model: HA_MODEL_SWITCH,
                            via_device: HA_DEVICE_VIA
                        },
                        origin: { 
                            name: HA_ORIGIN_NAME,
                            sw_version: HA_ORIGIN_SW_VERSION,
                            support_url: HA_ORIGIN_SUPPORT_URL
                        }
                    };
                    this.mqttPublishQueue.add({ topic: discoveryTopic, payload: JSON.stringify(payload), options: { retain: true, qos: 0 } });
                    discoveryCount++;
                    discovered = true;
                }

                // --- Check for Relay --- 
                if (!discovered && relayAppId && appAddress === relayAppId) {
                     const finalLabel = groupLabel || `CBus Relay ${networkId}/${relayAppId}/${groupId}`;
                     const uniqueId = `cgateweb_${networkId}_${relayAppId}_${groupId}`;
                     const discoveryTopic = `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_SWITCH}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`;
                     const payload = { 
                         name: finalLabel,
                         unique_id: uniqueId,
                         state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${relayAppId}/${groupId}/state`,
                         command_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${relayAppId}/${groupId}/switch`,
                         payload_on: MQTT_STATE_ON,      
                         payload_off: MQTT_STATE_OFF,     
                         state_on: MQTT_STATE_ON,        
                         state_off: MQTT_STATE_OFF,       
                         qos: 0,
                         retain: true,
                         device_class: HA_DEVICE_CLASS_OUTLET, 
                         device: {
                             identifiers: [uniqueId],
                             name: finalLabel,
                             manufacturer: HA_DEVICE_MANUFACTURER, 
                             model: HA_MODEL_RELAY, 
                             via_device: HA_DEVICE_VIA 
                         },
                         origin: {
                             name: HA_ORIGIN_NAME, 
                             sw_version: HA_ORIGIN_SW_VERSION,
                             support_url: HA_ORIGIN_SUPPORT_URL
                         }
                     };
                     this.mqttPublishQueue.add({ topic: discoveryTopic, payload: JSON.stringify(payload), options: { retain: true, qos: 0 } });
                     discoveryCount++;
                     discovered = true; 
                 }
                 
                 // --- Check for PIR Motion Sensor --- 
                 // Check only if not already discovered as Cover, Switch, or Relay
                 if (!discovered && pirAppId && appAddress === pirAppId) {
                     const finalLabel = groupLabel || `CBus PIR ${networkId}/${pirAppId}/${groupId}`;
                     const uniqueId = `cgateweb_${networkId}_${pirAppId}_${groupId}`;
                     // Publish PIR motion sensor under the 'binary_sensor' component type in HA
                     const discoveryTopic = `${this.settings.ha_discovery_prefix}/binary_sensor/${uniqueId}/${HA_DISCOVERY_SUFFIX}`;
                     const payload = { // HA MQTT Binary Sensor payload
                         name: finalLabel,
                         unique_id: uniqueId,
                         state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${pirAppId}/${groupId}/${MQTT_TOPIC_SUFFIX_STATE}`,
                         payload_on: MQTT_STATE_ON,        // Motion detected = ON
                         payload_off: MQTT_STATE_OFF,       // Motion stopped/clear = OFF
                         device_class: 'motion',         // Set device class to motion
                         qos: 0,
                         retain: false, // Typically motion events are not retained
                         device: { 
                             identifiers: [uniqueId],
                             name: finalLabel,
                             manufacturer: HA_DEVICE_MANUFACTURER,
                             model: HA_MODEL_PIR, // Use PIR model constant
                             via_device: HA_DEVICE_VIA 
                         },
                         origin: { 
                             name: HA_ORIGIN_NAME,
                             sw_version: HA_ORIGIN_SW_VERSION,
                             support_url: HA_ORIGIN_SUPPORT_URL
                         }
                     };
                     this.mqttPublishQueue.add({ topic: discoveryTopic, payload: JSON.stringify(payload), options: { retain: false, qos: 0 } }); // Use retain: false
                     discoveryCount++;
                     discovered = true; // Mark as discovered
                 }
            });
        };

        try {
            // Iterate through each Unit definition in the network tree
            units.forEach((unit, index) => {
                this.log(`[DEBUG] HA Discovery: Processing Unit ${index + 1}/${units.length} (Addr: ${unit.UnitAddress || 'N/A'})`);
                // Replace optional chaining
                const applicationData = unit && unit.Application;
                if (!applicationData) return; // Skip unit if no Application data

                const lightingData = applicationData.Lighting;
                const enableControlData = applicationData.EnableControl;
                // Add other top-level apps here if needed

                // --- Process Lighting Application --- 
                 // Replace optional chaining
                if (lightingData && lightingData.Group) {
                    // C-Bus Lighting application (usually App ID 56)
                    const groups = Array.isArray(lightingData.Group)
                                    ? lightingData.Group
                                    : [lightingData.Group];
                    groups.forEach(group => {
                        const groupId = group.GroupAddress;
                        if (groupId === undefined || groupId === null || groupId === '') {
                            this.warn(`${WARN_PREFIX} Skipping lighting group in HA Discovery due to missing/invalid GroupAddress...`, group);
                            return;
                        }
                        const groupLabel = group.Label || `CBus Light ${networkId}/${lightingAppId}/${groupId}`;
                        const uniqueId = `cgateweb_${networkId}_${lightingAppId}_${groupId}`;
                        const discoveryTopic = `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_LIGHT}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`;
                        const payload = { // Standard HA MQTT Light payload (with brightness)
                            name: groupLabel,
                            unique_id: uniqueId,
                            state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${lightingAppId}/${groupId}/${MQTT_TOPIC_SUFFIX_STATE}`,
                            command_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${lightingAppId}/${groupId}/${MQTT_CMD_TYPE_SWITCH}`,
                            payload_on: MQTT_STATE_ON,
                            payload_off: MQTT_STATE_OFF,
                            brightness_state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${lightingAppId}/${groupId}/${MQTT_TOPIC_SUFFIX_LEVEL}`,
                            brightness_command_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${lightingAppId}/${groupId}/${MQTT_CMD_TYPE_RAMP}`,
                            brightness_scale: 100, 
                            qos: 0, 
                            retain: true,
                            device: {
                                identifiers: [uniqueId],
                                name: groupLabel,
                                manufacturer: HA_DEVICE_MANUFACTURER,
                                model: HA_MODEL_LIGHTING,
                                via_device: HA_DEVICE_VIA
                            },
                            origin: {
                                name: HA_ORIGIN_NAME,
                                sw_version: HA_ORIGIN_SW_VERSION,
                                support_url: HA_ORIGIN_SUPPORT_URL
                            }
                        };
                        this.mqttPublishQueue.add({ topic: discoveryTopic, payload: JSON.stringify(payload), options: { retain: true, qos: 0 } });
                        discoveryCount++;
                    });
                    
                    // --- Process EnableControl NESTED under Lighting --- 
                    // Replace optional chaining check
                    if (lightingData.EnableControl) {
                        processEnableControl(lightingData.EnableControl);
                    }
                }

                // --- Process TOP-LEVEL EnableControl --- 
                // Replace optional chaining check
                if (enableControlData) {
                    // Note: If the same group address exists both nested and top-level,
                    // HA should handle the duplicate discovery message gracefully due to unique_id.
                    processEnableControl(enableControlData);
                }
                
                // --- Process other top-level applications here --- 
                // Example with optional chaining replaced:
                // const measurementData = applicationData.Measurement;
                // if (measurementData && measurementData.Group) { processMeasurement(measurementData); }

            }); // end units.forEach

            const duration = Date.now() - startTime;
            this.log(`${LOG_PREFIX} Published ${discoveryCount} HA Discovery messages for network ${networkId} (took ${duration}ms).`);

        } catch (e) {
            this.error(`${ERROR_PREFIX} Error processing TreeXML for HA Discovery (network ${networkId}):`, e, treeData);
        }
    }
}

// Export classes for testing or potential require() usage
module.exports = {
    CgateWebBridge,
    ThrottledQueue,
    CBusEvent,
    CBusCommand,
    settings: defaultSettings // Export the original defaults for tests
};

// --- Main Execution ---
// Only run if executed directly (node index.js)
if (require.main === module) {
    // Create bridge instance, constructor handles merging defaults
    const bridge = new CgateWebBridge(userSettings);
    bridge.start();

    // Graceful shutdown
    const shutdown = () => {
        console.log('\nGracefully shutting down...');
        bridge.stop();
        // Give queues a moment to potentially finish processing last items if needed
        setTimeout(() => process.exit(0), 500);
    };

    process.on('SIGINT', () => {
        console.log('Received SIGINT (Ctrl+C).');
        shutdown();
    });

    process.on('SIGTERM', () => {
        console.log('Received SIGTERM.');
        shutdown();
    });

    process.on('uncaughtException', (err) => {
        console.error('UNCAUGHT EXCEPTION! Shutting down...', err);
        // Attempt graceful stop, need access to 'bridge' instance
        if (bridge) bridge.stop(); 
        process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
        console.error('UNHANDLED REJECTION! Shutting down...', reason, 'Promise:', promise);
        // Attempt graceful stop, need access to 'bridge' instance
        if (bridge) bridge.stop(); 
        process.exit(1);
    });
}