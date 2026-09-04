// @ts-check
const { EventEmitter } = require('events');
const CBusCommand = require('./cbusCommand');
const CoverRampTracker = require('./coverRampTracker');
const { createLogger } = require('./logger');
const { redactMqttPayload, describeCbusAddressRangeError } = require('./utils');
const { resolveSetting } = require('./config/schema');
const {
    MQTT_TOPIC_MANUAL_TRIGGER,
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
    CGATE_CMD_GET,
    CGATE_CMD_RAMP,
    CGATE_PARAM_LEVEL,
    NEWLINE,
    SECURITY_ARM_TOPIC_REGEX,
    SECURITY_BYPASS_TOPIC_REGEX,
    MEASUREMENT_DATA_TOPIC_REGEX
} = require('./constants');

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

/**
 * Methods mixed into MqttCommandRouter.prototype from mqttCommandRouterLighting.js
 * at module load (see the Object.assign call at the bottom of this file).
 * @typedef {Object} MqttCommandRouterLightingMethods
 * @property {(command: import('./cbusCommand'), payload: string) => void} _handleSwitch
 * @property {(command: import('./cbusCommand'), payload: string, topic: string) => void} _handleRamp
 */

/**
 * Methods mixed into MqttCommandRouter.prototype from mqttCommandRouterSensors.js
 * at module load (see the Object.assign call at the bottom of this file).
 * @typedef {Object} MqttCommandRouterSensorsMethods
 * @property {(network: string, application: string, device: string, channel: string, payload: string, topic: string) => void} _handleMeasurementData
 * @property {(command: import('./cbusCommand'), payload: string, topic: string) => void} _handleTemperatureBroadcast
 * @property {(command: import('./cbusCommand'), payload: string, topic: string) => void} _handleSceneModule
 * @property {(command: import('./cbusCommand'), payload: string, topic: string) => void} _handleEnableControl
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
                const sensors = /** @type {MqttCommandRouter & MqttCommandRouterSensorsMethods} */ (
                    /** @type {unknown} */ (this)
                );
                sensors._handleMeasurementData(network, application, device, channel, payload, topic);
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
        // Domain handlers live on mixins (see Object.assign below).
        const aircon = /** @type {MqttCommandRouter & MqttCommandRouterAirconMethods} */ (
            /** @type {unknown} */ (this)
        );
        const covers = /** @type {MqttCommandRouter & MqttCommandRouterCoverMethods} */ (
            /** @type {unknown} */ (this)
        );
        const lighting = /** @type {MqttCommandRouter & MqttCommandRouterLightingMethods} */ (
            /** @type {unknown} */ (this)
        );
        const sensors = /** @type {MqttCommandRouter & MqttCommandRouterSensorsMethods} */ (
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
                lighting._handleSwitch(command, payload);
                break;
            case MQTT_CMD_TYPE_RAMP:
                lighting._handleRamp(command, payload, topic);
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
                sensors._handleTemperatureBroadcast(command, payload, topic);
                break;
            case MQTT_CMD_TYPE_PLAY:
            case MQTT_CMD_TYPE_RECORD:
                sensors._handleSceneModule(command, payload, topic);
                break;
            case MQTT_CMD_TYPE_SET:
            case MQTT_CMD_TYPE_LABEL:
            case MQTT_CMD_TYPE_REMOVE:
                sensors._handleEnableControl(command, payload, topic);
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
Object.assign(MqttCommandRouter.prototype, require('./mqttCommandRouterLighting'));
Object.assign(MqttCommandRouter.prototype, require('./mqttCommandRouterSensors'));
module.exports = MqttCommandRouter;
