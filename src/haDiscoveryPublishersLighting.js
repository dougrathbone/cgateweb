// @ts-check
const { getDiscoveryTypeForApp, getDiscoveryConfig } = require('./haDiscoveryConfigs');
const { classifyLightingGroup, typeFromLabelPrefix } = require('./deviceTypeClassifier');
const { entityTypeForGroup } = require('./unitTypeClassifier');
const {
    MQTT_TOPIC_PREFIX_READ,
    MQTT_TOPIC_PREFIX_WRITE,
    MQTT_TOPIC_SUFFIX_STATE,
    MQTT_TOPIC_SUFFIX_LEVEL,
    MQTT_TOPIC_SUFFIX_POSITION,
    MQTT_TOPIC_SUFFIX_TILT,
    MQTT_TOPIC_SUFFIX_EVENT,
    MQTT_CMD_TYPE_SWITCH,
    MQTT_CMD_TYPE_RAMP,
    MQTT_CMD_TYPE_POSITION,
    MQTT_CMD_TYPE_TILT,
    MQTT_CMD_TYPE_STOP,
    MQTT_CMD_TYPE_TRIGGER,
    MQTT_STATE_ON,
    MQTT_STATE_OFF,
    MQTT_COMMAND_STOP,
    MQTT_RETAINED_STATE_OPTIONS,
    HA_COMPONENT_LIGHT,
    HA_COMPONENT_BUTTON,
    HA_COMPONENT_BINARY_SENSOR,
    HA_COMPONENT_SCENE,
    HA_DISCOVERY_SUFFIX,
    HA_MODEL_LIGHTING,
    HA_MODEL_TRIGGER
} = require('./constants');

class _HaDiscoveryPublishersLighting {
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

    /** @type {Set<string>} */
    _publishedTopics;

    /** @type {Set<string>} */
    _treeDiscoveredGroups;

    /** @type {boolean} */
    _recordingTreeGroups;

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

    /**
     * Shared identity preamble (implemented in haDiscoveryPublishers).
     * @type {(spec: Object) => { finalLabel: string, uniqueId: string, entityId: string|undefined, area: string|undefined, discoveryTopic: string }}
     */
    _resolveEntityIdentity;

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
     * HVAC-via-lighting climate discovery (implemented in haDiscoveryPublishersAircon).
     * @type {(networkId: string|number, appId: string|number, groupId: string|number, groupLabel: string|null|undefined) => void}
     */
    _createHvacDiscovery;

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
for (const name of Object.getOwnPropertyNames(_HaDiscoveryPublishersLighting.prototype)) {
    if (name === 'constructor') continue;
    methods[name] = _HaDiscoveryPublishersLighting.prototype[name];
}
module.exports = methods;
