// @ts-check
const { resolveSetting } = require('./config/schema');
const {
    MQTT_TOPIC_PREFIX_READ,
    MQTT_RETAINED_STATE_OPTIONS,
    MQTT_TOPIC_SUFFIX_LEVEL,
    MQTT_TOPIC_SUFFIX_POSITION,
    CGATE_CMD_TERMINATERAMP,
    CGATE_LEVEL_MAX,
    NEWLINE
} = require('./constants');

class _MqttCommandRouterCovers {
    // Host-provided instance state. This class is never instantiated: its
    // prototype methods are copied onto MqttCommandRouter (see the Object.assign
    // in mqttCommandRouter.js), which supplies every member declared below. The
    // field declarations exist purely so @ts-check can resolve them; they never run.

    /** @type {ReturnType<typeof import('./logger').createLogger>} */
    logger;

    /** @type {Object} */
    settings;

    /** @type {{ getLevel: Function }|null} */
    deviceStateManager;

    /** @type {{ publish: Function }|null} */
    mqttClient;

    /** @type {import('./coverRampTracker')} */
    _coverRampTracker;

    /**
     * Shared RAMP queue helper (implemented on MqttCommandRouter).
     * @type {(command: import('./cbusCommand'), topic: string, spec: Object) => void}
     */
    _queueRampCommand;

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
     * Handles cover position commands (set position 0-100%).
     * Uses RAMP command to set the position level and starts interpolated
     * position updates so Home Assistant shows smooth progress.
     * @param {import('./cbusCommand')} command - The position command
     * @param {string} topic - Original topic for error logging
     * @private
     */
    _handlePosition(command, topic) {
        this._queueRampCommand(command, topic, {
            name: 'Position',
            priority: 'interactive',
            invalidText: `Invalid position value for topic ${topic}`,
            debugLine: (n, a, g, l) => `Setting cover position: ${n}/${a}/${g} to level ${l}`,
            afterQueue: (level) => {
                // Start interpolated position updates so HA shows smooth movement
                // Position payloads always produce a numeric level (or null, excluded above).
                this._startCoverRamp(command.getNetwork(), command.getApplication(), command.getGroup(), /** @type {number} */ (level), null);
            }
        });
    }

    /**
     * Handles cover tilt commands (set tilt angle 0-100%).
     * Uses RAMP command to set the tilt level.
     * @param {import('./cbusCommand')} command - The tilt command
     * @param {string} topic - Original topic for error logging
     * @private
     */
    _handleTilt(command, topic) {
        this._queueRampCommand(command, topic, {
            name: 'Tilt',
            priority: 'interactive',
            invalidText: `Invalid tilt value for topic ${topic}`,
            debugLine: (n, a, g, l) => `Setting cover tilt: ${n}/${a}/${g} to level ${l}`
        });
    }

    /**
     * Handles stop commands for covers/blinds.
     * Uses TERMINATERAMP to stop any in-progress movement.
     * Also cancels any active interpolated position ramp.
     * @param {import('./cbusCommand')} command - The stop command
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
            : resolveSetting(this.settings, 'cover_ramp_duration_ms');

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
}

const methods = {};
for (const name of Object.getOwnPropertyNames(_MqttCommandRouterCovers.prototype)) {
    if (name === 'constructor') continue;
    methods[name] = _MqttCommandRouterCovers.prototype[name];
}
module.exports = methods;
