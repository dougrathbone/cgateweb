// @ts-check
const { redactMqttPayload } = require('./utils');
const { resolveSetting } = require('./config/schema');
const {
    MQTT_TOPIC_PREFIX_READ,
    MQTT_RETAINED_STATE_OPTIONS,
    MQTT_TOPIC_SUFFIX_LEVEL,
    MQTT_TOPIC_SUFFIX_STATE,
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
    NEWLINE
} = require('./constants');

/**
 * Cover stop handler (implemented in mqttCommandRouterCovers). Declared here so
 * the switch-topic STOP path type-checks against the mixed-in prototype.
 * @typedef {Object} MqttCommandRouterCoverMethods
 * @property {(command: import('./cbusCommand'), topic: string) => void} _handleStop
 */

class _MqttCommandRouterLighting {
    // Host-provided instance state. This class is never instantiated: its
    // prototype methods are copied onto MqttCommandRouter (see the Object.assign
    // in mqttCommandRouter.js), which supplies every member declared below. The
    // field declarations exist purely so @ts-check can resolve them; they never run.

    /** @type {ReturnType<typeof import('./logger').createLogger>} */
    logger;

    /** @type {Object} */
    settings;

    /** @type {{ cancelRelativeLevelOperation: Function, setupRelativeLevelOperation: Function }|null} */
    deviceStateManager;

    /** @type {{ publish: Function }|null} */
    mqttClient;

    /**
     * Queue a C-Gate command string (implemented on MqttCommandRouter).
     * @type {(command: string, priority?: *) => void}
     */
    _queueCommand;

    /**
     * Build a C-Gate device path (implemented on MqttCommandRouter).
     * @type {(command: import('./cbusCommand')) => string}
     */
    _buildCGatePath;

    /**
     * Handles switch commands (ON/OFF).
     * @param {import('./cbusCommand')} command - The switch command
     * @param {string} payload - The command payload (ON/OFF)
     * @private
     */
    _handleSwitch(command, payload) {
        const action = payload.toUpperCase();

        // Home Assistant's MQTT cover platform publishes payload_stop ("STOP") to
        // the command (switch) topic rather than a dedicated stop topic, so a STOP
        // on the switch topic must be routed to the cover-stop (TERMINATERAMP) path.
        if (action === MQTT_COMMAND_STOP) {
            const covers = /** @type {_MqttCommandRouterLighting & MqttCommandRouterCoverMethods} */ (
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
     * @param {import('./cbusCommand')} command - The ramp command
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
     * @param {import('./cbusCommand')} command - The ramp command
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
}

const methods = {};
for (const name of Object.getOwnPropertyNames(_MqttCommandRouterLighting.prototype)) {
    if (name === 'constructor') continue;
    methods[name] = _MqttCommandRouterLighting.prototype[name];
}
module.exports = methods;
