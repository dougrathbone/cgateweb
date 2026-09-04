// @ts-check
const { EventEmitter } = require('events');
const CBusCommand = require('./cbusCommand');
const CoverRampTracker = require('./coverRampTracker');
const { createLogger } = require('./logger');
const { redactMqttPayload, describeCbusAddressRangeError } = require('./utils');
const { resolveSetting } = require('./config/schema');
const {
    MQTT_TOPIC_MANUAL_TRIGGER,
    MQTT_TOPIC_PREFIX_READ,
    MQTT_RETAINED_STATE_OPTIONS,
    MQTT_TOPIC_SUFFIX_LEVEL,
    MQTT_TOPIC_SUFFIX_STATE,
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
    MQTT_CMD_TYPE_HVAC_FAN_MODE,
    MQTT_CMD_TYPE_TEMPERATURE,
    MQTT_CMD_TYPE_PLAY,
    MQTT_CMD_TYPE_RECORD,
    MQTT_CMD_TYPE_SET,
    MQTT_CMD_TYPE_LABEL,
    MQTT_CMD_TYPE_REMOVE,
    MQTT_STATE_ON,
    MQTT_STATE_OFF,
    MQTT_COMMAND_STOP,
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
    NEWLINE,
    SECURITY_ARM_TOPIC_REGEX,
    SECURITY_BYPASS_TOPIC_REGEX,
    MEASUREMENT_DATA_TOPIC_REGEX,
    DEFAULT_CBUS_APP_TEMPERATURE
} = require('./constants');
const { buildMeasurementDataCommand } = require('./measurementCommand');
const { buildTemperatureBroadcastCommand, celsiusToTemperatureBroadcastByte } = require('./temperatureCommand');
const { buildScenePlayCommand, buildSceneRecordCommand } = require('./sceneCommand');
const { buildEnableSetCommand, buildEnableLabelCommand, buildEnableRemoveCommand } = require('./enableCommand');
const { UNIT_TABLE: MEASUREMENT_UNIT_TABLE } = require('./applicationDecoders/measurementDecoder');

/**
 * Methods mixed into MqttCommandRouter.prototype from mqttCommandRouterSecurity.js
 * at module load (see the Object.assign call at the bottom of this file).
 * Declared here so calls into the mixin type-check; the implementations live there.
 * @typedef {Object} MqttCommandRouterSecurityMethods
 * @property {(network: string, application: string, payload: string, topic: string) => void} _handleSecurityArm
 * @property {(network: string, application: string, topic: string) => void} _handleSecurityBypass
 */

/**
 * Methods mixed into MqttCommandRouter.prototype from mqttCommandRouterAircon.js
 * at module load (see the Object.assign call at the bottom of this file).
 * @typedef {Object} MqttCommandRouterAirconMethods
 * @property {(command: import('./cbusCommand'), payload: string, topic: string) => void} _handleHvacSetpoint
 * @property {(command: import('./cbusCommand'), payload: string, topic: string) => void} _handleHvacMode
 * @property {(command: import('./cbusCommand'), payload: string, topic: string) => void} _handleHvacFanMode
 */

/**
 * Methods mixed into MqttCommandRouter.prototype from mqttCommandRouterCovers.js
 * at module load (see the Object.assign call at the bottom of this file).
 * @typedef {Object} MqttCommandRouterCoverMethods
 * @property {(command: import('./cbusCommand'), topic: string) => void} _handlePosition
 * @property {(command: import('./cbusCommand'), topic: string) => void} _handleTilt
 * @property {(command: import('./cbusCommand'), topic: string) => void} _handleStop
 * @property {(network: string, application: string, group: string, targetLevel: number, durationMs: number|null) => void} _startCoverRamp
 */

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
        // Pending debounced native-aircon setpoint writes: "net/unit" -> { handle }.
        this._airconSetpointTimers = new Map();

        // Use shared tracker if provided, otherwise create a private one
        this._coverRampTracker = options.coverRampTracker
            || new CoverRampTracker(resolveSetting(this.settings, 'coverRampUpdateIntervalMs'));

        // Brute-force limit on disarm, keyed by network/application. Built
        // lazily on first disarm so the settings object can be mutated after
        // construction (which the tests and the add-on config reload both do).
        this._disarmLimiter = null;

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
        if (this.logger.isLevelEnabled && this.logger.isLevelEnabled('debug')) {
            // Redacted: a disarm payload carries the alarm PIN (#51).
            this.logger.debug(`MQTT Recv: ${topic} -> ${redactMqttPayload(payload)}`);
        }

        // Handle manual HA discovery trigger
        if (topic === MQTT_TOPIC_MANUAL_TRIGGER) {
            this._handleDiscoveryTrigger();
            return;
        }

        // Security panel arm/disarm: the panel command topic has no numeric
        // group, so it can't parse as a CBusCommand — routed directly like the
        // manual discovery trigger. Handlers are mixed in from
        // mqttCommandRouterSecurity.js (see Object.assign below).
        const self = /** @type {MqttCommandRouter & MqttCommandRouterSecurityMethods} */ (
            /** @type {unknown} */ (this)
        );

        const securityArmMatch = topic.match(SECURITY_ARM_TOPIC_REGEX);
        if (securityArmMatch) {
            const [, network, application] = securityArmMatch;
            if (this._hasAddressInRange(topic, { network, application })) {
                self._handleSecurityArm(network, application, payload, topic);
            }
            return;
        }

        // Security panel zone bypass (the virtual '#' keypad key, issue #42):
        // same no-numeric-group shape as the arm topic.
        const securityBypassMatch = topic.match(SECURITY_BYPASS_TOPIC_REGEX);
        if (securityBypassMatch) {
            const [, network, application] = securityBypassMatch;
            if (this._hasAddressInRange(topic, { network, application })) {
                self._handleSecurityBypass(network, application, topic);
            }
            return;
        }

        // Measurement data injection: the address is 4 segments
        // (network/application/device/channel), so it can't parse as a
        // CBusCommand either — routed directly like the security arm topic.
        const measurementDataMatch = topic.match(MEASUREMENT_DATA_TOPIC_REGEX);
        if (measurementDataMatch) {
            const [, network, application, device, channel] = measurementDataMatch;
            if (this._hasAddressInRange(topic, { network, application, device, channel })) {
                this._handleMeasurementData(network, application, device, channel, payload, topic);
            }
            return;
        }

        // Parse MQTT command
        const command = new CBusCommand(topic, payload);
        if (!command.isValid()) {
            // Redacted, and this one matters most: it fires at the default log
            // level, so a topic typo on a hand-built alarm card used to put the
            // PIN into an ordinary log (#51).
            this.logger.warn(`Invalid MQTT command: ${topic} -> ${redactMqttPayload(payload)}`);
            return;
        }

        this._processCommand(command, topic, payload);
    }

    /**
     * Range-check the C-Bus address components a dedicated topic regex captured,
     * warning and refusing the message when any is out of bounds.
     *
     * The topic regexes match digit runs, not ranges, and deliberately stay that
     * way — a pattern spelling out 0-254 is unreadable and rots the moment a
     * bound changes — so the captured values are checked here instead, against
     * the same table CBusCommand uses.
     *
     * This exists because these topics return from routeMessage before
     * CBusCommand is ever constructed, which is where every other write topic
     * gets its address checked. `cbus/write/999/208/panel/arm` therefore sent
     * `security arm //HOME/999/208 away` to C-Gate, and the measurement topic
     * did the same with an address C-Bus cannot express. C-Gate rejects them, so
     * the cost was malformed commands and log noise rather than anything
     * reaching the bus — but it left the write side lagging the inbound side,
     * which was hardened for the equivalent gap (see CBusEvent
     * _applyAddressComponents).
     *
     * @param {string} topic - Topic the address came from; named in the warning.
     * @param {Object<string, string>} components - Named components, e.g. { network, application }.
     * @returns {boolean} true when the whole address is in range.
     * @private
     */
    _hasAddressInRange(topic, components) {
        const rangeError = describeCbusAddressRangeError(components);
        if (rangeError) {
            this.logger.warn(`Ignoring ${topic}: ${rangeError}`);
            return false;
        }
        return true;
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
        // HVAC / cover handlers live on mixins (see Object.assign below).
        const aircon = /** @type {MqttCommandRouter & MqttCommandRouterAirconMethods} */ (
            /** @type {unknown} */ (this)
        );
        const covers = /** @type {MqttCommandRouter & MqttCommandRouterCoverMethods} */ (
            /** @type {unknown} */ (this)
        );

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
                covers._handlePosition(command, topic);
                break;
            case MQTT_CMD_TYPE_TILT:
                covers._handleTilt(command, topic);
                break;
            case MQTT_CMD_TYPE_STOP:
                covers._handleStop(command, topic);
                break;
            case MQTT_CMD_TYPE_TRIGGER:
                this._handleTrigger(command, topic);
                break;
            case MQTT_CMD_TYPE_HVAC_SETPOINT:
                aircon._handleHvacSetpoint(command, payload, topic);
                break;
            case MQTT_CMD_TYPE_HVAC_MODE:
                aircon._handleHvacMode(command, payload, topic);
                break;
            case MQTT_CMD_TYPE_HVAC_FAN_MODE:
                aircon._handleHvacFanMode(command, payload, topic);
                break;
            case MQTT_CMD_TYPE_TEMPERATURE:
                this._handleTemperatureBroadcast(command, payload, topic);
                break;
            case MQTT_CMD_TYPE_PLAY:
            case MQTT_CMD_TYPE_RECORD:
                this._handleSceneModule(command, payload, topic);
                break;
            case MQTT_CMD_TYPE_SET:
            case MQTT_CMD_TYPE_LABEL:
            case MQTT_CMD_TYPE_REMOVE:
                this._handleEnableControl(command, payload, topic);
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
     * Handles a Measurement application (228/$E4) data-injection command:
     * "cbus/write/{net}/{app}/{device}/{channel}/data" with payload
     * "value,multiplier,units" (confirmed working format via live end-to-end
     * testing against real C-Gate). This is how a scripted/virtual measurement
     * source (e.g. a solar inverter reading) gets onto the bus — not a
     * hardware-control write, so it shares the single cbus_measurement_app_id
     * gate with the read path rather than needing a separate *_control_enabled
     * flag (unlike Air Conditioning/Security, which drive real plant/panels).
     * @private
     */
    _handleMeasurementData(network, application, device, channel, payload, topic) {
        const appId = this.settings.cbus_measurement_app_id;
        if (!appId || String(application) !== String(appId)) {
            this.logger.warn(`Measurement data command for unconfigured application ${application} on topic ${topic}`);
            return;
        }

        const parts = String(payload).split(',');
        const value = parseInt(parts[0], 10);
        const multiplier = parts.length > 1 ? parseInt(parts[1], 10) : 0;
        const unitsCode = parts.length > 2 ? parseInt(parts[2], 10) : 0; // default $00 (°C)

        if (!Number.isInteger(value) || value < -32768 || value > 32767) {
            this.logger.warn(`Invalid measurement value "${parts[0]}" on topic ${topic} (expected an integer, -32768..32767)`);
            return;
        }
        if (!Number.isInteger(multiplier) || multiplier < -128 || multiplier > 127) {
            this.logger.warn(`Invalid measurement multiplier "${parts[1]}" on topic ${topic} (expected an integer, -128..127)`);
            return;
        }
        if (!Number.isInteger(unitsCode) || !Object.prototype.hasOwnProperty.call(MEASUREMENT_UNIT_TABLE, unitsCode)) {
            this.logger.warn(`Unknown measurement units code "${parts[2]}" on topic ${topic} (see docs/Measurement Application.md §28.5.1.2)`);
            return;
        }

        const cmd = buildMeasurementDataCommand({
            cbusname: this.cbusname, network, application, device, channel, value, multiplier, unitsCode
        });
        this._queueCommand(cmd + NEWLINE);
        this.logger.info(`Measurement data: ${network}/${application}/${device}/${channel} -> ${value} x 10^${multiplier} (units ${unitsCode})`);
    }

    /**
     * Inject a Temperature Broadcast (app 25 / $19):
     * cbus/write/{net}/{app}/{group}/temperature with a Celsius payload.
     * @private
     */
    _handleTemperatureBroadcast(command, payload, topic) {
        if (String(command.getApplication()) !== DEFAULT_CBUS_APP_TEMPERATURE) {
            this.logger.warn(`Temperature command for non-broadcast application ${command.getApplication()} on topic ${topic}`);
            return;
        }
        const celsius = parseFloat(String(payload).trim());
        const rawByte = celsiusToTemperatureBroadcastByte(celsius);
        if (rawByte === null) {
            this.logger.warn(`Invalid temperature "${payload}" on topic ${topic} (expected 0.0–63.75 °C)`);
            return;
        }
        const cmd = buildTemperatureBroadcastCommand({
            cbusname: this.cbusname,
            network: command.getNetwork(),
            application: command.getApplication(),
            group: command.getGroup(),
            rawByte
        });
        this._queueCommand(cmd + NEWLINE);
        this.logger.info(`Temperature broadcast: ${command.getNetwork()}/${command.getApplication()}/${command.getGroup()} -> ${celsius} °C (raw ${rawByte})`);
    }

    /**
     * Play or record a Scene Module scene. C-Gate: SCENE PLAY|RECORD <set> <scene>.
     * Record overwrites module memory; gated on cbus_scene_module_enabled.
     * @private
     */
    _handleSceneModule(command, payload, topic) {
        if (!this.settings.cbus_scene_module_enabled) {
            this.logger.warn(`Scene Module command ignored (cbus_scene_module_enabled is off): ${topic}`);
            return;
        }
        const scene = parseInt(String(payload).trim(), 10);
        if (!Number.isInteger(scene) || scene < 0 || scene > 255) {
            this.logger.warn(`Invalid Scene Module scene "${payload}" on topic ${topic} (expected 0–255)`);
            return;
        }
        const set = command.getGroup();
        const builder = command.getCommandType() === MQTT_CMD_TYPE_RECORD
            ? buildSceneRecordCommand
            : buildScenePlayCommand;
        const cmd = builder({ set, scene });
        this._queueCommand(cmd + NEWLINE);
        this.logger.info(`Scene Module ${command.getCommandType()}: set ${set} scene ${scene}`);
    }

    /**
     * Extra Enable Control verbs (C-Gate ENABLE SET|LABEL|REMOVE).
     * Gated on cbus_enable_control_app_id (typically 203). ON/OFF/RAMP on the
     * same application still use the generic handlers. REMOVE deletes the
     * C-Gate group object and requires payload ON.
     * @private
     */
    _handleEnableControl(command, payload, topic) {
        const appId = this.settings.cbus_enable_control_app_id;
        if (appId === undefined || appId === null || String(appId).trim() === '' || String(appId) === '0') {
            this.logger.warn(`Enable Control command ignored (cbus_enable_control_app_id is unset): ${topic}`);
            return;
        }
        if (String(command.getApplication()) !== String(appId)) {
            this.logger.warn(`Enable Control command for non-enable application ${command.getApplication()} on topic ${topic}`);
            return;
        }
        const args = {
            cbusname: this.cbusname,
            network: command.getNetwork(),
            application: command.getApplication(),
            group: command.getGroup(),
            payload
        };
        const commandType = command.getCommandType();
        let result;
        if (commandType === MQTT_CMD_TYPE_SET) {
            result = buildEnableSetCommand(args);
        } else if (commandType === MQTT_CMD_TYPE_LABEL) {
            result = buildEnableLabelCommand(args);
        } else {
            result = buildEnableRemoveCommand(args);
        }
        if (result.ok === false) {
            this.logger.warn(`Enable Control command ignored: ${result.error} on topic ${topic}`);
            return;
        }
        this._queueCommand(result.command + NEWLINE);
        this.logger.info(`Enable Control ${commandType}: ${command.getNetwork()}/${command.getApplication()}/${command.getGroup()}`);
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
            const covers = /** @type {MqttCommandRouter & MqttCommandRouterCoverMethods} */ (
                /** @type {unknown} */ (this)
            );
            covers._handleStop(command, command.getTopic());
            return;
        }

        const cbusPath = this._buildCGatePath(command);

        let cgateCommand;
        if (action === MQTT_STATE_ON) {
            cgateCommand = `${CGATE_CMD_ON} ${cbusPath}${NEWLINE}`;
        } else if (action === MQTT_STATE_OFF) {
            cgateCommand = `${CGATE_CMD_OFF} ${cbusPath}${NEWLINE}`;
        } else {
            this.logger.warn(`Invalid payload for switch command: ${redactMqttPayload(payload)}`);
            return;
        }

        this._queueCommand(cgateCommand);
        this._publishOptimisticLightState(command.getNetwork(), command.getApplication(), command.getGroup(), {
            state: action,
            levelPercent: action === MQTT_STATE_ON ? 100 : 0
        });
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
                this._publishOptimisticLightState(command.getNetwork(), command.getApplication(), command.getGroup(), {
                    state: MQTT_STATE_ON,
                    levelPercent: 100
                });
                break;
            case MQTT_STATE_OFF:
                this._queueCommand(`${CGATE_CMD_OFF} ${cbusPath}${NEWLINE}`);
                this._publishOptimisticLightState(command.getNetwork(), command.getApplication(), command.getGroup(), {
                    state: MQTT_STATE_OFF,
                    levelPercent: 0
                });
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
        
        if (typeof level === 'number') {
            let cgateCommand = `${CGATE_CMD_RAMP} ${cbusPath} ${level}`;
            if (rampTime) {
                cgateCommand += ` ${rampTime}`;
            }
            this._queueCommand(cgateCommand + NEWLINE);
            const levelPercent = Math.round(level / CGATE_LEVEL_MAX * 100);
            this._publishOptimisticLightState(command.getNetwork(), command.getApplication(), command.getGroup(), {
                state: level > 0 ? MQTT_STATE_ON : MQTT_STATE_OFF,
                levelPercent
            });
        } else {
            this.logger.warn(`Invalid payload for ramp command: ${redactMqttPayload(payload)}`);
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

        const timeoutMs = resolveSetting(this.settings, 'relativeLevelTimeoutMs');
        this.deviceStateManager.setupRelativeLevelOperation(levelAddress, (currentLevel) => {
            const newLevel = Math.max(CGATE_LEVEL_MIN, Math.min(limit, currentLevel + step));
            this.logger.debug(`${actionName}: ${levelAddress} ${currentLevel} -> ${newLevel}`);
            this._queueCommand(`${CGATE_CMD_RAMP} ${cbusPath} ${newLevel}${NEWLINE}`);
            const [network, application, group] = levelAddress.split('/');
            this._publishOptimisticLightState(network, application, group, {
                state: newLevel > 0 ? MQTT_STATE_ON : MQTT_STATE_OFF,
                levelPercent: Math.round(newLevel / CGATE_LEVEL_MAX * 100)
            });
        }, timeoutMs);

        // Query current level first; the response drives the callback above.
        const queryCommand = `${CGATE_CMD_GET} ${cbusPath} ${CGATE_PARAM_LEVEL}${NEWLINE}`;
        this._queueCommand(queryCommand);
    }

    /**
     * Cleans up pending relative level operations (timers and listeners) and
     * any debounced aircon setpoint writes, so no timer fires after shutdown.
     */
    shutdown() {
        if (this.deviceStateManager) {
            this.deviceStateManager.clearAllOperations();
        }
        for (const pending of this._airconSetpointTimers.values()) {
            clearTimeout(pending.handle);
        }
        this._airconSetpointTimers.clear();
    }

    /**
     * Shared core for the level-carrying write handlers (position, tilt,
     * trigger): group guard, RAMP assembly, queue and debug log. The deltas
     * live in the spec: queue priority, log wording and an optional
     * after-queue hook (position's ramp tracker).
     *
     * @param {CBusCommand} command
     * @param {string} topic - Original topic for error logging
     * @param {Object} spec
     * @param {string} spec.name - Command name for the missing-group warning.
     * @param {string|null} spec.priority - Queue priority (null = default).
     * @param {string} spec.invalidText - Warning for an unparseable payload.
     * @param {(network: string, application: string, group: string, level: string|number) => string} spec.debugLine
     * @param {(level: string|number) => void} [spec.afterQueue]
     * @private
     */
    _queueRampCommand(command, topic, spec) {
        if (!command.getGroup()) {
            this.logger.warn(`${spec.name} command requires device ID on topic ${topic}`);
            return;
        }

        const level = command.getLevel();
        if (level === null || level === undefined) {
            this.logger.warn(spec.invalidText);
            return;
        }

        // Level is already converted from percentage (0-100) to C-Gate level (0-255)
        const cgateCommand = `${CGATE_CMD_RAMP} ${this._buildCGatePath(command)} ${level}${NEWLINE}`;
        if (spec.priority) {
            this._queueCommand(cgateCommand, spec.priority);
        } else {
            this._queueCommand(cgateCommand);
        }
        this.logger.debug(spec.debugLine(command.getNetwork(), command.getApplication(), command.getGroup(), level));
        if (spec.afterQueue) spec.afterQueue(level);
    }

    /**
     * Handles trigger commands for C-Bus trigger groups.
     * Fires the trigger at the specified level (default full level 255 for 'ON' payload).
     * @param {CBusCommand} command - The trigger command
     * @param {string} topic - Original topic for error logging
     * @private
     */
    _handleTrigger(command, topic) {
        this._queueRampCommand(command, topic, {
            name: 'Trigger',
            priority: null,
            invalidText: `Invalid trigger payload for topic ${topic}`,
            debugLine: (n, a, g, l) => `Firing trigger: ${n}/${a}/${g} at level ${l}`
        });
    }

    /**
     * Publish expected lighting state/level immediately after a write so Home
     * Assistant's light card updates without waiting for the C-Gate event port
     * (issue #52: dim from HA succeeded on the bus while the entity stayed off).
     * The real event confirms the same topics shortly after.
     * @param {string} network
     * @param {string} application
     * @param {string} group
     * @param {{ state?: string, levelPercent?: number }} [fields]
     * @private
     */
    _publishOptimisticLightState(network, application, group, fields = {}) {
        if (!this.mqttClient || typeof this.mqttClient.publish !== 'function') return;
        if (!network || !application || !group) return;
        const state = fields.state;
        const levelPercent = fields.levelPercent;
        const base = `${MQTT_TOPIC_PREFIX_READ}/${network}/${application}/${group}`;
        const opts = this.settings.retainreads ? MQTT_RETAINED_STATE_OPTIONS : { qos: 0 };
        if (state !== undefined && state !== null) {
            this.mqttClient.publish(`${base}/${MQTT_TOPIC_SUFFIX_STATE}`, String(state), opts);
        }
        if (levelPercent !== undefined && levelPercent !== null) {
            this.mqttClient.publish(`${base}/${MQTT_TOPIC_SUFFIX_LEVEL}`, String(levelPercent), opts);
        }
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

Object.assign(MqttCommandRouter.prototype, require('./mqttCommandRouterSecurity'));
Object.assign(MqttCommandRouter.prototype, require('./mqttCommandRouterAircon'));
Object.assign(MqttCommandRouter.prototype, require('./mqttCommandRouterCovers'));
module.exports = MqttCommandRouter;
