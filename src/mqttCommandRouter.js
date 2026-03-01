const { EventEmitter } = require('events');
const CBusCommand = require('./cbusCommand');
const { createLogger } = require('./logger');
const {
    MQTT_TOPIC_MANUAL_TRIGGER,
    MQTT_CMD_TYPE_GETALL,
    MQTT_CMD_TYPE_GETTREE,
    MQTT_CMD_TYPE_SWITCH,
    MQTT_CMD_TYPE_RAMP,
    MQTT_CMD_TYPE_POSITION,
    MQTT_CMD_TYPE_STOP,
    MQTT_STATE_ON,
    MQTT_STATE_OFF,
    MQTT_COMMAND_INCREASE,
    MQTT_COMMAND_DECREASE,
    MQTT_TOPIC_SUFFIX_LEVEL,
    CGATE_CMD_ON,
    CGATE_CMD_OFF,
    CGATE_CMD_RAMP,
    CGATE_CMD_TERMINATERAMP,
    CGATE_CMD_GET,
    CGATE_PARAM_LEVEL,
    CGATE_LEVEL_MIN,
    CGATE_LEVEL_MAX,
    RAMP_STEP,
    NEWLINE
} = require('./constants');

/**
 * Routes MQTT commands to appropriate C-Gate commands.
 * 
 * Handles the translation from MQTT topics/payloads to C-Gate protocol commands.
 * This router is responsible for:
 * - Parsing and validating MQTT commands
 * - Converting MQTT topics to C-Gate paths
 * - Managing device state for relative operations (increase/decrease)
 * - Queuing commands for transmission to C-Gate
 * 
 * @fires MqttCommandRouter#cgateCommand - When a C-Gate command should be sent
 * @fires MqttCommandRouter#haDiscoveryTrigger - When HA discovery should be triggered
 * @fires MqttCommandRouter#treeRequest - When device tree is requested for a network
 */
class MqttCommandRouter extends EventEmitter {
    /**
     * Creates a new MQTT command router.
     * 
     * @param {Object} options - Configuration options
     * @param {string} options.cbusname - C-Gate project name
     * @param {boolean} options.ha_discovery_enabled - Whether HA discovery is enabled
     * @param {EventEmitter} options.internalEventEmitter - Internal event emitter for level tracking
     * @param {Object} options.cgateCommandQueue - Queue for sending commands to C-Gate
     */
    constructor(options) {
        super();
        
        this.cbusname = options.cbusname;
        this.haDiscoveryEnabled = options.ha_discovery_enabled;
        this.internalEventEmitter = options.internalEventEmitter;
        this.cgateCommandQueue = options.cgateCommandQueue;
        
        // Track pending relative level operations to prevent duplicate handlers per address
        this._pendingRelativeLevels = new Map();
        
        this.logger = createLogger({ 
            component: 'MqttCommandRouter',
            level: 'info'
        });
    }

    /**
     * Routes an incoming MQTT message to the appropriate handler.
     * 
     * @param {string} topic - MQTT topic
     * @param {string} payload - MQTT payload
     */
    routeMessage(topic, payload) {
        this.logger.info(`MQTT Recv: ${topic} -> ${payload}`);

        // Handle manual HA discovery trigger
        if (topic === MQTT_TOPIC_MANUAL_TRIGGER) {
            this._handleDiscoveryTrigger();
            return;
        }

        // Parse MQTT command
        const command = new CBusCommand(topic, payload);
        if (!command.isValid()) {
            this.logger.warn(`Invalid MQTT command: ${topic} -> ${payload}`);
            return;
        }

        this._processCommand(command, topic, payload);
    }

    /**
     * Processes a validated MQTT command and dispatches it to the appropriate handler.
     * 
     * @param {CBusCommand} command - The parsed and validated MQTT command
     * @param {string} topic - Original MQTT topic for logging
     * @param {string} payload - Original MQTT payload for logging
     * @private
     */
    _processCommand(command, topic, payload) {
        const commandType = command.getCommandType();
        
        switch (commandType) {
            case MQTT_CMD_TYPE_GETTREE:
                this._handleGetTree(command);
                break;
            case MQTT_CMD_TYPE_GETALL:
                this._handleGetAll(command);
                break;
            case MQTT_CMD_TYPE_SWITCH:
                this._handleSwitch(command, payload);
                break;
            case MQTT_CMD_TYPE_RAMP:
                this._handleRamp(command, payload, topic);
                break;
            case MQTT_CMD_TYPE_POSITION:
                this._handlePosition(command, topic);
                break;
            case MQTT_CMD_TYPE_STOP:
                this._handleStop(command, topic);
                break;
            default:
                this.logger.warn(`Unrecognized command type: ${commandType}`);
        }
    }

    /**
     * Handles manual HA discovery trigger requests.
     * @private
     */
    _handleDiscoveryTrigger() {
        if (this.haDiscoveryEnabled) {
            this.logger.info('Manual HA Discovery triggered via MQTT');
            this.emit('haDiscoveryTrigger');
        } else {
            this.logger.warn('Manual HA Discovery trigger received, but feature is disabled in settings');
        }
    }

    /**
     * Handles device tree requests for HA discovery.
     * @param {CBusCommand} command - The tree request command
     * @private
     */
    _handleGetTree(command) {
        this.logger.debug(`Requesting device tree for network ${command.getNetwork()}`);
        
        // Emit event for HA discovery to track which network tree was requested
        this.emit('treeRequest', command.getNetwork());
        
        // Queue C-Gate TREEXML command
        const cgateCommand = `TREEXML ${command.getNetwork()}${NEWLINE}`;
        this._queueCommand(cgateCommand);
    }

    /**
     * Handles "get all" requests to query current device states.
     * @param {CBusCommand} command - The get all command
     * @private
     */
    _handleGetAll(command) {
        this.logger.debug(`Getting all devices for ${command.getNetwork()}/${command.getApplication()}`);
        
        // C-Gate path format: //PROJECT/network/application/* (wildcard gets all groups)
        const cbusPath = `//${this.cbusname}/${command.getNetwork()}/${command.getApplication()}/*`;
        
        // Queue C-Gate GET command to query current levels
        const cgateCommand = `${CGATE_CMD_GET} ${cbusPath} ${CGATE_PARAM_LEVEL}${NEWLINE}`;
        this._queueCommand(cgateCommand);
    }

    /**
     * Handles switch commands (ON/OFF).
     * @param {CBusCommand} command - The switch command
     * @param {string} payload - The command payload (ON/OFF)
     * @private
     */
    _handleSwitch(command, payload) {
        const cbusPath = this._buildCGatePath(command);
        const action = payload.toUpperCase();
        
        let cgateCommand;
        if (action === MQTT_STATE_ON) {
            cgateCommand = `${CGATE_CMD_ON} ${cbusPath}${NEWLINE}`;
        } else if (action === MQTT_STATE_OFF) {
            cgateCommand = `${CGATE_CMD_OFF} ${cbusPath}${NEWLINE}`;
        } else {
            this.logger.warn(`Invalid payload for switch command: ${payload}`);
            return;
        }

        this._queueCommand(cgateCommand);
    }

    /**
     * Handles ramp commands (dimming, level setting).
     * @param {CBusCommand} command - The ramp command
     * @param {string} payload - The command payload
     * @param {string} topic - Original topic for error logging
     * @private
     */
    _handleRamp(command, payload, topic) {
        if (!command.getGroup()) {
            this.logger.warn(`Ramp command requires device ID on topic ${topic}`);
            return;
        }

        const cbusPath = this._buildCGatePath(command);
        const rampAction = payload.toUpperCase();
        const levelAddress = `${command.getNetwork()}/${command.getApplication()}/${command.getGroup()}`;

        switch (rampAction) {
            case MQTT_COMMAND_INCREASE:
                this._handleRelativeLevel(cbusPath, levelAddress, RAMP_STEP, CGATE_LEVEL_MAX, "INCREASE");
                break;
            case MQTT_COMMAND_DECREASE:
                this._handleRelativeLevel(cbusPath, levelAddress, -RAMP_STEP, CGATE_LEVEL_MAX, "DECREASE");
                break;
            case MQTT_STATE_ON:
                this._queueCommand(`${CGATE_CMD_ON} ${cbusPath}${NEWLINE}`);
                break;
            case MQTT_STATE_OFF:
                this._queueCommand(`${CGATE_CMD_OFF} ${cbusPath}${NEWLINE}`);
                break;
            default:
                this._handleAbsoluteLevel(command, cbusPath, payload);
        }
    }

    /**
     * Handles absolute level setting (e.g., "50" or "75,2s").
     * @param {CBusCommand} command - The ramp command
     * @param {string} cbusPath - C-Gate device path
     * @param {string} payload - The level payload
     * @private
     */
    _handleAbsoluteLevel(command, cbusPath, payload) {
        const level = command.getLevel();
        const rampTime = command.getRampTime();
        
        if (level !== null) {
            let cgateCommand = `${CGATE_CMD_RAMP} ${cbusPath} ${level}`;
            if (rampTime) {
                cgateCommand += ` ${rampTime}`;
            }
            this._queueCommand(cgateCommand + NEWLINE);
        } else {
            this.logger.warn(`Invalid payload for ramp command: ${payload}`);
        }
    }

    /**
     * Handles relative level changes (increase/decrease).
     * @param {string} cbusPath - C-Gate device path
     * @param {string} levelAddress - Address for level tracking
     * @param {number} step - Level change amount
     * @param {number} limit - Maximum/minimum level limit
     * @param {string} actionName - Action name for logging
     * @private
     */
    _handleRelativeLevel(cbusPath, levelAddress, step, limit, actionName) {
        // Cancel any existing pending operation for this address to prevent duplicate handlers
        this._cancelPendingRelativeLevel(levelAddress);

        function cleanup() {
            this.internalEventEmitter.removeListener(MQTT_TOPIC_SUFFIX_LEVEL, levelHandler);
            this._pendingRelativeLevels.delete(levelAddress);
            clearTimeout(timeoutHandle);
        }

        const levelHandler = (address, currentLevel) => {
            if (address === levelAddress) {
                cleanup.call(this);
                const newLevel = Math.max(CGATE_LEVEL_MIN, Math.min(limit, currentLevel + step));
                this.logger.debug(`${actionName}: ${levelAddress} ${currentLevel} -> ${newLevel}`);
                
                const cgateCommand = `${CGATE_CMD_RAMP} ${cbusPath} ${newLevel}${NEWLINE}`;
                this._queueCommand(cgateCommand);
            }
        };

        const timeoutHandle = setTimeout(() => {
            cleanup.call(this);
            this.logger.warn(`Timeout waiting for level response from ${levelAddress} during ${actionName}`);
        }, 5000);

        this._pendingRelativeLevels.set(levelAddress, { handler: levelHandler, timeoutHandle });
        this.internalEventEmitter.on(MQTT_TOPIC_SUFFIX_LEVEL, levelHandler);

        // Query current level first
        const queryCommand = `${CGATE_CMD_GET} ${cbusPath} ${CGATE_PARAM_LEVEL}${NEWLINE}`;
        this._queueCommand(queryCommand);
    }

    /**
     * Cancels a pending relative level operation for the given address.
     * Removes the event listener and clears the timeout.
     * @param {string} levelAddress - Address to cancel
     * @private
     */
    _cancelPendingRelativeLevel(levelAddress) {
        const pending = this._pendingRelativeLevels.get(levelAddress);
        if (pending) {
            this.internalEventEmitter.removeListener(MQTT_TOPIC_SUFFIX_LEVEL, pending.handler);
            clearTimeout(pending.timeoutHandle);
            this._pendingRelativeLevels.delete(levelAddress);
            this.logger.debug(`Superseded pending relative level operation for ${levelAddress}`);
        }
    }

    /**
     * Handles cover position commands (set position 0-100%).
     * Uses RAMP command to set the position level.
     * @param {CBusCommand} command - The position command
     * @param {string} topic - Original topic for error logging
     * @private
     */
    _handlePosition(command, topic) {
        if (!command.getGroup()) {
            this.logger.warn(`Position command requires device ID on topic ${topic}`);
            return;
        }

        const cbusPath = this._buildCGatePath(command);
        const level = command.getLevel();
        
        if (level !== null) {
            // Use RAMP command to set cover position
            // Level is already converted from percentage (0-100) to C-Gate level (0-255)
            const cgateCommand = `${CGATE_CMD_RAMP} ${cbusPath} ${level}${NEWLINE}`;
            this._queueCommand(cgateCommand);
            this.logger.debug(`Setting cover position: ${command.getNetwork()}/${command.getApplication()}/${command.getGroup()} to level ${level}`);
        } else {
            this.logger.warn(`Invalid position value for topic ${topic}`);
        }
    }

    /**
     * Handles stop commands for covers/blinds.
     * Uses TERMINATERAMP to stop any in-progress movement.
     * @param {CBusCommand} command - The stop command
     * @param {string} topic - Original topic for error logging
     * @private
     */
    _handleStop(command, topic) {
        if (!command.getGroup()) {
            this.logger.warn(`Stop command requires device ID on topic ${topic}`);
            return;
        }

        const cbusPath = this._buildCGatePath(command);
        
        // TERMINATERAMP stops any in-progress ramp operation, effectively stopping the cover
        const cgateCommand = `${CGATE_CMD_TERMINATERAMP} ${cbusPath}${NEWLINE}`;
        this._queueCommand(cgateCommand);
        this.logger.debug(`Stopping cover: ${command.getNetwork()}/${command.getApplication()}/${command.getGroup()}`);
    }

    /**
     * Builds a C-Gate device path from a command.
     * @param {CBusCommand} command - The command containing address information
     * @returns {string} C-Gate path format: //PROJECT/network/application/group
     * @private
     */
    _buildCGatePath(command) {
        return `//${this.cbusname}/${command.getNetwork()}/${command.getApplication()}/${command.getGroup()}`;
    }

    /**
     * Queues a command for transmission to C-Gate.
     * @param {string} command - The C-Gate command to queue
     * @private
     */
    _queueCommand(command) {
        this.cgateCommandQueue.add(command);
    }
}

module.exports = MqttCommandRouter;
