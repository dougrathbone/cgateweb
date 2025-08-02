const { EventEmitter } = require('events');
const CgateConnection = require('./cgateConnection');
const MqttManager = require('./mqttManager');
const HaDiscovery = require('./haDiscovery');
const ThrottledQueue = require('./throttledQueue');
const CBusEvent = require('./cbusEvent');
const CBusCommand = require('./cbusCommand');
const { createLogger } = require('./logger');
const {
    LOG_PREFIX,
    WARN_PREFIX,
    ERROR_PREFIX,
    MQTT_TOPIC_PREFIX_WRITE,
    MQTT_TOPIC_PREFIX_READ,
    MQTT_TOPIC_SUFFIX_STATE,
    MQTT_TOPIC_SUFFIX_LEVEL,
    MQTT_TOPIC_MANUAL_TRIGGER,
    MQTT_CMD_TYPE_GETALL,
    MQTT_CMD_TYPE_GETTREE,
    MQTT_CMD_TYPE_SWITCH,
    MQTT_CMD_TYPE_RAMP,
    MQTT_STATE_ON,
    MQTT_STATE_OFF,
    MQTT_COMMAND_INCREASE,
    MQTT_COMMAND_DECREASE,
    CGATE_CMD_ON,
    CGATE_CMD_OFF,
    CGATE_CMD_RAMP,
    CGATE_CMD_GET,
    CGATE_PARAM_LEVEL,
    CGATE_LEVEL_MIN,
    CGATE_LEVEL_MAX,
    RAMP_STEP,
    CGATE_RESPONSE_OBJECT_STATUS,
    CGATE_RESPONSE_TREE_START,
    CGATE_RESPONSE_TREE_DATA,
    CGATE_RESPONSE_TREE_END,
    NEWLINE
} = require('./constants');

/**
 * Main bridge class that connects C-Gate (Clipsal C-Bus automation system) to MQTT.
 * 
 * This class orchestrates communication between:
 * - C-Gate server (Clipsal's C-Bus automation gateway)
 * - MQTT broker (for Home Assistant and other automation systems)
 * - Home Assistant discovery protocol
 * 
 * The bridge translates between C-Bus events and MQTT messages, enabling
 * bidirectional control of C-Bus devices through MQTT.
 * 
 * @example
 * const bridge = new CgateWebBridge({
 *   mqtt: 'mqtt://localhost:1883',
 *   cbusip: '192.168.1.100',
 *   cbuscommandport: 20023,
 *   cbuseventport: 20024,
 *   cbusname: 'SHAC'
 * });
 * bridge.start();
 */
class CgateWebBridge {
    /**
     * Creates a new CgateWebBridge instance.
     * 
     * @param {Object} settings - Configuration settings for the bridge
     * @param {string} settings.mqtt - MQTT broker URL (e.g., 'mqtt://localhost:1883')
     * @param {string} settings.cbusip - C-Gate server IP address
     * @param {number} settings.cbuscommandport - C-Gate command port (typically 20023)
     * @param {number} settings.cbuseventport - C-Gate event port (typically 20024)
     * @param {string} settings.cbusname - C-Gate project name
     * @param {Function} [mqttClientFactory=null] - Factory for creating MQTT clients (for testing)
     * @param {Function} [commandSocketFactory=null] - Factory for command sockets (for testing)
     * @param {Function} [eventSocketFactory=null] - Factory for event sockets (for testing)
     */
    constructor(settings, mqttClientFactory = null, commandSocketFactory = null, eventSocketFactory = null) {
        // Merge with default settings
        const { defaultSettings } = require('../index.js');
        this.settings = { ...defaultSettings, ...settings };
        this.logger = createLogger({ 
            component: 'bridge', 
            level: this.settings.logging ? 'info' : 'warn',
            enabled: true 
        });

        // Store factory references for test compatibility
        this.mqttClientFactory = mqttClientFactory;
        this.commandSocketFactory = commandSocketFactory;
        this.eventSocketFactory = eventSocketFactory;
        
        // Connection managers
        this.mqttManager = new MqttManager(this.settings);
        this.commandConnection = new CgateConnection('command', this.settings.cbusip, this.settings.cbuscommandport, this.settings);
        this.eventConnection = new CgateConnection('event', this.settings.cbusip, this.settings.cbuseventport, this.settings);
        
        // Service modules
        this.haDiscovery = new HaDiscovery(this.settings, this.mqttManager, this.commandConnection);
        
        // Message queues
        this.cgateCommandQueue = new ThrottledQueue(
            (command) => this._sendCgateCommand(command),
            this.settings.messageinterval,
            'C-Gate Command Queue'
        );
        
        this.mqttPublishQueue = new ThrottledQueue(
            (message) => this._publishMqttMessage(message),
            this.settings.messageinterval,
            'MQTT Publish Queue'
        );

        // Internal state
        this.commandBuffer = '';
        this.eventBuffer = '';
        this.internalEventEmitter = new EventEmitter();
        this.periodicGetAllInterval = null;

        // Internal state tracking
        this.allConnected = false;

        // MQTT options
        this._mqttOptions = this.settings.retainreads ? { retain: true, qos: 0 } : { qos: 0 };

        // Validate settings and exit if invalid
        if (!this._validateSettings()) {
            process.exit(1);
        }

        this._setupEventHandlers();
    }

    _setupEventHandlers() {
        // MQTT event handlers
        this.mqttManager.on('connect', () => {
            this._handleAllConnected();
        });
        this.mqttManager.on('message', (topic, payload) => this._handleMqttMessage(topic, payload));
        this.mqttManager.on('close', () => {
            this.allConnected = false;
        });

        // C-Gate command connection handlers
        this.commandConnection.on('connect', () => {
            this._handleAllConnected();
        });
        this.commandConnection.on('data', (data) => this._handleCommandData(data));
        this.commandConnection.on('close', () => {
            this.allConnected = false;
        });

        // C-Gate event connection handlers
        this.eventConnection.on('connect', () => {
            this._handleAllConnected();
        });
        this.eventConnection.on('data', (data) => this._handleEventData(data));
        this.eventConnection.on('close', () => {
            this.allConnected = false;
        });
    }

    /**
     * Starts the bridge by connecting to MQTT broker and C-Gate server.
     * 
     * This method initiates connections to:
     * - MQTT broker (for receiving commands and publishing events)
     * - C-Gate command port (for sending commands to C-Bus devices)
     * - C-Gate event port (for receiving C-Bus device events)
     * 
     * @returns {CgateWebBridge} Returns this instance for method chaining
     */
    start() {
        this.logger.info('Starting cgateweb bridge');
        
        // Start all connections
        this.mqttManager.connect();
        this.commandConnection.connect();
        this.eventConnection.connect();
        
        return this;
    }

    /**
     * Stops the bridge and cleans up all resources.
     * 
     * This method:
     * - Clears any running periodic tasks
     * - Empties message queues
     * - Disconnects from MQTT broker and C-Gate server
     * - Resets connection state
     */
    stop() {
        this.log(`${LOG_PREFIX} Stopping cgateweb bridge...`);
        
        // Clear periodic tasks
        if (this.periodicGetAllInterval) {
            clearInterval(this.periodicGetAllInterval);
            this.periodicGetAllInterval = null;
        }

        // Clear queues
        this.cgateCommandQueue.clear();
        this.mqttPublishQueue.clear();

        // Disconnect all connections
        this.mqttManager.disconnect();
        this.commandConnection.disconnect();
        this.eventConnection.disconnect();

        this.allConnected = false;
    }

    _handleAllConnected() {
        if (this.mqttManager.connected && 
            this.commandConnection.connected && 
            this.eventConnection.connected &&
            !this.allConnected) {
            
            this.allConnected = true;
            this.log(`${LOG_PREFIX} ALL CONNECTED`);
            this.log(`${LOG_PREFIX} Connection Successful: MQTT (${this.settings.mqtt}), C-Gate (${this.settings.cbusip}:${this.settings.cbuscommandport},${this.settings.cbuseventport}). Awaiting messages...`);

            // Trigger initial get all
            if (this.settings.getallnetapp && this.settings.getallonstart) {
                this.log(`${LOG_PREFIX} Getting all initial values for ${this.settings.getallnetapp}...`);
                this.cgateCommandQueue.add(`${CGATE_CMD_GET} //${this.settings.cbusname}/${this.settings.getallnetapp}/* ${CGATE_PARAM_LEVEL}${NEWLINE}`);
            }

            // Setup periodic get all
            if (this.settings.getallnetapp && this.settings.getallperiod) {
                if (this.periodicGetAllInterval) {
                    clearInterval(this.periodicGetAllInterval);
                }
                this.log(`${LOG_PREFIX} Starting periodic 'get all' every ${this.settings.getallperiod} seconds.`);
                this.periodicGetAllInterval = setInterval(() => {
                    this.log(`${LOG_PREFIX} Getting all periodic values for ${this.settings.getallnetapp}...`);
                    this.cgateCommandQueue.add(`${CGATE_CMD_GET} //${this.settings.cbusname}/${this.settings.getallnetapp}/* ${CGATE_PARAM_LEVEL}${NEWLINE}`);
                }, this.settings.getallperiod * 1000);
            }
            
            // Trigger HA Discovery
            if (this.settings.ha_discovery_enabled) {
                this.haDiscovery.trigger();
            }
        }
    }

    /**
     * Handles incoming MQTT messages and converts them to C-Gate commands.
     * 
     * Processes MQTT topics like:
     * - "cbus/write/254/56/4/switch" with payload "ON" → C-Gate "on" command
     * - "cbus/write/254/56/4/ramp" with payload "50" → C-Gate "ramp" to 50% command
     * - "cgateweb/trigger_discovery" → triggers Home Assistant discovery
     * 
     * @param {string} topic - MQTT topic that was published to
     * @param {string|Buffer} payload - MQTT message payload
     * @private
     */
    _handleMqttMessage(topic, payload) {
        this.log(`${LOG_PREFIX} MQTT Recv: ${topic} -> ${payload}`);

        // Handle manual HA discovery trigger
        if (topic === MQTT_TOPIC_MANUAL_TRIGGER) {
            if (this.settings.ha_discovery_enabled) {
                this.log(`${LOG_PREFIX} Manual HA Discovery triggered via MQTT.`);
                this.haDiscovery.trigger();
            } else {
                this.warn(`${WARN_PREFIX} Manual HA Discovery trigger received, but feature is disabled in settings.`);
            }
            return;
        }

        // Parse MQTT command
        const command = new CBusCommand(topic, payload);
        if (!command.isValid()) {
            this.warn(`${WARN_PREFIX} Invalid MQTT command: ${topic} -> ${payload}`);
            return;
        }

        this._processMqttCommand(command, topic, payload);
    }

    _processMqttCommand(command, topic, payload) {
        const commandType = command.getCommandType();
        
        switch (commandType) {
            case MQTT_CMD_TYPE_GETTREE:
                this._handleMqttGetTree(command);
                break;
            case MQTT_CMD_TYPE_GETALL:
                this._handleMqttGetAll(command);
                break;
            case MQTT_CMD_TYPE_SWITCH:
                this._handleMqttSwitch(command, payload);
                break;
            case MQTT_CMD_TYPE_RAMP:
                this._handleMqttRamp(command, payload, topic);
                break;
            default:
                this.warn(`${WARN_PREFIX} Unrecognized command type: ${commandType}`);
        }
    }

    _handleMqttGetTree(command) {
        // Store network for HA discovery to know which network tree was requested
        this.haDiscovery.treeNetwork = command.getNetwork();
        // C-Gate TREEXML command returns XML describing all devices on the network
        this.cgateCommandQueue.add(`TREEXML ${command.getNetwork()}${NEWLINE}`);
    }

    _handleMqttGetAll(command) {
        // C-Gate path format: //PROJECT/network/application/* (wildcard gets all groups)
        const cbusPath = `//${this.settings.cbusname}/${command.getNetwork()}/${command.getApplication()}/*`;
        // C-Gate GET command queries current level of all devices in the application
        this.cgateCommandQueue.add(`${CGATE_CMD_GET} ${cbusPath} ${CGATE_PARAM_LEVEL}${NEWLINE}`);
    }

    _handleMqttSwitch(command, payload) {
        // C-Gate path format: //PROJECT/network/application/group (specific device)
        const cbusPath = `//${this.settings.cbusname}/${command.getNetwork()}/${command.getApplication()}/${command.getGroup()}`;
        
        if (payload.toUpperCase() === MQTT_STATE_ON) {
            // C-Gate "on" command turns device full brightness (level 255)
            this.cgateCommandQueue.add(`${CGATE_CMD_ON} ${cbusPath}${NEWLINE}`);
        } else if (payload.toUpperCase() === MQTT_STATE_OFF) {
            // C-Gate "off" command turns device off (level 0)
            this.cgateCommandQueue.add(`${CGATE_CMD_OFF} ${cbusPath}${NEWLINE}`);
        } else {
            this.warn(`${WARN_PREFIX} Invalid payload for switch command: ${payload}`);
        }
    }

    _handleMqttRamp(command, payload, topic) {
        if (!command.getGroup()) {
            this.warn(`${WARN_PREFIX} Ramp command requires device ID on topic ${topic}`);
            return;
        }

        const cbusPath = `//${this.settings.cbusname}/${command.getNetwork()}/${command.getApplication()}/${command.getGroup()}`;
        const rampAction = payload.toUpperCase();
        // Simple address format for level tracking (without project name)
        const levelAddress = `${command.getNetwork()}/${command.getApplication()}/${command.getGroup()}`;

        switch (rampAction) {
            case MQTT_COMMAND_INCREASE:
                // Relative increase: get current level, add RAMP_STEP (26 = ~10%), cap at 255
                this._queueRampIncreaseDecrease(cbusPath, levelAddress, RAMP_STEP, CGATE_LEVEL_MAX, "INCREASE");
                break;
            case MQTT_COMMAND_DECREASE:
                // Relative decrease: get current level, subtract RAMP_STEP, floor at 0
                this._queueRampIncreaseDecrease(cbusPath, levelAddress, -RAMP_STEP, CGATE_LEVEL_MIN, "DECREASE");
                break;
            case MQTT_STATE_ON:
                // Direct on command (level 255)
                this.cgateCommandQueue.add(`${CGATE_CMD_ON} ${cbusPath}${NEWLINE}`);
                break;
            case MQTT_STATE_OFF:
                // Direct off command (level 0)
                this.cgateCommandQueue.add(`${CGATE_CMD_OFF} ${cbusPath}${NEWLINE}`);
                break;
            default:
                // Handle absolute level command (e.g., "50" or "75,2s")
                const level = command.getLevel();
                const rampTime = command.getRampTime();
                if (level !== null) {
                    // C-Gate ramp command: "ramp //PROJECT/network/app/group level [time]"
                    let rampCmd = `${CGATE_CMD_RAMP} ${cbusPath} ${level}`;
                    if (rampTime) {
                        // Optional ramp time (e.g., "2s" for 2-second transition)
                        rampCmd += ` ${rampTime}`;
                    }
                    this.cgateCommandQueue.add(rampCmd + NEWLINE);
                } else {
                    this.warn(`${WARN_PREFIX} Invalid payload for ramp command: ${payload}`);
                }
        }
    }

    _queueRampIncreaseDecrease(cbusPath, levelAddress, step, limit, actionName) {
        // Set up one-time listener for level response from the device we're about to query
        this.internalEventEmitter.once(MQTT_TOPIC_SUFFIX_LEVEL, (address, currentLevel) => {
            if (address === levelAddress) {
                const currentLevelNum = parseInt(currentLevel);
                if (!isNaN(currentLevelNum)) {
                    // Calculate new level: current + step (step can be negative for decrease)
                    let newLevel = currentLevelNum + step;
                    // Apply bounds: increase caps at max (255), decrease floors at min (0)
                    newLevel = (step > 0) ? Math.min(limit, newLevel) : Math.max(limit, newLevel);
                    // Send ramp command with calculated level
                    this.cgateCommandQueue.add(`${CGATE_CMD_RAMP} ${cbusPath} ${newLevel}${NEWLINE}`);
                } else {
                    this.warn(`${WARN_PREFIX} Could not parse current level for ${actionName}: ${currentLevel}`);
                }
            }
        });
        // First, query current level - response will trigger the listener above
        this.cgateCommandQueue.add(`${CGATE_CMD_GET} ${cbusPath} ${CGATE_PARAM_LEVEL}${NEWLINE}`);
    }

    _handleCommandData(data) {
        this.commandBuffer += data.toString();
        let newlineIndex;

        while ((newlineIndex = this.commandBuffer.indexOf(NEWLINE)) > -1) {
            const line = this.commandBuffer.substring(0, newlineIndex).trim();
            this.commandBuffer = this.commandBuffer.substring(newlineIndex + 1);

            if (!line) continue;

            this.log(`${LOG_PREFIX} C-Gate Recv (Cmd): ${line}`);

            try {
                const parsedResponse = this._parseCommandResponseLine(line);
                if (!parsedResponse) continue;

                this._processCommandResponse(parsedResponse.responseCode, parsedResponse.statusData);
            } catch (e) {
                this.error(`${ERROR_PREFIX} Error processing command data line:`, e, `Line: ${line}`); 
            }
        }
    }

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
             this.log(`${LOG_PREFIX} Skipping invalid command response line: ${line}`);
             return null; 
        }

        return { responseCode, statusData };
    }

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
                    this.log(`${LOG_PREFIX} Unhandled C-Gate response ${responseCode}: ${statusData}`);
                }
        }
    }

    _processCommandObjectStatus(statusData) {
        const event = new CBusEvent(`${CGATE_RESPONSE_OBJECT_STATUS} ${statusData}`);
        if (event.isValid()) {
            this._publishEvent(event, '(Cmd)');
            this._emitLevelFromEvent(event);
        } else {
            this.warn(`${WARN_PREFIX} Could not parse object status: ${statusData}`);
        }
    }

    _processCommandErrorResponse(responseCode, statusData) {
        let baseMessage = `${ERROR_PREFIX} C-Gate Command Error ${responseCode}:`;
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
        this.error(`${baseMessage}${hint} - ${detail}`);
    }

    _handleEventData(data) {
        this.eventBuffer += data.toString();
        let newlineIndex;

        while ((newlineIndex = this.eventBuffer.indexOf(NEWLINE)) > -1) {
            const line = this.eventBuffer.substring(0, newlineIndex).trim();
            this.eventBuffer = this.eventBuffer.substring(newlineIndex + 1);

            if (!line) continue;

            this._processEventLine(line);
        }
    }

    _processEventLine(line) {
        if (line.startsWith('#')) {
            this.log(`${LOG_PREFIX} Ignoring comment from event port:`, line);
            return;
        }

        this.log(`${LOG_PREFIX} C-Gate Recv (Evt): ${line}`);

        try {
            const event = new CBusEvent(line);
            if (event.isValid()) {
                this._publishEvent(event, '(Evt)');
                this._emitLevelFromEvent(event);
            } else {
                this.warn(`${WARN_PREFIX} Could not parse event line: ${line}`);
            }
        } catch (e) {
            this.error(`${ERROR_PREFIX} Error processing event data line:`, e, `Line: ${line}`);
        }
    }

    _emitLevelFromEvent(event) {
        // PIR sensors only send state (motion detected/cleared), not brightness levels
        if (event.getApplication() === this.settings.ha_discovery_pir_app_id) {
            return;
        }
        
        const simpleAddr = `${event.getNetwork()}/${event.getApplication()}/${event.getGroup()}`;
        let levelValue = null;

        if (event.getLevel() !== null) {
            // Ramp events include explicit level (0-255)
            levelValue = event.getLevel();
        } else if (event.getAction() === CGATE_CMD_ON.toLowerCase()) {
            // "on" events imply full brightness (255)
            levelValue = CGATE_LEVEL_MAX;
        } else if (event.getAction() === CGATE_CMD_OFF.toLowerCase()) {
            // "off" events imply no brightness (0) 
            levelValue = CGATE_LEVEL_MIN;
        }

        if (levelValue !== null) {
            // Emit internal level event for relative ramp operations (increase/decrease)
            this.internalEventEmitter.emit(MQTT_TOPIC_SUFFIX_LEVEL, simpleAddr, levelValue);
        }
    }

    /**
     * Publishes C-Bus events to MQTT topics for Home Assistant and other consumers.
     * 
     * Converts C-Bus events into MQTT messages:
     * - C-Bus "lighting on 254/56/4" → MQTT "cbus/read/254/56/4/state" with "ON"
     * - C-Bus "lighting ramp 254/56/4 128" → MQTT "cbus/read/254/56/4/level" with "50"
     * 
     * Special handling for PIR sensors (motion detectors) that only publish state.
     * 
     * @param {CBusEvent} event - Parsed C-Bus event to publish
     * @param {string} [source=''] - Source identifier for logging (e.g., '(Evt)', '(Cmd)')
     * @private
     */
    _publishEvent(event, source = '') {
        if (!event || !event.isValid()) {
            return;
        }

        const topicBase = `${MQTT_TOPIC_PREFIX_READ}/${event.getNetwork()}/${event.getApplication()}/${event.getGroup()}`;
        // Convert C-Gate level (0-255) to percentage (0-100) for Home Assistant
        const levelPercent = Math.round((event.getLevel() || 0) / CGATE_LEVEL_MAX * 100);
        const isPirSensor = event.getApplication() === this.settings.ha_discovery_pir_app_id;

        let state;
        if (isPirSensor) {
            // PIR sensors: state based on action (motion detected/cleared)
            state = (event.getAction() === CGATE_CMD_ON.toLowerCase()) ? MQTT_STATE_ON : MQTT_STATE_OFF;
        } else {
            // Lighting devices: state based on brightness level (any level > 0 = ON)
            state = (levelPercent > 0) ? MQTT_STATE_ON : MQTT_STATE_OFF;
        }
       
        this.log(`${LOG_PREFIX} C-Bus Status ${source}: ${event.getNetwork()}/${event.getApplication()}/${event.getGroup()} ${state}` + (isPirSensor ? '' : ` (${levelPercent}%)`));

        this.mqttPublishQueue.add({ 
            topic: `${topicBase}/${MQTT_TOPIC_SUFFIX_STATE}`, 
            payload: state, 
            options: this._mqttOptions 
        });
        
        if (!isPirSensor) {
            this.mqttPublishQueue.add({ 
                topic: `${topicBase}/${MQTT_TOPIC_SUFFIX_LEVEL}`, 
                payload: levelPercent.toString(), 
                options: this._mqttOptions 
            });
        }
    }

    _sendCgateCommand(command) {
        this.commandConnection.send(command);
    }

    _publishMqttMessage(message) {
        this.mqttManager.publish(message.topic, message.payload, message.options);
    }

    /**
     * Logs an informational message.
     * 
     * @param {string} message - The message to log
     * @param {Object} [meta={}] - Additional metadata for structured logging
     */
    log(message, meta = {}) {
        this.logger.info(message, meta);
    }

    /**
     * Logs a warning message.
     * 
     * @param {string} message - The warning message to log
     * @param {Object} [meta={}] - Additional metadata for structured logging
     */
    warn(message, meta = {}) {
        this.logger.warn(message, meta);
    }

    /**
     * Logs an error message.
     * 
     * @param {string} message - The error message to log
     * @param {Object} [meta={}] - Additional metadata for structured logging
     */
    error(message, meta = {}) {
        this.logger.error(message, meta);
    }

    // Legacy method compatibility for tests
    _connectMqtt() {
        return this.mqttManager.connect();
    }

    _connectCommandSocket() {
        return this.commandConnection.connect();
    }

    _connectEventSocket() {
        return this.eventConnection.connect();
    }


    _validateSettings() {
        const requiredStringSettings = [
            'mqtt', 'cbusname', 'cbusip'
        ];
        
        const requiredNumberSettings = [
            'cbuscommandport', 'cbuseventport', 'messageinterval'
        ];

        let isValid = true;

        // Check required string settings
        for (const setting of requiredStringSettings) {
            if (!this.settings[setting] || typeof this.settings[setting] !== 'string') {
                this.error(`Invalid setting: '${setting}' must be a non-empty string`);
                isValid = false;
            }
        }

        // Check required number settings
        for (const setting of requiredNumberSettings) {
            if (typeof this.settings[setting] !== 'number' || this.settings[setting] <= 0) {
                this.error(`Invalid setting: '${setting}' must be a positive number`);
                isValid = false;
            }
        }

        // Check mqtt setting specifically (it can be null in the test case)
        if (this.settings.mqtt === null || this.settings.mqtt === undefined) {
            this.error(`Invalid setting: 'mqtt' must be a non-empty string`);
            isValid = false;
        }

        return isValid;
    }
}

module.exports = CgateWebBridge;