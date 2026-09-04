// @ts-check
const { buildMeasurementDataCommand } = require('./measurementCommand');
const { buildTemperatureBroadcastCommand, celsiusToTemperatureBroadcastByte } = require('./temperatureCommand');
const { buildScenePlayCommand, buildSceneRecordCommand } = require('./sceneCommand');
const { buildEnableSetCommand, buildEnableLabelCommand, buildEnableRemoveCommand } = require('./enableCommand');
const { UNIT_TABLE: MEASUREMENT_UNIT_TABLE } = require('./applicationDecoders/measurementDecoder');
const {
    MQTT_CMD_TYPE_RECORD,
    MQTT_CMD_TYPE_SET,
    MQTT_CMD_TYPE_LABEL,
    NEWLINE,
    DEFAULT_CBUS_APP_TEMPERATURE
} = require('./constants');

class _MqttCommandRouterSensors {
    // Host-provided instance state. This class is never instantiated: its
    // prototype methods are copied onto MqttCommandRouter (see the Object.assign
    // in mqttCommandRouter.js), which supplies every member declared below. The
    // field declarations exist purely so @ts-check can resolve them; they never run.

    /** @type {ReturnType<typeof import('./logger').createLogger>} */
    logger;

    /** @type {Object} */
    settings;

    /** @type {string} */
    cbusname;

    /**
     * Queue a C-Gate command string (implemented on MqttCommandRouter).
     * @type {(command: string, priority?: *) => void}
     */
    _queueCommand;

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
}

const methods = {};
for (const name of Object.getOwnPropertyNames(_MqttCommandRouterSensors.prototype)) {
    if (name === 'constructor') continue;
    methods[name] = _MqttCommandRouterSensors.prototype[name];
}
module.exports = methods;
