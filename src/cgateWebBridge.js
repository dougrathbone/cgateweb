const { EventEmitter } = require('events');
const CgateConnection = require('./cgateConnection');
const MqttManager = require('./mqttManager');
const HaDiscovery = require('./haDiscovery');
const ThrottledQueue = require('./throttledQueue');
const CBusEvent = require('./cbusEvent');
const CBusCommand = require('./cbusCommand');
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

class CgateWebBridge {
    constructor(settings) {
        this.settings = settings;
        
        // Connection managers
        this.mqttManager = new MqttManager(settings);
        this.commandConnection = new CgateConnection('command', settings.cbusip, settings.cbuscommandport, settings);
        this.eventConnection = new CgateConnection('event', settings.cbusip, settings.cbuseventport, settings);
        
        // Service modules
        this.haDiscovery = new HaDiscovery(settings, this.mqttManager, this.commandConnection);
        
        // Message queues
        this.cgateCommandQueue = new ThrottledQueue(
            (command) => this._sendCgateCommand(command),
            settings.messageinterval,
            'C-Gate Command Queue'
        );
        
        this.mqttPublishQueue = new ThrottledQueue(
            (message) => this._publishMqttMessage(message),
            settings.messageinterval,
            'MQTT Publish Queue'
        );

        // Internal state
        this.commandBuffer = '';
        this.eventBuffer = '';
        this.internalEventEmitter = new EventEmitter();
        this.periodicGetAllInterval = null;

        // Connection state
        this.allConnected = false;

        // MQTT options
        this._mqttOptions = settings.retainreads ? { retain: true, qos: 0 } : { qos: 0 };

        this._setupEventHandlers();
    }

    _setupEventHandlers() {
        // MQTT event handlers
        this.mqttManager.on('connect', () => this._handleAllConnected());
        this.mqttManager.on('message', (topic, payload) => this._handleMqttMessage(topic, payload));
        this.mqttManager.on('close', () => {
            this.allConnected = false;
        });

        // C-Gate command connection handlers
        this.commandConnection.on('connect', () => this._handleAllConnected());
        this.commandConnection.on('data', (data) => this._handleCommandData(data));
        this.commandConnection.on('close', () => {
            this.allConnected = false;
        });

        // C-Gate event connection handlers
        this.eventConnection.on('connect', () => this._handleAllConnected());
        this.eventConnection.on('data', (data) => this._handleEventData(data));
        this.eventConnection.on('close', () => {
            this.allConnected = false;
        });
    }

    start() {
        this.log(`${LOG_PREFIX} Starting cgateweb bridge...`);
        
        // Start all connections
        this.mqttManager.connect();
        this.commandConnection.connect();
        this.eventConnection.connect();
        
        return this;
    }

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
        this.haDiscovery.treeNetwork = command.getNetwork();
        this.cgateCommandQueue.add(`TREEXML ${command.getNetwork()}${NEWLINE}`);
    }

    _handleMqttGetAll(command) {
        const cbusPath = `//${this.settings.cbusname}/${command.getNetwork()}/${command.getApplication()}/*`;
        this.cgateCommandQueue.add(`${CGATE_CMD_GET} ${cbusPath} ${CGATE_PARAM_LEVEL}${NEWLINE}`);
    }

    _handleMqttSwitch(command, payload) {
        const cbusPath = `//${this.settings.cbusname}/${command.getNetwork()}/${command.getApplication()}/${command.getGroup()}`;
        
        if (payload.toUpperCase() === MQTT_STATE_ON) {
            this.cgateCommandQueue.add(`${CGATE_CMD_ON} ${cbusPath}${NEWLINE}`);
        } else if (payload.toUpperCase() === MQTT_STATE_OFF) {
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
        const levelAddress = `${command.getNetwork()}/${command.getApplication()}/${command.getGroup()}`;

        switch (rampAction) {
            case MQTT_COMMAND_INCREASE:
                this._queueRampIncreaseDecrease(cbusPath, levelAddress, RAMP_STEP, CGATE_LEVEL_MAX, "INCREASE");
                break;
            case MQTT_COMMAND_DECREASE:
                this._queueRampIncreaseDecrease(cbusPath, levelAddress, -RAMP_STEP, CGATE_LEVEL_MIN, "DECREASE");
                break;
            case MQTT_STATE_ON:
                this.cgateCommandQueue.add(`${CGATE_CMD_ON} ${cbusPath}${NEWLINE}`);
                break;
            case MQTT_STATE_OFF:
                this.cgateCommandQueue.add(`${CGATE_CMD_OFF} ${cbusPath}${NEWLINE}`);
                break;
            default:
                // Handle percentage level command
                const level = command.getLevel();
                const rampTime = command.getRampTime();
                if (level !== null) {
                    let rampCmd = `${CGATE_CMD_RAMP} ${cbusPath} ${level}`;
                    if (rampTime) {
                        rampCmd += ` ${rampTime}`;
                    }
                    this.cgateCommandQueue.add(rampCmd + NEWLINE);
                } else {
                    this.warn(`${WARN_PREFIX} Invalid payload for ramp command: ${payload}`);
                }
        }
    }

    _queueRampIncreaseDecrease(cbusPath, levelAddress, step, limit, actionName) {
        this.internalEventEmitter.once(MQTT_TOPIC_SUFFIX_LEVEL, (address, currentLevel) => {
            if (address === levelAddress) {
                const currentLevelNum = parseInt(currentLevel);
                if (!isNaN(currentLevelNum)) {
                    let newLevel = currentLevelNum + step;
                    newLevel = (step > 0) ? Math.min(limit, newLevel) : Math.max(limit, newLevel);
                    this.cgateCommandQueue.add(`${CGATE_CMD_RAMP} ${cbusPath} ${newLevel}${NEWLINE}`);
                } else {
                    this.warn(`${WARN_PREFIX} Could not parse current level for ${actionName}: ${currentLevel}`);
                }
            }
        });
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
            responseCode = line.substring(0, hyphenIndex).trim();
            statusData = line.substring(hyphenIndex + 1).trim();
        } else {
            const spaceParts = line.split(' ');
            responseCode = spaceParts[0].trim();
            if (spaceParts.length > 1) {
                 statusData = spaceParts.slice(1).join(' ').trim();
            }
        }
        
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
        // Do not emit level events for PIR sensors
        if (event.getApplication() === this.settings.ha_discovery_pir_app_id) {
            return;
        }
        
        const simpleAddr = `${event.getNetwork()}/${event.getApplication()}/${event.getGroup()}`;
        let levelValue = null;

        if (event.getLevel() !== null) {
            levelValue = event.getLevel();
        } else if (event.getAction() === CGATE_CMD_ON.toLowerCase()) {
            levelValue = CGATE_LEVEL_MAX;
        } else if (event.getAction() === CGATE_CMD_OFF.toLowerCase()) {
            levelValue = CGATE_LEVEL_MIN;
        }

        if (levelValue !== null) {
            this.internalEventEmitter.emit(MQTT_TOPIC_SUFFIX_LEVEL, simpleAddr, levelValue);
        }
    }

    _publishEvent(event, source = '') {
        if (!event || !event.isValid()) {
            return;
        }

        const topicBase = `${MQTT_TOPIC_PREFIX_READ}/${event.getNetwork()}/${event.getApplication()}/${event.getGroup()}`;
        const levelPercent = Math.round((event.getLevel() || 0) / CGATE_LEVEL_MAX * 100);
        const isPirSensor = event.getApplication() === this.settings.ha_discovery_pir_app_id;

        let state;
        if (isPirSensor) {
            state = (event.getAction() === CGATE_CMD_ON.toLowerCase()) ? MQTT_STATE_ON : MQTT_STATE_OFF;
        } else {
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

    // Logging methods
    log(message, ...args) {
        if (this.settings.logging) {
            console.log(message, ...args);
        }
    }

    warn(message, ...args) {
        console.warn(message, ...args);
    }

    error(message, ...args) {
        console.error(message, ...args);
    }
}

module.exports = CgateWebBridge;