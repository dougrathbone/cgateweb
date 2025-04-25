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
    ha_discovery_relay_app_id: null // Default: Don't discover relays
};

// --- Load User Settings ---
let userSettings = {};
try {
    userSettings = require('./settings.js');
} catch (e) {
    console.warn('[WARN] Could not load ./settings.js, using defaults.');
}

// --- Constants ---
const MQTT_TOPIC_PREFIX_READ = 'cbus/read';
const MQTT_TOPIC_PREFIX_WRITE = 'cbus/write';
const MQTT_STATE_ON = 'ON';
const MQTT_STATE_OFF = 'OFF';
const RAMP_STEP = 26; // Standard ramp step (approx 10%)
const RECONNECT_INITIAL_DELAY_MS = defaultSettings.reconnectinitialdelay;
const RECONNECT_MAX_DELAY_MS = defaultSettings.reconnectmaxdelay;
const CGATE_RESPONSE_OBJECT_STATUS = '300';
const CGATE_RESPONSE_TREE_START = '343';
const CGATE_RESPONSE_TREE_END = '344';
const CGATE_RESPONSE_TREE_DATA = '347';
const LOG_PREFIX = '[INFO]';
const WARN_PREFIX = '[WARN]';
const ERROR_PREFIX = '[ERROR]';

// Throttled Queue Implementation (Reverted to original setInterval logic)
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

class CBusEvent {
    constructor(data) {
        // "lighting on 254/56/4  #sourceunit=8 OID=... sessionId=... commandId=..."
        const dataStr = data.toString();
        // Split primarily by double space, take first part, then split by space
        const mainParts = dataStr.split("  ")[0].split(" ");
        const addressParts = (mainParts.length > 2) ? mainParts[2].split("/") : [];

        this._deviceType = mainParts.length > 0 ? mainParts[0] : null;
        this._action = mainParts.length > 1 ? mainParts[1] : null;
        this._host = addressParts.length > 0 ? addressParts[0] : null;
        this._group = addressParts.length > 1 ? addressParts[1] : null;
        this._device = addressParts.length > 2 ? addressParts[2] : null;
        this._levelRaw = (mainParts.length > 3 && !isNaN(parseInt(mainParts[3]))) ? parseInt(mainParts[3]) : null; // e.g., from ramp command

        // Basic validation
        if (!this._deviceType || !this._action || !this._host || !this._group || !this._device) {
            console.warn(`${WARN_PREFIX} Malformed C-Bus Event data:`, dataStr);
            // Set properties to null to indicate failure
            this._deviceType = this._action = this._host = this._group = this._device = this._levelRaw = null;
        }
    }

    isValid() {
        return this._deviceType !== null; // Check if basic parsing succeeded
    }

    DeviceType() { return this._deviceType; }
    Action() { return this._action; }
    Host() { return this._host; }
    Group() { return this._group; }
    Device() { return this._device; }

    // Calculate level (0-100%)
    Level() {
        if (this._action === "on") return "100";
        if (this._action === "off") return "0";
        if (this._levelRaw !== null) {
            return Math.round(this._levelRaw * 100 / 255).toString();
        }
        return "0"; // Default to 0 if no level info and not explicitly 'on'
    }
}

class CBusCommand {
    constructor(topic, message) {
        // "cbus/write/254/56/7/switch ON"
        const topicStr = topic.toString();
        const messageStr = message ? message.toString() : ''; // Handle potentially null/undefined message
        const topicParts = topicStr.split("/");

        this._isValid = false;
        if (topicParts.length >= 6 && topicParts[0] === 'cbus' && topicParts[1] === 'write') {
            this._host = topicParts[2];
            this._group = topicParts[3];
            this._device = topicParts[4]; // Can be empty for group-level commands like getall
            const commandAndArgs = topicParts[5].split(' '); // e.g., "switch", "ramp"
            this._commandType = commandAndArgs[0];
            this._action = commandAndArgs[0]; // Often the same as commandType for simple cases
            this._message = messageStr;
            this._isValid = true; // Mark as valid if basic structure matches
        } else {
            // Initialize fields to null/defaults if invalid
            this._host = null;
            this._group = null;
            this._device = null;
            this._commandType = null;
            this._action = null;
            this._message = '';
            console.warn(`${WARN_PREFIX} Malformed C-Bus Command topic:`, topicStr);
        }
    }

    isValid() {
        return this._isValid;
    }

    Host() { return this._host; }
    Group() { return this._group; }
    Device() { return this._device; } // Note: Can be empty for 'getall' etc.
    CommandType() { return this._commandType; }
    Action() { return this._action; } // May need refinement based on CommandType
    Message() { return this._message; }

    // Level calculation based on Action and Message (0-100%)
    Level() {
        if (!this._isValid) return null;
        // Handle explicit ON/OFF in the message (for switch or ramp)
        if (this._message.toUpperCase() === "ON") return "100";
        if (this._message.toUpperCase() === "OFF") return "0";
        // Handle direct level setting in message (e.g., "50" or "50,2s")
        if (this._commandType === "ramp" || this._commandType === "switch") {
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

    // Raw level calculation (0-255) needed for RAMP command
    RawLevel() {
        if (!this._isValid) return null;
        if (this._message.toUpperCase() === "ON") return 255;
        if (this._message.toUpperCase() === "OFF") return 0;

        if (this._commandType === "ramp") {
            const messageParts = this._message.split(',');
            const levelPart = parseInt(messageParts[0]);
            if (!isNaN(levelPart)) {
                const percentage = Math.max(0, Math.min(100, levelPart));
                return Math.round(percentage * 255 / 100);
            }
        }
        return null; // Cannot determine raw level
    }

    // Get ramp time if specified (e.g., "50,2s")
    RampTime() {
        if (!this._isValid || this._commandType !== "ramp") return null;
        const messageParts = this._message.split(',');
        if (messageParts.length > 1) {
            return messageParts[1].trim(); // e.g., "2s", "1m"
        }
        return null;
    }
}

// Main Bridge Class
class CgateWebBridge {
    constructor(userSettings = {}, mqttClientFactory, commandSocketFactory, eventSocketFactory) {
        // Merge settings using the module-level defaultSettings
        this.settings = { ...defaultSettings, ...userSettings }; 
        // Ensure ha_discovery_networks is always an array after merge
        if (!Array.isArray(this.settings.ha_discovery_networks)) {
            this.warn('[WARN] ha_discovery_networks in settings is not an array, defaulting to [].');
            this.settings.ha_discovery_networks = [];
        }
        // Ensure cover app ID is treated as string for consistency
        this.settings.ha_discovery_cover_app_id = String(this.settings.ha_discovery_cover_app_id);
        // Ensure switch app ID is string if set, otherwise keep null
        this.settings.ha_discovery_switch_app_id = this.settings.ha_discovery_switch_app_id !== null 
            ? String(this.settings.ha_discovery_switch_app_id) 
            : null;
        // Ensure relay app ID is string if set, otherwise keep null
        this.settings.ha_discovery_relay_app_id = this.settings.ha_discovery_relay_app_id !== null
            ? String(this.settings.ha_discovery_relay_app_id)
            : null;

        // Use provided factories or default ones
        this.mqttClientFactory = mqttClientFactory || (() => {
            // Construct URL and options for mqtt.connect()
            const brokerUrl = 'mqtt://' + (this.settings.mqtt || 'localhost:1883');
            const mqttConnectOptions = {};
            if (this.settings.mqttusername && this.settings.mqttpassword) {
                mqttConnectOptions.username = this.settings.mqttusername;
                mqttConnectOptions.password = this.settings.mqttpassword;
            }
            // Add other potential options if needed, e.g.:
            // mqttConnectOptions.clientId = 'cgateweb_' + Math.random().toString(16).substr(2, 8);
            // mqttConnectOptions.clean = true;
            this.log(`${LOG_PREFIX} Creating MQTT client for: ${brokerUrl}`);
            return mqtt.connect(brokerUrl, mqttConnectOptions); // Use mqtt.connect()
        });
        this.commandSocketFactory = commandSocketFactory || (() => new net.Socket());
        this.eventSocketFactory = eventSocketFactory || (() => new net.Socket());

        // Prepare MQTT options based on settings
        this._mqttOptions = {};
        if (this.settings.retainreads === true) {
            this._mqttOptions.retain = true;
        }

        // Initialize state
        this.client = null;
        this.commandSocket = null;
        this.eventSocket = null;
        this.clientConnected = false;
        this.commandConnected = false;
        this.eventConnected = false;
        this.commandBuffer = "";
        this.eventBuffer = ""; // Separate buffer for event socket
        this.treeBuffer = "";
        this.treeNetwork = null;
        this.internalEventEmitter = new events.EventEmitter();
        this.internalEventEmitter.setMaxListeners(20); // Allow more listeners for ramp commands
        this.periodicGetAllInterval = null;
        this.commandReconnectTimeout = null;
        this.eventReconnectTimeout = null;
        this.commandReconnectAttempts = 0;
        this.eventReconnectAttempts = 0;

        // Initialize Queues
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

    start() {
        this.log(`${LOG_PREFIX} Starting CgateWebBridge...`);
        // Add the attempting connection message
        this.log(`${LOG_PREFIX} Attempting connections: MQTT (${this.settings.mqtt}), C-Gate (${this.settings.cbusip}:${this.settings.cbuscommandport},${this.settings.cbuseventport})...`);
        this._connectMqtt();
        this._connectCommandSocket();
        this._connectEventSocket();
        // Discovery is triggered from _checkAllConnected after connections are up
    }

    stop() {
        this.log(`${LOG_PREFIX} Stopping CgateWebBridge...`);

        // Clear reconnect timeouts
        if (this.commandReconnectTimeout) clearTimeout(this.commandReconnectTimeout);
        if (this.eventReconnectTimeout) clearTimeout(this.eventReconnectTimeout);
        this.commandReconnectTimeout = null;
        this.eventReconnectTimeout = null;

        // Clear periodic get all interval
        if (this.periodicGetAllInterval) clearInterval(this.periodicGetAllInterval);
        this.periodicGetAllInterval = null;

        // Clear queues
        this.mqttPublishQueue.clear();
        this.cgateCommandQueue.clear();

        // Disconnect MQTT client
        if (this.client) {
            try {
                this.client.end(true); // Force close, don't wait for queue
            } catch (e) {
                this.error("Error closing MQTT client:", e);
            }
            this.client = null; // Release reference
        }

        // Disconnect C-Gate sockets
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

        // Remove all listeners from internal emitter to prevent leaks
        this.internalEventEmitter.removeAllListeners();

        // Reset flags (will also be reset by close handlers, but good practice)
        this.clientConnected = false;
        this.commandConnected = false;
        this.eventConnected = false;

        this.log(`${LOG_PREFIX} CgateWebBridge stopped.`);
    }

    _connectMqtt() {
        // Prevent multiple simultaneous connection attempts
        if (this.client) {
            this.log("MQTT client already exists or connection attempt in progress.");
            return;
        }
        this.log(`${LOG_PREFIX} Connecting to MQTT: ${this.settings.mqtt}`);
        this.client = this.mqttClientFactory(); // Use factory

        // Remove previous listeners if any (important for reconnect logic)
        this.client.removeAllListeners();

        this.client.on('connect', this._handleMqttConnect.bind(this));
        this.client.on('message', this._handleMqttMessage.bind(this));
        this.client.on('close', this._handleMqttClose.bind(this));
        this.client.on('error', this._handleMqttError.bind(this));
        this.client.on('offline', () => { this.warn(`${WARN_PREFIX} MQTT Client Offline.`); });
        this.client.on('reconnect', () => { this.log(`${LOG_PREFIX} MQTT Client Reconnecting...`); });
    }

    _connectCommandSocket() {
        // Prevent multiple simultaneous connection attempts
        if (this.commandSocket && this.commandSocket.connecting) {
            this.log("Command socket connection attempt already in progress.");
            return;
        }

        // Clean up old socket if exists
        if (this.commandSocket) {
            this.commandSocket.removeAllListeners();
            this.commandSocket.destroy();
            this.commandSocket = null;
        }

        this.log(`${LOG_PREFIX} Connecting to C-Gate Command Port: ${this.settings.cbusip}:${this.settings.cbuscommandport} (Attempt ${this.commandReconnectAttempts + 1})`);
        this.commandSocket = this.commandSocketFactory(); // Use factory

        this.commandSocket.on('connect', this._handleCommandConnect.bind(this));
        this.commandSocket.on('data', this._handleCommandData.bind(this));
        this.commandSocket.on('close', this._handleCommandClose.bind(this));
        this.commandSocket.on('error', this._handleCommandError.bind(this));

        try {
            this.commandSocket.connect(this.settings.cbuscommandport, this.settings.cbusip);
        } catch (e) {
            this.error("Error initiating command socket connection:", e);
            this._handleCommandError(e); // Treat initiation error like a connection error
        }
    }

    _connectEventSocket() {
        // Prevent multiple simultaneous connection attempts
        if (this.eventSocket && this.eventSocket.connecting) {
            this.log("Event socket connection attempt already in progress.");
            return;
        }

        // Clean up old socket if exists
        if (this.eventSocket) {
            this.eventSocket.removeAllListeners();
            this.eventSocket.destroy();
            this.eventSocket = null;
        }

        this.log(`${LOG_PREFIX} Connecting to C-Gate Event Port: ${this.settings.cbusip}:${this.settings.cbuseventport} (Attempt ${this.eventReconnectAttempts + 1})`);
        this.eventSocket = this.eventSocketFactory(); // Use factory

        this.eventSocket.on('connect', this._handleEventConnect.bind(this));
        this.eventSocket.on('data', this._handleEventData.bind(this));
        this.eventSocket.on('close', this._handleEventClose.bind(this));
        this.eventSocket.on('error', this._handleEventError.bind(this));

        try {
            this.eventSocket.connect(this.settings.cbuseventport, this.settings.cbusip);
        } catch (e) {
            this.error("Error initiating event socket connection:", e);
            this._handleEventError(e); // Treat initiation error like a connection error
        }
    }

    _scheduleReconnect(socketType) {
        let delay;
        let attempts;
        let connectFn;
        let timeoutProp;
        let currentTimeout;

        if (socketType === 'command') {
            if (this.commandConnected || (this.commandSocket && this.commandSocket.connecting)) return;
            this.log(`[DEBUG] Incrementing command attempts from ${this.commandReconnectAttempts}`);
            this.commandReconnectAttempts++;
            attempts = this.commandReconnectAttempts;
            connectFn = this._connectCommandSocket.bind(this);
            timeoutProp = 'commandReconnectTimeout';
            currentTimeout = this.commandReconnectTimeout;
        } else { // event
            if (this.eventConnected || (this.eventSocket && this.eventSocket.connecting)) return;
            this.log(`[DEBUG] Incrementing event attempts from ${this.eventReconnectAttempts}`);
            this.eventReconnectAttempts++;
            attempts = this.eventReconnectAttempts;
            connectFn = this._connectEventSocket.bind(this);
            timeoutProp = 'eventReconnectTimeout';
            currentTimeout = this.eventReconnectTimeout;
        }

        // Exponential backoff with cap
        delay = Math.min(this.settings.reconnectinitialdelay * Math.pow(2, attempts - 1), this.settings.reconnectmaxdelay);

        // Add specific logging for debugging test failures
        this.log(`[DEBUG] Scheduling ${socketType} reconnect: attempt=${attempts}, delay=${delay}ms`);

        this.log(`${LOG_PREFIX} ${socketType.toUpperCase()} PORT RECONNECTING in ${Math.round(delay/1000)}s (attempt ${attempts})...`);

         if (currentTimeout) {
             clearTimeout(currentTimeout);
         }

        this[timeoutProp] = setTimeout(connectFn, delay);
    }

    // --- Event Handlers ---

    _handleMqttConnect() {
        this.clientConnected = true;
        this.log(`${LOG_PREFIX} CONNECTED TO MQTT: ${this.settings.mqtt}`);
        // Publish Online status (LWT is generally preferred for this)
        this.mqttPublishQueue.add({ topic: 'hello/cgateweb', payload: 'Online', options: { retain: false } }); // Don't retain simple online message

        this.client.subscribe(`${MQTT_TOPIC_PREFIX_WRITE}/#`, (err) => {
            if (err) {
                this.error(`${ERROR_PREFIX} MQTT Subscription error:`, err);
            } else {
                this.log(`${LOG_PREFIX} Subscribed to MQTT topic: ${MQTT_TOPIC_PREFIX_WRITE}/#`);
            }
        });
        this._checkAllConnected();
    }

    _handleMqttClose() {
        this.clientConnected = false;
        this.warn(`${WARN_PREFIX} MQTT Client Closed. Reconnection handled by library.`);
        // Clear the client reference to allow reconnection attempt
        if (this.client) {
            this.client.removeAllListeners(); // Clean up listeners
            this.client = null;
        }
        // Attempt to reconnect MQTT explicitly if the library doesn't handle it well
        // setTimeout(() => this._connectMqtt(), RECONNECT_INITIAL_DELAY_MS);
    }

    _handleMqttError(err) {
        if (err.code === 5) { // MQTT CONNACK code 5: Not authorized
            this.error(`${ERROR_PREFIX} MQTT Connection Error: Authentication failed. Please check username/password in settings.js.`);
            this.error(`${ERROR_PREFIX} Exiting due to fatal MQTT authentication error.`);
            // Clear client reference *before* exiting? (Optional, maybe cleaner)
            if (this.client) {
                this.client.removeAllListeners();
                this.client = null;
            }
            process.exit(1); // Exit the process
        } else {
            // Handle generic errors
            this.error(`${ERROR_PREFIX} MQTT Client Error:`, err);
            this.clientConnected = false; // Set flag ONLY for non-fatal errors
            if (this.client) {
                this.client.removeAllListeners();
                this.client = null;
            }
            // Potentially add non-fatal reconnect logic here if needed
        }
    }

    _handleCommandConnect() {
        this.commandConnected = true;
        this.commandReconnectAttempts = 0;
        if (this.commandReconnectTimeout) clearTimeout(this.commandReconnectTimeout);
        this.commandReconnectTimeout = null;
        this.log(`${LOG_PREFIX} CONNECTED TO C-GATE COMMAND PORT: ${this.settings.cbusip}:${this.settings.cbuscommandport}`);
        try {
            if (this.commandSocket && !this.commandSocket.destroyed) {
                const commandString = 'EVENT ON\n';
                this.commandSocket.write(commandString);
                this.log(`${LOG_PREFIX} C-Gate Sent: ${commandString.trim()} (Directly on connect)`);
            } else {
                this.warn(`${WARN_PREFIX} Command socket not available to send initial EVENT ON.`);
            }
        } catch (e) {
            this.error(`${ERROR_PREFIX} Error sending initial EVENT ON:`, e);
            // Handle error appropriately, maybe close/reconnect?
        }
        this._checkAllConnected();
    }

    _handleCommandClose(hadError) {
        this.commandConnected = false;
        // Clear the socket reference
        if (this.commandSocket) {
            this.commandSocket.removeAllListeners();
            // Don't destroy here, already closed
            this.commandSocket = null;
        }
        this.warn(`${WARN_PREFIX} COMMAND PORT DISCONNECTED${hadError ? ' with error' : ''}`);
        this._scheduleReconnect('command');
    }

    _handleCommandError(err) {
        this.error(`${ERROR_PREFIX} C-Gate Command Socket Error:`, err);
        // The 'close' event will usually follow an error, triggering reconnect.
        // If it doesn't, we might need explicit handling here.
        // Ensure flags are set correctly
        this.commandConnected = false;
        // Clear the socket reference
        if (this.commandSocket && !this.commandSocket.destroyed) {
            this.commandSocket.destroy(); // Explicitly destroy if not already done
        }
        this.commandSocket = null;
        // Manually trigger reconnect scheduling if close doesn't follow quickly
        // setTimeout(() => this._scheduleReconnect('command'), 100); 
    }

    _handleEventConnect() {
        this.eventConnected = true;
        this.eventReconnectAttempts = 0;
        if (this.eventReconnectTimeout) clearTimeout(this.eventReconnectTimeout);
        this.eventReconnectTimeout = null;
        this.log(`${LOG_PREFIX} CONNECTED TO C-GATE EVENT PORT: ${this.settings.cbusip}:${this.settings.cbuseventport}`);
        this._checkAllConnected();
    }

    _handleEventClose(hadError) {
        this.eventConnected = false;
        // Clear the socket reference
        if (this.eventSocket) {
            this.eventSocket.removeAllListeners();
            // Don't destroy here, already closed
            this.eventSocket = null;
        }
        this.warn(`${WARN_PREFIX} EVENT PORT DISCONNECTED${hadError ? ' with error' : ''}`);
        this._scheduleReconnect('event');
    }

    _handleEventError(err) {
        this.error(`${ERROR_PREFIX} C-Gate Event Socket Error:`, err);
        // The 'close' event will usually follow an error, triggering reconnect.
        // Ensure flags are set correctly
        this.eventConnected = false;
        // Clear the socket reference
        if (this.eventSocket && !this.eventSocket.destroyed) {
            this.eventSocket.destroy(); // Explicitly destroy if not already done
        }
        this.eventSocket = null;
        // Manually trigger reconnect scheduling if close doesn't follow quickly
        // setTimeout(() => this._scheduleReconnect('event'), 100);
    }

    _checkAllConnected() {
        if (this.clientConnected && this.commandConnected && this.eventConnected) {
            this.log(`${LOG_PREFIX} ALL CONNECTED`);
            this.log(`${LOG_PREFIX} Connection Successful: MQTT (${this.settings.mqtt}), C-Gate (${this.settings.cbusip}:${this.settings.cbuscommandport},${this.settings.cbuseventport}). Awaiting messages...`);

            // --- Trigger Initial Get All --- 
            if (this.settings.getallnetapp && this.settings.getallonstart) {
                this.log(`${LOG_PREFIX} Getting all initial values for ${this.settings.getallnetapp}...`);
                this.cgateCommandQueue.add(`GET //${this.settings.cbusname}/${this.settings.getallnetapp}/* level\n`); // Standardize newline
            }

            // --- Trigger Periodic Get All --- 
            if (this.settings.getallnetapp && this.settings.getallperiod) {
                 if (this.periodicGetAllInterval) {
                      clearInterval(this.periodicGetAllInterval);
                 }
                this.log(`${LOG_PREFIX} Starting periodic 'get all' every ${this.settings.getallperiod} seconds.`);
                this.periodicGetAllInterval = setInterval(() => {
                    this.log(`${LOG_PREFIX} Getting all periodic values for ${this.settings.getallnetapp}...`);
                    this.cgateCommandQueue.add(`GET //${this.settings.cbusname}/${this.settings.getallnetapp}/* level\n`); // Standardize newline
                }, this.settings.getallperiod * 1000);
            }
            
            // --- Trigger HA Discovery (if enabled) ---
            if (this.settings.ha_discovery_enabled) {
                this._triggerHaDiscovery();
            }
        }
    }
    
    // --- New method to trigger discovery ---
    _triggerHaDiscovery() {
        this.log(`${LOG_PREFIX} HA Discovery enabled, querying network trees...`);
        let networksToDiscover = this.settings.ha_discovery_networks;
        
        // If no networks explicitly configured, try using getallnetapp network if set
        if (networksToDiscover.length === 0 && this.settings.getallnetapp) {
            const networkIdMatch = String(this.settings.getallnetapp).match(/^(\d+)/); // Match potential network ID if getallnetapp is like '254' or '254/56'
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
        
        networksToDiscover.forEach(networkId => {
            if (networkId) {
                this.log(`${LOG_PREFIX} Queuing TREEXML for network ${networkId} for HA Discovery.`);
                // Use a distinct internal event or flag later if needed to distinguish 
                // HA discovery TREEXML from manual requests.
                this.cgateCommandQueue.add(`TREEXML ${networkId}\n`);
            } else {
                this.warn(`${WARN_PREFIX} Invalid network ID found in ha_discovery_networks: ${networkId}`);
            }
        });
    }

    // --- Queue Processors ---

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

    _processCgateCommand(commandString) {
        if (this.commandConnected && this.commandSocket) {
            try {
                this.commandSocket.write(commandString);
                this.log(`${LOG_PREFIX} C-Gate Sent: ${commandString.trim()}`);
            } catch (e) {
                this.error(`${ERROR_PREFIX} Error writing to C-Gate command socket:`, e, commandString.trim());
            }
        } else {
            this.warn(`${WARN_PREFIX} C-Gate command socket not connected. Dropping command:`, commandString.trim());
            // Optional: Implement retry logic
        }
    }

    // --- Data Handling ---

    _handleMqttMessage(topic, messageBuffer) {
        const message = messageBuffer.toString();
        this.log(`${LOG_PREFIX} MQTT received on ${topic}: ${message}`);

        // --- Add handler for manual discovery trigger ---
        if (topic === 'cbus/write/bridge/announce') { // Example topic
            if (this.settings.ha_discovery_enabled) {
                 this.log(`${LOG_PREFIX} Manual HA Discovery triggered via MQTT.`);
                 this._triggerHaDiscovery();
             } else {
                 this.warn(`${WARN_PREFIX} Manual HA Discovery trigger received, but feature is disabled in settings.`);
             }
             return; // Don't process as CBusCommand
        }

        const command = new CBusCommand(topic, message);
        if (!command.isValid()) {
            this.warn(`${WARN_PREFIX} Ignoring invalid MQTT command on topic ${topic}`);
            return;
        }

        // Construct C-Bus path carefully, handling potentially empty device ID
        let cbusPath = `//${this.settings.cbusname}/${command.Host()}/${command.Group()}/`;
        if (command.Device()) {
            cbusPath += command.Device();
        } else {
            // If device is empty, trim trailing slash? Depends on C-Gate expectations.
            // For GET //.../* commands, the path is different.
            if (command.CommandType() === 'getall') {
                cbusPath = `//${this.settings.cbusname}/${command.Host()}/${command.Group()}/*`;
            } else {
                // Assume commands like ON/OFF require a device, log warning?
                this.warn(`${WARN_PREFIX} MQTT command on topic ${topic} has empty device ID.`);
                // For safety, let's return if the path seems incomplete for the command type
                if (command.CommandType() !== 'gettree') { // gettree targets network only
                    return;
                }
            }
        }

        try {
            switch (command.CommandType()) {
                case "gettree":
                    this.treeNetwork = command.Host();
                    this.cgateCommandQueue.add(`TREEXML ${command.Host()}\n`); // Standardize newline
                    break;

                case "getall":
                    this.cgateCommandQueue.add(`GET ${cbusPath} level\n`); // Standardize newline
                    break;

                case "switch":
                    if (message.toUpperCase() === MQTT_STATE_ON) {
                        this.cgateCommandQueue.add(`ON ${cbusPath}\n`); // Standardize newline
                    } else if (message.toUpperCase() === MQTT_STATE_OFF) {
                        this.cgateCommandQueue.add(`OFF ${cbusPath}\n`); // Standardize newline
                    } else {
                        this.warn(`${WARN_PREFIX} Invalid payload for switch command: ${message}`);
                    }
                    break;

                case "ramp":
                    const rampAction = message.toUpperCase();
                    const levelAddress = `${command.Host()}/${command.Group()}/${command.Device()}`; // For event emitter
                    // Ensure we have a device for ramp actions
                    if (!command.Device()) {
                        this.warn(`${WARN_PREFIX} Ramp command requires device ID on topic ${topic}`);
                        break;
                    }

                    switch (rampAction) {
                        case "INCREASE":
                            this.internalEventEmitter.once('level', (address, currentLevel) => {
                                if (address === levelAddress) {
                                    // Ensure currentLevel is a number (it comes from event emitter which might pass string or number)
                                    const currentLevelNum = parseInt(currentLevel);
                                    if (!isNaN(currentLevelNum)) {
                                        const newLevel = Math.min(255, currentLevelNum + RAMP_STEP);
                                        this.cgateCommandQueue.add(`RAMP ${cbusPath} ${newLevel}\n`); // Standardize newline
                                    } else {
                                        this.warn(`${WARN_PREFIX} Could not parse current level for INCREASE: ${currentLevel}`);
                                    }
                                }
                            });
                            this.cgateCommandQueue.add(`GET ${cbusPath} level\n`); // Standardize newline
                            break;

                        case "DECREASE":
                            this.internalEventEmitter.once('level', (address, currentLevel) => {
                                if (address === levelAddress) {
                                    const currentLevelNum = parseInt(currentLevel);
                                    if (!isNaN(currentLevelNum)) {
                                        const newLevel = Math.max(0, currentLevelNum - RAMP_STEP);
                                        this.cgateCommandQueue.add(`RAMP ${cbusPath} ${newLevel}\n`); // Standardize newline
                                    } else {
                                        this.warn(`${WARN_PREFIX} Could not parse current level for DECREASE: ${currentLevel}`);
                                    }
                                }
                            });
                            this.cgateCommandQueue.add(`GET ${cbusPath} level\n`); // Standardize newline
                            break;

                        case MQTT_STATE_ON:
                            this.cgateCommandQueue.add(`ON ${cbusPath}\n`); // Standardize newline
                            break;
                        case MQTT_STATE_OFF:
                            this.cgateCommandQueue.add(`OFF ${cbusPath}\n`); // Standardize newline
                            break;
                        default:
                            const rawLevel = command.RawLevel();
                            const rampTime = command.RampTime();
                            if (rawLevel !== null) {
                                if (rampTime) {
                                    this.cgateCommandQueue.add(`RAMP ${cbusPath} ${rawLevel} ${rampTime}\n`); // Standardize newline
                                } else {
                                    this.cgateCommandQueue.add(`RAMP ${cbusPath} ${rawLevel}\n`); // Standardize newline
                                }
                            } else {
                                this.warn(`${WARN_PREFIX} Invalid payload for ramp command: ${message}`);
                            }
                    }
                    break;

                default:
                    this.warn(`${WARN_PREFIX} Unknown MQTT command type received: ${command.CommandType()}`);
            }
        } catch (e) {
            this.error(`${ERROR_PREFIX} Error processing MQTT message:`, e, `Topic: ${topic}, Message: ${message}`);
        }
    }

    _handleCommandData(data) {
        this.commandBuffer += data.toString();
        let newlineIndex;

        while ((newlineIndex = this.commandBuffer.indexOf('\n')) > -1) {
            const line = this.commandBuffer.substring(0, newlineIndex).trim();
            this.commandBuffer = this.commandBuffer.substring(newlineIndex + 1);

            if (!line) continue; // Skip empty lines

            this.log(`${LOG_PREFIX} C-Gate Recv (Cmd): ${line}`);

            try {
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
                
                if (!responseCode || !/^[1-6]\d{2}$/.test(responseCode)) {
                     continue; // Skip processing this line
                }

                if (responseCode === CGATE_RESPONSE_OBJECT_STATUS) { // 300
                    const levelMatch = statusData.match(/(\/\/.*?\/.*?\/.*?\/.*?)\s+level=(\d+)/);

                    if (levelMatch) {
                        const fullAddress = levelMatch[1]; // e.g., //PROJECT/254/56/10
                        const levelValue = parseInt(levelMatch[2]);
                        const levelPercent = Math.round(levelValue * 100 / 255).toString();
                        const addressParts = fullAddress.split('/'); // ['', '', project, network, app, group]
                        if (addressParts.length >= 6) {
                            const netAddr = addressParts[3];
                            const appAddr = addressParts[4];
                            const groupAddr = addressParts[5];
                            const simpleAddr = `${netAddr}/${appAddr}/${groupAddr}`; // For event emitter
                            const topicBase = `${MQTT_TOPIC_PREFIX_READ}/${simpleAddr}`;

                            this.internalEventEmitter.emit('level', simpleAddr, levelValue);

                            if (levelValue === 0) {
                                this.log(`${LOG_PREFIX} C-Bus Status (Cmd/Get): ${simpleAddr} OFF (0%)`);
                                this.mqttPublishQueue.add({ topic: `${topicBase}/state`, payload: MQTT_STATE_OFF, options: this._mqttOptions });
                                this.mqttPublishQueue.add({ topic: `${topicBase}/level`, payload: '0', options: this._mqttOptions });
                            } else {
                                this.log(`${LOG_PREFIX} C-Bus Status (Cmd/Get): ${simpleAddr} ON (${levelPercent}%)`);
                                this.mqttPublishQueue.add({ topic: `${topicBase}/state`, payload: MQTT_STATE_ON, options: this._mqttOptions });
                                this.mqttPublishQueue.add({ topic: `${topicBase}/level`, payload: levelPercent, options: this._mqttOptions });
                            }
                        } else {
                            this.warn(`${WARN_PREFIX} Could not parse address from command data (level report): ${fullAddress}`);
                        }
                    } else {
                        const event = new CBusEvent(statusData);
                        if (event.isValid()) {
                            this._publishEvent(event, '(Cmd/Event)');
                            this._emitLevelFromEvent(event);
                        } else {
                            this.log(`${LOG_PREFIX} Unhandled status response (300) from command port: ${statusData}`);
                        }
                    }
                } else if (responseCode === CGATE_RESPONSE_TREE_START) {
                    this.treeBuffer = '';
                    this.treeNetwork = statusData || this.treeNetwork;
                    this.log(`${LOG_PREFIX} Started receiving TreeXML for network ${this.treeNetwork || 'unknown'}...`);
                } else if (responseCode === CGATE_RESPONSE_TREE_DATA) { // 347
                    this.treeBuffer += statusData + '\n';
                } else if (responseCode === CGATE_RESPONSE_TREE_END) { // 344
                    this.log(`${LOG_PREFIX} Finished receiving TreeXML. Parsing...`);
                    const networkForTree = this.treeNetwork; // Capture before clearing
                    const treeXmlData = this.treeBuffer;
                    this.treeBuffer = ''; // Clear buffer immediately
                    this.treeNetwork = null; // Reset network context immediately

                    if (networkForTree && treeXmlData) {
                        parseString(treeXmlData, { explicitArray: false }, (err, result) => { 
                            if (err) {
                                this.error(`${ERROR_PREFIX} Error parsing TreeXML for network ${networkForTree}:`, err);
                            } else {
                                this.log(`${LOG_PREFIX} Parsed TreeXML for network ${networkForTree}`);
                                // TODO: Decide if manual gettree should also publish to HA?
                                // For now, only publish simple tree to standard topic
                                this.mqttPublishQueue.add({ 
                                    topic: `${MQTT_TOPIC_PREFIX_READ}/${networkForTree}///tree`,
                                    payload: JSON.stringify(result),
                                    options: this._mqttOptions 
                                });
                                
                                // --- Generate HA Discovery Payloads ---
                                const allowedNetworks = this.settings.ha_discovery_networks.map(String); // Convert allowed list to strings
                                if (this.settings.ha_discovery_enabled && allowedNetworks.includes(String(networkForTree))) {
                                    this._publishHaDiscoveryFromTree(networkForTree, result);
                                }
                            }
                            // No cleanup here, done earlier
                        });
                    } else {
                        this.warn(`${WARN_PREFIX} Received TreeXML end (344) but no buffer or network context was set.`); 
                    }
                } else if (responseCode.startsWith('4') || responseCode.startsWith('5')) {
                    this.error(`${ERROR_PREFIX} C-Gate Command Error Response: ${responseCode} ${statusData}`);
                } else {
                }
            } catch (e) {
                this.error(`${ERROR_PREFIX} Error processing command data line:`, e, `Line: ${line}`); 
            }
        }
    }

    _handleEventData(data) {
        this.eventBuffer += data.toString();
        let newlineIndex;

        while ((newlineIndex = this.eventBuffer.indexOf('\n')) > -1) {
            const line = this.eventBuffer.substring(0, newlineIndex).trim();
            this.eventBuffer = this.eventBuffer.substring(newlineIndex + 1);

            if (!line) continue; // Skip empty lines

            // Handle comments (lines starting with #)
            if (line.startsWith('#')) {
                this.log(`${LOG_PREFIX} Ignoring comment from event port:`, line);
                continue;
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
    }

    // Helper to emit the 'level' event based on a parsed CBusEvent
    _emitLevelFromEvent(event) {
        const simpleAddr = `${event.Host()}/${event.Group()}/${event.Device()}`;
        let levelValue = null;
        // Try to get raw level first (most accurate for ramp)
        if (event._levelRaw !== null) {
            levelValue = event._levelRaw;
        } else if (event.Action() === 'on') {
            levelValue = 255;
        } else if (event.Action() === 'off') {
            levelValue = 0;
        }

        if (levelValue !== null) {
            this.internalEventEmitter.emit('level', simpleAddr, levelValue);
        } else {
            this.log(`${LOG_PREFIX} Could not determine level value for event:`, event);
        }
    }

    // Helper to publish state/level based on a parsed CBusEvent
    _publishEvent(event, source = '') {
        if (!event || !event.isValid()) {
            return;
        }
        const topicBase = `${MQTT_TOPIC_PREFIX_READ}/${event.Host()}/${event.Group()}/${event.Device()}`;
        const levelPercent = event.Level(); // Get 0-100 level

        // Determine state based on level (more reliable than action for ramp)
        const state = (levelPercent !== null && parseInt(levelPercent) > 0) ? MQTT_STATE_ON : MQTT_STATE_OFF;

        this.log(`${LOG_PREFIX} C-Bus Status ${source}: ${event.Host()}/${event.Group()}/${event.Device()} ${state} (${levelPercent || '0'}%)`);

        // Publish state and level
        this.mqttPublishQueue.add({ topic: `${topicBase}/state`, payload: state, options: this._mqttOptions });
        this.mqttPublishQueue.add({ topic: `${topicBase}/level`, payload: levelPercent || '0', options: this._mqttOptions });
    }

    // --- New method to generate and publish HA discovery messages ---
    _publishHaDiscoveryFromTree(networkId, treeData) {
        this.log(`${LOG_PREFIX} Generating HA Discovery messages for network ${networkId}...`);
        // Basic structure assuming xml2js result format
        const projectData = treeData?.Network;
        if (!projectData?.Interface?.Network || projectData.Interface.Network.NetworkNumber !== String(networkId)) {
             this.warn(`${WARN_PREFIX} TreeXML for network ${networkId} seems malformed or doesn't match expected structure.`);
             return;
        }

        const units = projectData.Interface.Network.Unit || [];
        const lightingAppId = '56'; // TODO: Make configurable?
        const coverAppId = this.settings.ha_discovery_cover_app_id; // Get configured cover app ID
        const switchAppId = this.settings.ha_discovery_switch_app_id; // Get switch app ID
        const relayAppId = this.settings.ha_discovery_relay_app_id; // Get relay app ID
        let discoveryCount = 0;

        // Function to process EnableControl groups (avoids repetition)
        const processEnableControl = (enableControlData) => {
            if (!enableControlData?.Group) return; // Check if group exists

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
                let discovered = false;

                // Check if it matches the Cover App ID
                if (coverAppId && appAddress === coverAppId) {
                    const finalLabel = groupLabel || `CBus Cover ${networkId}/${coverAppId}/${groupId}`;
                    const uniqueId = `cgateweb_${networkId}_${coverAppId}_${groupId}`;
                    const discoveryTopic = `${this.settings.ha_discovery_prefix}/cover/${uniqueId}/config`;
                    const payload = {
                        name: finalLabel,
                        unique_id: uniqueId,
                        state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${coverAppId}/${groupId}/state`,
                        command_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${coverAppId}/${groupId}/switch`,
                        payload_open: "ON",
                        payload_close: "OFF",
                        state_open: "ON",
                        state_closed: "OFF",
                        qos: 0,
                        retain: true,
                        device_class: "shutter",
                        device: {
                            identifiers: [uniqueId],
                            name: finalLabel,
                            manufacturer: "Clipsal C-Bus via cgateweb",
                            model: "Enable Control Group (Cover)",
                            via_device: "cgateweb_bridge"
                        },
                        origin: {
                            name: "cgateweb",
                            sw_version: "0.1.0", // TODO: Get version dynamically
                            support_url: "https://github.com/dougrathbone/cgateweb"
                        }
                    };
                    this.mqttPublishQueue.add({ topic: discoveryTopic, payload: JSON.stringify(payload), options: { retain: true, qos: 0 } });
                    discoveryCount++;
                    discovered = true;
                }

                // Check if it matches the Switch App ID (and wasn't already discovered as a cover)
                if (!discovered && switchAppId && appAddress === switchAppId) {
                    const finalLabel = groupLabel || `CBus Switch ${networkId}/${switchAppId}/${groupId}`;
                    const uniqueId = `cgateweb_${networkId}_${switchAppId}_${groupId}`;
                    const discoveryTopic = `${this.settings.ha_discovery_prefix}/switch/${uniqueId}/config`;
                    const payload = {
                        name: finalLabel,
                        unique_id: uniqueId,
                        state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${switchAppId}/${groupId}/state`,
                        command_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${switchAppId}/${groupId}/switch`,
                        payload_on: "ON",
                        payload_off: "OFF",
                        state_on: "ON",
                        state_off: "OFF",
                        qos: 0,
                        retain: true,
                        // device_class: "switch", // Optional: specific device class if needed
                        device: {
                            identifiers: [uniqueId],
                            name: finalLabel,
                            manufacturer: "Clipsal C-Bus via cgateweb",
                            model: "Enable Control Group (Switch)",
                            via_device: "cgateweb_bridge"
                        },
                        origin: {
                            name: "cgateweb",
                            sw_version: "0.1.0",
                            support_url: "https://github.com/dougrathbone/cgateweb"
                        }
                    };
                    this.mqttPublishQueue.add({ topic: discoveryTopic, payload: JSON.stringify(payload), options: { retain: true, qos: 0 } });
                    discoveryCount++;
                    discovered = true;
                }

                // Check if it matches the Relay App ID (and wasn't already discovered)
                // Treat relays as switches in Home Assistant
                if (!discovered && relayAppId && appAddress === relayAppId) {
                     const finalLabel = groupLabel || `CBus Relay ${networkId}/${relayAppId}/${groupId}`;
                     const uniqueId = `cgateweb_${networkId}_${relayAppId}_${groupId}`;
                     const discoveryTopic = `${this.settings.ha_discovery_prefix}/switch/${uniqueId}/config`;
                     const payload = {
                         name: finalLabel,
                         unique_id: uniqueId,
                         state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${relayAppId}/${groupId}/state`,
                         command_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${relayAppId}/${groupId}/switch`,
                         payload_on: "ON",
                         payload_off: "OFF",
                         state_on: "ON",
                         state_off: "OFF",
                         qos: 0,
                         retain: true,
                         device_class: "outlet", // Use 'outlet' device class for relays
                         device: {
                             identifiers: [uniqueId],
                             name: finalLabel,
                             manufacturer: "Clipsal C-Bus via cgateweb",
                             model: "Enable Control Group (Relay)",
                             via_device: "cgateweb_bridge"
                         },
                         origin: {
                             name: "cgateweb",
                             sw_version: "0.1.0", // TODO: Get version dynamically
                             support_url: "https://github.com/dougrathbone/cgateweb"
                         }
                     };
                     this.mqttPublishQueue.add({ topic: discoveryTopic, payload: JSON.stringify(payload), options: { retain: true, qos: 0 } });
                     discoveryCount++;
                     discovered = true; // Mark as discovered
                 }
            });
        };

        try {
            units.forEach(unit => {
                const lightingData = unit.Application?.Lighting;
                const enableControlData = unit.Application?.EnableControl;
                // Add other top-level apps here if needed, e.g.: const measurementData = unit.Application?.Measurement;

                // --- Process Lighting --- 
                if (lightingData?.Group) {
                    // Check ApplicationAddress if needed (though usually 56)
                    // if (lightingData.ApplicationAddress !== lightingAppId) { ... }
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
                        const discoveryTopic = `${this.settings.ha_discovery_prefix}/light/${uniqueId}/config`;
                        const payload = {
                            name: groupLabel,
                            unique_id: uniqueId,
                            state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${lightingAppId}/${groupId}/state`,
                            command_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${lightingAppId}/${groupId}/switch`,
                            payload_on: "ON",
                            payload_off: "OFF",
                            brightness_state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${lightingAppId}/${groupId}/level`,
                            brightness_command_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${lightingAppId}/${groupId}/ramp`,
                            brightness_scale: 100,
                            qos: 0,
                            retain: true,
                            device: {
                                identifiers: [uniqueId],
                                name: groupLabel,
                                manufacturer: "Clipsal C-Bus via cgateweb",
                                model: "Lighting Group",
                                via_device: "cgateweb_bridge"
                            },
                            origin: {
                                name: "cgateweb",
                                sw_version: "0.1.0", // TODO: Get version dynamically
                                support_url: "https://github.com/dougrathbone/cgateweb"
                            }
                        };
                        this.mqttPublishQueue.add({ topic: discoveryTopic, payload: JSON.stringify(payload), options: { retain: true, qos: 0 } });
                        discoveryCount++;
                    });
                    
                    // --- Process EnableControl NESTED under Lighting --- 
                    if (lightingData.EnableControl) {
                        processEnableControl(lightingData.EnableControl);
                    }
                }

                // --- Process TOP-LEVEL EnableControl --- 
                // (Ensure it wasn't already processed as nested - though unlikely for same group)
                // The processEnableControl function itself handles the App ID check.
                if (enableControlData) {
                    // We might need a check here if the same group could appear both nested and top-level.
                    // For now, assume distinct groups or that double-processing is harmless 
                    // if the unique ID prevents duplicate HA entities.
                    processEnableControl(enableControlData);
                }
                
                // --- Process other top-level applications here --- 
                // e.g., if (measurementData?.Group) { ... }

            }); // end units.forEach

            this.log(`${LOG_PREFIX} Published ${discoveryCount} HA Discovery messages for network ${networkId}.`);

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