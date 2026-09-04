// @ts-check
const { getDiscoveryTypeForApp } = require('./haDiscoveryConfigs');
const { buildOriginBlock, buildDeviceBlock } = require('./haDiscoveryPayloads');
const {
    MQTT_TOPIC_PREFIX_READ,
    MQTT_TOPIC_PREFIX_WRITE,
    MQTT_STATE_ON,
    MQTT_STATE_OFF,
    MQTT_RETAINED_STATE_OPTIONS,
    HA_COMPONENT_BINARY_SENSOR,
    HA_DISCOVERY_SUFFIX,
    DEFAULT_CBUS_APP_LIGHTING,
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
    _currentRunTopics;

    /**
     * Installed on HaDiscovery; nested unlisted-group publish reuses the tree
     * run's snapshot and topic set instead of rolling its own.
     * @type {(fn: (ctx: { outermost: boolean, ownTopics: boolean }) => any) => any}
     */
    _withDiscoveryRun;

    /**
     * Lighting-application group discovery (implemented in haDiscoveryPublishersLighting).
     * @type {(networkId: string|number, appId: string|number, group: Object) => void}
     */
    _processOneLightingGroup;

    /**
     * Enable-control / typed-app group discovery (implemented in haDiscoveryPublishersLighting).
     * @type {(networkId: string|number, appAddress: string|number, groups: Array<Object>) => void}
     */
    _processEnableControlGroups;

    /**
     * Clock / temperature / measurement discovery (implemented in
     * haDiscoveryPublishersSensors).
     * @type {(network: string|number, appId: string|number) => boolean}
     */
    ensureClockDiscovery;

    /** @type {(network: string|number, appId: string|number, group: string|number) => boolean} */
    ensureTemperatureDiscovery;

    /** @type {(network: string|number, appId: string|number, device: string|number, channel: string|number, reading: Object) => boolean} */
    ensureMeasurementDiscovery;

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
}

const methods = {};
for (const name of Object.getOwnPropertyNames(_HaDiscoveryPublishers.prototype)) {
    if (name === 'constructor') continue;
    methods[name] = _HaDiscoveryPublishers.prototype[name];
}
module.exports = methods;
