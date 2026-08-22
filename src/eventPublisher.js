// @ts-check
const { createLogger } = require('./logger');
const { clampSetting, evictOldestFifo, cbusLevelToTemperature } = require('./utils');
const {
    MQTT_TOPIC_PREFIX_READ,
    MQTT_TOPIC_SUFFIX_STATE,
    MQTT_TOPIC_SUFFIX_LEVEL,
    MQTT_TOPIC_SUFFIX_POSITION,
    MQTT_TOPIC_SUFFIX_TILT,
    MQTT_TOPIC_SUFFIX_EVENT,
    MQTT_TOPIC_SUFFIX_HVAC_CURRENT_TEMP,
    MQTT_TOPIC_SUFFIX_HVAC_SETPOINT,
    MQTT_TOPIC_SUFFIX_HVAC_MODE,
    MQTT_TOPIC_SUFFIX_HVAC_FAN_MODE,
    MQTT_TOPIC_SUFFIX_HVAC_FAN_SPEED,
    MQTT_TOPIC_SUFFIX_HVAC_ACTION,
    MQTT_TOPIC_SUFFIX_HVAC_ERROR,
    MQTT_TOPIC_SUFFIX_HVAC_ERROR_DESCRIPTION,
    MQTT_TOPIC_SUFFIX_HVAC_SENSOR_STATUS,
    MQTT_TOPIC_SUFFIX_HVAC_PROBLEM,
    MQTT_TOPIC_SUFFIX_HVAC_SENSOR_PROBLEM,
    MQTT_TOPIC_SUFFIX_HVAC_CURRENT_HUMIDITY,
    MQTT_TOPIC_SUFFIX_HVAC_HUMIDITY_SETPOINT,
    MQTT_TOPIC_SUFFIX_HVAC_HUMIDITY_MODE,
    MQTT_TOPIC_SUFFIX_HVAC_HUMIDITY_ACTION,
    MQTT_TOPIC_SUFFIX_HVAC_FAN_SPEED_PCT,
    MQTT_TOPIC_SUFFIX_HVAC_COMFORT_LEVEL,
    MQTT_TOPIC_SUFFIX_HVAC_DAMPER,
    MQTT_TOPIC_SUFFIX_HVAC_BUSY,
    MQTT_TOPIC_SUFFIX_HVAC_EXPANSION,
    MQTT_TOPIC_SUFFIX_HVAC_PLANT_TYPE,
    MQTT_TOPIC_SUFFIX_HVAC_PLANT_TYPE_DESCRIPTION,
    MQTT_TOPIC_SUFFIX_SOURCE_UNIT,
    MQTT_TOPIC_SUFFIX_ATTRIBUTES,
    MQTT_TOPIC_SUFFIX_VALUE,
    MQTT_TOPIC_SUFFIX_UNIT,
    MQTT_STATE_ON,
    MQTT_STATE_OFF,
    CGATE_CMD_ON,
    CGATE_LEVEL_MAX
} = require('./constants');

// Security zone JSON-attributes payloads. Only four zone states exist, so the
// payload string for each is built once instead of JSON-stringifying per zone
// per status report. Frozen so the shared strings can't be mutated.
//
// Zone isolation (the panel bypassing a zone for an armed period) doubles the
// table rather than composing JSON at publish time, because the state space is
// still tiny and closed: 4 zone states x isolated/not. The overwhelmingly common
// publish — a plain sealed/unsealed zone, 80 of them per status report — costs
// exactly what it did before (one property read off a frozen object) and still
// allocates nothing; the isolated variant is just as cheap. A composed
// JSON.stringify would have put an object literal and a serialisation on that
// path for the benefit of the rare case.
//
// Absence, not `"isolated":false`, means not isolated. That keeps the
// non-isolated payloads byte-identical to what shipped before, so existing
// automations and templates reading `zone_state` see no change at all, and
// `state_attr(...,'isolated')` is falsy for them either way.
const SECURITY_ZONE_ATTRIBUTES_PAYLOAD = Object.freeze({
    sealed: '{"zone_state":"sealed"}',
    unsealed: '{"zone_state":"unsealed"}',
    open: '{"zone_state":"open"}',
    short: '{"zone_state":"short"}'
});

const SECURITY_ZONE_ISOLATED_ATTRIBUTES_PAYLOAD = Object.freeze({
    sealed: '{"zone_state":"sealed","isolated":true}',
    unsealed: '{"zone_state":"unsealed","isolated":true}',
    open: '{"zone_state":"open","isolated":true}',
    short: '{"zone_state":"short","isolated":true}'
});

// A panel can isolate a zone before we have ever seen that zone's state (the
// initial status report may not have arrived, or may never arrive). Isolation is
// still worth publishing on its own — and the empty payload is what clears it
// again, since the attributes topic is a whole-document replace.
const SECURITY_ZONE_ISOLATED_ONLY_PAYLOAD = '{"isolated":true}';
const SECURITY_ZONE_NO_ATTRIBUTES_PAYLOAD = '{}';

/**
 * Dispatch table for publishReading: kind → handler(ep, base, reading).
 * Handlers keep the historical publish semantics (skip nulls, pre-rendered
 * security payloads, etc.); the table only removes the if/else chain.
 */
const READING_KIND_HANDLERS = {
    temperature(ep, base, reading) {
        // celsius is null when the sensor reports total failure (§25.8.6) —
        // surface the status, not the meaningless temperature.
        if (reading.celsius !== null && reading.celsius !== undefined) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_CURRENT_TEMP}`,
                String(reading.celsius),
                ep.mqttOptions
            );
        }
        if (reading.sensorStatus !== null && reading.sensorStatus !== undefined) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_SENSOR_STATUS}`,
                String(reading.sensorStatus),
                ep.mqttOptions
            );
            // Degraded (out of calibration) or failed sensor → problem state
            // for the binary_sensor (spec §25.6.12).
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_SENSOR_PROBLEM}`,
                reading.sensorStatus >= 2 ? MQTT_STATE_ON : MQTT_STATE_OFF,
                ep.mqttOptions
            );
        }
    },

    mode(ep, base, reading) {
        if (reading.mode !== null && reading.mode !== undefined) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_MODE}`,
                reading.mode,
                ep.mqttOptions
            );
        }
        if (reading.setpoint !== null && reading.setpoint !== undefined) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_SETPOINT}`,
                String(reading.setpoint),
                ep.mqttOptions
            );
        }
        // Fan speed/mode from the Aux Level (spec §25.6.11). Fan speed is the
        // raw 0-63 setting (0 = default speed) — HA climate has no numeric
        // fan-speed concept, so it stays an MQTT-only topic.
        if (reading.fanMode !== null && reading.fanMode !== undefined) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_FAN_MODE}`,
                reading.fanMode,
                ep.mqttOptions
            );
        }
        if (reading.fanSpeed !== null && reading.fanSpeed !== undefined) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_FAN_SPEED}`,
                String(reading.fanSpeed),
                ep.mqttOptions
            );
        }
        // Fan speed from the Raw Level (vent/fan, evaporative-manual) as a
        // percentage (§25.12.8), and the evaporative Comfort Level
        // (§25.12.7) — both MQTT-only (no HA climate equivalent).
        if (reading.fanSpeedPercent !== null && reading.fanSpeedPercent !== undefined) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_FAN_SPEED_PCT}`,
                String(reading.fanSpeedPercent),
                ep.mqttOptions
            );
        }
        if (reading.comfortLevel !== null && reading.comfortLevel !== undefined) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_COMFORT_LEVEL}`,
                String(reading.comfortLevel),
                ep.mqttOptions
            );
        }
    },

    clock(ep, base, reading) {
        // Clock and Timekeeping (app 223): the network's date and time
        // arrive as two separate broadcasts, so each gets its own topic
        // and neither waits on the other. Published verbatim as the
        // network reported them — see the note in clockDecoder.js on why
        // they are deliberately not combined into a timestamp.
        ep._publishIfNeeded(
            `${base}/${reading.variant}`,
            reading.value,
            ep.mqttOptions
        );
    },

    state(ep, base, reading) {
        ep._publishIfNeeded(
            `${base}/${MQTT_TOPIC_SUFFIX_STATE}`,
            reading.on ? 'ON' : 'OFF',
            ep.mqttOptions
        );
    },

    action(ep, base, reading) {
        // Live plant running state → Home Assistant climate hvac_action.
        ep._publishIfNeeded(
            `${base}/${MQTT_TOPIC_SUFFIX_HVAC_ACTION}`,
            reading.action,
            ep.mqttOptions
        );
        // The remaining §25.6.6 status bits. cooling/heating/fan are already
        // folded into `action` above; these three carry information that
        // hvac_action cannot express, so they get their own topics rather
        // than being decoded and thrown away:
        //   damper (bit 3) — Closed/Open, ON = open
        //   busy   (bit 5) — the plant is mid-transition, so a mode or
        //                    setpoint write may not take effect yet
        //   expansion (bit 7) — protocol expansion marker with no defined
        //                    meaning in issue 1.12; published for
        //                    completeness, deliberately given no HA entity
        //                    (nothing sensible to show a user).
        ep._publishBooleanIfPresent(reading.damper, `${base}/${MQTT_TOPIC_SUFFIX_HVAC_DAMPER}`);
        ep._publishBooleanIfPresent(reading.busy, `${base}/${MQTT_TOPIC_SUFFIX_HVAC_BUSY}`);
        ep._publishBooleanIfPresent(reading.expansion, `${base}/${MQTT_TOPIC_SUFFIX_HVAC_EXPANSION}`);
        // Plant type (spec §25.6.4): numeric code + human description, the
        // same pairing as the error code below. This is the plant actually
        // reporting status, not the type requested by a mode broadcast —
        // see decodeZonePlantStatus for why only this verb feeds the topic.
        if (reading.type !== null && reading.type !== undefined) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_PLANT_TYPE}`,
                String(reading.type),
                ep.mqttOptions
            );
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_PLANT_TYPE_DESCRIPTION}`,
                reading.typeDescription,
                ep.mqttOptions
            );
        }
        // Plant error state (spec §25.6.5): numeric code + human description.
        if (reading.errorCode !== null && reading.errorCode !== undefined) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_ERROR}`,
                String(reading.errorCode),
                ep.mqttOptions
            );
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_ERROR_DESCRIPTION}`,
                reading.errorDescription,
                ep.mqttOptions
            );
        }
        // Problem binary state for the HA binary_sensor: ON when the status
        // error bit (§25.6.6 bit 6) or a non-zero error code says so.
        if ((reading.error !== null && reading.error !== undefined)
            || (reading.errorCode !== null && reading.errorCode !== undefined)) {
            const problem = reading.error === true || (reading.errorCode || 0) > 0;
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_PROBLEM}`,
                problem ? MQTT_STATE_ON : MQTT_STATE_OFF,
                ep.mqttOptions
            );
        }
    },

    humidity(ep, base, reading) {
        // Zone humidity (spec §25.8.7, 0–100%). Null when the sensor reports
        // total failure — surface nothing rather than a bogus reading.
        if (reading.humidity !== null && reading.humidity !== undefined) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_CURRENT_HUMIDITY}`,
                String(reading.humidity),
                ep.mqttOptions
            );
        }
    },

    humidity_mode(ep, base, reading) {
        // Humidity control mode + target (spec §25.8.12). MQTT-only state;
        // the climate entity reads these as current/target humidity.
        if (reading.mode !== null && reading.mode !== undefined) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_HUMIDITY_MODE}`,
                reading.mode,
                ep.mqttOptions
            );
        }
        if (reading.humiditySetpoint !== null && reading.humiditySetpoint !== undefined) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_HUMIDITY_SETPOINT}`,
                String(reading.humiditySetpoint),
                ep.mqttOptions
            );
        }
    },

    humidity_action(ep, base, reading) {
        // Humidity plant running state (spec §25.8.5/§25.6.10).
        ep._publishIfNeeded(
            `${base}/${MQTT_TOPIC_SUFFIX_HVAC_HUMIDITY_ACTION}`,
            reading.action,
            ep.mqttOptions
        );
    },

    security_zone(ep, base, reading) {
        // Security zone state (app 208): the binary_sensor state is ON for
        // unsealed/open/short and OFF for sealed; the raw 2-bit state name
        // goes to the JSON attributes topic so automations can distinguish
        // fault states (open/short) from a normal unsealed zone.
        //
        // `isolated` is extra context on the attributes topic only — an
        // isolated zone that is unsealed is still unsealed, so the state
        // topic's meaning is untouched. A reading with no zoneState is an
        // isolation-only update (the panel bypassed a zone without
        // reporting its state), which publishes attributes and nothing else.
        const hasZoneState = reading.zoneState !== null && reading.zoneState !== undefined;
        const isolated = reading.isolated === true;
        if (hasZoneState) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_STATE}`,
                reading.zoneState === 'sealed' ? MQTT_STATE_OFF : MQTT_STATE_ON,
                ep.mqttOptions
            );
        }
        const attributesPayload = hasZoneState
            ? (isolated ? SECURITY_ZONE_ISOLATED_ATTRIBUTES_PAYLOAD : SECURITY_ZONE_ATTRIBUTES_PAYLOAD)[reading.zoneState]
            : (isolated ? SECURITY_ZONE_ISOLATED_ONLY_PAYLOAD : SECURITY_ZONE_NO_ATTRIBUTES_PAYLOAD);
        if (attributesPayload) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_ATTRIBUTES}`,
                attributesPayload,
                ep.mqttOptions
            );
        }
    },

    security_panel(ep, base, reading) {
        // Panel-wide trouble condition (app 208): ON means the trouble is
        // present. `group` is the "panel/<condition>" path segment, so the
        // base already addresses the right topic.
        ep._publishIfNeeded(
            `${base}/${MQTT_TOPIC_SUFFIX_STATE}`,
            reading.active ? MQTT_STATE_ON : MQTT_STATE_OFF,
            ep.mqttOptions
        );
    },

    security_alarm(ep, base, reading) {
        // HA alarm_control_panel state (app 208): one of disarmed,
        // armed_home/away/night/vacation, arming, pending, triggered.
        // `group` is "panel", so the base is cbus/read/{net}/{app}/panel.
        // The blocking zone (arm_not_ready) rides the attributes topic and
        // is republished on every transition so it clears with the state.
        ep._publishIfNeeded(
            `${base}/${MQTT_TOPIC_SUFFIX_STATE}`,
            reading.alarmState,
            ep.mqttOptions
        );
        const attributes = reading.blockingZone ? { blocking_zone: reading.blockingZone } : {};
        ep._publishIfNeeded(
            `${base}/${MQTT_TOPIC_SUFFIX_ATTRIBUTES}`,
            JSON.stringify(attributes),
            ep.mqttOptions
        );
    },

    measurement(ep, base, reading) {
        // Measurement application (app 228): `group` is "{device}/{channel}",
        // so `base` already addresses cbus/read/{net}/{app}/{device}/{channel}.
        ep._publishIfNeeded(
            `${base}/${MQTT_TOPIC_SUFFIX_VALUE}`,
            String(reading.value),
            ep.mqttOptions
        );
        ep._publishIfNeeded(
            `${base}/${MQTT_TOPIC_SUFFIX_UNIT}`,
            reading.unit || '',
            ep.mqttOptions
        );
    }
};

class EventPublisher {
    /**
     * Creates a new EventPublisher instance.
     *
     * @param {Object}   options - Configuration options
     * @param {Object}   options.settings - Bridge settings containing PIR sensor config
     * @param {Function} options.publishFn - Direct MQTT publish function: (topic, payload, options) => void
     * @param {Object}   options.mqttOptions - MQTT publishing options (retain, qos, etc.)
     * @param {Object}   [options.labelLoader] - Optional LabelLoader for type override awareness
     * @param {Object}   [options.logger] - Optional logger instance
     * @param {Object}   [options.coverRampTracker] - Optional CoverRampTracker to cancel on real events
     * @param {Function} [options.onEventLog] - Optional callback receiving event-log entries for live streaming (SSE)
     */
    constructor(options) {
        this.settings = options.settings;
        this.publishFn = options.publishFn;
        this.mqttOptions = options.mqttOptions;
        // Trigger events must never be retained; prebuilt once (mqtt.js does
        // not mutate the options object) instead of spread per publish.
        this._triggerMqttOptions = Object.freeze({ ...this.mqttOptions, retain: false });
        this.labelLoader = options.labelLoader || null;
        this.coverRampTracker = options.coverRampTracker || null;
        this.onEventLog = options.onEventLog || null;
        this.eventPublishDedupWindowMs = clampSetting(this.settings.eventPublishDedupWindowMs, 0, 0);
        this.eventPublishDedupMaxEntries = clampSetting(this.settings.eventPublishDedupMaxEntries, 100, 5000);
        this.topicCacheMaxEntries = clampSetting(this.settings.topicCacheMaxEntries, 100, 5000);
        this.eventPublishCoalesce = this.settings.eventPublishCoalesce === true;
        this._recentPublishes = new Map();
        this._topicCache = new Map();
        this._coalesceBuffer = new Map();
        this._coalesceTimer = null;
        this._publishStats = {
            publishAttempts: 0,
            published: 0,
            dedupDropped: 0,
            dedupEvicted: 0,
            coalesced: 0,
            topicCacheHit: 0,
            topicCacheMiss: 0
        };
        
        this.logger = options.logger || createLogger({ 
            component: 'event-publisher', 
            level: this.settings.log_level || (this.settings.logging ? 'info' : 'warn'),
            enabled: true 
        });
    }

    /**
     * Publishes a C-Bus event to MQTT topics for Home Assistant and other consumers.
     * 
     * Publishes directly to MQTT without throttling -- QoS 0 publishes are
     * near-instant TCP buffer writes handled asynchronously by the mqtt library.
     * 
     * @param {import('./cbusEvent')} event - Parsed C-Bus event to publish
     * @param {string} [source=''] - Source identifier for logging (e.g., '(Evt)', '(Cmd)')
     */
    publishEvent(event, source = '') {
        if (!event || !event.isValid()) {
            return;
        }

        const network = event.getNetwork();
        const application = event.getApplication();
        const group = event.getGroup();
        const action = event.getAction();
        const rawLevel = event.getLevel();
        const actionIsOn = action === CGATE_CMD_ON.toLowerCase();

        // Specialised application decoders (e.g. Temperature Broadcast, app 25)
        // attach a structured reading to the event. Publish it to the dedicated
        // reading topic and skip the lighting/state path entirely.
        const reading = /** @type {{kind?: string}|null} */ (event.getReading && event.getReading());
        if (reading) {
            if (this.logger.isLevelEnabled && this.logger.isLevelEnabled('debug')) {
                this.logger.debug(`C-Bus Reading ${source}: ${network}/${application}/${group} ${reading.kind}`);
            }
            this.publishReading(network, application, group, reading);
            return;
        }

        const topics = this._getTopicsForAddress(network, application, group);

        // The event's origin unit (#sourceunit metadata) — which C-Bus unit
        // changed the group. Lets automations react to physical switch presses
        // and distinguish them from bridge/CNI-originated writes (issue #35).
        const sourceUnit = event.getSourceUnit && event.getSourceUnit();
        if (sourceUnit !== null && sourceUnit !== undefined) {
            this._publishIfNeeded(
                `${MQTT_TOPIC_PREFIX_READ}/${network}/${application}/${group}/${MQTT_TOPIC_SUFFIX_SOURCE_UNIT}`,
                sourceUnit,
                this.mqttOptions
            );
        }
        const isPirSensor = application === this.settings.ha_discovery_pir_app_id;
        const isTrigger = application === this.settings.ha_discovery_trigger_app_id;
        const isCoverApp = application === this.settings.ha_discovery_cover_app_id;
        const isCoverOverride = this._isTypeOverride(network, application, group, 'cover');
        const isCover = isCoverApp || isCoverOverride;

        // Cancel any active interpolated ramp for this cover address so the real
        // C-Gate event value takes over immediately without further estimated updates.
        if (isCover && this.coverRampTracker) {
            this.coverRampTracker.cancelRamp(`${network}/${application}/${group}`);
        }
        const isHvac = this.settings.ha_discovery_hvac_app_id &&
            application === String(this.settings.ha_discovery_hvac_app_id);
        const isTiltApp = this.settings.ha_discovery_cover_tilt_app_id &&
            application === String(this.settings.ha_discovery_cover_tilt_app_id);
        
        // Calculate level percentage for Home Assistant.
        // Math.round is intentional: HA expects integer 0-100. This means two adjacent
        // C-Bus levels can map to the same percentage (e.g. 127 and 128 both → 50).
        const levelPercent = rawLevel !== null
            ? Math.round(rawLevel / CGATE_LEVEL_MAX * 100)
            : (actionIsOn ? 100 : 0);

        let state;
        if (isPirSensor) {
            // PIR sensors: state based on action (motion detected/cleared)
            state = actionIsOn ? MQTT_STATE_ON : MQTT_STATE_OFF;
        } else {
            // Covers and lighting: state based on raw level, not quantized
            // percent — rawLevel 1-2 rounds to 0% but the device IS on/open.
            state = rawLevel !== null
                ? ((rawLevel > 0) ? MQTT_STATE_ON : MQTT_STATE_OFF)
                : (actionIsOn ? MQTT_STATE_ON : MQTT_STATE_OFF);
        }
       
        // Emit event log entry for live event stream (before any early returns)
        if (this.onEventLog) {
            const action = event.getAction();
            let eventType = 'update';
            if (action === 'ramp') eventType = 'ramp';
            else if (action === 'on') eventType = 'on';
            else if (action === 'off') eventType = 'off';
            this.onEventLog({
                ts: Date.now(),
                network: network,
                app: application,
                group: group,
                level: rawLevel !== null ? rawLevel : (actionIsOn ? 255 : 0),
                type: eventType
            });
        }

        // Trigger groups publish as HA event entities - never retain
        if (isTrigger) {
            const eventPayload = rawLevel !== null
                ? JSON.stringify({ event_type: 'trigger', level: rawLevel })
                : JSON.stringify({ event_type: 'trigger' });

            if (this.logger.isLevelEnabled && this.logger.isLevelEnabled('debug')) {
                this.logger.debug(`C-Bus Trigger ${source}: ${network}/${application}/${group}` + (rawLevel !== null ? ` level=${rawLevel}` : ''));
            }

            // Trigger events must not be retained - always publish with retain: false
            this._publishIfNeeded(
                topics.event,
                eventPayload,
                this._triggerMqttOptions
            );
            return;
        }

        // HVAC groups publish temperature/mode to dedicated climate topics
        if (isHvac) {
            this._publishHvacEvent(network, application, group, rawLevel, action, source);
            return;
        }

        // Tilt app groups publish tilt angle to the tilt topic only (0-100%)
        if (isTiltApp) {
            const tiltPercent = rawLevel !== null
                ? Math.round(rawLevel / CGATE_LEVEL_MAX * 100)
                : (actionIsOn ? 100 : 0);

            if (this.logger.isLevelEnabled && this.logger.isLevelEnabled('debug')) {
                this.logger.debug(`C-Bus Tilt ${source}: ${network}/${application}/${group} ${tiltPercent}%`);
            }

            this._publishIfNeeded(
                `${MQTT_TOPIC_PREFIX_READ}/${network}/${application}/${group}/${MQTT_TOPIC_SUFFIX_TILT}`,
                tiltPercent.toString(),
                this.mqttOptions
            );
            return;
        }

        if (this.logger.isLevelEnabled && this.logger.isLevelEnabled('debug')) {
            this.logger.debug(`C-Bus Status ${source}: ${network}/${application}/${group} ${state}` + (isPirSensor ? '' : ` (${levelPercent}%)`));
        }

        // Publish state message directly (no throttle)
        this._publishIfNeeded(
            topics.state,
            state,
            this.mqttOptions
        );

        // Publish level/position message for non-PIR sensors
        if (!isPirSensor) {
            this._publishIfNeeded(
                topics.level,
                levelPercent.toString(),
                this.mqttOptions
            );

            // Also publish position for covers (same value, different topic for HA cover entity)
            if (isCover) {
                this._publishIfNeeded(
                    topics.position,
                    levelPercent.toString(),
                    this.mqttOptions
                );
            }
        }
    }

    /**
     * Publishes a structured reading produced by a specialised application
     * decoder (e.g. Air Conditioning). Routes by reading.kind:
     *
     *   temperature → cbus/read/{net}/{app}/{group}/current_temperature (if celsius non-null)
     *               → cbus/read/{net}/{app}/{group}/sensor_status + sensor_problem (if decoded)
     *   mode        → cbus/read/{net}/{app}/{group}/mode  (if mode non-null)
     *               → cbus/read/{net}/{app}/{group}/setpoint (if setpoint non-null)
     *               → cbus/read/{net}/{app}/{group}/fan_mode + fan_speed (if aux level decoded)
     *   state       → cbus/read/{net}/{app}/{group}/state  ('ON'|'OFF')
     *   action      → cbus/read/{net}/{app}/{group}/action + problem
     *               → cbus/read/{net}/{app}/{group}/error + error_description (if error code decoded)
     *               → cbus/read/{net}/{app}/{group}/damper|busy|expansion (§25.6.6 bits, if decoded)
     *               → cbus/read/{net}/{app}/{group}/plant_type + plant_type_description (§25.6.4)
     *   humidity       → cbus/read/{net}/{app}/{group}/current_humidity (if non-null)
     *   humidity_mode  → cbus/read/{net}/{app}/{group}/humidity_mode + humidity_setpoint
     *   humidity_action → cbus/read/{net}/{app}/{group}/humidity_action
     *   security_zone  → cbus/read/{net}/{app}/{zone}/state (ON for unsealed/open/short)
     *                  → cbus/read/{net}/{app}/{zone}/attributes (raw 2-bit state
     *                    name, plus `isolated` while the panel has the zone bypassed)
     *   measurement    → cbus/read/{net}/{app}/{device}/{channel}/value (decoded number)
     *                  → cbus/read/{net}/{app}/{device}/{channel}/unit (unit string, '' if none)
     *   clock          → cbus/read/{net}/{app}/clock/date ('YYYY-MM-DD') or
     *                    cbus/read/{net}/{app}/clock/time ('HH:MM:SS'), whichever
     *                    the broadcast carried — the two arrive separately
     */
    publishReading(network, application, group, reading) {
        if (!reading) return;

        const base = `${MQTT_TOPIC_PREFIX_READ}/${network}/${application}/${group}`;
        const handler = READING_KIND_HANDLERS[reading.kind];
        if (handler) {
            handler(this, base, reading);
        }
    }

    /**
     * Publish a decoded boolean flag as an ON/OFF binary state, or publish
     * nothing at all when the decoder didn't produce the field.
     *
     * The absent case matters: the flag topics are retained, so emitting OFF for
     * a field a reading never carried would assert "this is off" about something
     * we simply don't know, and would then stick in the broker.
     *
     * @param {*} value - Decoded flag; only true/false publish.
     * @param {string} topic - Full topic to publish to.
     * @private
     */
    _publishBooleanIfPresent(value, topic) {
        if (value === null || value === undefined) return;
        this._publishIfNeeded(topic, value ? MQTT_STATE_ON : MQTT_STATE_OFF, this.mqttOptions);
    }

    /**
     * Publish HVAC events to climate-specific MQTT topics.
     *
     * When C-Gate reports a level change on an HVAC group address, we interpret it
     * as both a current temperature reading and a setpoint update (the C-Bus HVAC
     * thermostat reports both via the same group address in most implementations).
     *
     * Mode is not updated by standard level events — mode changes require separate
     * C-Gate events that are not yet captured in this implementation.
     *
     * TODO: Hardware validation required for mode detection. If the hardware reports
     * mode changes on a separate group address, this will need extending.
     *
     * @param {string} network - C-Bus network number
     * @param {string} application - C-Bus application number
     * @param {string} group - C-Bus group number
     * @param {number|null} rawLevel - C-Bus level value (0-255), or null if not present
     * @param {string} action - C-Gate action ('on', 'off', 'ramp', etc.)
     * @param {string} source - Source identifier for logging
     * @private
     */
    _publishHvacEvent(network, application, group, rawLevel, action, source) {
        const readBase = `${MQTT_TOPIC_PREFIX_READ}/${network}/${application}/${group}`;

        if (rawLevel !== null) {
            // HVAC-via-lighting temperature encoding: level / 2 across a
            // 0-50C range at 0.5C resolution (level 0 = 0.0C, 100 = 50.0C).
            const tempCelsius = cbusLevelToTemperature(rawLevel);
            const tempStr = tempCelsius.toFixed(1);

            if (this.logger.isLevelEnabled && this.logger.isLevelEnabled('debug')) {
                this.logger.debug(`C-Bus HVAC ${source}: ${network}/${application}/${group} level=${rawLevel} temp=${tempStr}°C`);
            }

            this._publishIfNeeded(
                `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_CURRENT_TEMP}`,
                tempStr,
                this.mqttOptions
            );

            // Same value — C-Bus level represents the controlled setpoint.
            this._publishIfNeeded(
                `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_SETPOINT}`,
                tempStr,
                this.mqttOptions
            );
        }

        // Publish mode based on action only. C-Gate sends explicit 'off' action when
        // the HVAC unit is turned off. rawLevel=0 is NOT used because it maps to 0°C
        // setpoint, which is a valid (if unusual) temperature, not an off state.
        // off/auto is all this path can ever report, which is why discovery advertises
        // only those two — see _createHvacDiscovery. Anything richer needs the native
        // Air Conditioning application (cbus_aircon_app_id).
        // TODO: Hardware validation — real HVAC units may report heat/cool/fan_only via
        // dedicated group addresses or extended C-Gate event fields not yet handled here.
        const mode = (action === 'off') ? 'off' : 'auto';
        this._publishIfNeeded(
            `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_MODE}`,
            mode,
            this.mqttOptions
        );
    }

    /**
     * Checks whether the event's group has a type override matching the given type.
     * Falls back to false when no labelLoader is configured.
     */
    _isTypeOverride(network, application, group, type) {
        if (!this.labelLoader) return false;
        const typeOverrides = this.labelLoader.getTypeOverrides();
        if (!typeOverrides) return false;
        const labelKey = `${network}/${application}/${group}`;
        return typeOverrides.get(labelKey) === type;
    }

    _publishIfNeeded(topic, payload, options) {
        this._publishStats.publishAttempts += 1;
        if (this.eventPublishCoalesce) {
            const hadExisting = this._coalesceBuffer.has(topic);
            this._coalesceBuffer.set(topic, { payload, options });
            if (hadExisting) {
                this._publishStats.coalesced += 1;
            }
            this._scheduleCoalesceFlush();
            return;
        }

        this._publishNow(topic, payload, options);
    }

    _publishNow(topic, payload, options) {
        if (!this.eventPublishDedupWindowMs) {
            this.publishFn(topic, payload, options);
            this._publishStats.published += 1;
            return;
        }

        const now = Date.now();
        const previous = this._recentPublishes.get(topic);
        if (previous && previous.payload === payload && (now - previous.atMs) <= this.eventPublishDedupWindowMs) {
            this._publishStats.dedupDropped += 1;
            return;
        }

        this._recentPublishes.set(topic, { payload, atMs: now });
        this._pruneDedupCache(now);
        this.publishFn(topic, payload, options);
        this._publishStats.published += 1;
    }

    _scheduleCoalesceFlush() {
        if (this._coalesceTimer) return;
        this._coalesceTimer = setImmediate(() => {
            this._coalesceTimer = null;
            this._flushCoalesceBuffer();
        });
    }

    _flushCoalesceBuffer() {
        if (this._coalesceBuffer.size === 0) {
            return;
        }
        const entries = [...this._coalesceBuffer.entries()];
        this._coalesceBuffer.clear();
        for (const [topic, value] of entries) {
            this._publishNow(topic, value.payload, value.options);
        }
    }

    _getTopicsForAddress(network, application, group) {
        const key = `${network}/${application}/${group}`;
        const cached = this._topicCache.get(key);
        if (cached) {
            this._publishStats.topicCacheHit += 1;
            return cached;
        }

        const topicBase = `${MQTT_TOPIC_PREFIX_READ}/${key}`;
        const topics = {
            state: `${topicBase}/${MQTT_TOPIC_SUFFIX_STATE}`,
            level: `${topicBase}/${MQTT_TOPIC_SUFFIX_LEVEL}`,
            position: `${topicBase}/${MQTT_TOPIC_SUFFIX_POSITION}`,
            event: `${topicBase}/${MQTT_TOPIC_SUFFIX_EVENT}`
        };

        if (this._topicCache.size >= this.topicCacheMaxEntries) {
            evictOldestFifo(this._topicCache);
        }
        this._topicCache.set(key, topics);
        this._publishStats.topicCacheMiss += 1;
        return topics;
    }

    _pruneDedupCache(now) {
        if (this._recentPublishes.size <= this.eventPublishDedupMaxEntries) {
            return;
        }

        // First pass: remove expired entries.
        const expiryCutoff = now - this.eventPublishDedupWindowMs;
        for (const [key, value] of this._recentPublishes) {
            if (value.atMs < expiryCutoff) {
                this._recentPublishes.delete(key);
                this._publishStats.dedupEvicted += 1;
            }
        }

        // Second pass: enforce max size by oldest insertion order.
        while (this._recentPublishes.size > this.eventPublishDedupMaxEntries) {
            const oldestKey = evictOldestFifo(this._recentPublishes);
            if (oldestKey === undefined) break;
            this._publishStats.dedupEvicted += 1;
        }
    }

    shutdown() {
        if (this._coalesceTimer) {
            clearImmediate(this._coalesceTimer);
            this._coalesceTimer = null;
        }
        this._coalesceBuffer.clear();
        this._recentPublishes.clear();
        this._topicCache.clear();
    }

    getStats() {
        return {
            ...this._publishStats,
            dedupWindowMs: this.eventPublishDedupWindowMs,
            dedupCacheSize: this._recentPublishes.size,
            topicCacheSize: this._topicCache.size,
            coalesceEnabled: this.eventPublishCoalesce,
            coalesceBufferSize: this._coalesceBuffer.size
        };
    }
}

module.exports = EventPublisher;
