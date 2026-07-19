// @ts-check
const { getDiscoveryTypeForApp, getDiscoveryConfig } = require('./haDiscoveryConfigs');
const { classifyLightingGroup } = require('./deviceTypeClassifier');
const { buildOriginBlock, buildDeviceBlock } = require('./haDiscoveryPayloads');
const {
    MQTT_TOPIC_PREFIX_READ,
    MQTT_TOPIC_PREFIX_WRITE,
    MQTT_TOPIC_SUFFIX_STATE,
    MQTT_TOPIC_SUFFIX_LEVEL,
    MQTT_TOPIC_SUFFIX_POSITION,
    MQTT_TOPIC_SUFFIX_TILT,
    MQTT_TOPIC_SUFFIX_EVENT,
    MQTT_TOPIC_SUFFIX_HVAC_CURRENT_TEMP,
    MQTT_TOPIC_SUFFIX_HVAC_SETPOINT,
    MQTT_TOPIC_SUFFIX_HVAC_MODE,
    MQTT_TOPIC_SUFFIX_HVAC_FAN_MODE,
    MQTT_TOPIC_SUFFIX_HVAC_ACTION,
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
    MQTT_STATE_ON,
    MQTT_STATE_OFF,
    MQTT_COMMAND_STOP,
    MQTT_RETAINED_STATE_OPTIONS,
    HA_COMPONENT_LIGHT,
    HA_COMPONENT_BUTTON,
    HA_COMPONENT_CLIMATE,
    HA_COMPONENT_BINARY_SENSOR,
    HA_COMPONENT_SCENE,
    HA_DISCOVERY_SUFFIX,
    HA_MODEL_LIGHTING,
    HA_MODEL_TRIGGER,
    entityIdFields
} = require('./constants');

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
    _currentRunTopics;

    /**
     * Per-run label data snapshot installed by _publishDiscoveryFromTree for
     * the duration of a synchronous discovery run (null outside a run).
     * @type {{ labelMap: Map<string, string>, typeOverrides: Map<string, string>, entityIds: Map<string, string>, exclude: Set<string>, areas: Map<string, string> } | null}
     */
    _labelSnapshot;

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
        const { labelMap, entityIds, exclude, areas } = this._labelSnapshot;

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
        const customLabel = labelMap.get(labelKey);
        const groupLabel = group.Label;
        const finalLabel = customLabel || groupLabel || `CBus Light ${networkId}/${appId}/${groupId}`;
        if (customLabel) this.labelStats.custom++;
        else if (groupLabel) this.labelStats.treexml++;
        else this.labelStats.fallback++;

        const uniqueId = `cgateweb_${networkId}_${appId}_${groupId}`;
        const entityId = entityIds.get(labelKey);
        const area = areas && areas.get(labelKey);
        const discoveryTopic = `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_LIGHT}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`;

        const payload = {
            name: null,
            unique_id: uniqueId,
            ...(entityId && entityIdFields(HA_COMPONENT_LIGHT, entityId)),
            state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/${groupId}/${MQTT_TOPIC_SUFFIX_STATE}`,
            command_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${appId}/${groupId}/${MQTT_CMD_TYPE_RAMP}`,
            brightness_state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/${groupId}/${MQTT_TOPIC_SUFFIX_LEVEL}`,
            brightness_command_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${appId}/${groupId}/${MQTT_CMD_TYPE_RAMP}`,
            brightness_scale: 100,
            on_command_type: 'brightness',
            payload_on: MQTT_STATE_ON,
            payload_off: MQTT_STATE_OFF,
            state_value_template: '{{ value }}',
            brightness_value_template: '{{ value }}',
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
        const resolvedType = typeOverrides.get(labelKey) || classifyLightingGroup(labelForClassification, this.settings);

        if (!resolvedType || resolvedType === 'light') {
            return false;
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
            // Clear any entity published on an earlier run so it disappears from
            // HA once the user excludes it (e.g. a PAC/controller mirroring the
            // real thermostats).
            const excludedUniqueId = `cgateweb_${network}_${appId}_${sourceUnit}`;
            const excludedTopic = `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_CLIMATE}/${excludedUniqueId}/${HA_DISCOVERY_SUFFIX}`;
            this._publish(excludedTopic, '', MQTT_RETAINED_STATE_OPTIONS);
            this._publishedTopics.delete(excludedTopic);
            this._eventDrivenDiscoveryTopics.delete(excludedTopic);
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
        const customLabel = this.labelMap.get(labelKey);
        const finalLabel = customLabel || `CBus HVAC ${networkId}/${appId}/${sourceUnit}`;
        if (customLabel) this.labelStats.custom++;
        else this.labelStats.fallback++;

        const uniqueId = `cgateweb_${networkId}_${appId}_${sourceUnit}`;
        const entityId = this.entityIds.get(labelKey);
        const area = this.areas && this.areas.get(labelKey);
        const discoveryTopic = `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_CLIMATE}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`;
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
            // Fan mode from the Aux Level (spec §25.6.11 bit 6). Read-only state:
            // the control path does not write the Aux Level, so no
            // fan_mode_command_topic. HA accepts an arbitrary fan_modes list; the
            // C-Bus values are automatic/continuous. (Raw 0-63 fan speed has no HA
            // climate equivalent — it stays on the fan_speed MQTT topic.)
            fan_mode_state_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_FAN_MODE}`,
            fan_modes: ['automatic', 'continuous'],

            // Command topics — only when control is opt-in enabled.
            ...(controlEnabled && {
                temperature_command_topic: `${writeBase}/${MQTT_CMD_TYPE_HVAC_SETPOINT}`,
                mode_command_topic: `${writeBase}/${MQTT_CMD_TYPE_HVAC_MODE}`
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

        this._publish(discoveryTopic, JSON.stringify(payload), MQTT_RETAINED_STATE_OPTIONS);
        this._publishedTopics.add(discoveryTopic);
        this._eventDrivenDiscoveryTopics.add(discoveryTopic);
        this.discoveryCount++;
        this.logger.info(`Native HVAC climate entity published: ${labelKey} (${finalLabel})`);
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
        const { labelMap, entityIds, exclude, areas } = this._labelSnapshot;
        const labelKey = `${networkId}/${appId}/${groupId}`;

        if (exclude.has(labelKey)) {
            this.logger.debug(`Excluding HVAC group ${labelKey} from discovery`);
            return;
        }

        const customLabel = labelMap.get(labelKey);
        const finalLabel = customLabel || groupLabel || `CBus HVAC Zone ${networkId}/${appId}/${groupId}`;
        if (customLabel) this.labelStats.custom++;
        else if (groupLabel) this.labelStats.treexml++;
        else this.labelStats.fallback++;

        const uniqueId = `cgateweb_${networkId}_${appId}_${groupId}`;
        const entityId = entityIds.get(labelKey);
        const area = areas && areas.get(labelKey);
        const discoveryTopic = `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_CLIMATE}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`;

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
        const { labelMap, entityIds, exclude, areas } = this._labelSnapshot;
        const labelKey = `${networkId}/${appId}/${groupId}`;

        if (exclude.has(labelKey)) {
            this.logger.debug(`Excluding group ${labelKey} from discovery`);
            return;
        }

        const customLabel = labelMap.get(labelKey);
        const finalLabel = customLabel || groupLabel || `CBus ${config.defaultType} ${networkId}/${appId}/${groupId}`;
        if (customLabel) this.labelStats.custom++;
        else if (groupLabel) this.labelStats.treexml++;
        else this.labelStats.fallback++;
        const uniqueId = `cgateweb_${networkId}_${appId}_${groupId}`;
        const entityId = entityIds.get(labelKey);
        const area = areas && areas.get(labelKey);
        const discoveryTopic = `${this.settings.ha_discovery_prefix}/${config.component}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`;

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
