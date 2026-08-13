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
    MQTT_TOPIC_SUFFIX_HVAC_CURRENT_TEMP,
    MQTT_TOPIC_SUFFIX_HVAC_SETPOINT,
    MQTT_TOPIC_SUFFIX_HVAC_MODE,
    MQTT_TOPIC_SUFFIX_HVAC_FAN_MODE,
    MQTT_TOPIC_SUFFIX_HVAC_ACTION,
    MQTT_TOPIC_SUFFIX_HVAC_CURRENT_HUMIDITY,
    MQTT_TOPIC_SUFFIX_HVAC_HUMIDITY_SETPOINT,
    MQTT_TOPIC_SUFFIX_HVAC_PROBLEM,
    MQTT_TOPIC_SUFFIX_HVAC_SENSOR_PROBLEM,
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
    entityIdFields
} = require('./constants');
const { PANEL_CONDITIONS } = require('./securityPanelConditions');

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
    _securityPanelSeen;

    /** @type {Set<string>} */
    _currentRunTopics;

    /**
     * Per-run label data snapshot installed by _publishDiscoveryFromTree for
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
        const { labelMap, entityIds, areas } = this._labelSnapshot;

        const customLabel = labelMap.get(labelKey);
        const groupLabel = group.Label;
        const finalLabel = customLabel || groupLabel || spec.fallbackLabel;
        if (customLabel) this.labelStats.custom++;
        else if (groupLabel) this.labelStats.treexml++;
        else this.labelStats.fallback++;

        const uniqueId = `cgateweb_${networkId}_${appId}_${groupId}`;
        const entityId = entityIds.get(labelKey);
        const area = areas && areas.get(labelKey);
        const discoveryTopic = `${this.settings.ha_discovery_prefix}/${spec.component}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`;

        const payload = {
            name: null,
            unique_id: uniqueId,
            ...(entityId && entityIdFields(spec.component, entityId)),
            ...spec.fields({
                read: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/${groupId}`,
                write: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${appId}/${groupId}`
            }),
            qos: 0,
            // command topics must NOT be retained: a retained command replays to
            // cgateweb on every reconnect and re-toggles the light (see _createDiscovery).
            device: buildDeviceBlock({
                identifiers: [uniqueId],
                name: finalLabel,
                model: HA_MODEL_LIGHTING,
                area
            }),
            origin: buildOriginBlock()
        };

        this._publish(discoveryTopic, JSON.stringify(payload), MQTT_RETAINED_STATE_OPTIONS);
        if (this._currentRunTopics) this._currentRunTopics.add(discoveryTopic);
        this.discoveryCount++;
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

            if (discoveryType === 'hvac') {
                this._createHvacDiscovery(networkId, appAddress, groupId, group.Label);
            } else {
                this._createDiscovery(networkId, appAddress, groupId, group.Label, getDiscoveryConfig(discoveryType));
            }
        });
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
        const discoveryTopic = `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_BINARY_SENSOR}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`;
        const payload = {
            name: 'CNI Connectivity',
            unique_id: uniqueId,
            device_class: 'connectivity',
            state_topic: `${MQTT_TOPIC_PREFIX_READ}/${net}/cni/state`,
            payload_on: MQTT_STATE_ON,
            payload_off: MQTT_STATE_OFF,
            qos: 0,
            device: buildDeviceBlock({
                identifiers: [`cgateweb_network_${net}`],
                name: `C-Bus Network ${net}`,
                model: 'C-Bus Network Interface'
            }),
            origin: buildOriginBlock()
        };

        this._publish(discoveryTopic, JSON.stringify(payload), MQTT_RETAINED_STATE_OPTIONS);
        this._publishedTopics.add(discoveryTopic);
        this._eventDrivenDiscoveryTopics.add(discoveryTopic);
        this._cniDiscoverySeen.add(net);
        this.discoveryCount++;
        this.logger.info(`CNI connectivity binary_sensor published for network ${net}`);
        return true;
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
        if (this._temperatureSeen.has(key)) return false;

        if (this.exclude.has(key)) {
            this.logger.debug(`Excluding temperature group ${key} from discovery`);
            const excludedUniqueId = `cgateweb_${network}_${appId}_${group}`;
            const excludedTopic = `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_SENSOR}/${excludedUniqueId}/${HA_DISCOVERY_SUFFIX}`;
            this._retractEventDrivenConfig(excludedTopic);
            this._temperatureSeen.add(key); // don't re-check on every event
            return false;
        }

        this._createTemperatureDiscovery(String(network), String(appId), String(group));
        this._temperatureSeen.add(key);
        return true;
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
     * Build and publish the temperature sensor discovery payload for one group.
     * State comes from the app-25 temperatureDecoder reading topic
     * (cbus/read/{net}/{app}/{group}/current_temperature, °C = byte/4).
     *
     * @private
     */
    _createTemperatureDiscovery(networkId, appId, group) {
        const labelKey = `${networkId}/${appId}/${group}`;
        const { finalLabel, uniqueId, entityId, area, discoveryTopic } = this._resolveEntityIdentity({
            networkId, appId, groupId: group, labelKey,
            component: HA_COMPONENT_SENSOR,
            fallbackLabel: `CBus Temperature ${networkId}/${appId}/${group}`
        });

        const payload = {
            name: null,
            unique_id: uniqueId,
            ...(entityId && entityIdFields(HA_COMPONENT_SENSOR, entityId)),

            state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/${group}/${MQTT_TOPIC_SUFFIX_HVAC_CURRENT_TEMP}`,
            device_class: 'temperature',
            state_class: 'measurement',
            unit_of_measurement: '°C', // app-25 wire format is always °C (byte/4)

            qos: 0,
            device: buildDeviceBlock({
                identifiers: [uniqueId],
                name: finalLabel,
                model: 'C-Bus Temperature Sensor',
                area
            }),
            origin: buildOriginBlock()
        };

        this._publishEventDrivenConfig(discoveryTopic, payload);
        this.logger.info(`Temperature sensor entity published: ${labelKey} (${finalLabel})`);
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
        if (this._securityZoneSeen.has(key)) return false;

        // Zone labels live under application 1 in the Toolkit project, so an
        // exclusion can be recorded against either key shape.
        const labelKey = securityZoneLabelKey(network, zone);
        if (this.exclude.has(key) || this.exclude.has(labelKey)) {
            this.logger.debug(`Excluding security zone ${key} from discovery`);
            const excludedUniqueId = `cgateweb_${network}_${appId}_${zone}`;
            const excludedTopic = `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_BINARY_SENSOR}/${excludedUniqueId}/${HA_DISCOVERY_SUFFIX}`;
            this._retractEventDrivenConfig(excludedTopic);
            this._securityZoneSeen.add(key); // don't re-check on every event
            return false;
        }

        this._createSecurityZoneDiscovery(String(network), String(appId), String(zone));
        this._securityZoneSeen.add(key);
        return true;
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
            component: HA_COMPONENT_BINARY_SENSOR,
            fallbackLabel: `CBus Security Zone ${networkId}/${appId}/${zone}`
        });
        const readBase = `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/${zone}`;
        const deviceClass = classifySecurityZoneDeviceClass(finalLabel, this.settings);

        const payload = {
            name: null,
            unique_id: uniqueId,
            ...(entityId && entityIdFields(HA_COMPONENT_BINARY_SENSOR, entityId)),

            state_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_STATE}`,
            payload_on: MQTT_STATE_ON,
            payload_off: MQTT_STATE_OFF,
            json_attributes_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_ATTRIBUTES}`,
            ...(deviceClass && { device_class: deviceClass }),

            qos: 0,
            device: buildDeviceBlock({
                identifiers: [uniqueId],
                name: finalLabel,
                model: 'C-Bus Security Zone',
                area
            }),
            origin: buildOriginBlock()
        };

        this._publishEventDrivenConfig(discoveryTopic, payload);
        this.logger.info(`Security zone binary_sensor published: ${networkId}/${appId}/${zone} (${finalLabel})`);
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
        if (this._securityPanelSeen.has(key)) return false;

        if (this.exclude.has(key)) {
            this.logger.debug(`Excluding security panel ${network}/${appId} from discovery`);
            for (const condition of PANEL_CONDITIONS) {
                this._retractEventDrivenConfig(
                    this._securityPanelTopic(this._securityPanelUniqueId(String(network), String(appId), condition.id))
                );
            }
            this._retractEventDrivenConfig(this._securityAlarmTopic(String(network), String(appId)));
            this._securityPanelSeen.add(key); // don't re-check on every event
            return false;
        }

        this._createSecurityPanelDiscovery(String(network), String(appId));
        this._securityPanelSeen.add(key);
        return true;
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
        for (const condition of PANEL_CONDITIONS) {
            const uniqueId = this._securityPanelUniqueId(networkId, appId, condition.id);
            const discoveryTopic = this._securityPanelTopic(uniqueId);
            const readBase = `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/panel/${condition.id}`;

            const payload = {
                // Several entities on one shared device, so each needs its own
                // name (zones use null, taking the device name instead).
                name: condition.name,
                unique_id: uniqueId,

                state_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_STATE}`,
                payload_on: MQTT_STATE_ON,
                payload_off: MQTT_STATE_OFF,
                device_class: condition.deviceClass,
                entity_category: 'diagnostic',

                qos: 0,
                device: buildDeviceBlock({
                    identifiers: [`cgateweb_${networkId}_${appId}_panel`],
                    name: deviceName,
                    model: 'C-Bus Security Panel'
                }),
                origin: buildOriginBlock()
            };

            this._publishEventDrivenConfig(discoveryTopic, payload);
        }
        this.logger.info(`Security panel binary_sensors published: ${networkId}/${appId} (${PANEL_CONDITIONS.length} conditions)`);

        this._createSecurityAlarmDiscovery(networkId, appId, deviceName);
    }

    /**
     * Build and publish the alarm_control_panel entity for the security
     * panel, on the same device as the trouble sensors. State comes from
     * securityEventHandler via cbus/read/{net}/{app}/panel/state (HA alarm
     * states); the arm_not_ready blocking zone rides the attributes topic.
     * The command topic only exists when cbus_security_control_enabled — an
     * arm write carries no PIN on the bus, so control is opt-in (the entity
     * is read-only without it, following the native-aircon precedent).
     *
     * Home Assistant always renders a Disarm button once a command_topic exists
     * (supported_features has no disarm flag to withhold). Whether it does
     * anything depends on cbus_security_disarm_enabled, a second opt-in on top
     * of control: C-Bus has no disarm command, so disarming means replaying the
     * PIN through Emulate Keypad (#51), and that is a bigger decision than
     * arming.
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
        // Disarm rides on control: without a command topic there is nothing to
        // send a PIN over.
        const disarmEnabled = controlEnabled && !!this.settings.cbus_security_disarm_enabled;

        const payload = {
            // Primary entity on the shared panel device: takes the device name.
            name: null,
            unique_id: uniqueId,

            state_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_STATE}`,
            json_attributes_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_ATTRIBUTES}`,
            // Arm away/night/home(day-stay)/vacation; no custom bypass and no
            // manual trigger on this panel. Disarm is not in this list because
            // HA has no such flag — see the note above.
            supported_features: ['arm_home', 'arm_away', 'arm_night', 'arm_vacation'],
            // Home Assistant defaults both of these to true and then refuses to
            // publish an arm/disarm without a code — it pops "PIN required" and
            // the command never reaches MQTT at all, which is how 1.23.1 shipped
            // an arm button that did nothing (#42). Arming carries no PIN on
            // C-Bus, so there is never a code to enter for it.
            code_arm_required: false,
            code_disarm_required: disarmEnabled,
            ...(controlEnabled && {
                command_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${appId}/panel/arm`
            }),
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
            }),

            qos: 0,
            device: buildDeviceBlock({
                identifiers: [uniqueId],
                name: deviceName,
                model: 'C-Bus Security Panel'
            }),
            origin: buildOriginBlock()
        };

        this._publishEventDrivenConfig(discoveryTopic, payload);
        const mode = !controlEnabled ? 'read-only' : (disarmEnabled ? 'arm + disarm' : 'arm only');
        this.logger.info(`Security panel alarm_control_panel published: ${networkId}/${appId} (${mode})`);

        // The bypass button is a control write (Emulate Keypad '#'), so it
        // only exists when control is enabled — without it the button could
        // never work.
        if (controlEnabled) {
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
        const discoveryTopic = `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_BUTTON}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`;

        const payload = {
            name: 'Bypass open zones',
            unique_id: uniqueId,
            command_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${appId}/panel/bypass`,
            qos: 0,
            device: buildDeviceBlock({
                identifiers: [`cgateweb_${networkId}_${appId}_panel`],
                name: deviceName,
                model: 'C-Bus Security Panel'
            }),
            origin: buildOriginBlock()
        };

        this._publishEventDrivenConfig(discoveryTopic, payload);
        this.logger.info(`Security panel zone-bypass button published: ${networkId}/${appId}`);
    }

    /**
     * Publish one event-driven discovery config and register it: session-wide
     * published-topics set (stale cleanup), event-driven set (so tree runs
     * don't retract it) and the entity counter. Inverse of
     * {@link _retractEventDrivenConfig}.
     *
     * @param {string} topic
     * @param {Object} payload - Discovery config payload (JSON-stringified here).
     * @private
     */
    _publishEventDrivenConfig(topic, payload) {
        this._publish(topic, JSON.stringify(payload), MQTT_RETAINED_STATE_OPTIONS);
        this._publishedTopics.add(topic);
        this._eventDrivenDiscoveryTopics.add(topic);
        this.discoveryCount++;
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
        if (this._nativeAirconSeen.has(key)) return false;

        if (this.exclude.has(key)) {
            this.logger.debug(`Excluding native HVAC unit ${key} from discovery`);
            // Clear any entities published on an earlier run (climate + problem
            // sensors) so they disappear from HA once the user excludes it (e.g.
            // a PAC/controller mirroring the real thermostats).
            for (const topic of this._nativeAirconDiscoveryTopics(network, appId, sourceUnit)) {
                this._retractEventDrivenConfig(topic);
            }
            this._nativeAirconSeen.add(key); // don't re-check on every event
            return false;
        }

        this._createNativeAirconDiscovery(String(network), String(appId), String(sourceUnit));
        this._nativeAirconSeen.add(key);
        return true;
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
        const temperatureUnit = (this.settings.ha_hvac_temperature_unit || 'C').toUpperCase() === 'F' ? 'F' : 'C';
        const readBase = `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/${sourceUnit}`;
        const writeBase = `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${appId}/${sourceUnit}`;
        const controlEnabled = !!this.settings.cbus_aircon_control_enabled;

        const payload = {
            name: null,
            unique_id: uniqueId,
            ...(entityId && entityIdFields(HA_COMPONENT_CLIMATE, entityId)),

            // State topics published by the native aircon decoder.
            current_temperature_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_CURRENT_TEMP}`,
            temperature_state_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_SETPOINT}`,
            mode_state_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_MODE}`,
            action_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_ACTION}`,
            // Humidity state (spec-derived humidity verbs; only populated on
            // installs with humidity plant). Read-only — no humidity writes.
            // Note the key is target_humidity_state_topic: the MQTT climate
            // schema has no "humidity_state_topic" — that key is silently dead.
            current_humidity_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_CURRENT_HUMIDITY}`,
            target_humidity_state_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_HUMIDITY_SETPOINT}`,
            min_humidity: 0,
            max_humidity: 100,
            // Fan mode from the Aux Level (spec §25.6.11 bit 6). HA accepts an
            // arbitrary fan_modes list; the C-Bus values are automatic/continuous.
            // (Raw 0-63 fan speed has no HA climate equivalent — it stays on the
            // fan_speed MQTT topic.)
            fan_mode_state_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_FAN_MODE}`,
            fan_modes: ['automatic', 'continuous'],

            // Command topics — only when control is opt-in enabled.
            ...(controlEnabled && {
                temperature_command_topic: `${writeBase}/${MQTT_CMD_TYPE_HVAC_SETPOINT}`,
                mode_command_topic: `${writeBase}/${MQTT_CMD_TYPE_HVAC_MODE}`,
                fan_mode_command_topic: `${writeBase}/${MQTT_CMD_TYPE_HVAC_FAN_MODE}`
            }),

            // Verified against real hardware (captures 2026-06-11).
            modes: ['off', 'heat', 'cool', 'auto', 'fan_only'],

            temperature_unit: temperatureUnit,
            min_temp: HVAC_MIN_TEMP_C,
            max_temp: HVAC_MAX_TEMP_C,
            temp_step: 0.5,

            qos: 0,
            device: buildDeviceBlock({
                identifiers: [uniqueId],
                name: finalLabel,
                model: 'C-Bus Air Conditioning Thermostat',
                area
            }),
            origin: buildOriginBlock()
        };

        this._publishEventDrivenConfig(discoveryTopic, payload);
        this.logger.info(`Native HVAC climate entity published: ${labelKey} (${finalLabel})`);

        this._createNativeAirconProblemSensors(networkId, appId, sourceUnit, uniqueId, finalLabel, area, readBase);
    }

    /**
     * All discovery config topics belonging to one native AC thermostat
     * (climate + problem binary_sensors) — used by the exclude path to retract
     * every entity for the unit.
     * @private
     */
    _nativeAirconDiscoveryTopics(network, appId, sourceUnit) {
        const base = `cgateweb_${network}_${appId}_${sourceUnit}`;
        const prefix = this.settings.ha_discovery_prefix;
        return [
            `${prefix}/${HA_COMPONENT_CLIMATE}/${base}/${HA_DISCOVERY_SUFFIX}`,
            `${prefix}/${HA_COMPONENT_BINARY_SENSOR}/${base}_problem/${HA_DISCOVERY_SUFFIX}`,
            `${prefix}/${HA_COMPONENT_BINARY_SENSOR}/${base}_sensor_problem/${HA_DISCOVERY_SUFFIX}`
        ];
    }

    /**
     * Publish the problem binary_sensors for one native AC thermostat: plant
     * error (spec §25.6.6 bit 6 / §25.6.5 code) and temperature-sensor fault
     * (§25.6.12). Both attach to the thermostat's device (same identifiers) and
     * are read-only — published regardless of cbus_aircon_control_enabled.
     * @private
     */
    _createNativeAirconProblemSensors(networkId, appId, sourceUnit, uniqueId, finalLabel, area, readBase) {
        const definitions = [
            { suffix: 'problem', name: 'Plant problem', stateTopic: `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_PROBLEM}` },
            { suffix: 'sensor_problem', name: 'Temperature sensor problem', stateTopic: `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_SENSOR_PROBLEM}` }
        ];
        for (const def of definitions) {
            const sensorUniqueId = `${uniqueId}_${def.suffix}`;
            const topic = `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_BINARY_SENSOR}/${sensorUniqueId}/${HA_DISCOVERY_SUFFIX}`;
            const payload = {
                name: def.name,
                unique_id: sensorUniqueId,
                device_class: 'problem',
                state_topic: def.stateTopic,
                payload_on: MQTT_STATE_ON,
                payload_off: MQTT_STATE_OFF,
                qos: 0,
                device: buildDeviceBlock({
                    identifiers: [uniqueId],
                    name: finalLabel,
                    model: 'C-Bus Air Conditioning Thermostat',
                    area
                }),
                origin: buildOriginBlock()
            };
            this._publishEventDrivenConfig(topic, payload);
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
     *   - Mode and fan control are not exposed via standard C-Gate level commands in the
     *     simplified implementation. Full mode/fan support would require vendor-specific
     *     C-Gate extensions or additional group addresses per zone.
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

        const temperatureUnit = (this.settings.ha_hvac_temperature_unit || 'C').toUpperCase() === 'F' ? 'F' : 'C';

        // Topic layout for this HVAC group
        const readBase = `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/${groupId}`;
        const writeBase = `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${appId}/${groupId}`;

        const payload = {
            name: null,
            unique_id: uniqueId,
            ...(entityId && entityIdFields(HA_COMPONENT_CLIMATE, entityId)),

            // Current temperature: reported by C-Gate as a status level on this group.
            // Template converts 0-255 C-Bus level to 0-50°C (0.5°C resolution):
            //   temperature = level / 255 * 50   (approximation; see TODO above)
            current_temperature_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_CURRENT_TEMP}`,

            // Target temperature setpoint — command and state topics
            temperature_command_topic: `${writeBase}/${MQTT_CMD_TYPE_HVAC_SETPOINT}`,
            temperature_state_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_SETPOINT}`,

            // Mode control topics
            mode_command_topic: `${writeBase}/${MQTT_CMD_TYPE_HVAC_MODE}`,
            mode_state_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_MODE}`,

            // Supported modes — based on typical C-Bus HVAC thermostat capabilities.
            // TODO: Hardware validation — some units may only support a subset of these.
            modes: ['off', 'auto', 'cool', 'heat', 'fan_only'],

            temperature_unit: temperatureUnit,
            min_temp: HVAC_MIN_TEMP_C,
            max_temp: HVAC_MAX_TEMP_C,
            temp_step: 0.5,

            qos: 0,
            // command topics must NOT be retained (see _createDiscovery note)
            device: buildDeviceBlock({
                identifiers: [uniqueId],
                name: finalLabel,
                model: 'HVAC Zone (Air Conditioning)',
                area
            }),
            origin: buildOriginBlock()
        };

        this._publish(discoveryTopic, JSON.stringify(payload), MQTT_RETAINED_STATE_OPTIONS);
        if (this._currentRunTopics) this._currentRunTopics.add(discoveryTopic);
        this.discoveryCount++;
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

        // HA event entities use a dedicated event topic (not state topic) and must not be retained
        const stateTopic = config.isTrigger
            ? `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/${groupId}/${MQTT_TOPIC_SUFFIX_EVENT}`
            : `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/${groupId}/${MQTT_TOPIC_SUFFIX_STATE}`;

        const payload = {
            name: null,
            unique_id: uniqueId,
            ...(entityId && entityIdFields(config.component, entityId)),
            state_topic: stateTopic,
            ...(!config.omitCommandTopic && { command_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${appId}/${groupId}/${MQTT_CMD_TYPE_SWITCH}` }),
            ...config.payloads,
            ...(config.positionSupport && {
                position_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/${groupId}/${MQTT_TOPIC_SUFFIX_POSITION}`,
                set_position_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${appId}/${groupId}/${MQTT_CMD_TYPE_POSITION}`,
                stop_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${appId}/${groupId}/${MQTT_CMD_TYPE_STOP}`,
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
            qos: 0,
            // NOTE: command topics must NOT be retained. A retained command sits on the
            // broker and is redelivered to cgateweb on every (re)connect, replaying stale
            // ON/OFF/RAMP commands that toggle devices unexpectedly. State retention is
            // handled separately by the read/state publish options, not here.
            ...(config.deviceClass && { device_class: config.deviceClass }),
            device: buildDeviceBlock({
                identifiers: [uniqueId],
                name: finalLabel,
                model: config.model,
                area
            }),
            origin: buildOriginBlock()
        };

        this._publish(discoveryTopic, JSON.stringify(payload), MQTT_RETAINED_STATE_OPTIONS);
        if (this._currentRunTopics) this._currentRunTopics.add(discoveryTopic);
        this.discoveryCount++;

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
        const discoveryTopic = `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_BUTTON}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`;

        const payload = {
            name: null,
            unique_id: uniqueId,
            ...(entityId && entityIdFields(HA_COMPONENT_BUTTON, `${entityId}_btn`)),
            command_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${appId}/${groupId}/${MQTT_CMD_TYPE_TRIGGER}`,
            payload_press: MQTT_STATE_ON,
            qos: 0,
            retain: false,
            device: buildDeviceBlock({
                identifiers: [`cgateweb_${networkId}_${appId}_${groupId}`],
                name: label,
                model: HA_MODEL_TRIGGER
            }),
            origin: buildOriginBlock()
        };

        this._publish(discoveryTopic, JSON.stringify(payload), MQTT_RETAINED_STATE_OPTIONS);
        this.discoveryCount++;
    }

    _publishTriggerScene(networkId, appId, groupId, label) {
        const { entityIds } = this._labelSnapshot;
        const labelKey = `${networkId}/${appId}/${groupId}`;
        const uniqueId = `cgateweb_${networkId}_${appId}_${groupId}_scene`;
        const entityId = entityIds.get(labelKey);
        const discoveryTopic = `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_SCENE}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`;

        const payload = {
            name: null,
            unique_id: uniqueId,
            ...(entityId && entityIdFields(HA_COMPONENT_SCENE, `${entityId}_scene`)),
            command_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${appId}/${groupId}/${MQTT_CMD_TYPE_SWITCH}`,
            payload_on: MQTT_STATE_ON,
            qos: 0,
            retain: false,
            device: buildDeviceBlock({
                identifiers: [`cgateweb_${networkId}_${appId}_${groupId}`],
                name: label,
                model: HA_MODEL_TRIGGER
            }),
            origin: buildOriginBlock()
        };

        this._publish(discoveryTopic, JSON.stringify(payload), MQTT_RETAINED_STATE_OPTIONS);
        this.discoveryCount++;
    }
}

const methods = {};
for (const name of Object.getOwnPropertyNames(_HaDiscoveryPublishers.prototype)) {
    if (name === 'constructor') continue;
    methods[name] = _HaDiscoveryPublishers.prototype[name];
}
module.exports = methods;
