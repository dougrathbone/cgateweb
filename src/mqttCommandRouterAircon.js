// @ts-check
const { temperatureToCbusLevel } = require('./utils');
const { resolveSetting } = require('./config/schema');
const {
    MQTT_TOPIC_PREFIX_READ,
    MQTT_RETAINED_STATE_OPTIONS,
    MQTT_TOPIC_SUFFIX_HVAC_SETPOINT,
    MQTT_TOPIC_SUFFIX_HVAC_MODE,
    MQTT_TOPIC_SUFFIX_HVAC_FAN_MODE,
    CGATE_CMD_ON,
    CGATE_CMD_OFF,
    CGATE_CMD_RAMP,
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

class _MqttCommandRouterAircon {
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

    /** @type {Object|null} */
    airconControlRegistry;

    /** @type {Map<string, { handle: NodeJS.Timeout }>} */
    _airconSetpointTimers;

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
     * True when the command targets the native Air Conditioning application
     * (cbus_aircon_app_id) rather than the HVAC-via-lighting pattern.
     * @param {import('./cbusCommand')} command
     * @returns {boolean}
     * @private
     */
    _isNativeAircon(command) {
        return !!this.settings.cbus_aircon_app_id &&
            String(command.getApplication()) === String(this.settings.cbus_aircon_app_id);
    }

    /**
     * Whether a native HVAC write may proceed: warns and returns false when
     * cbus_aircon_control_enabled is off.
     *
     * @param {string} what - What was attempted ('setpoint', 'mode', 'fan mode').
     * @param {string} topic - Original topic for the warning.
     * @returns {boolean}
     * @private
     */
    _nativeAirconControlAllowed(what, topic) {
        if (this.settings.cbus_aircon_control_enabled) return true;
        this.logger.warn(`Native HVAC control is disabled (set cbus_aircon_control_enabled to enable); ignoring ${what} on ${topic}`);
        return false;
    }

    /**
     * The thermostat state learned from its broadcasts, or null (with a
     * warning) when the unit hasn't reported yet — native writes need its
     * ward/zones/type, so there is nothing to build a command from before then.
     *
     * @param {string} network
     * @param {string} unit - Thermostat source unit address.
     * @param {string} what - What was attempted ('set setpoint', 'set mode', 'set fan mode').
     * @param {string} topic - Original topic for the warning.
     * @returns {Object|null}
     * @private
     */
    _requireNativeAirconState(network, unit, what, topic) {
        const state = this.airconControlRegistry && this.airconControlRegistry.get(network, unit);
        if (!state) {
            this.logger.warn(`No known HVAC state for ${network}/${unit} yet; cannot ${what} until the thermostat reports once (${topic})`);
            return null;
        }
        return state;
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
     * @param {import('./cbusCommand')} command - The setpoint command
     * @param {string} payload - Temperature value as a string (e.g., "22.5")
     * @param {string} topic - Original topic for error logging
     * @private
     */
    _handleHvacSetpoint(command, payload, topic) {
        if (this._isNativeAircon(command)) {
            if (!this._nativeAirconControlAllowed('setpoint', topic)) return;
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

        // Same 10–32°C range the climate entity advertises (HVAC_MIN/MAX_TEMP_C),
        // then encode at 0.5°C resolution (level = temperature * 2).
        const clampedTemp = Math.max(HVAC_MIN_TEMP_C, Math.min(HVAC_MAX_TEMP_C, tempCelsius));
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
     * the native Air Conditioning application. Only two modes exist here: 'off' →
     * C-Gate OFF, 'auto' → C-Gate ON, leaving the actual heat/cool decision to the
     * PAC/touchscreen logic the group feeds.
     *
     * Named modes (heat/cool/dry/fan_only) are refused rather than sent as a bare
     * ON. A single group level has nowhere to carry a mode, and C-Bus never reports
     * one back, so an accepted 'heat' would turn the unit on in whatever mode the
     * PAC chose and then report itself as 'auto'. Discovery therefore advertises
     * off/auto only; the warning is for anyone publishing to the topic by hand.
     *
     * @param {import('./cbusCommand')} command - The mode command
     * @param {string} payload - Mode string ("off" or "auto")
     * @param {string} topic - Original topic for error logging
     * @private
     */
    _handleHvacMode(command, payload, topic) {
        if (this._isNativeAircon(command)) {
            if (!this._nativeAirconControlAllowed('mode', topic)) return;
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
        } else if (mode === 'auto') {
            // ON only — the thermostat keeps its last setpoint and picks its own mode.
            // TODO: If the C-Bus hardware supports dedicated mode group addresses,
            // extend this to send mode-specific RAMP values to additional group addresses.
            cgateCommand = `${CGATE_CMD_ON} ${cbusPath}${NEWLINE}`;
        } else if (['heat', 'cool', 'heat_cool', 'dry', 'fan_only'].includes(mode)) {
            this.logger.warn(`HVAC mode "${payload}" is not supported on the ha_discovery_hvac_app_id path — a single lighting group cannot carry a mode, so only off and auto work. Use the native Air Conditioning application (cbus_aircon_app_id) for real mode control. Ignoring ${topic}`);
            return;
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
     * @param {import('./cbusCommand')} command
     * @param {string} payload
     * @param {string} topic
     * @private
     */
    _handleNativeAirconSetpoint(command, payload, topic) {
        const network = command.getNetwork();
        const unit = command.getGroup();
        const state = this._requireNativeAirconState(network, unit, 'set setpoint', topic);
        if (!state) return;
        if (state.modeRaw === 0) {
            // Writing a setpoint to an off thermostat would force it on in the
            // fallback mode — the climate card adjusting a target must never
            // power the unit up.
            this.logger.warn(`HVAC unit ${network}/${unit} is off; ignoring setpoint of ${payload}°C — turn it on first (${topic})`);
            return;
        }
        const tempC = parseFloat(payload);
        if (isNaN(tempC)) {
            this.logger.warn(`Invalid HVAC setpoint value "${payload}" on topic ${topic}`);
            return;
        }
        const clamped = Math.max(HVAC_MIN_TEMP_C, Math.min(HVAC_MAX_TEMP_C, tempC));
        // Optimistically reflect the new target so the HA card updates instantly,
        // then debounce the actual command: the thermostat echoes each Set Zone
        // HVAC Mode message, so streaming increments causes race conditions —
        // §25.12.11 says wait until the user has finished, then send one message.
        this._publishOptimisticHvacState(network, command.getApplication(), unit, { setpointC: clamped });
        this._debounceAirconSetpoint(network, command.getApplication(), unit, clamped);
    }

    /**
     * Collapse rapid setpoint adjustments into a single AIRCON command sent a
     * few seconds after the last change (spec §25.12.11 "Timeout on
     * Adjustment"; §25.8.10 also recommends spacing these commands). The
     * command is built at fire time from the then-current learned state.
     * @param {string} network
     * @param {string} application
     * @param {string} unit
     * @param {number} clamped
     * @private
     */
    _debounceAirconSetpoint(network, application, unit, clamped) {
        const key = `${network}/${unit}`;
        const pending = this._airconSetpointTimers.get(key);
        if (pending) clearTimeout(pending.handle);
        const delayMs = resolveSetting(this.settings, 'airconSetpointDebounceMs');
        const handle = setTimeout(() => {
            this._airconSetpointTimers.delete(key);
            this._sendAirconSetpoint(network, application, unit, clamped);
        }, delayMs);
        if (typeof handle.unref === 'function') handle.unref();
        this._airconSetpointTimers.set(key, { handle });
        this.logger.debug(`Native HVAC setpoint: ${network}/${unit} -> ${clamped}°C queued (debounced ${delayMs}ms)`);
    }

    /**
     * Cancel a pending (debounced) setpoint write, e.g. when the user switches
     * mode instead — the latest explicit action wins.
     * @param {string} network
     * @param {string} unit
     * @private
     */
    _cancelPendingAirconSetpoint(network, unit) {
        const pending = this._airconSetpointTimers.get(`${network}/${unit}`);
        if (pending) {
            clearTimeout(pending.handle);
            this._airconSetpointTimers.delete(`${network}/${unit}`);
        }
    }

    /**
     * Actually send a debounced setpoint write, using the thermostat's current
     * learned state (mode, flags, ward/zones/type) at fire time.
     * @param {string} network
     * @param {string} application
     * @param {string} unit
     * @param {number} clamped
     * @private
     */
    _sendAirconSetpoint(network, application, unit, clamped) {
        const state = this.airconControlRegistry && this.airconControlRegistry.get(network, unit);
        if (!state) return;
        const level = Math.round(clamped * 256); // °C × 256, temperature value (rawlevel=0)
        const modeRaw = (state.modeRaw !== null && state.modeRaw !== undefined && state.modeRaw !== 0)
            ? state.modeRaw : HVAC_CODE_BY_MODE.heat;
        const cmd = buildSetZoneHvacMode({
            cbusname: this.cbusname,
            network,
            application,
            ward: state.ward,
            zones: state.zones,
            modeRaw,
            rawlevel: 0,
            ...this._airconFlagEcho(state),
            type: state.type,
            level
        });
        this._queueCommand(cmd + NEWLINE);
        // Keep the learned state coherent until the thermostat's echo broadcast.
        this.airconControlRegistry.noteSetpointWrite(network, unit, modeRaw, level);
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
     * @param {string} [state.fanMode] - Fan mode to publish
     * @private
     */
    _publishOptimisticHvacState(network, application, unit, { mode, setpointC, fanMode } = {}) {
        if (!this.mqttClient || typeof this.mqttClient.publish !== 'function') return;
        const base = `${MQTT_TOPIC_PREFIX_READ}/${network}/${application}/${unit}`;
        const opts = this.settings.retainreads ? MQTT_RETAINED_STATE_OPTIONS : { qos: 0 };
        if (setpointC !== undefined && setpointC !== null) {
            this.mqttClient.publish(`${base}/${MQTT_TOPIC_SUFFIX_HVAC_SETPOINT}`, String(setpointC), opts);
        }
        if (mode !== undefined && mode !== null) {
            this.mqttClient.publish(`${base}/${MQTT_TOPIC_SUFFIX_HVAC_MODE}`, String(mode), opts);
        }
        if (fanMode !== undefined && fanMode !== null) {
            this.mqttClient.publish(`${base}/${MQTT_TOPIC_SUFFIX_HVAC_FAN_MODE}`, String(fanMode), opts);
        }
    }

    /**
     * Native Air Conditioning mode change via AIRCON SET_WARD_OFF (off) or
     * SET_ZONE_HVAC_MODE (any active mode, keeping the last setpoint; Fan Only
     * uses the raw "no level" sentinel).
     * @param {import('./cbusCommand')} command
     * @param {string} payload
     * @param {string} topic
     * @private
     */
    _handleNativeAirconMode(command, payload, topic) {
        const network = command.getNetwork();
        const unit = command.getGroup();
        const application = command.getApplication();
        const state = this._requireNativeAirconState(network, unit, 'set mode', topic);
        if (!state) return;

        const mode = String(payload).toLowerCase();
        if (mode === 'off') {
            this._cancelPendingAirconSetpoint(network, unit);
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

        this._cancelPendingAirconSetpoint(network, unit);
        const { rawlevel, level } = this._airconLevelForModeRaw(state, code);
        const cmd = buildSetZoneHvacMode({
            cbusname: this.cbusname,
            network,
            application,
            ward: state.ward,
            zones: state.zones,
            modeRaw: code,
            rawlevel,
            ...this._airconFlagEcho(state),
            type: state.type,
            level
        });
        this._queueCommand(cmd + NEWLINE);
        this._publishOptimisticHvacState(network, application, unit, { mode });
        this.logger.info(`Native HVAC mode: ${network}/${unit} -> ${mode} (ward ${state.ward}, zones ${state.zones})`);
    }

    /**
     * Resolve the <Level> for a SET_ZONE_HVAC_MODE write: Fan Only carries the
     * raw-level fan value; otherwise §25.12.11 says each Operating Type recalls
     * its own Set Point — use the one learned for the target mode, falling back
     * to the last seen target, then a default, when never observed.
     * @param {Object} state
     * @param {number} modeRaw
     * @returns {{ rawlevel: number, level: number }}
     * @private
     */
    _airconLevelForModeRaw(state, modeRaw) {
        if (modeRaw === HVAC_CODE_BY_MODE.fan_only) {
            return { rawlevel: 1, level: FAN_LEVEL_SENTINEL };
        }
        const byMode = state.setpointRawByMode && state.setpointRawByMode[modeRaw];
        if (Number.isInteger(byMode) && byMode > 0 && byMode <= 12800) {
            return { rawlevel: 0, level: byMode };
        }
        if (state.setpointRaw !== null && state.setpointRaw !== undefined && state.setpointRaw > 0 && state.setpointRaw <= 12800) {
            return { rawlevel: 0, level: state.setpointRaw };
        }
        return { rawlevel: 0, level: Math.round(DEFAULT_SETPOINT_C * 256) };
    }

    /**
     * HVAC fan mode command entry point (cbus/write/…/fanmode). Only the native
     * Air Conditioning application supports it (via the Aux Level, §25.6.11);
     * HVAC-via-lighting has no fan concept.
     * @param {import('./cbusCommand')} command
     * @param {string} payload
     * @param {string} topic
     * @private
     */
    _handleHvacFanMode(command, payload, topic) {
        if (this._isNativeAircon(command)) {
            if (!this._nativeAirconControlAllowed('fan mode', topic)) return;
            return this._handleNativeAirconFanMode(command, payload, topic);
        }
        this.logger.warn(`HVAC fan mode is only supported on the native Air Conditioning application; ignoring ${topic}`);
    }

    /**
     * Native Air Conditioning fan mode via the Aux Level (§25.6.3 A bit +
     * §25.6.11): 'automatic' clears the aux-used flag (aux-controlled functions
     * run automatically); 'continuous' sets Aux Level bit 6, preserving any
     * learned fan-speed setting in bits 0-5. Mode and setpoint are kept from the
     * thermostat's current state.
     * @param {import('./cbusCommand')} command
     * @param {string} payload
     * @param {string} topic
     * @private
     */
    _handleNativeAirconFanMode(command, payload, topic) {
        const network = command.getNetwork();
        const unit = command.getGroup();
        const application = command.getApplication();
        const state = this._requireNativeAirconState(network, unit, 'set fan mode', topic);
        if (!state) return;
        if (state.modeRaw === 0) {
            // Same guard as the setpoint path: a fan-mode write would force the
            // off unit on in the fallback mode.
            this.logger.warn(`HVAC unit ${network}/${unit} is off; ignoring fan mode "${payload}" — turn it on first (${topic})`);
            return;
        }

        const fanMode = String(payload).toLowerCase();
        let useaux;
        let aux;
        if (fanMode === 'automatic') {
            useaux = 0;
            aux = 0;
        } else if (fanMode === 'continuous') {
            useaux = 1;
            // Re-combine bit 6 with the learned speed bits whenever we have
            // them — including after an automatic write, which clears the
            // aux-used flag but deliberately keeps the learned aux level.
            aux = 0x40 | (Number.isInteger(state.auxLevel) ? (state.auxLevel & 0x3F) : 0);
        } else {
            this.logger.warn(`Unknown HVAC fan mode "${payload}" on topic ${topic} (expected automatic|continuous)`);
            return;
        }

        const modeRaw = (state.modeRaw !== null && state.modeRaw !== undefined && state.modeRaw !== 0)
            ? state.modeRaw : HVAC_CODE_BY_MODE.heat;
        this._cancelPendingAirconSetpoint(network, unit);
        const { rawlevel, level } = this._airconLevelForModeRaw(state, modeRaw);
        const flags = this._airconFlagEcho(state);
        const cmd = buildSetZoneHvacMode({
            cbusname: this.cbusname,
            network,
            application,
            ward: state.ward,
            zones: state.zones,
            modeRaw,
            rawlevel,
            setback: flags.setback,
            guard: flags.guard,
            useaux,
            type: state.type,
            level,
            aux
        });
        this._queueCommand(cmd + NEWLINE);
        // An automatic write clears the aux-used flag but must not clobber the
        // learned fan-speed bits — a later continuous write combines bit 6
        // with them (§25.6.11).
        this.airconControlRegistry.noteAuxLevelWrite(network, unit, useaux === 1,
            useaux === 1 ? aux : (Number.isInteger(state.auxLevel) ? state.auxLevel : aux));
        this._publishOptimisticHvacState(network, application, unit, { fanMode });
        this.logger.info(`Native HVAC fan mode: ${network}/${unit} -> ${fanMode} (ward ${state.ward}, zones ${state.zones})`);
    }

    /**
     * Resolve the Mode & Flags byte fields (§25.6.3) and Aux Level for a write
     * from the thermostat's learned broadcasts, so HA-originated commands echo
     * its configuration instead of silently clearing setback/guard/aux state.
     * Defaults mirror the thermostat-typical broadcast (setback 0, guard 0,
     * aux used, aux level 0) when nothing has been learned.
     * @param {Object} state
     * @returns {{ setback: number, guard: number, useaux: number, aux: number }}
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
}

const methods = {};
for (const name of Object.getOwnPropertyNames(_MqttCommandRouterAircon.prototype)) {
    if (name === 'constructor') continue;
    methods[name] = _MqttCommandRouterAircon.prototype[name];
}
module.exports = methods;
