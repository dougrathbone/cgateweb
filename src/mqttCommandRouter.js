// @ts-check
const { EventEmitter } = require('events');
const CBusCommand = require('./cbusCommand');
const CoverRampTracker = require('./coverRampTracker');
const { createLogger } = require('./logger');
const { temperatureToCbusLevel } = require('./utils');
const {
    MQTT_TOPIC_MANUAL_TRIGGER,
    MQTT_TOPIC_PREFIX_READ,
    MQTT_RETAINED_STATE_OPTIONS,
    MQTT_TOPIC_SUFFIX_LEVEL,
    MQTT_TOPIC_SUFFIX_POSITION,
    MQTT_CMD_TYPE_GETALL,
    MQTT_CMD_TYPE_GETTREE,
    MQTT_CMD_TYPE_SWITCH,
    MQTT_CMD_TYPE_RAMP,
    MQTT_CMD_TYPE_POSITION,
    MQTT_CMD_TYPE_TILT,
    MQTT_CMD_TYPE_STOP,
    MQTT_CMD_TYPE_TRIGGER,
    MQTT_CMD_TYPE_HVAC_SETPOINT,
    MQTT_CMD_TYPE_HVAC_MODE,
    MQTT_TOPIC_SUFFIX_HVAC_SETPOINT,
    MQTT_TOPIC_SUFFIX_HVAC_MODE,
    MQTT_STATE_ON,
    MQTT_STATE_OFF,
    MQTT_COMMAND_STOP,
    MQTT_COMMAND_INCREASE,
    MQTT_COMMAND_DECREASE,
    CGATE_CMD_ON,
    CGATE_CMD_OFF,
    CGATE_CMD_RAMP,
    CGATE_CMD_TERMINATERAMP,
    CGATE_CMD_GET,
    CGATE_PARAM_LEVEL,
    CGATE_LEVEL_MIN,
    CGATE_LEVEL_MAX,
    RAMP_STEP,
    NEWLINE,
    HVAC_MIN_TEMP_C,
    HVAC_MAX_TEMP_C
} = require('./constants');
const {
    HVAC_CODE_BY_MODE,
    FAN_LEVEL_SENTINEL,
    DEFAULT_SETPOINT_C,
    buildSetZoneHvacMode,
    buildSetWardOff
} = require('./airconControlRegistry');

class MqttCommandRouter extends EventEmitter {
    /**
     * Creates a new MQTT command router.
     *
     * @param {Object}       options - Configuration options
     * @param {string}       options.cbusname - C-Gate project name
     * @param {boolean}      options.ha_discovery_enabled - Whether HA discovery is enabled
     * @param {EventEmitter} options.internalEventEmitter - Internal event emitter for level tracking
     * @param {Object}       options.cgateCommandQueue - Queue for sending commands to C-Gate
     * @param {Object}       [options.deviceStateManager] - DeviceStateManager for reading current levels
     * @param {Object}       [options.mqttClient] - MQTT client for publishing interpolated positions
     * @param {Object}       [options.settings] - Application settings (cover_ramp_duration_ms etc.)
     * @param {Object}       [options.coverRampTracker] - Shared CoverRampTracker instance (optional)
     * @param {Object}       [options.airconControlRegistry] - AirconControlRegistry holding learned thermostat state (optional)
     */
    constructor(options) {
        super();

        this.cbusname = options.cbusname;
        this.haDiscoveryEnabled = options.ha_discovery_enabled;
        this.internalEventEmitter = options.internalEventEmitter;
        this.cgateCommandQueue = options.cgateCommandQueue;
        this.deviceStateManager = options.deviceStateManager || null;
        this.mqttClient = options.mqttClient || null;
        this.settings = options.settings || {};
        // Per-thermostat ward/zone/type state for native Air Conditioning writes.
        this.airconControlRegistry = options.airconControlRegistry || null;

        // Use shared tracker if provided, otherwise create a private one
        this._coverRampTracker = options.coverRampTracker
            || new CoverRampTracker(this.settings.coverRampUpdateIntervalMs || 500);

        this.logger = createLogger({
            component: 'MqttCommandRouter',
            level: 'info'
        });
    }

    /**
     * Returns the CoverRampTracker used by this router.
     * Callers (e.g. EventPublisher wiring) can use this to share the same tracker instance.
     *
     * @returns {CoverRampTracker}
     */
    get coverRampTracker() {
        return this._coverRampTracker;
    }

    /**
     * Routes an incoming MQTT message to the appropriate handler.
     * 
     * @param {string} topic - MQTT topic
     * @param {string} payload - MQTT payload
     */
    routeMessage(topic, payload) {
        this.logger.debug(`MQTT Recv: ${topic} -> ${payload}`);

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
            case MQTT_CMD_TYPE_TILT:
                this._handleTilt(command, topic);
                break;
            case MQTT_CMD_TYPE_STOP:
                this._handleStop(command, topic);
                break;
            case MQTT_CMD_TYPE_TRIGGER:
                this._handleTrigger(command, topic);
                break;
            case MQTT_CMD_TYPE_HVAC_SETPOINT:
                this._handleHvacSetpoint(command, payload, topic);
                break;
            case MQTT_CMD_TYPE_HVAC_MODE:
                this._handleHvacMode(command, payload, topic);
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

        // Emit event only; the bridge routes this to HaDiscovery.queueTreeRequest,
        // which sends the (project-qualified) TREEXML AND records the network in
        // pendingTreeNetworks so the response is attributed correctly.
        //
        // The router must NOT also queue the TREEXML itself: that produced two
        // TREEXML commands per manual gettree, so C-Gate returned two tree
        // responses. The first was attributed to the network; the second arrived
        // with an empty pending queue and fell back to the "unknown" network,
        // publishing duplicate cgateweb_unknown_* entities (issue #25).
        this.emit('treeRequest', command.getNetwork());
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
        const action = payload.toUpperCase();

        // Home Assistant's MQTT cover platform publishes payload_stop ("STOP") to
        // the command (switch) topic rather than a dedicated stop topic, so a STOP
        // on the switch topic must be routed to the cover-stop (TERMINATERAMP) path.
        if (action === MQTT_COMMAND_STOP) {
            this._handleStop(command, command.getTopic());
            return;
        }

        const cbusPath = this._buildCGatePath(command);

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
        if (!this.deviceStateManager) {
            this.logger.warn(`Cannot process ${actionName} for ${levelAddress}: no device state manager available`);
            return;
        }

        // Supersede any in-flight operation for this address so the latest
        // command wins, then delegate listener/timeout management to the
        // DeviceStateManager (single owner of relative-level operations).
        this.deviceStateManager.cancelRelativeLevelOperation(levelAddress);

        const timeoutMs = this.settings.relativeLevelTimeoutMs || 5000;
        this.deviceStateManager.setupRelativeLevelOperation(levelAddress, (currentLevel) => {
            const newLevel = Math.max(CGATE_LEVEL_MIN, Math.min(limit, currentLevel + step));
            this.logger.debug(`${actionName}: ${levelAddress} ${currentLevel} -> ${newLevel}`);
            this._queueCommand(`${CGATE_CMD_RAMP} ${cbusPath} ${newLevel}${NEWLINE}`);
        }, timeoutMs);

        // Query current level first; the response drives the callback above.
        const queryCommand = `${CGATE_CMD_GET} ${cbusPath} ${CGATE_PARAM_LEVEL}${NEWLINE}`;
        this._queueCommand(queryCommand);
    }

    /**
     * Cleans up pending relative level operations (timers and listeners).
     */
    shutdown() {
        if (this.deviceStateManager) {
            this.deviceStateManager.clearAllOperations();
        }
    }

    /**
     * Handles cover position commands (set position 0-100%).
     * Uses RAMP command to set the position level and starts interpolated
     * position updates so Home Assistant shows smooth progress.
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
            this._queueCommand(cgateCommand, 'interactive');

            const network = command.getNetwork();
            const application = command.getApplication();
            const group = command.getGroup();
            this.logger.debug(`Setting cover position: ${network}/${application}/${group} to level ${level}`);

            // Start interpolated position updates so HA shows smooth movement
            // Position payloads always produce a numeric level (or null, excluded above).
            this._startCoverRamp(network, application, group, /** @type {number} */ (level), null);
        } else {
            this.logger.warn(`Invalid position value for topic ${topic}`);
        }
    }

    /**
     * Handles cover tilt commands (set tilt angle 0-100%).
     * Uses RAMP command to set the tilt level.
     * @param {CBusCommand} command - The tilt command
     * @param {string} topic - Original topic for error logging
     * @private
     */
    _handleTilt(command, topic) {
        if (!command.getGroup()) {
            this.logger.warn(`Tilt command requires device ID on topic ${topic}`);
            return;
        }

        const cbusPath = this._buildCGatePath(command);
        const level = command.getLevel();

        if (level !== null) {
            // Use RAMP command to set tilt angle
            // Level is already converted from percentage (0-100) to C-Gate level (0-255)
            const cgateCommand = `${CGATE_CMD_RAMP} ${cbusPath} ${level}${NEWLINE}`;
            this._queueCommand(cgateCommand, 'interactive');
            this.logger.debug(`Setting cover tilt: ${command.getNetwork()}/${command.getApplication()}/${command.getGroup()} to level ${level}`);
        } else {
            this.logger.warn(`Invalid tilt value for topic ${topic}`);
        }
    }

    /**
     * Handles stop commands for covers/blinds.
     * Uses TERMINATERAMP to stop any in-progress movement.
     * Also cancels any active interpolated position ramp.
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
        const network = command.getNetwork();
        const application = command.getApplication();
        const group = command.getGroup();

        // TERMINATERAMP stops any in-progress ramp operation, effectively stopping the cover
        const cgateCommand = `${CGATE_CMD_TERMINATERAMP} ${cbusPath}${NEWLINE}`;
        this._queueCommand(cgateCommand, 'critical');
        this.logger.debug(`Stopping cover: ${network}/${application}/${group}`);

        // Cancel any interpolated ramp so estimated positions stop being published
        const key = `${network}/${application}/${group}`;
        this._coverRampTracker.cancelRamp(key);
    }

    /**
     * Starts a cover ramp tracker entry to publish interpolated position values.
     *
     * Reads the current level from deviceStateManager, then starts a
     * CoverRampTracker ramp that publishes estimated position and level every
     * 500 ms until the ramp completes or is cancelled.
     *
     * @param {string}      network     - C-Bus network number
     * @param {string}      application - C-Bus application number
     * @param {string}      group       - C-Bus group number
     * @param {number}      targetLevel - Target C-Bus level (0–255)
     * @param {number|null} durationMs  - Ramp duration in ms, or null to use default setting
     * @private
     */
    _startCoverRamp(network, application, group, targetLevel, durationMs) {
        if (!this.mqttClient) {
            return;
        }

        const key = `${network}/${application}/${group}`;
        const startLevel = (this.deviceStateManager && this.deviceStateManager.getLevel(network, application, group)) || 0;
        const duration = durationMs !== null && durationMs !== undefined
            ? durationMs
            : (this.settings.cover_ramp_duration_ms || 5000);

        const mqttOptions = this.settings.retainreads ? MQTT_RETAINED_STATE_OPTIONS : { qos: 0 };
        const topicBase = `${MQTT_TOPIC_PREFIX_READ}/${network}/${application}/${group}`;

        this._coverRampTracker.startRamp(key, startLevel, targetLevel, duration, (level) => {
            const positionPercent = Math.round(level / CGATE_LEVEL_MAX * 100);
            this.mqttClient.publish(
                `${topicBase}/${MQTT_TOPIC_SUFFIX_POSITION}`,
                String(positionPercent),
                mqttOptions
            );
            this.mqttClient.publish(
                `${topicBase}/${MQTT_TOPIC_SUFFIX_LEVEL}`,
                String(positionPercent),
                mqttOptions
            );
        });

        this.logger.debug(`Cover ramp started: ${key} from ${startLevel} to ${targetLevel} over ${duration}ms`);
    }

    /**
     * Handles trigger commands for C-Bus trigger groups.
     * Fires the trigger at the specified level (default full level 255 for 'ON' payload).
     * @param {CBusCommand} command - The trigger command
     * @param {string} topic - Original topic for error logging
     * @private
     */
    _handleTrigger(command, topic) {
        if (!command.getGroup()) {
            this.logger.warn(`Trigger command requires device ID on topic ${topic}`);
            return;
        }

        const cbusPath = this._buildCGatePath(command);
        const level = command.getLevel();

        if (level !== null && level !== undefined) {
            const cgateCommand = `${CGATE_CMD_RAMP} ${cbusPath} ${level}${NEWLINE}`;
            this._queueCommand(cgateCommand);
            this.logger.debug(`Firing trigger: ${command.getNetwork()}/${command.getApplication()}/${command.getGroup()} at level ${level}`);
        } else {
            this.logger.warn(`Invalid trigger payload for topic ${topic}`);
        }
    }

    /**
     * Handles HVAC setpoint commands for the "HVAC-via-lighting" pattern.
     *
     * This is NOT the native C-Bus Air Conditioning ($AC/172) protocol — C-Gate
     * exposes no command verb for that application. Instead this maps a target
     * temperature onto a lighting-style group level, which works when a PAC or
     * touchscreen has been programmed to expose HVAC control as a lighting-
     * compatible group (the common real-world setup; see the project README).
     *
     * Mapping: level = round(clamp(temp, 0, 50) * 2)  →  0.5°C resolution.
     * The receiving logic block in the PAC interprets the level. Adjust the PAC
     * logic, not this code, if your resolution differs.
     *
     * @param {CBusCommand} command - The setpoint command
     * @param {string} payload - Temperature value as a string (e.g., "22.5")
     * @param {string} topic - Original topic for error logging
     * @private
     */
    /**
     * True when the command targets the native Air Conditioning application
     * (cbus_aircon_app_id) rather than the HVAC-via-lighting pattern.
     * @private
     */
    _isNativeAircon(command) {
        return !!this.settings.cbus_aircon_app_id &&
            String(command.getApplication()) === String(this.settings.cbus_aircon_app_id);
    }

    _handleHvacSetpoint(command, payload, topic) {
        if (this._isNativeAircon(command)) {
            if (!this.settings.cbus_aircon_control_enabled) {
                this.logger.warn(`Native HVAC control is disabled (set cbus_aircon_control_enabled to enable); ignoring setpoint on ${topic}`);
                return;
            }
            return this._handleNativeAirconSetpoint(command, payload, topic);
        }

        if (!command.getGroup()) {
            this.logger.warn(`HVAC setpoint command requires device ID on topic ${topic}`);
            return;
        }

        const tempCelsius = parseFloat(payload);
        if (isNaN(tempCelsius)) {
            this.logger.warn(`Invalid HVAC setpoint value "${payload}" on topic ${topic}`);
            return;
        }

        // Clamp to valid C-Bus HVAC temperature range, then encode at 0.5°C
        // resolution (level = temperature * 2) via the shared helper.
        const clampedTemp = Math.max(0, Math.min(50, tempCelsius));
        const cbusLevel = temperatureToCbusLevel(clampedTemp);

        const cbusPath = this._buildCGatePath(command);
        const cgateCommand = `${CGATE_CMD_RAMP} ${cbusPath} ${cbusLevel}${NEWLINE}`;
        this._queueCommand(cgateCommand);
        this.logger.debug(`HVAC setpoint: ${command.getNetwork()}/${command.getApplication()}/${command.getGroup()} temp=${clampedTemp}°C level=${cbusLevel}`);
    }

    /**
     * Handles HVAC mode commands for the "HVAC-via-lighting" pattern.
     *
     * As with the setpoint handler, this drives a lighting-compatible group, not
     * the native Air Conditioning application. 'off' → C-Gate OFF; any active
     * mode ('auto'/'cool'/'heat'/'fan_only') → C-Gate ON, leaving mode selection
     * to the PAC/touchscreen logic that the group feeds.
     *
     * @param {CBusCommand} command - The mode command
     * @param {string} payload - Mode string (e.g., "off", "auto", "cool")
     * @param {string} topic - Original topic for error logging
     * @private
     */
    _handleHvacMode(command, payload, topic) {
        if (this._isNativeAircon(command)) {
            if (!this.settings.cbus_aircon_control_enabled) {
                this.logger.warn(`Native HVAC control is disabled (set cbus_aircon_control_enabled to enable); ignoring mode on ${topic}`);
                return;
            }
            return this._handleNativeAirconMode(command, payload, topic);
        }

        if (!command.getGroup()) {
            this.logger.warn(`HVAC mode command requires device ID on topic ${topic}`);
            return;
        }

        const cbusPath = this._buildCGatePath(command);
        const mode = payload.toLowerCase();
        let cgateCommand;

        if (mode === 'off') {
            cgateCommand = `${CGATE_CMD_OFF} ${cbusPath}${NEWLINE}`;
        } else if (['auto', 'cool', 'heat', 'fan_only'].includes(mode)) {
            // All active modes map to ON — the thermostat maintains its last setpoint.
            // TODO: If the C-Bus hardware supports dedicated mode group addresses,
            // extend this to send mode-specific RAMP values to additional group addresses.
            cgateCommand = `${CGATE_CMD_ON} ${cbusPath}${NEWLINE}`;
        } else {
            this.logger.warn(`Unknown HVAC mode "${payload}" on topic ${topic}`);
            return;
        }

        this._queueCommand(cgateCommand);
        this.logger.debug(`HVAC mode: ${command.getNetwork()}/${command.getApplication()}/${command.getGroup()} mode=${mode}`);
    }

    /**
     * Native Air Conditioning setpoint: keep the thermostat's current mode and
     * change the target temperature, via AIRCON SET_ZONE_HVAC_MODE. Needs the
     * thermostat's ward/zones/type, learned from its broadcasts (registry).
     * @private
     */
    _handleNativeAirconSetpoint(command, payload, topic) {
        const network = command.getNetwork();
        const unit = command.getGroup();
        const state = this.airconControlRegistry && this.airconControlRegistry.get(network, unit);
        if (!state) {
            this.logger.warn(`No known HVAC state for ${network}/${unit} yet; cannot set setpoint until the thermostat reports once (${topic})`);
            return;
        }
        const tempC = parseFloat(payload);
        if (isNaN(tempC)) {
            this.logger.warn(`Invalid HVAC setpoint value "${payload}" on topic ${topic}`);
            return;
        }
        const clamped = Math.max(HVAC_MIN_TEMP_C, Math.min(HVAC_MAX_TEMP_C, tempC));
        const level = Math.round(clamped * 256); // °C × 256, temperature value (rawlevel=0)
        const modeRaw = (state.modeRaw !== null && state.modeRaw !== undefined && state.modeRaw !== 0)
            ? state.modeRaw : HVAC_CODE_BY_MODE.heat;
        const cmd = buildSetZoneHvacMode({
            cbusname: this.cbusname,
            network,
            application: command.getApplication(),
            ward: state.ward,
            zones: state.zones,
            modeRaw,
            rawlevel: 0,
            ...this._airconFlagEcho(state),
            type: (state.type !== null && state.type !== undefined) ? state.type : 0,
            level
        });
        this._queueCommand(cmd + NEWLINE);
        // Keep the learned state coherent until the thermostat's echo broadcast.
        this.airconControlRegistry.noteSetpointWrite(network, unit, modeRaw, level);
        // Optimistically reflect the new target so the HA card updates instantly
        // rather than waiting for the thermostat's next broadcast.
        this._publishOptimisticHvacState(network, command.getApplication(), unit, { setpointC: clamped });
        this.logger.info(`Native HVAC setpoint: ${network}/${unit} -> ${clamped}°C (ward ${state.ward}, zones ${state.zones})`);
    }

    /**
     * Publish the expected HVAC state to the read topics immediately after a
     * write, so Home Assistant's card reflects the change without waiting for
     * the thermostat's broadcast. The real broadcast confirms it shortly after.
     * @param {string} network - C-Bus network address
     * @param {string} application - C-Bus application address
     * @param {string} unit - Aircon unit (group) address
     * @param {Object} [state] - State fields to publish
     * @param {string} [state.mode] - HVAC mode to publish
     * @param {number} [state.setpointC] - Target temperature in °C to publish
     * @private
     */
    _publishOptimisticHvacState(network, application, unit, { mode, setpointC } = {}) {
        if (!this.mqttClient || typeof this.mqttClient.publish !== 'function') return;
        const base = `${MQTT_TOPIC_PREFIX_READ}/${network}/${application}/${unit}`;
        const opts = this.settings.retainreads ? MQTT_RETAINED_STATE_OPTIONS : { qos: 0 };
        if (setpointC !== undefined && setpointC !== null) {
            this.mqttClient.publish(`${base}/${MQTT_TOPIC_SUFFIX_HVAC_SETPOINT}`, String(setpointC), opts);
        }
        if (mode !== undefined && mode !== null) {
            this.mqttClient.publish(`${base}/${MQTT_TOPIC_SUFFIX_HVAC_MODE}`, String(mode), opts);
        }
    }

    /**
     * Native Air Conditioning mode change via AIRCON SET_WARD_OFF (off) or
     * SET_ZONE_HVAC_MODE (any active mode, keeping the last setpoint; Fan Only
     * uses the raw "no level" sentinel).
     * @private
     */
    _handleNativeAirconMode(command, payload, topic) {
        const network = command.getNetwork();
        const unit = command.getGroup();
        const application = command.getApplication();
        const state = this.airconControlRegistry && this.airconControlRegistry.get(network, unit);
        if (!state) {
            this.logger.warn(`No known HVAC state for ${network}/${unit} yet; cannot set mode until the thermostat reports once (${topic})`);
            return;
        }

        const mode = String(payload).toLowerCase();
        if (mode === 'off') {
            this._queueCommand(buildSetWardOff({ cbusname: this.cbusname, network, application, ward: state.ward }) + NEWLINE);
            this._publishOptimisticHvacState(network, application, unit, { mode: 'off' });
            this.logger.info(`Native HVAC mode: ${network}/${unit} -> off (ward ${state.ward})`);
            return;
        }

        const code = HVAC_CODE_BY_MODE[mode];
        if (code === undefined) {
            this.logger.warn(`Unknown HVAC mode "${payload}" on topic ${topic}`);
            return;
        }

        let rawlevel;
        let level;
        if (mode === 'fan_only') {
            rawlevel = 1;
            level = FAN_LEVEL_SENTINEL;
        } else {
            rawlevel = 0;
            // §25.12.11: each Operating Type has its own Set Point — recall the
            // one learned for the target mode rather than forcing the current
            // mode's value into it. Fall back to the last seen target, then a
            // default, when that mode's setpoint was never observed.
            const byMode = state.setpointRawByMode && state.setpointRawByMode[code];
            if (Number.isInteger(byMode) && byMode > 0 && byMode <= 12800) {
                level = byMode;
            } else if (state.setpointRaw !== null && state.setpointRaw !== undefined && state.setpointRaw > 0 && state.setpointRaw <= 12800) {
                level = state.setpointRaw;
            } else {
                level = Math.round(DEFAULT_SETPOINT_C * 256);
            }
        }
        const cmd = buildSetZoneHvacMode({
            cbusname: this.cbusname,
            network,
            application,
            ward: state.ward,
            zones: state.zones,
            modeRaw: code,
            rawlevel,
            ...this._airconFlagEcho(state),
            type: (state.type !== null && state.type !== undefined) ? state.type : 0,
            level
        });
        this._queueCommand(cmd + NEWLINE);
        this._publishOptimisticHvacState(network, application, unit, { mode });
        this.logger.info(`Native HVAC mode: ${network}/${unit} -> ${mode} (ward ${state.ward}, zones ${state.zones})`);
    }

    /**
     * Resolve the Mode & Flags byte fields (§25.6.3) and Aux Level for a write
     * from the thermostat's learned broadcasts, so HA-originated commands echo
     * its configuration instead of silently clearing setback/guard/aux state.
     * Defaults mirror the thermostat-typical broadcast (setback 0, guard 0,
     * aux used, aux level 0) when nothing has been learned.
     * @private
     */
    _airconFlagEcho(state) {
        return {
            setback: state.setbackEnabled === true ? 1 : 0,
            guard: state.guardEnabled === true ? 1 : 0,
            useaux: state.auxLevelUsed === false ? 0 : 1,
            aux: (state.auxLevelUsed && Number.isInteger(state.auxLevel)) ? state.auxLevel : 0
        };
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

    _queueCommand(command, priority) {
        if (priority) {
            this.cgateCommandQueue.add(command, { priority });
        } else {
            this.cgateCommandQueue.add(command);
        }
    }
}

module.exports = MqttCommandRouter;
