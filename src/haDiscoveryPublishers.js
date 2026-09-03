// @ts-check
const { getDiscoveryTypeForApp, getDiscoveryConfig } = require('./haDiscoveryConfigs');
const { classifyLightingGroup, typeFromLabelPrefix, classifySecurityZoneDeviceClass } = require('./deviceTypeClassifier');
const { entityTypeForGroup } = require('./unitTypeClassifier');
const { buildOriginBlock, buildDeviceBlock } = require('./haDiscoveryPayloads');
const { securityZoneLabelKey } = require('./securityZoneLabels');
const {
    MQTT_TOPIC_PREFIX_READ,
    MQTT_TOPIC_PREFIX_WRITE,
    MQTT_TOPIC_SUFFIX_STATE,
    MQTT_TOPIC_SUFFIX_LEVEL,
    MQTT_TOPIC_SUFFIX_POSITION,
    MQTT_TOPIC_SUFFIX_TILT,
    MQTT_TOPIC_SUFFIX_EVENT,
    MQTT_TOPIC_SUFFIX_ATTRIBUTES,
    MQTT_TOPIC_SUFFIX_LOOP_FAULT,
    MQTT_TOPIC_SUFFIX_PASSWORD_ENTRY,
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
    MQTT_TOPIC_SUFFIX_VALUE,
    HVAC_MIN_TEMP_C,
    HVAC_MAX_TEMP_C,
    MQTT_CMD_TYPE_SWITCH,
    MQTT_CMD_TYPE_RAMP,
    MQTT_CMD_TYPE_POSITION,
    MQTT_CMD_TYPE_TILT,
    MQTT_CMD_TYPE_STOP,
    MQTT_CMD_TYPE_TRIGGER,
    MQTT_CMD_TYPE_HVAC_SETPOINT,
    MQTT_CMD_TYPE_HVAC_MODE,
    MQTT_CMD_TYPE_HVAC_FAN_MODE,
    MQTT_STATE_ON,
    MQTT_STATE_OFF,
    MQTT_COMMAND_STOP,
    MQTT_RETAINED_STATE_OPTIONS,
    HA_COMPONENT_LIGHT,
    HA_COMPONENT_BUTTON,
    HA_COMPONENT_CLIMATE,
    HA_COMPONENT_SENSOR,
    HA_COMPONENT_BINARY_SENSOR,
    HA_COMPONENT_ALARM_PANEL,
    HA_COMPONENT_SCENE,
    HA_DISCOVERY_SUFFIX,
    HA_MODEL_LIGHTING,
    HA_MODEL_TRIGGER,
    DEFAULT_CBUS_APP_LIGHTING,
    entityIdFields
} = require('./constants');
const { PANEL_CONDITIONS } = require('./securityPanelConditions');
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

// The two halves of the C-Bus network clock, which app 223 broadcasts as
// separate events. Icons only — deliberately no device_class; see
// ensureClockDiscovery for why a timestamp would be dishonest here.
const CLOCK_VARIANTS = [
    { id: 'date', name: 'Clock Date', icon: 'mdi:calendar' },
    { id: 'time', name: 'Clock Time', icon: 'mdi:clock-outline' }
];

/**
 * Static shape for the app-25 temperature sensor. Identity (label, unique id,
 * area, topic) is resolved per call; everything else is fixed by the wire
 * format (byte/4 → °C).
 */
const TEMPERATURE_ENTITY = {
    component: HA_COMPONENT_SENSOR,
    model: 'C-Bus Temperature Sensor',
    fallbackLabel: (networkId, appId, group) => `CBus Temperature ${networkId}/${appId}/${group}`,
    fields: (networkId, appId, group) => ({
        state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/${group}/${MQTT_TOPIC_SUFFIX_HVAC_CURRENT_TEMP}`,
        device_class: 'temperature',
        state_class: 'measurement',
        unit_of_measurement: '°C'
    })
};

/**
 * Static shape for an app-208 security zone binary_sensor. device_class is
 * filled in at publish time from the zone's application-1 label.
 */
const SECURITY_ZONE_ENTITY = {
    component: HA_COMPONENT_BINARY_SENSOR,
    model: 'C-Bus Security Zone',
    fallbackLabel: (networkId, appId, zone) => `CBus Security Zone ${networkId}/${appId}/${zone}`,
    fields: (networkId, appId, zone, deviceClass) => {
        const readBase = `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/${zone}`;
        return {
            state_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_STATE}`,
            payload_on: MQTT_STATE_ON,
            payload_off: MQTT_STATE_OFF,
            json_attributes_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_ATTRIBUTES}`,
            ...(deviceClass && { device_class: deviceClass })
        };
    }
};

/**
 * Measurement (app 228) is heterogeneous: unit/device_class/state_class come
 * from the decoded reading. Only the model and component are fixed here.
 */
const MEASUREMENT_ENTITY = {
    component: HA_COMPONENT_SENSOR,
    model: 'C-Bus Measurement Sensor',
    fallbackLabel: (networkId, appId, device, channel) =>
        `CBus Measurement ${networkId}/${appId}/${device}/${channel}`,
    fields: (networkId, appId, device, channel, reading) => ({
        state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/${device}/${channel}/${MQTT_TOPIC_SUFFIX_VALUE}`,
        // From the reading, not hardcoded: Home Assistant rejects
        // device_class 'energy' paired with state_class 'measurement', so
        // Wh readings carry 'total_increasing' instead (see UNIT_TABLE).
        state_class: (reading && reading.stateClass) || 'measurement',
        ...(reading && reading.deviceClass ? { device_class: reading.deviceClass } : {}),
        ...(reading && reading.unit ? { unit_of_measurement: reading.unit } : {})
    })
};

class _HaDiscoveryPublishers {
    // Host-provided instance state. This class is never instantiated: its
    // prototype methods are copied onto HaDiscovery (see the Object.assign in
    // haDiscovery.js), which supplies every member declared below. The field
    // declarations exist purely so @ts-check can resolve them; they never run.

    /** @type {ReturnType<typeof import('./logger').createLogger>} */
    logger;

    /** @type {Object} */
    settings;

    /** @type {(topic: string, payload: string, options: Object) => void} */
    _publish;

    /** @type {number} */
    discoveryCount;

    /** @type {{ custom: number, treexml: number, fallback: number }} */
    labelStats;

    /** @type {Map<string, string>} */
    labelMap;

    /** @type {Map<string, string>} */
    typeOverrides;

    /** @type {Map<string, string>} */
    entityIds;

    /** @type {Set<string>} */
    exclude;

    /** @type {Map<string, string>} */
    areas;

    /** @type {Set<string>} */
    _publishedTopics;

    /** @type {Set<string>} */
    _eventDrivenDiscoveryTopics;

    /** @type {Set<string>} */
    _cniDiscoverySeen;

    /** @type {Set<string>} */
    _nativeAirconSeen;

    /** @type {Set<string>} */
    _temperatureSeen;

    /** @type {Set<string>} */
    _securityZoneSeen;

    /** @type {Set<string>} */
    _unlistedGroupSeen;

    /** @type {(key: string, topics: Iterable<string>) => void} */
    _rememberUnlistedGroupTopics;

    /** @type {(key: string) => void} */
    _retractUnlistedGroupKey;

    /** @type {Set<string>} */
    _treeDiscoveredGroups;

    /** @type {boolean} */
    _recordingTreeGroups;

    /** @type {Set<string>} */
    _securityPanelSeen;

    /** @type {Set<string>} */
    _measurementSeen;

    // Unlike its siblings this one is not constructed in haDiscovery.js — the
    // clock path initialises it on first use, so it stays self-contained.
    /** @type {Set<string>|undefined} */
    _clockSeen;

    /** @type {Set<string>} */
    _currentRunTopics;

    /**
     * Installed on HaDiscovery; nested unlisted-group publish reuses the tree
     * run's snapshot and topic set instead of rolling its own.
     * @type {(fn: (ctx: { outermost: boolean, ownTopics: boolean }) => any) => any}
     */
    _withDiscoveryRun;

    /**
     * Per-run label data snapshot installed by _withDiscoveryRun for
     * the duration of a synchronous discovery run (null outside a run).
     * @type {{ labelMap: Map<string, string>, typeOverrides: Map<string, string>, entityIds: Map<string, string>, exclude: Set<string>, areas: Map<string, string> } | null}
     */
    _labelSnapshot;

    /**
     * Per-run map of "<appId>/<groupId>" to the unit types driving that group,
     * installed by _publishDiscoveryFromTree (null outside a run, and left null
     * when ha_discovery_type_from_unit is off).
     * @type {Map<string, { types: Set<string> }> | null}
     */
    _unitTypeIndex;

    /**
     * True when this run's tree still had units whose <Groups> had not synced,
     * so a group can look input-only purely because the load unit's binding has
     * not arrived yet. Installed by _publishDiscoveryFromTree alongside
     * _unitTypeIndex; suppresses the destructive binary_sensor conclusion.
     * @type {boolean}
     */
    _treeIncomplete;

    _processLightingGroups(networkId, appId, groups) {
        const groupArray = Array.isArray(groups) ? groups : [groups];
        for (const group of groupArray) {
            this._processOneLightingGroup(networkId, appId, group);
        }
    }

    /**
     * Discover a single lighting-application group: skip invalid/excluded
     * groups, publish a typed entity (cover/switch/HVAC/…) when the label or a
     * manual override resolves to a non-light type, otherwise publish a light.
     * @private
     */
    _processOneLightingGroup(networkId, appId, group) {
        const { exclude } = this._labelSnapshot;

        const groupId = group.GroupAddress;
        if (groupId === undefined || groupId === null || groupId === '') {
            this.logger.warn(`Skipping lighting group in HA Discovery due to missing/invalid GroupAddress`, { group });
            return;
        }

        if (this._recordingTreeGroups !== false) {
            this._treeDiscoveredGroups.add(`${networkId}/${appId}/${groupId}`);
        }

        const labelKey = `${networkId}/${appId}/${groupId}`;
        if (exclude.has(labelKey)) {
            this.logger.debug(`Excluding group ${labelKey} from discovery`);
            return;
        }

        // A manual override or auto-classification can turn a lighting group into
        // a cover/switch/HVAC/etc. entity; that path also clears any stale light
        // config and we're done.
        if (this._tryCreateTypedEntity(networkId, appId, groupId, group, labelKey)) {
            return;
        }

        // Default: a dimmable light entity.
        this._publishLightingGroupEntity(networkId, appId, groupId, group, labelKey, {
            component: HA_COMPONENT_LIGHT,
            fallbackLabel: `CBus Light ${networkId}/${appId}/${groupId}`,
            fields: ({ read, write }) => ({
                state_topic: `${read}/${MQTT_TOPIC_SUFFIX_STATE}`,
                command_topic: `${write}/${MQTT_CMD_TYPE_RAMP}`,
                brightness_state_topic: `${read}/${MQTT_TOPIC_SUFFIX_LEVEL}`,
                brightness_command_topic: `${write}/${MQTT_CMD_TYPE_RAMP}`,
                brightness_scale: 100,
                on_command_type: 'brightness',
                payload_on: MQTT_STATE_ON,
                payload_off: MQTT_STATE_OFF,
                state_value_template: '{{ value }}',
                brightness_value_template: '{{ value }}'
            })
        });

        // It is a light, so retract any binary_sensor config an earlier run
        // published for it — including one published by a run that classified
        // the group input-only before this group's load unit reported a type.
        this._clearStaleInputBinarySensorConfig(networkId, appId, groupId);
    }

    /**
     * Publish one Lighting-application group as a single HA entity.
     *
     * The three shapes a lighting group can take — dimmable light, relay-driven
     * on/off light, input-only binary sensor — differ only in their HA component
     * and in the block of topic/payload keys between `unique_id` and `qos`.
     * Label resolution (custom → TREEXML → fallback, with its stats), unique id,
     * entity-id hint, area lookup, device block and per-run bookkeeping are
     * identical, so they live here once rather than three times.
     *
     * @param {Object} spec
     * @param {string} spec.component - HA component: light, binary_sensor, …
     * @param {string} spec.fallbackLabel - Label used when neither a custom nor a TREEXML label exists.
     * @param {(bases: { read: string, write: string }) => Object} spec.fields -
     *   Component-specific payload keys, given the group's read/write topic bases.
     * @private
     */
    _publishLightingGroupEntity(networkId, appId, groupId, group, labelKey, spec) {
        const { finalLabel, uniqueId, entityId, area, discoveryTopic } = this._resolveEntityIdentity({
            networkId, appId, groupId, labelKey,
            component: spec.component,
            fallbackLabel: spec.fallbackLabel,
            groupLabel: group.Label,
            labels: this._labelSnapshot
        });

        // command topics must NOT be retained: a retained command replays to
        // cgateweb on every reconnect and re-toggles the light (see _createDiscovery).
        this._finishTreeEntity({
            discoveryTopic, uniqueId, entityId,
            component: spec.component,
            fields: spec.fields({
                read: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/${groupId}`,
                write: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${appId}/${groupId}`
            }),
            deviceIdentifiers: [uniqueId],
            deviceName: finalLabel,
            model: HA_MODEL_LIGHTING,
            area
        });
    }

    /**
     * A relay-driven lighting group: still a light (it is wired onto the
     * Lighting application and switches a light group), but with no dim slider.
     * Staying in the light domain keeps entity ids and existing automations
     * working, which moving it to `switch` would break (issue #38).
     * @private
     */
    _createOnOffLightDiscovery(networkId, appId, groupId, group, labelKey) {
        this._publishLightingGroupEntity(networkId, appId, groupId, group, labelKey, {
            component: HA_COMPONENT_LIGHT,
            fallbackLabel: `CBus Light ${networkId}/${appId}/${groupId}`,
            fields: ({ read, write }) => ({
                state_topic: `${read}/${MQTT_TOPIC_SUFFIX_STATE}`,
                command_topic: `${write}/${MQTT_CMD_TYPE_SWITCH}`,
                payload_on: MQTT_STATE_ON,
                payload_off: MQTT_STATE_OFF,
                state_value_template: '{{ value }}'
            })
        });
    }

    /**
     * A group driven only by input units (bus coupler, key input, sensor) with
     * no output unit on it: there is no load to control, so publish a binary
     * sensor to trigger automations from (issue #37). No device_class — a
     * coupler is not necessarily motion.
     * @private
     */
    _createInputBinarySensorDiscovery(networkId, appId, groupId, group, labelKey) {
        this._publishLightingGroupEntity(networkId, appId, groupId, group, labelKey, {
            component: HA_COMPONENT_BINARY_SENSOR,
            fallbackLabel: `CBus Input ${networkId}/${appId}/${groupId}`,
            fields: ({ read }) => ({
                state_topic: `${read}/${MQTT_TOPIC_SUFFIX_STATE}`,
                payload_on: MQTT_STATE_ON,
                payload_off: MQTT_STATE_OFF
            })
        });
    }

    /**
     * If the group's resolved type (manual override first, else
     * auto-classification) is a non-light type, publish that entity, clear any
     * stale retained light config, and return true. Returns false to fall
     * through to light discovery.
     *
     * Manual type_overrides have absolute priority; auto-detection only fills in
     * when there is no override and never returns 'light'. Application-id
     * mappings are handled in _processEnableControlGroups, not here.
     * @private
     */
    _tryCreateTypedEntity(networkId, appId, groupId, group, labelKey) {
        const { labelMap, typeOverrides } = this._labelSnapshot;
        const labelForClassification = labelMap.get(labelKey) || group.Label || '';

        // Precedence: manual type_overrides, then an explicit entity-id domain
        // prefix in the label (issue #35), then the cover-name keyword heuristics,
        // then the type of the unit driving the group (issues #38, #37). A relay
        // output can drive a light, a motorised blind or an irrigation valve —
        // the hardware alone cannot tell those apart. A name that positively
        // identifies a cover (e.g. "Patio Blind") is better evidence than the
        // unit type, so it must win before the unit type gets a say; groups
        // whose name says nothing about being a cover still fall through to
        // unit-type classification, which is where most of the feature's value
        // comes from.
        const unitType = entityTypeForGroup(
            this._unitTypeIndex ? this._unitTypeIndex.get(`${appId}/${groupId}`) : null,
            this.settings,
            { treeIncomplete: this._treeIncomplete === true }
        );

        // A "light." prefix expresses an entity DOMAIN, not a dim capability, so
        // it pins the group to the light domain (the cover-name heuristics below
        // must not retype it) while still letting the unit type choose between a
        // dimmable and an on/off light. Left as a plain 'light' it short-circuited
        // the chain, and a relay-driven group named "light.porch" got a brightness
        // slider that ramps a relay channel. Any other unit-type conclusion
        // (binary_sensor) is discarded here: the prefix says there is a light.
        /** @type {'light'|'light-onoff'|'cover'|'switch'|'relay'|'pir'|null} */
        let prefixType = typeFromLabelPrefix(labelForClassification, this.settings);
        if (prefixType === 'light') {
            prefixType = unitType === 'light-onoff' ? 'light-onoff' : 'light';
        }

        const resolvedType = typeOverrides.get(labelKey)
            || prefixType
            || classifyLightingGroup(labelForClassification, this.settings)
            || unitType;

        // A dimmer-driven group resolves to the default dimmable light, so there
        // is nothing to do here beyond falling through to it unchanged.
        if (!resolvedType || resolvedType === 'light' || resolvedType === 'light-dimmable') {
            return false;
        }

        // The unit-type outcomes below are payload shapes, not entries in the
        // getDiscoveryConfig table, so they must be dispatched before the lookup
        // — which keeps its original meaning of "a type nobody recognises".
        //
        // Gated on the feature flag, because resolvedType does not only come
        // from entityTypeForGroup: type_overrides are unvalidated arbitrary
        // strings read from the user's label file. A user who guessed
        // "binary_sensor" instead of the documented "pir" previously got a light
        // plus an "Unknown resolved type" warning; without the gate they would
        // instead silently lose control of the load (a read-only entity with no
        // command_topic, and the light config retracted) with the feature off.
        const typeFromUnitEnabled = this.settings.ha_discovery_type_from_unit === true;

        if (typeFromUnitEnabled && resolvedType === 'light-onoff') {
            this.logger.debug(`Resolved type: ${labelKey} -> light (on/off, relay-driven)`);
            this._createOnOffLightDiscovery(networkId, appId, groupId, group, labelKey);
            // It is a light, so retract any binary_sensor config an earlier run
            // published for it.
            this._clearStaleInputBinarySensorConfig(networkId, appId, groupId);
            return true;
        }

        if (typeFromUnitEnabled && resolvedType === 'binary_sensor') {
            this.logger.debug(`Resolved type: ${labelKey} -> binary_sensor (input-only)`);
            this._createInputBinarySensorDiscovery(networkId, appId, groupId, group, labelKey);
            // It moved out of the light domain, so retract any light config a
            // previous run published for it.
            this._clearStaleLightConfig(networkId, appId, groupId);
            return true;
        }

        const config = getDiscoveryConfig(resolvedType);
        if (!config) {
            this.logger.warn(`Unknown resolved type "${resolvedType}" for ${labelKey}, falling back to light`);
            return false;
        }

        this.logger.debug(`Resolved type: ${labelKey} -> ${resolvedType}`);
        if (config.isHvac) {
            // HVAC needs the dedicated climate payload (temperature/mode topics);
            // the generic builder would publish a climate entity with no controls.
            this._createHvacDiscovery(networkId, appId, groupId, group.Label);
        } else {
            this._createDiscovery(networkId, appId, groupId, group.Label, config);
        }
        this._clearStaleLightConfig(networkId, appId, groupId);
        return true;
    }

    /**
     * Remove a stale retained light discovery config for a group that has
     * resolved to a non-light type (e.g. it was published as a light on an
     * earlier run, before an override/classification changed it).
     * @private
     */
    _clearStaleLightConfig(networkId, appId, groupId) {
        const uniqueId = `cgateweb_${networkId}_${appId}_${groupId}`;
        const staleTopic = `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_LIGHT}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`;
        this._publish(staleTopic, '', MQTT_RETAINED_STATE_OPTIONS);
        this._publishedTopics.delete(staleTopic);
    }

    /**
     * The inverse: a lighting group that is being published as a light must not
     * keep a retained binary_sensor config from a run that classified it
     * input-only. Without this the read-only entity survives for ever as a
     * duplicate of the light — HA has already loaded it, and the end-of-run
     * stale-topic sweep only knows the topics published in the current process,
     * so it cannot help once the add-on has restarted (which is exactly what
     * changing an add-on option does).
     *
     * Gated on ha_discovery_type_from_unit so a user who has never enabled the
     * feature — who therefore can never have one of these — sees no extra
     * traffic and byte-identical output.
     * @private
     */
    _clearStaleInputBinarySensorConfig(networkId, appId, groupId) {
        if (this.settings.ha_discovery_type_from_unit !== true) return;
        const uniqueId = `cgateweb_${networkId}_${appId}_${groupId}`;
        const staleTopic = `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_BINARY_SENSOR}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`;
        this._publish(staleTopic, '', MQTT_RETAINED_STATE_OPTIONS);
        this._publishedTopics.delete(staleTopic);
    }

    _processEnableControlGroups(networkId, appAddress, groups) {
        const groupArray = Array.isArray(groups) ? groups : [groups];

        // Tilt app groups are not standalone entities — they enrich cover discovery only
        const tiltAppId = this.settings.ha_discovery_cover_tilt_app_id;
        if (tiltAppId && String(appAddress) === String(tiltAppId)) {
            return;
        }

        // Determine the discovery type based on application address
        const discoveryType = getDiscoveryTypeForApp(this.settings, appAddress);
        if (!discoveryType) {
            return;
        }

        groupArray.forEach(group => {
            const groupId = group.GroupAddress;
            if (groupId === undefined || groupId === null || groupId === '') {
                this.logger.warn(`Skipping EnableControl group in HA Discovery due to missing/invalid GroupAddress (App: ${appAddress})`, { group });
                return;
            }

            if (this._recordingTreeGroups !== false) {
                this._treeDiscoveredGroups.add(`${networkId}/${appAddress}/${groupId}`);
            }

            if (discoveryType === 'hvac') {
                this._createHvacDiscovery(networkId, appAddress, groupId, group.Label);
            } else {
                this._createDiscovery(networkId, appAddress, groupId, group.Label, getDiscoveryConfig(discoveryType));
            }
        });
    }

    /**
     * Shared skeleton for the event-driven `ensure*Discovery` entry points:
     * bail if discovery is off or this key was already handled, honour
     * `exclude` by retracting what an earlier run published, record the key
     * either way, otherwise publish.
     *
     * The ordering is load-bearing. In particular the excluded branch must
     * still record the key - otherwise every later event for an excluded
     * entity re-runs the check and re-publishes an empty retraction.
     *
     * Callers keep their own argument validation: the arity and which
     * arguments may legitimately be absent differ between them.
     *
     * @param {Object} spec
     * @param {string} spec.key - Identity in the `seen` set.
     * @param {Set<string>} spec.seen - Per-kind idempotence set.
     * @param {string[]} [spec.excludeKeys] - Address forms an exclusion may use (default: [key]).
     * @param {string} spec.describe - Subject of the "Excluding ..." debug line.
     * @param {() => void} spec.retract - Clear earlier publishes; called only when excluded.
     * @param {() => void} spec.create - Publish; called only when not excluded.
     * @returns {boolean} true if something was published this call.
     * @private
     */
    _ensureEventDrivenEntity({ key, seen, excludeKeys, describe, retract, create }) {
        if (!this.settings.ha_discovery_enabled) return false;
        if (seen.has(key)) return false;

        if ((excludeKeys || [key]).some(candidate => this.exclude.has(candidate))) {
            this.logger.debug(`Excluding ${describe} from discovery`);
            retract();
            seen.add(key); // don't re-check on every event
            return false;
        }

        create();
        seen.add(key);
        return true;
    }

    /**
     * Publish a Home Assistant binary_sensor (device_class=connectivity) for a
     * C-Bus network's CNI/PCI link, once per network. ON = the interface is
     * connected, OFF = the CNI/PCI link to the C-Bus network is down. Fed by the
     * retained state topic cbus/read/{network}/cni/state (see cgateWebBridge).
     *
     * @param {string|number} networkId
     * @returns {boolean} true if a new entity was published this call
     */
    ensureNetworkConnectivityDiscovery(networkId) {
        if (!this.settings.ha_discovery_enabled) return false;
        if (networkId === null || networkId === undefined) return false;
        const net = String(networkId);
        if (this._cniDiscoverySeen.has(net)) return false;

        const uniqueId = `cgateweb_${net}_cni`;
        this._finishEventDrivenEntity({
            discoveryTopic: `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_BINARY_SENSOR}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`,
            uniqueId,
            component: HA_COMPONENT_BINARY_SENSOR,
            name: 'CNI Connectivity',
            fields: {
                device_class: 'connectivity',
                state_topic: `${MQTT_TOPIC_PREFIX_READ}/${net}/cni/state`,
                payload_on: MQTT_STATE_ON,
                payload_off: MQTT_STATE_OFF
            },
            deviceIdentifiers: [`cgateweb_network_${net}`],
            deviceName: `C-Bus Network ${net}`,
            model: 'C-Bus Network Interface',
            logInfo: `CNI connectivity binary_sensor published for network ${net}`
        });
        this._cniDiscoverySeen.add(net);
        return true;
    }

    /**
     * Event-driven discovery for the C-Bus Clock and Timekeeping (app 223)
     * network clock. Announces two diagnostic sensors — the network's date and
     * its time — the first time clock traffic is decoded on a network.
     *
     * WHY NO device_class: 'timestamp'
     * --------------------------------
     * It would not be honest. Home Assistant's timestamp device_class requires
     * a full ISO 8601 datetime WITH a UTC offset, and the bus gives us neither
     * half of that: date and time arrive as two separate broadcasts, and
     * neither carries a timezone. Producing one timestamp would mean joining
     * two independent events and assuming the C-Bus network runs in the bridge
     * host's timezone.
     *
     * Worse, it would defeat the point. The reason to surface a network clock
     * at all is to notice when it has DRIFTED — and a timestamp entity is
     * normalised to UTC and rendered as relative time ("2 hours ago"), which
     * launders a wrong clock into a plausible-looking instant. Two plain string
     * sensors show exactly what the panel said, which is the diagnostic.
     *
     * Both sensors sit on the existing "C-Bus Network {n}" device alongside the
     * CNI connectivity sensor: the clock is a property of the network, not of a
     * separate piece of hardware. entity_category 'diagnostic' keeps them off
     * auto-generated dashboards.
     *
     * @param {string|number} network
     * @param {string|number} appId - clock app id (223)
     * @returns {boolean} true if the entities were published this call
     */
    ensureClockDiscovery(network, appId) {
        if (!this.settings.ha_discovery_enabled) return false;
        if (network === null || network === undefined || appId === null || appId === undefined) return false;

        // Initialised lazily: the sibling Seen sets are constructed in
        // haDiscovery.js, and this keeps the clock path self-contained.
        if (!this._clockSeen) this._clockSeen = new Set();

        const key = `${network}/${appId}/clock`;
        return this._ensureEventDrivenEntity({
            key,
            seen: this._clockSeen,
            describe: `network clock ${network}/${appId}`,
            retract: () => {
                for (const variant of CLOCK_VARIANTS) {
                    this._retractEventDrivenConfig(
                        this._clockTopic(this._clockUniqueId(String(network), String(appId), variant.id))
                    );
                }
            },
            create: () => this._createClockDiscovery(String(network), String(appId))
        });
    }

    /**
     * unique_id for one half of the network clock. The discovery topic embeds
     * this, so both must come from here or a retraction would target a topic HA
     * never saw and orphan the entity.
     *
     * @param {string} networkId
     * @param {string} appId
     * @param {string} variantId - 'date' or 'time'
     * @returns {string}
     * @private
     */
    _clockUniqueId(networkId, appId, variantId) {
        return `cgateweb_${networkId}_${appId}_clock_${variantId}`;
    }

    /**
     * @param {string} uniqueId
     * @returns {string}
     * @private
     */
    _clockTopic(uniqueId) {
        return `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_SENSOR}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`;
    }

    /**
     * Build and publish the two network-clock sensor payloads. State comes from
     * the clock decoder via cbus/read/{net}/{app}/clock/date and .../time.
     *
     * @private
     */
    _createClockDiscovery(networkId, appId) {
        for (const variant of CLOCK_VARIANTS) {
            const uniqueId = this._clockUniqueId(networkId, appId, variant.id);
            this._finishEventDrivenEntity({
                discoveryTopic: this._clockTopic(uniqueId),
                uniqueId,
                component: HA_COMPONENT_SENSOR,
                // Two entities on the shared network device, so each needs its
                // own name rather than inheriting the device's.
                name: variant.name,
                fields: {
                    state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/clock/${variant.id}`,
                    // No device_class and no unit_of_measurement, deliberately —
                    // see the note on ensureClockDiscovery.
                    entity_category: 'diagnostic',
                    icon: variant.icon
                },
                deviceIdentifiers: [`cgateweb_network_${networkId}`],
                deviceName: `C-Bus Network ${networkId}`,
                model: 'C-Bus Network Interface'
            });
        }
        this.logger.info(`Network clock sensors published: ${networkId}/${appId}`);
    }

    /**
     * Event-driven discovery for C-Bus Temperature Broadcast (app 25) sensors.
     * Called whenever a temperature reading is published for a group; announces
     * the HA temperature sensor the first time that group is seen. Like the
     * native aircon path, groups announce themselves on the bus — only sensors
     * that actually broadcast get an entity.
     *
     * @param {string|number} network
     * @param {string|number} appId  - temperature app id (e.g. 25)
     * @param {string|number} group  - temperature group address
     * @returns {boolean} true if a new sensor entity was published this call
     */
    ensureTemperatureDiscovery(network, appId, group) {
        if (!this.settings.ha_discovery_enabled) return false;
        if (network === null || network === undefined || appId === null || appId === undefined || group === null || group === undefined) return false;

        const key = `${network}/${appId}/${group}`;
        return this._ensureEventDrivenEntity({
            key,
            seen: this._temperatureSeen,
            describe: `temperature group ${key}`,
            retract: () => this._retractEventDrivenConfig(
                `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_SENSOR}/cgateweb_${network}_${appId}_${group}/${HA_DISCOVERY_SUFFIX}`
            ),
            create: () => this._createTemperatureDiscovery(String(network), String(appId), String(group))
        });
    }

    /**
     * Opt-in: announce a Home Assistant entity the first time a lighting-style
     * group appears on the bus even if it is missing from the Toolkit project
     * (#63). Off by default because scene addresses and unused groups also
     * appear in the event stream. Turning the option off retracts leftover
     * configs (see {@link HaDiscovery#syncUnlistedGroupDiscovery}).
     *
     * @param {string|number} network
     * @param {string|number} appId
     * @param {string|number} group
     * @returns {boolean}
     */
    ensureUnlistedGroupDiscovery(network, appId, group) {
        if (!this.settings.ha_discovery_enabled) return false;
        if (network === null || network === undefined || appId === null || appId === undefined
            || group === null || group === undefined || group === '') {
            return false;
        }

        const key = `${network}/${appId}/${group}`;
        if (!this.settings.ha_discovery_unlisted_groups) {
            this._retractUnlistedGroupKey(key);
            return false;
        }
        if (this._treeDiscoveredGroups.has(key)) return false;
        if (this.exclude.has(key)) {
            this._retractUnlistedGroupKey(key);
            return false;
        }
        if (this._unlistedGroupSeen.has(key)) return false;

        const isLighting = String(appId) === DEFAULT_CBUS_APP_LIGHTING;
        const typed = getDiscoveryTypeForApp(this.settings, appId);
        if (!isLighting && !typed) return false;
        if (typed === 'trigger') return false;

        // Tree processors finish via _finishTreeEntity, which records topics on
        // _currentRunTopics rather than _publishedTopics. _withDiscoveryRun owns
        // the topic set when this is not already inside a TREEXML pass, then
        // those topics are promoted onto the event-driven sets so a later tree
        // scan does not retract them.
        return this._withDiscoveryRun(({ ownTopics }) => {
            const topicsBefore = new Set(this._currentRunTopics);
            this._recordingTreeGroups = false;
            try {
                if (isLighting) {
                    this._processOneLightingGroup(network, appId, { GroupAddress: group });
                } else {
                    this._processEnableControlGroups(network, appId, [{ GroupAddress: group }]);
                }
                this._unlistedGroupSeen.add(key);

                const added = [...this._currentRunTopics].filter((t) => !topicsBefore.has(t));
                this._rememberUnlistedGroupTopics(key, added);

                let published = false;
                if (ownTopics) {
                    for (const topic of this._currentRunTopics) {
                        this._publishedTopics.add(topic);
                        this._eventDrivenDiscoveryTopics.add(topic);
                        published = true;
                    }
                } else if (this._currentRunTopics.size > topicsBefore.size) {
                    for (const topic of this._currentRunTopics) {
                        this._eventDrivenDiscoveryTopics.add(topic);
                    }
                    published = true;
                }
                return published;
            } finally {
                this._recordingTreeGroups = true;
            }
        });
    }

    /**
     * Shared identity preamble for the discovery creators: resolve the
     * entity's label (custom label, then optional TREEXML group label, then
     * the fallback), tally the label-stats bucket it came from, and derive
     * the unique id, entity-id hint, area and discovery topic.
     *
     * @param {Object} spec
     * @param {string} spec.networkId
     * @param {string} spec.appId
     * @param {string} spec.groupId - Address the entity is keyed on.
     * @param {string} spec.labelKey - Label-map key ("{network}/{app}/{group}"; security zones use their app-1 key).
     * @param {string} spec.component - HA component (sensor, binary_sensor, climate, …).
     * @param {string} spec.fallbackLabel - Used when no custom or group label exists.
     * @param {string|null} [spec.groupLabel] - TREEXML group label (tree-run creators only).
     * @param {{ labelMap: Map<string, string>, entityIds: Map<string, string>, areas: Map<string, string> }|null} [spec.labels]
     *   Label lookup source; defaults to the instance maps (event-driven creators).
     * @returns {{ finalLabel: string, uniqueId: string, entityId: string|undefined, area: string|undefined, discoveryTopic: string }}
     * @private
     */
    _resolveEntityIdentity({ networkId, appId, groupId, labelKey, component, fallbackLabel, groupLabel = null, labels = null }) {
        const source = labels || { labelMap: this.labelMap, entityIds: this.entityIds, areas: this.areas };
        const customLabel = source.labelMap.get(labelKey);
        const finalLabel = customLabel || groupLabel || fallbackLabel;
        if (customLabel) this.labelStats.custom++;
        else if (groupLabel) this.labelStats.treexml++;
        else this.labelStats.fallback++;

        const uniqueId = `cgateweb_${networkId}_${appId}_${groupId}`;
        const entityId = source.entityIds.get(labelKey);
        const area = source.areas && source.areas.get(labelKey);
        const discoveryTopic = `${this.settings.ha_discovery_prefix}/${component}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`;

        return { finalLabel, uniqueId, entityId, area, discoveryTopic };
    }

    /**
     * Assemble the shared discovery shell (name / unique_id / entity-id hint /
     * qos / device / origin) around component-specific fields and publish.
     * Does not track topics — callers choose tree ({@link _finishTreeEntity})
     * or event-driven ({@link _finishEventDrivenEntity}) registration.
     *
     * @param {Object} spec
     * @param {string} spec.discoveryTopic
     * @param {string} spec.uniqueId
     * @param {string} [spec.entityId]
     * @param {string} spec.component
     * @param {string|null} [spec.name=null]
     * @param {Object} spec.fields
     * @param {string[]} spec.deviceIdentifiers
     * @param {string} spec.deviceName
     * @param {string} spec.model
     * @param {string} [spec.area]
     * @private
     */
    _publishDiscoveryPayload({
        discoveryTopic, uniqueId, entityId, component, name = null, fields,
        deviceIdentifiers, deviceName, model, area
    }) {
        this._publish(discoveryTopic, JSON.stringify({
            name,
            unique_id: uniqueId,
            ...(entityId && entityIdFields(component, entityId)),
            ...fields,
            qos: 0,
            device: buildDeviceBlock({
                identifiers: deviceIdentifiers,
                name: deviceName,
                model,
                area
            }),
            origin: buildOriginBlock()
        }), MQTT_RETAINED_STATE_OPTIONS);
    }

    /**
     * Finish a tree-run discovery entity: publish via
     * {@link _publishDiscoveryPayload}, record the topic on the current run
     * (stale cleanup), and bump the entity counter.
     *
     * @param {Object} spec - Same shape as {@link _publishDiscoveryPayload}.
     * @private
     */
    _finishTreeEntity(spec) {
        this._publishDiscoveryPayload(spec);
        if (this._currentRunTopics) this._currentRunTopics.add(spec.discoveryTopic);
        this.discoveryCount++;
    }

    /**
     * Finish an event-driven discovery entity: publish via
     * {@link _publishDiscoveryPayload}, then register on the session-wide and
     * event-driven topic sets (so tree runs don't retract it).
     *
     * @param {Object} spec
     * @param {string} spec.discoveryTopic
     * @param {string} spec.uniqueId
     * @param {string} [spec.entityId]
     * @param {string} spec.component
     * @param {string|null} [spec.name=null]
     * @param {Object} spec.fields
     * @param {string[]} spec.deviceIdentifiers
     * @param {string} spec.deviceName
     * @param {string} spec.model
     * @param {string} [spec.area]
     * @param {string} [spec.logInfo]
     * @private
     */
    _finishEventDrivenEntity({
        discoveryTopic, uniqueId, entityId, component, name = null, fields,
        deviceIdentifiers, deviceName, model, area, logInfo
    }) {
        this._publishDiscoveryPayload({
            discoveryTopic, uniqueId, entityId, component, name, fields,
            deviceIdentifiers, deviceName, model, area
        });
        this._publishedTopics.add(discoveryTopic);
        this._eventDrivenDiscoveryTopics.add(discoveryTopic);
        this.discoveryCount++;
        if (logInfo) this.logger.info(logInfo);
    }

    /**
     * Read/write topic bases for a single address under a network/app.
     * @private
     */
    _topicBases(networkId, appId, address) {
        return {
            readBase: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/${address}`,
            writeBase: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${appId}/${address}`
        };
    }

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
     * Build and publish the temperature sensor discovery payload for one group.
     * @private
     */
    _createTemperatureDiscovery(networkId, appId, group) {
        const labelKey = `${networkId}/${appId}/${group}`;
        const { finalLabel, uniqueId, entityId, area, discoveryTopic } = this._resolveEntityIdentity({
            networkId, appId, groupId: group, labelKey,
            component: TEMPERATURE_ENTITY.component,
            fallbackLabel: TEMPERATURE_ENTITY.fallbackLabel(networkId, appId, group)
        });

        this._finishEventDrivenEntity({
            discoveryTopic, uniqueId, entityId,
            component: TEMPERATURE_ENTITY.component,
            fields: TEMPERATURE_ENTITY.fields(networkId, appId, group),
            deviceIdentifiers: [uniqueId],
            deviceName: finalLabel,
            model: TEMPERATURE_ENTITY.model,
            area,
            logInfo: `Temperature sensor entity published: ${labelKey} (${finalLabel})`
        });
    }

    /**
     * Event-driven discovery for C-Bus Measurement (app 228) channels. Called
     * whenever a measurement reading is decoded; announces the HA sensor the
     * first time that device/channel is seen. Unlike Temperature (always °C),
     * Measurement covers heterogeneous quantities, so unit/device_class come
     * from the decoded reading rather than being fixed.
     *
     * @param {string|number} network
     * @param {string|number} appId - measurement app id (e.g. 228)
     * @param {string|number} device
     * @param {string|number} channel
     * @param {{unit: string|null, deviceClass: string|null}} reading - decoded measurementDecoder reading
     * @returns {boolean} true if a new sensor entity was published this call
     */
    ensureMeasurementDiscovery(network, appId, device, channel, reading) {
        if (!this.settings.ha_discovery_enabled) return false;
        if (network === null || network === undefined || appId === null || appId === undefined
            || device === null || device === undefined || channel === null || channel === undefined) return false;

        const key = `${network}/${appId}/${device}/${channel}`;
        return this._ensureEventDrivenEntity({
            key,
            seen: this._measurementSeen,
            describe: `measurement channel ${key}`,
            retract: () => this._retractEventDrivenConfig(
                `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_SENSOR}/cgateweb_${network}_${appId}_${device}_${channel}/${HA_DISCOVERY_SUFFIX}`
            ),
            create: () => this._createMeasurementDiscovery(String(network), String(appId), String(device), String(channel), reading)
        });
    }

    /**
     * Build and publish the measurement sensor discovery payload for one
     * device/channel. State comes from the measurementDecoder reading topic
     * (cbus/read/{net}/{app}/{device}/{channel}/value).
     *
     * @private
     */
    _createMeasurementDiscovery(networkId, appId, device, channel, reading) {
        const groupId = `${device}_${channel}`;
        const labelKey = `${networkId}/${appId}/${device}/${channel}`;
        const { finalLabel, uniqueId, entityId, area, discoveryTopic } = this._resolveEntityIdentity({
            networkId, appId, groupId, labelKey,
            component: MEASUREMENT_ENTITY.component,
            fallbackLabel: MEASUREMENT_ENTITY.fallbackLabel(networkId, appId, device, channel)
        });

        this._finishEventDrivenEntity({
            discoveryTopic, uniqueId, entityId,
            component: MEASUREMENT_ENTITY.component,
            fields: MEASUREMENT_ENTITY.fields(networkId, appId, device, channel, reading),
            deviceIdentifiers: [uniqueId],
            deviceName: finalLabel,
            model: MEASUREMENT_ENTITY.model,
            area,
            logInfo: `Measurement sensor entity published: ${labelKey} (${finalLabel})`
        });
    }

    /**
     * Event-driven discovery for C-Bus Security (app 208) zones. Called
     * whenever a zone event or status report mentions a zone; announces the
     * HA binary_sensor the first time that zone is seen. Follows the
     * ensureTemperatureDiscovery contract: idempotent Seen set, `exclude`
     * honored with retraction, topics registered in _publishedTopics and
     * _eventDrivenDiscoveryTopics so tree-run stale cleanup skips them.
     *
     * @param {string|number} network
     * @param {string|number} appId - security app id (e.g. 208)
     * @param {string|number} zone  - security zone number (1-127)
     * @returns {boolean} true if a new binary_sensor entity was published this call
     */
    ensureSecurityZoneDiscovery(network, appId, zone) {
        if (!this.settings.ha_discovery_enabled) return false;
        if (network === null || network === undefined || appId === null || appId === undefined || zone === null || zone === undefined) return false;

        const key = `${network}/${appId}/${zone}`;
        return this._ensureEventDrivenEntity({
            key,
            seen: this._securityZoneSeen,
            // Zone labels live under application 1 in the Toolkit project, so
            // an exclusion can be recorded against either key shape.
            excludeKeys: [key, securityZoneLabelKey(network, zone)],
            describe: `security zone ${key}`,
            retract: () => {
                this._retractEventDrivenConfig(
                    `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_BINARY_SENSOR}/cgateweb_${network}_${appId}_${zone}/${HA_DISCOVERY_SUFFIX}`
                );
                this._retractEventDrivenConfig(
                    `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_BINARY_SENSOR}/cgateweb_${network}_${appId}_${zone}_loop_fault/${HA_DISCOVERY_SUFFIX}`
                );
            },
            create: () => this._createSecurityZoneDiscovery(String(network), String(appId), String(zone))
        });
    }

    /**
     * Build and publish the binary_sensor discovery payload for one security
     * zone. State comes from the securityEventHandler zone topics
     * (cbus/read/{net}/{app}/{zone}/state ON = unsealed/open/short, OFF =
     * sealed); the raw 2-bit state name rides the JSON attributes topic.
     * The zone's name and device class come from its application-1 label.
     *
     * @private
     */
    _createSecurityZoneDiscovery(networkId, appId, zone) {
        // Zone labels live under application 1 in the Toolkit project (the
        // label importer stores them as {net}/1/{zone} keys).
        const labelKey = securityZoneLabelKey(networkId, zone);
        const { finalLabel, uniqueId, entityId, area, discoveryTopic } = this._resolveEntityIdentity({
            networkId, appId, groupId: zone, labelKey,
            component: SECURITY_ZONE_ENTITY.component,
            fallbackLabel: SECURITY_ZONE_ENTITY.fallbackLabel(networkId, appId, zone)
        });
        const deviceClass = classifySecurityZoneDeviceClass(finalLabel, this.settings);

        this._finishEventDrivenEntity({
            discoveryTopic, uniqueId, entityId,
            component: SECURITY_ZONE_ENTITY.component,
            fields: SECURITY_ZONE_ENTITY.fields(networkId, appId, zone, deviceClass),
            deviceIdentifiers: [uniqueId],
            deviceName: finalLabel,
            model: SECURITY_ZONE_ENTITY.model,
            area,
            logInfo: `Security zone binary_sensor published: ${networkId}/${appId}/${zone} (${finalLabel})`
        });

        const loopFaultUniqueId = `${uniqueId}_loop_fault`;
        this._finishEventDrivenEntity({
            discoveryTopic: `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_BINARY_SENSOR}/${loopFaultUniqueId}/${HA_DISCOVERY_SUFFIX}`,
            uniqueId: loopFaultUniqueId,
            entityId: undefined,
            component: HA_COMPONENT_BINARY_SENSOR,
            name: 'Loop fault',
            fields: {
                state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/${zone}/${MQTT_TOPIC_SUFFIX_LOOP_FAULT}`,
                payload_on: MQTT_STATE_ON,
                payload_off: MQTT_STATE_OFF,
                device_class: 'problem',
                entity_category: 'diagnostic'
            },
            deviceIdentifiers: [uniqueId],
            deviceName: finalLabel,
            model: SECURITY_ZONE_ENTITY.model,
            area
        });
    }

    /**
     * Announce the seven panel-wide trouble binary_sensors for a network the
     * first time any security traffic is seen on it. Follows the
     * ensureSecurityZoneDiscovery contract: idempotent Seen set, `exclude`
     * honored with retraction, topics registered in _publishedTopics and
     * _eventDrivenDiscoveryTopics so tree-run stale cleanup skips them.
     *
     * Unlike zones (one HA device each), all seven share a single "C-Bus
     * Security Panel" device: they describe the panel's health, not seven
     * separate pieces of hardware. entity_category 'diagnostic' keeps them off
     * auto-generated dashboards.
     *
     * @param {string|number} network
     * @param {string|number} appId - security app id (e.g. 208)
     * @returns {boolean} true if the entities were published this call
     */
    ensureSecurityPanelDiscovery(network, appId) {
        if (!this.settings.ha_discovery_enabled) return false;
        if (network === null || network === undefined || appId === null || appId === undefined) return false;

        const key = `${network}/${appId}/panel`;
        return this._ensureEventDrivenEntity({
            key,
            seen: this._securityPanelSeen,
            describe: `security panel ${network}/${appId}`,
            retract: () => {
                for (const condition of PANEL_CONDITIONS) {
                    this._retractEventDrivenConfig(
                        this._securityPanelTopic(this._securityPanelUniqueId(String(network), String(appId), condition.id))
                    );
                }
                this._retractEventDrivenConfig(this._securityAlarmTopic(String(network), String(appId)));
                this._retractEventDrivenConfig(
                    `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_SENSOR}/cgateweb_${network}_${appId}_password_entry/${HA_DISCOVERY_SUFFIX}`
                );
                this._retractEventDrivenConfig(
                    `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_SENSOR}/cgateweb_${network}_${appId}_bypassed_zones/${HA_DISCOVERY_SUFFIX}`
                );
            },
            create: () => this._createSecurityPanelDiscovery(String(network), String(appId))
        });
    }

    /**
     * unique_id for one panel trouble condition. The discovery topic embeds this,
     * so both must come from here or a retraction would target a topic HA never
     * saw and orphan the entity.
     *
     * @param {string} networkId
     * @param {string} appId
     * @param {string} conditionId
     * @returns {string}
     * @private
     */
    _securityPanelUniqueId(networkId, appId, conditionId) {
        return `cgateweb_${networkId}_${appId}_panel_${conditionId}`;
    }

    /**
     * @param {string} uniqueId
     * @returns {string}
     * @private
     */
    _securityPanelTopic(uniqueId) {
        return `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_BINARY_SENSOR}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`;
    }

    /**
     * Discovery config topic for the panel's alarm_control_panel entity.
     *
     * @param {string} networkId
     * @param {string} appId
     * @returns {string}
     * @private
     */
    _securityAlarmTopic(networkId, appId) {
        return `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_ALARM_PANEL}/cgateweb_${networkId}_${appId}_panel/${HA_DISCOVERY_SUFFIX}`;
    }

    /**
     * Build and publish the panel trouble binary_sensor payloads, one per
     * condition. State comes from securityEventHandler via
     * cbus/read/{net}/{app}/panel/{condition}/state (ON = trouble present).
     *
     * @private
     */
    _createSecurityPanelDiscovery(networkId, appId) {
        const deviceName = `C-Bus Security Panel ${networkId}/${appId}`;
        const deviceIdentifiers = [`cgateweb_${networkId}_${appId}_panel`];
        for (const condition of PANEL_CONDITIONS) {
            const uniqueId = this._securityPanelUniqueId(networkId, appId, condition.id);
            const readBase = `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/panel/${condition.id}`;

            this._finishEventDrivenEntity({
                discoveryTopic: this._securityPanelTopic(uniqueId),
                uniqueId,
                component: HA_COMPONENT_BINARY_SENSOR,
                // Several entities on one shared device, so each needs its own
                // name (zones use null, taking the device name instead).
                name: condition.name,
                fields: {
                    state_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_STATE}`,
                    payload_on: MQTT_STATE_ON,
                    payload_off: MQTT_STATE_OFF,
                    device_class: condition.deviceClass,
                    entity_category: 'diagnostic'
                },
                deviceIdentifiers,
                deviceName,
                model: 'C-Bus Security Panel'
            });
        }
        this.logger.info(`Security panel binary_sensors published: ${networkId}/${appId} (${PANEL_CONDITIONS.length} conditions)`);

        this._createSecurityAlarmDiscovery(networkId, appId, deviceName);

        this._finishEventDrivenEntity({
            discoveryTopic: `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_SENSOR}/cgateweb_${networkId}_${appId}_password_entry/${HA_DISCOVERY_SUFFIX}`,
            uniqueId: `cgateweb_${networkId}_${appId}_password_entry`,
            component: HA_COMPONENT_SENSOR,
            name: 'Password entry',
            fields: {
                state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/panel/${MQTT_TOPIC_SUFFIX_PASSWORD_ENTRY}`,
                entity_category: 'diagnostic'
            },
            deviceIdentifiers,
            deviceName,
            model: 'C-Bus Security Panel'
        });

        this._finishEventDrivenEntity({
            discoveryTopic: `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_SENSOR}/cgateweb_${networkId}_${appId}_bypassed_zones/${HA_DISCOVERY_SUFFIX}`,
            uniqueId: `cgateweb_${networkId}_${appId}_bypassed_zones`,
            component: HA_COMPONENT_SENSOR,
            name: 'Bypassed zones',
            fields: {
                state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/panel/bypassed_zones/${MQTT_TOPIC_SUFFIX_STATE}`,
                json_attributes_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/panel/bypassed_zones/${MQTT_TOPIC_SUFFIX_ATTRIBUTES}`,
                entity_category: 'diagnostic',
                icon: 'mdi:shield-off-outline'
            },
            deviceIdentifiers,
            deviceName,
            model: 'C-Bus Security Panel'
        });
    }

    /**
     * Build and publish the alarm_control_panel entity for the security
     * panel, on the same device as the trouble sensors. State comes from
     * securityEventHandler via cbus/read/{net}/{app}/panel/state (HA alarm
     * states); the arm_not_ready blocking zone rides the attributes topic.
     * Control is opt-in via cbus_security_control_enabled — an arm write
     * carries no PIN on the bus. Read-only cannot mean "no command_topic",
     * though: Home Assistant's MQTT alarm schema requires that key and throws
     * away the whole config without it ("required key not provided @
     * data['command_topic']"), so the entity never appeared at all for the
     * default (control off) install. The topic is therefore always published
     * and read-only is expressed by advertising no arm actions; the router
     * refuses any write that arrives on it while control is off.
     *
     * Home Assistant always renders a Disarm button (supported_features has no
     * disarm flag to withhold). Whether it does anything depends on
     * cbus_security_disarm_enabled, a second opt-in on top of control: C-Bus
     * has no disarm command, so disarming means replaying the PIN through
     * Emulate Keypad (#51), and that is a bigger decision than arming.
     *
     * With disarm on, the panel uses Home Assistant's own keypad via
     * `code: REMOTE_CODE`. That is the variant worth having: HA shows a numeric
     * keypad and passes what was typed straight through to us, so the PIN lives
     * nowhere in configuration — not in the add-on options, not in HA's. The
     * cost is that it crosses MQTT on each disarm, which the docs say plainly.
     *
     * @private
     */
    _createSecurityAlarmDiscovery(networkId, appId, deviceName) {
        const uniqueId = `cgateweb_${networkId}_${appId}_panel`;
        const discoveryTopic = this._securityAlarmTopic(networkId, appId);
        const readBase = `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/panel`;
        const controlEnabled = !!this.settings.cbus_security_control_enabled;
        // Disarm rides on control: the router refuses every panel write while
        // control is off, so there would be nothing for a PIN to reach.
        const disarmEnabled = controlEnabled && !!this.settings.cbus_security_disarm_enabled;
        // Same shape as disarm: a second opt-in riding on control. Withheld
        // from supported_features rather than accepted-and-ignored, so the
        // alarm card never offers a "force arm" the bridge will refuse.
        const bypassEnabled = controlEnabled && !!this.settings.cbus_security_bypass_enabled;

        this._finishEventDrivenEntity({
            discoveryTopic, uniqueId,
            component: HA_COMPONENT_ALARM_PANEL,
            // Primary entity on the shared panel device: takes the device name.
            fields: {
                state_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_STATE}`,
                json_attributes_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_ATTRIBUTES}`,
                // Arm away/night/home(day-stay)/vacation, plus arm_custom_bypass.
                // No manual trigger on this panel, and disarm is not in this list
                // because HA has no such flag — see the note above.
                //
                // arm_custom_bypass is mapped to the '#' keypress that forces an
                // arm past an open zone. That is not quite HA's literal meaning
                // (arm while excluding chosen zones), but it is the closest native
                // action and it is what the panel actually offers, so the bypass
                // appears on the alarm card itself instead of only as a separate
                // button entity (#62). Present only with cbus_security_bypass_enabled.
                //
                // Empty with control off: that is how a read-only panel is
                // expressed now that the command topic has to be present
                // regardless, so the card shows state without offering an arm
                // the bridge would refuse.
                supported_features: controlEnabled
                    ? [
                        'arm_home', 'arm_away', 'arm_night', 'arm_vacation',
                        ...(bypassEnabled ? ['arm_custom_bypass'] : [])
                    ]
                    : [],
                // Home Assistant defaults both of these to true and then refuses to
                // publish an arm/disarm without a code — it pops "PIN required" and
                // the command never reaches MQTT at all, which is how 1.23.1 shipped
                // an arm button that did nothing (#42). Arming carries no PIN on
                // C-Bus, so there is never a code to enter for it.
                code_arm_required: false,
                code_disarm_required: disarmEnabled,
                command_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${appId}/panel/arm`,
                ...(disarmEnabled && {
                    // REMOTE_CODE: show HA's numeric keypad but skip HA's local
                    // validation, since only the panel can judge the PIN. A literal
                    // code here would be a second PIN to keep in sync and would
                    // block the real one from ever reaching the panel.
                    code: 'REMOTE_CODE',
                    // tojson rather than hand-quoting: a code is user input, and an
                    // embedded quote would otherwise produce malformed JSON. Arm
                    // actions come through here too with an empty code.
                    command_template:
                        '{"action": {{ action | tojson }}, "code": {{ (code or "") | tojson }}}'
                })
            },
            deviceIdentifiers: [uniqueId],
            deviceName,
            model: 'C-Bus Security Panel'
        });
        const mode = !controlEnabled
            ? 'read-only'
            : [disarmEnabled ? 'arm + disarm' : 'arm only', bypassEnabled ? '+ bypass' : ''].filter(Boolean).join(' ');
        this.logger.info(`Security panel alarm_control_panel published: ${networkId}/${appId} (${mode})`);

        // The bypass button is a control write (Emulate Keypad '#') behind its
        // own opt-in, so it only exists when both are on — otherwise it would
        // be a button that always logs "disabled" and does nothing.
        if (bypassEnabled) {
            this._createSecurityBypassDiscovery(networkId, appId, deviceName);
        }
    }

    /**
     * Build and publish the "Bypass open zones" button on the security panel
     * device. Pressing it sends the '#' keypress via `security emulate_keypad`,
     * which is what the physical keypad uses to bypass open zones when arming
     * stalls at arm_not_ready (issue #42).
     *
     * @private
     */
    _createSecurityBypassDiscovery(networkId, appId, deviceName) {
        const uniqueId = `cgateweb_${networkId}_${appId}_panel_bypass`;
        this._finishEventDrivenEntity({
            discoveryTopic: `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_BUTTON}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`,
            uniqueId,
            component: HA_COMPONENT_BUTTON,
            name: 'Bypass open zones',
            fields: {
                command_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${appId}/panel/bypass`
            },
            deviceIdentifiers: [`cgateweb_${networkId}_${appId}_panel`],
            deviceName,
            model: 'C-Bus Security Panel',
            logInfo: `Security panel zone-bypass button published: ${networkId}/${appId}`
        });
    }

    /**
     * Retract one event-driven discovery config: clear the retained message and
     * forget it, so a later tree run's stale cleanup doesn't try to clear it
     * again and the replay cache doesn't resurrect it on a broker reconnect.
     *
     * @param {string} topic
     * @private
     */
    _retractEventDrivenConfig(topic) {
        this._publish(topic, '', MQTT_RETAINED_STATE_OPTIONS);
        this._publishedTopics.delete(topic);
        this._eventDrivenDiscoveryTopics.delete(topic);
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

    _createDiscovery(networkId, appId, groupId, groupLabel, config) {
        const { exclude } = this._labelSnapshot;
        const labelKey = `${networkId}/${appId}/${groupId}`;

        if (exclude.has(labelKey)) {
            this.logger.debug(`Excluding group ${labelKey} from discovery`);
            return;
        }

        const { finalLabel, uniqueId, entityId, area, discoveryTopic } = this._resolveEntityIdentity({
            networkId, appId, groupId, labelKey,
            component: config.component,
            fallbackLabel: `CBus ${config.defaultType} ${networkId}/${appId}/${groupId}`,
            groupLabel,
            labels: this._labelSnapshot
        });

        const { readBase, writeBase } = this._topicBases(networkId, appId, groupId);

        // HA event entities use a dedicated event topic (not state topic) and must not be retained
        const stateTopic = config.isTrigger
            ? `${readBase}/${MQTT_TOPIC_SUFFIX_EVENT}`
            : `${readBase}/${MQTT_TOPIC_SUFFIX_STATE}`;

        // NOTE: command topics must NOT be retained. A retained command sits on the
        // broker and is redelivered to cgateweb on every (re)connect, replaying stale
        // ON/OFF/RAMP commands that toggle devices unexpectedly. State retention is
        // handled separately by the read/state publish options, not here.
        this._finishTreeEntity({
            discoveryTopic, uniqueId, entityId,
            component: config.component,
            fields: {
                state_topic: stateTopic,
                ...(!config.omitCommandTopic && { command_topic: `${writeBase}/${MQTT_CMD_TYPE_SWITCH}` }),
                ...config.payloads,
                ...(config.positionSupport && {
                    position_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_POSITION}`,
                    set_position_topic: `${writeBase}/${MQTT_CMD_TYPE_POSITION}`,
                    stop_topic: `${writeBase}/${MQTT_CMD_TYPE_STOP}`,
                    payload_stop: MQTT_COMMAND_STOP,
                    position_open: 100,
                    position_closed: 0,
                    optimistic: false
                }),
                ...(config.positionSupport && this.settings.ha_discovery_cover_tilt_app_id && {
                    tilt_status_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${this.settings.ha_discovery_cover_tilt_app_id}/${groupId}/${MQTT_TOPIC_SUFFIX_TILT}`,
                    tilt_command_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${this.settings.ha_discovery_cover_tilt_app_id}/${groupId}/${MQTT_CMD_TYPE_TILT}`,
                    tilt_min: 0,
                    tilt_max: 100,
                    tilt_optimistic: false
                }),
                ...(config.deviceClass && { device_class: config.deviceClass })
            },
            deviceIdentifiers: [uniqueId],
            deviceName: finalLabel,
            model: config.model,
            area
        });

        // For trigger groups, also publish companion entities:
        // - a button entity so HA automations can fire the C-Bus trigger via the trigger topic
        // - a scene entity (when enabled) so HA scenes can activate the C-Bus scene via the switch topic
        if (config.isTrigger) {
            this._publishTriggerButton(networkId, appId, groupId, finalLabel);
            if (this.settings.ha_discovery_scene_enabled !== false) {
                this._publishTriggerScene(networkId, appId, groupId, finalLabel);
            }
        }
    }

    _publishTriggerButton(networkId, appId, groupId, label) {
        const { entityIds } = this._labelSnapshot;
        const labelKey = `${networkId}/${appId}/${groupId}`;
        const uniqueId = `cgateweb_${networkId}_${appId}_${groupId}_btn`;
        const entityId = entityIds.get(labelKey);
        this._finishTreeEntity({
            discoveryTopic: `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_BUTTON}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`,
            uniqueId,
            entityId: entityId ? `${entityId}_btn` : undefined,
            component: HA_COMPONENT_BUTTON,
            fields: {
                command_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${appId}/${groupId}/${MQTT_CMD_TYPE_TRIGGER}`,
                payload_press: MQTT_STATE_ON,
                retain: false
            },
            deviceIdentifiers: [`cgateweb_${networkId}_${appId}_${groupId}`],
            deviceName: label,
            model: HA_MODEL_TRIGGER
        });
    }

    _publishTriggerScene(networkId, appId, groupId, label) {
        const { entityIds } = this._labelSnapshot;
        const labelKey = `${networkId}/${appId}/${groupId}`;
        const uniqueId = `cgateweb_${networkId}_${appId}_${groupId}_scene`;
        const entityId = entityIds.get(labelKey);
        this._finishTreeEntity({
            discoveryTopic: `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_SCENE}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`,
            uniqueId,
            entityId: entityId ? `${entityId}_scene` : undefined,
            component: HA_COMPONENT_SCENE,
            fields: {
                command_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${appId}/${groupId}/${MQTT_CMD_TYPE_SWITCH}`,
                payload_on: MQTT_STATE_ON,
                retain: false
            },
            deviceIdentifiers: [`cgateweb_${networkId}_${appId}_${groupId}`],
            deviceName: label,
            model: HA_MODEL_TRIGGER
        });
    }
}

const methods = {};
for (const name of Object.getOwnPropertyNames(_HaDiscoveryPublishers.prototype)) {
    if (name === 'constructor') continue;
    methods[name] = _HaDiscoveryPublishers.prototype[name];
}
module.exports = methods;
