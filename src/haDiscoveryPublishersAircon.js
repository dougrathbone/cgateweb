// @ts-check
const {
    MQTT_TOPIC_SUFFIX_HVAC_CURRENT_TEMP,
    MQTT_TOPIC_SUFFIX_HVAC_SETPOINT,
    MQTT_TOPIC_SUFFIX_HVAC_MODE,
    MQTT_TOPIC_SUFFIX_HVAC_FAN_MODE,
    MQTT_TOPIC_SUFFIX_HVAC_ACTION,
    MQTT_TOPIC_SUFFIX_HVAC_CURRENT_HUMIDITY,
    MQTT_TOPIC_SUFFIX_HVAC_HUMIDITY_SETPOINT,
    MQTT_TOPIC_SUFFIX_HVAC_PROBLEM,
    MQTT_TOPIC_SUFFIX_HVAC_SENSOR_PROBLEM,
    MQTT_TOPIC_SUFFIX_HVAC_SENSOR_STATUS,
    MQTT_TOPIC_SUFFIX_HVAC_ERROR_DESCRIPTION,
    MQTT_TOPIC_SUFFIX_HVAC_FAN_SPEED,
    MQTT_TOPIC_SUFFIX_HVAC_FAN_SPEED_PCT,
    MQTT_TOPIC_SUFFIX_HVAC_COMFORT_LEVEL,
    MQTT_TOPIC_SUFFIX_HVAC_HUMIDITY_MODE,
    MQTT_TOPIC_SUFFIX_HVAC_HUMIDITY_ACTION,
    MQTT_TOPIC_SUFFIX_HVAC_DAMPER,
    MQTT_TOPIC_SUFFIX_HVAC_BUSY,
    MQTT_TOPIC_SUFFIX_HVAC_PLANT_TYPE_DESCRIPTION,
    HVAC_MIN_TEMP_C,
    HVAC_MAX_TEMP_C,
    MQTT_CMD_TYPE_HVAC_SETPOINT,
    MQTT_CMD_TYPE_HVAC_MODE,
    MQTT_CMD_TYPE_HVAC_FAN_MODE,
    MQTT_STATE_ON,
    MQTT_STATE_OFF,
    HA_COMPONENT_CLIMATE,
    HA_COMPONENT_SENSOR,
    HA_COMPONENT_BINARY_SENSOR,
    HA_DISCOVERY_SUFFIX
} = require('./constants');
const { resolveSetting } = require('./config/schema');

const NATIVE_AIRCON_MODEL = 'C-Bus Air Conditioning Thermostat';

/**
 * Companion binary_sensors published on the native aircon thermostat's device,
 * next to its climate entity. Every one of these is fed by a topic the aircon
 * decoder already publishes; without an entity here a user has to hand-write
 * MQTT YAML to see any of it.
 *
 * `entityCategory` is deliberately per-entry rather than blanket 'diagnostic':
 * the two problem sensors shipped without it and moving them into HA's
 * diagnostic section now would pull them out of dashboards people have already
 * built. New entities start where they belong.
 */
const NATIVE_AIRCON_BINARY_SENSORS = [
    {
        suffix: 'problem',
        name: 'Plant problem',
        topicSuffix: MQTT_TOPIC_SUFFIX_HVAC_PROBLEM,
        deviceClass: 'problem'
    },
    {
        suffix: 'sensor_problem',
        name: 'Temperature sensor problem',
        topicSuffix: MQTT_TOPIC_SUFFIX_HVAC_SENSOR_PROBLEM,
        deviceClass: 'problem'
    },
    {
        // Spec §25.6.6 bit 3 is literally "Damper State: Closed / Open", which
        // is exactly what HA's generic 'opening' class renders — so the class is
        // read off the spec, not guessed at from the entity's name.
        suffix: 'damper',
        name: 'Damper',
        topicSuffix: MQTT_TOPIC_SUFFIX_HVAC_DAMPER,
        deviceClass: 'opening',
        entityCategory: 'diagnostic'
    },
    {
        // No device_class. The closest candidate is 'running', but §25.6.6 bit 5
        // is "Busy", not "running" — the plant reports Busy while it settles,
        // and what is actually running is already on hvac_action. Labelling it
        // 'running' would contradict the climate entity whenever the two differ.
        suffix: 'busy',
        name: 'Plant busy',
        topicSuffix: MQTT_TOPIC_SUFFIX_HVAC_BUSY,
        entityCategory: 'diagnostic'
    }
];

/**
 * Companion diagnostic sensors on the same thermostat device. All are readouts
 * rather than controls, so all are entity_category 'diagnostic' and stay off
 * auto-generated dashboards.
 *
 * Several are plant-dependent (fan speed needs an Aux Level, comfort level
 * needs evaporative plant, the humidity pair needs humidity plant). Those show
 * as unknown on installs whose plant never broadcasts them — which is the same
 * bargain the security panel's trouble sensors already make, and the honest one:
 * discovery happens the first time a thermostat is seen, long before we know
 * which optional verbs it will ever send.
 */
const NATIVE_AIRCON_SENSORS = [
    {
        suffix: 'plant_type',
        name: 'Plant type',
        topicSuffix: MQTT_TOPIC_SUFFIX_HVAC_PLANT_TYPE_DESCRIPTION
    },
    {
        // The description, not the raw code: 'Filter replacement required' is
        // what makes this worth an entity. The numeric code stays on its own
        // topic for automations that want to match on it.
        suffix: 'error',
        name: 'Plant error',
        topicSuffix: MQTT_TOPIC_SUFFIX_HVAC_ERROR_DESCRIPTION
    },
    {
        // Severity behind the sensor_problem binary_sensor (§25.6.12: 0 ok,
        // 1 relaxed accuracy, 2 out of calibration, 3 total failure) — "needs
        // recalibrating" and "dead" are different service calls.
        suffix: 'sensor_status',
        name: 'Temperature sensor status',
        topicSuffix: MQTT_TOPIC_SUFFIX_HVAC_SENSOR_STATUS
    },
    {
        // Raw 0-63 Aux Level fan speed (§25.6.11), 0 = plant default. No unit:
        // the numbering is plant-dependent and the plant's own speed table is
        // Toolkit configuration that never reaches the bus.
        suffix: 'fan_speed',
        name: 'Fan speed setting',
        topicSuffix: MQTT_TOPIC_SUFFIX_HVAC_FAN_SPEED
    },
    {
        // Fan output as a fraction of plant capacity (§25.12.8). '%' with no
        // device_class, for the reason measurementDecoder gives for unit $1A:
        // a percentage is not necessarily a humidity, and HA has no percentage
        // class that means "of capacity".
        suffix: 'fan_speed_pct',
        name: 'Fan output',
        topicSuffix: MQTT_TOPIC_SUFFIX_HVAC_FAN_SPEED_PCT,
        unit: '%',
        stateClass: 'measurement'
    },
    {
        // What an evaporative plant's wall panel actually displays (§25.12.7);
        // its "temperature" is meaningless in that mode.
        suffix: 'comfort_level',
        name: 'Comfort level',
        topicSuffix: MQTT_TOPIC_SUFFIX_HVAC_COMFORT_LEVEL
    },
    {
        suffix: 'humidity_mode',
        name: 'Humidity mode',
        topicSuffix: MQTT_TOPIC_SUFFIX_HVAC_HUMIDITY_MODE
    },
    {
        // Target humidity is a diagnostic readout, not a climate control: HA
        // rejects target_humidity_state_topic unless a matching command topic
        // is also set, and humidity writes are not implemented.
        suffix: 'humidity_setpoint',
        name: 'Humidity setpoint',
        topicSuffix: MQTT_TOPIC_SUFFIX_HVAC_HUMIDITY_SETPOINT,
        unit: '%',
        stateClass: 'measurement'
    },
    {
        // The humidity counterpart of hvac_action. The climate entity carries
        // current humidity but has no humidity equivalent of action_topic.
        suffix: 'humidity_action',
        name: 'Humidity action',
        topicSuffix: MQTT_TOPIC_SUFFIX_HVAC_HUMIDITY_ACTION
    }
];

class _HaDiscoveryPublishersAircon {
    // Host-provided instance state. This class is never instantiated: its
    // prototype methods are copied onto HaDiscovery (see the Object.assign in
    // haDiscovery.js), which supplies every member declared below. The field
    // declarations exist purely so @ts-check can resolve them; they never run.

    /** @type {ReturnType<typeof import('./logger').createLogger>} */
    logger;

    /** @type {Object} */
    settings;

    /** @type {Set<string>} */
    exclude;

    /** @type {Set<string>} */
    _nativeAirconSeen;

    /**
     * Per-run label data snapshot (implemented on HaDiscovery / publishers).
     * @type {{ labelMap: Map<string, string>, typeOverrides: Map<string, string>, entityIds: Map<string, string>, exclude: Set<string>, areas: Map<string, string> } | null}
     */
    _labelSnapshot;

    /**
     * Shared event-driven discovery gate (implemented in haDiscoveryPublishers).
     * @type {(spec: Object) => boolean}
     */
    _ensureEventDrivenEntity;

    /**
     * Retract one event-driven discovery config (implemented in haDiscoveryPublishers).
     * @type {(topic: string) => void}
     */
    _retractEventDrivenConfig;

    /**
     * Shared identity preamble (implemented in haDiscoveryPublishers).
     * @type {(spec: Object) => { finalLabel: string, uniqueId: string, entityId: string|undefined, area: string|undefined, discoveryTopic: string }}
     */
    _resolveEntityIdentity;

    /**
     * Finish an event-driven discovery entity (implemented in haDiscoveryPublishers).
     * @type {(spec: Object) => void}
     */
    _finishEventDrivenEntity;

    /**
     * Finish a tree-driven discovery entity (implemented in haDiscoveryPublishers).
     * @type {(spec: Object) => void}
     */
    _finishTreeEntity;

    /**
     * Read/write topic bases (implemented in haDiscoveryPublishers).
     * @type {(networkId: string|number, appId: string|number, address: string|number) => { readBase: string, writeBase: string }}
     */
    _topicBases;

    /**
     * Temperature unit for climate entities. Defaults to Celsius; only 'F'
     * (case-insensitive) selects Fahrenheit.
     * @returns {'C'|'F'}
     * @private
     */
    _hvacTemperatureUnit() {
        return resolveSetting(this.settings, 'ha_hvac_temperature_unit').toUpperCase() === 'F' ? 'F' : 'C';
    }

    /**
     * Shared climate range fields for both lighting-HVAC and native aircon.
     * Modes and command topics stay per-path — they are not interchangeable.
     * @private
     */
    _climateRangeFields() {
        return {
            temperature_unit: this._hvacTemperatureUnit(),
            min_temp: HVAC_MIN_TEMP_C,
            max_temp: HVAC_MAX_TEMP_C,
            temp_step: 0.5
        };
    }

    /**
     * Event-driven discovery for native C-Bus Air Conditioning (172) thermostats.
     * Called whenever an aircon reading with a source unit is decoded; publishes
     * the thermostat's HA climate entity the first time that unit is seen.
     *
     * Distinct from {@link _createHvacDiscovery} (the HVAC-via-lighting pattern):
     * here entities are keyed by **source unit** to match the native decoder's
     * topics (cbus/read/{net}/172/{sourceUnit}/…), and there is no TREEXML group
     * to enumerate from — thermostats announce themselves on the bus.
     *
     * @param {string} network
     * @param {string|number} appId      - aircon app id (e.g. 172)
     * @param {string|number} sourceUnit - thermostat unit address (e.g. 201)
     * @returns {boolean} true if a new climate entity was published this call
     */
    ensureNativeAirconDiscovery(network, appId, sourceUnit) {
        if (!this.settings.ha_discovery_enabled) return false;
        if (appId === null || appId === undefined || sourceUnit === null || sourceUnit === undefined) return false;

        const key = `${network}/${appId}/${sourceUnit}`;
        return this._ensureEventDrivenEntity({
            key,
            seen: this._nativeAirconSeen,
            describe: `native HVAC unit ${key}`,
            // Clear any entities published on an earlier run (climate + every
            // companion entity) so they disappear from HA once the user excludes
            // it (e.g. a PAC/controller mirroring the real thermostats).
            retract: () => {
                for (const topic of this._nativeAirconDiscoveryTopics(network, appId, sourceUnit)) {
                    this._retractEventDrivenConfig(topic);
                }
            },
            create: () => this._createNativeAirconDiscovery(String(network), String(appId), String(sourceUnit))
        });
    }

    /**
     * Build and publish the climate discovery payload for one native AC thermostat.
     *
     * State topics (current temperature, setpoint, mode, running action) are
     * always wired. Command topics (set temperature/mode) are added only when
     * cbus_aircon_control_enabled — control writes to live heating, so it is
     * opt-in. The router turns those into AIRCON SET_ZONE_HVAC_MODE / SET_WARD_*
     * commands (see mqttCommandRouter / airconControlRegistry).
     *
     * @private
     */
    _createNativeAirconDiscovery(networkId, appId, sourceUnit) {
        const labelKey = `${networkId}/${appId}/${sourceUnit}`;
        const { finalLabel, uniqueId, entityId, area, discoveryTopic } = this._resolveEntityIdentity({
            networkId, appId, groupId: sourceUnit, labelKey,
            component: HA_COMPONENT_CLIMATE,
            fallbackLabel: `CBus HVAC ${networkId}/${appId}/${sourceUnit}`
        });
        const { readBase, writeBase } = this._topicBases(networkId, appId, sourceUnit);
        const controlEnabled = !!this.settings.cbus_aircon_control_enabled;

        this._finishEventDrivenEntity({
            discoveryTopic, uniqueId, entityId,
            component: HA_COMPONENT_CLIMATE,
            fields: {
                // State topics published by the native aircon decoder.
                current_temperature_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_CURRENT_TEMP}`,
                temperature_state_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_SETPOINT}`,
                mode_state_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_MODE}`,
                action_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_ACTION}`,
                // Current humidity only. HA requires a command topic whenever
                // target_humidity_state_topic is set, and humidity writes are
                // not implemented, so the setpoint is a companion sensor.
                current_humidity_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_CURRENT_HUMIDITY}`,
                // Fan mode from the Aux Level (spec §25.6.11 bit 6). HA accepts an
                // arbitrary fan_modes list; the C-Bus values are automatic/continuous.
                // (Raw 0-63 fan speed still has no HA climate equivalent, so it stays
                // off this entity — it gets its own diagnostic sensor instead, see
                // NATIVE_AIRCON_SENSORS.)
                fan_mode_state_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_FAN_MODE}`,
                fan_modes: ['automatic', 'continuous'],

                // Command topics — only when control is opt-in enabled.
                // Distinct from lighting-HVAC: native AC uses aircon write verbs.
                ...(controlEnabled && {
                    temperature_command_topic: `${writeBase}/${MQTT_CMD_TYPE_HVAC_SETPOINT}`,
                    mode_command_topic: `${writeBase}/${MQTT_CMD_TYPE_HVAC_MODE}`,
                    fan_mode_command_topic: `${writeBase}/${MQTT_CMD_TYPE_HVAC_FAN_MODE}`
                }),

                // Verified against real hardware (captures 2026-06-11).
                modes: ['off', 'heat', 'cool', 'auto', 'fan_only'],

                ...this._climateRangeFields()
            },
            deviceIdentifiers: [uniqueId],
            deviceName: finalLabel,
            model: NATIVE_AIRCON_MODEL,
            area,
            logInfo: `Native HVAC climate entity published: ${labelKey} (${finalLabel})`
        });

        this._createNativeAirconCompanionEntities(uniqueId, finalLabel, area, readBase);
    }

    /**
     * All discovery config topics belonging to one native AC thermostat
     * (climate + every companion entity) — used by the exclude path to retract
     * every entity for the unit.
     *
     * Derived from the same two tables the creator publishes from, so a new
     * companion entity cannot be added and then left behind, still retained in
     * the broker, when its thermostat is excluded.
     * @private
     */
    _nativeAirconDiscoveryTopics(network, appId, sourceUnit) {
        const base = `cgateweb_${network}_${appId}_${sourceUnit}`;
        const prefix = this.settings.ha_discovery_prefix;
        return [
            `${prefix}/${HA_COMPONENT_CLIMATE}/${base}/${HA_DISCOVERY_SUFFIX}`,
            ...NATIVE_AIRCON_BINARY_SENSORS.map(def =>
                `${prefix}/${HA_COMPONENT_BINARY_SENSOR}/${base}_${def.suffix}/${HA_DISCOVERY_SUFFIX}`),
            ...NATIVE_AIRCON_SENSORS.map(def =>
                `${prefix}/${HA_COMPONENT_SENSOR}/${base}_${def.suffix}/${HA_DISCOVERY_SUFFIX}`)
        ];
    }

    /**
     * Publish the companion entities for one native AC thermostat: the plant
     * and sensor problem binary_sensors, the remaining §25.6.6 status bits, and
     * the diagnostic sensors for plant type, error detail, sensor status, fan
     * speed, comfort level and humidity. All attach to the thermostat's own
     * device (same identifiers as its climate entity, so HA groups them under
     * the one thermostat) and all are read-only — published regardless of
     * cbus_aircon_control_enabled, because none of them can be written.
     *
     * See NATIVE_AIRCON_BINARY_SENSORS / NATIVE_AIRCON_SENSORS for what each
     * one is and why it carries the device_class and category it does.
     * @private
     */
    _createNativeAirconCompanionEntities(uniqueId, finalLabel, area, readBase) {
        const deviceIdentifiers = [uniqueId];
        const deviceName = finalLabel;

        for (const def of NATIVE_AIRCON_BINARY_SENSORS) {
            const sensorUniqueId = `${uniqueId}_${def.suffix}`;
            this._finishEventDrivenEntity({
                discoveryTopic: `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_BINARY_SENSOR}/${sensorUniqueId}/${HA_DISCOVERY_SUFFIX}`,
                uniqueId: sensorUniqueId,
                component: HA_COMPONENT_BINARY_SENSOR,
                name: def.name,
                fields: {
                    ...(def.deviceClass && { device_class: def.deviceClass }),
                    ...(def.entityCategory && { entity_category: def.entityCategory }),
                    state_topic: `${readBase}/${def.topicSuffix}`,
                    payload_on: MQTT_STATE_ON,
                    payload_off: MQTT_STATE_OFF
                },
                deviceIdentifiers,
                deviceName,
                model: NATIVE_AIRCON_MODEL,
                area
            });
        }

        for (const def of NATIVE_AIRCON_SENSORS) {
            const sensorUniqueId = `${uniqueId}_${def.suffix}`;
            this._finishEventDrivenEntity({
                discoveryTopic: `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_SENSOR}/${sensorUniqueId}/${HA_DISCOVERY_SUFFIX}`,
                uniqueId: sensorUniqueId,
                component: HA_COMPONENT_SENSOR,
                name: def.name,
                fields: {
                    entity_category: 'diagnostic',
                    state_topic: `${readBase}/${def.topicSuffix}`,
                    ...(def.unit && { unit_of_measurement: def.unit }),
                    ...(def.stateClass && { state_class: def.stateClass })
                },
                deviceIdentifiers,
                deviceName,
                model: NATIVE_AIRCON_MODEL,
                area
            });
        }
    }

    /**
     * Publish a Home Assistant climate entity discovery payload for an HVAC group.
     *
     * HVAC-via-lighting protocol notes (configured via ha_discovery_hvac_app_id):
     *   This drives a lighting-compatible group, NOT the native C-Bus Air
     *   Conditioning application (172) — C-Gate exposes no lighting-style verb for
     *   that app. The pattern relies on a PAC/touchscreen mirroring HVAC control
     *   onto a lighting group. (Native read-only AC temperature is separate; see
     *   cbus_aircon_app_id.)
     *   - Each HVAC zone maps to one C-Bus group address.
     *   - Level 0-255 is used for the temperature setpoint (0.5°C resolution, 0-50°C range):
     *       raw_value = round(temperature_celsius * 2)  →  0°C = 0, 25°C = 50, 50°C = 100
     *   - The current temperature is reported back via the same group address as a status level.
     *   - Only off/auto are offered as modes, and fan control is not offered at all. A single
     *     lighting group carries one level and nothing else, so heat/cool/fan_only would need
     *     extra per-zone group addresses that ha_discovery_hvac_app_id cannot describe and that
     *     C-Bus never broadcasts back. Installations that need genuine mode control should use
     *     the native Air Conditioning application (cbus_aircon_app_id), which models it properly.
     *
     * TODO: Hardware validation required. The temperature encoding formula above is based on
     * community reports and the C-Bus HVAC thermostat (5000CT2) documentation. Actual
     * devices may use different group address layouts or encoding. Test against real hardware
     * before relying on setpoint commands.
     *
     * @private
     */
    _createHvacDiscovery(networkId, appId, groupId, groupLabel) {
        const { exclude } = this._labelSnapshot;
        const labelKey = `${networkId}/${appId}/${groupId}`;

        if (exclude.has(labelKey)) {
            this.logger.debug(`Excluding HVAC group ${labelKey} from discovery`);
            return;
        }

        const { finalLabel, uniqueId, entityId, area, discoveryTopic } = this._resolveEntityIdentity({
            networkId, appId, groupId, labelKey,
            component: HA_COMPONENT_CLIMATE,
            fallbackLabel: `CBus HVAC Zone ${networkId}/${appId}/${groupId}`,
            groupLabel,
            labels: this._labelSnapshot
        });

        const { readBase, writeBase } = this._topicBases(networkId, appId, groupId);

        // command topics must NOT be retained (see _createDiscovery note)
        this._finishTreeEntity({
            discoveryTopic, uniqueId, entityId,
            component: HA_COMPONENT_CLIMATE,
            fields: {
                // Current temperature: reported by C-Gate as a status level on this group.
                // EventPublisher decodes the level to °C before it reaches this topic, using the
                // inverse of the setpoint encoding above:
                //   temperature = level / 2   (0.5°C resolution; see TODO above)
                current_temperature_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_CURRENT_TEMP}`,

                // Target temperature setpoint — command and state topics
                temperature_command_topic: `${writeBase}/${MQTT_CMD_TYPE_HVAC_SETPOINT}`,
                temperature_state_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_SETPOINT}`,

                // Mode control topics
                mode_command_topic: `${writeBase}/${MQTT_CMD_TYPE_HVAC_MODE}`,
                mode_state_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_MODE}`,

                // Deliberately off/auto only — do not add heat/cool/fan_only back here.
                // This path has exactly one group level to work with: the router can only
                // translate a mode into C-Gate ON or OFF, and the event side can only infer
                // the same two states from what C-Bus reports. Advertising more modes gives
                // Home Assistant buttons that send a bare ON and then snap back to auto.
                modes: ['off', 'auto'],

                ...this._climateRangeFields()
            },
            deviceIdentifiers: [uniqueId],
            deviceName: finalLabel,
            model: 'HVAC Zone (Air Conditioning)',
            area
        });
    }
}

const methods = {};
for (const name of Object.getOwnPropertyNames(_HaDiscoveryPublishersAircon.prototype)) {
    if (name === 'constructor') continue;
    methods[name] = _HaDiscoveryPublishersAircon.prototype[name];
}
module.exports = methods;
