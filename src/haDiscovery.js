// @ts-check
const { createLogger } = require('./logger');
const { findNetworkData, collectUnitGroups } = require('./haDiscoveryTree');
const {
    DEFAULT_CBUS_APP_LIGHTING,
    MQTT_RETAINED_STATE_OPTIONS,
    HA_COMPONENT_SENSOR,
    HA_DISCOVERY_SUFFIX
} = require('./constants');

/**
 * Methods mixed into HaDiscovery.prototype from haDiscoveryTreeSession.js and
 * haDiscoveryPublishers.js at module load (see the Object.assign calls at the
 * bottom of this file). Declared here so calls into the mixin modules
 * type-check; the implementations live in those modules.
 * @typedef {Object} HaDiscoveryMixinMethods
 * @property {(networkId: string|number) => void} queueTreeRequest
 * @property {(networkId: string) => void} _clearTreeState
 * @property {(networkId: string) => void} _clearTreeResyncState
 * @property {(networkId: string|number, appId: string|number, groups: Array<Object>) => void} _processLightingGroups
 * @property {(networkId: string|number, appAddress: string|number, groups: Array<Object>) => void} _processEnableControlGroups
 */
class HaDiscovery {
    /**
     * @param {Object} settings - Configuration settings
     * @param {Function} publishFn - Function to publish MQTT messages: (topic, payload, options) => void
     * @param {Function} sendCommandFn - Function to send C-Gate commands: (command) => void
     * @param {Object} [labelData] - Optional label data object from LabelLoader.getLabelData()
     * @param {Map<string, string>} [labelData.labels] - Label overrides keyed by "network/app/group"
     * @param {Map<string, string>} [labelData.typeOverrides] - Type overrides ("cover"|"switch"|"light")
     * @param {Map<string, string>} [labelData.entityIds] - Entity ID hints (default_entity_id for HA)
     * @param {Set<string>} [labelData.exclude] - Addresses to skip during discovery
     */
    constructor(settings, publishFn, sendCommandFn, labelData = null) {
        this.settings = settings;
        this._publish = publishFn;
        this._sendCommand = sendCommandFn;
        this._applyLabelData(labelData);

        this.pendingTreeNetworks = [];
        this.activeTreeSession = null;
        this.treeBufferParts = [];
        this.treeNetwork = null;
        this.discoveryCount = 0;
        this.labelStats = { custom: 0, treexml: 0, fallback: 0 };
        this.logger = createLogger({ component: 'HaDiscovery' });
        // Tracks all discovery config topics published in this session so that
        // stale retained messages can be cleared when devices are excluded or change type.
        this._publishedTopics = new Set();

        // C-Gate accepts TCP connections on the command port before its project
        // networks are loaded. Initial TREEXML can therefore return 401 "Network
        // not found" until C-Gate finishes startup. This map drives a
        // per-network retry loop with exponential backoff so HA Discovery
        // recovers automatically without restarting the bridge.
        // networkId -> { attempts, watchdogHandle, retryHandle }
        this._treeRequestState = new Map();
        // Per-network parse generation. Bumped when a TREEXML is sent so a
        // stale parseString callback from an earlier tree cannot corrupt
        // retry/discovery state after a newer request has started.
        this._treeParseEpoch = new Map();
        // Networks whose TreeXML is currently in parseString (session already cleared).
        this._parsingNetworks = new Set();
        this._maxTreeRetryAttempts = (settings && settings.haDiscoveryMaxTreeRetryAttempts) || 8;
        this._treeRetryInitialDelayMs = (settings && settings.haDiscoveryTreeRetryInitialDelayMs) || 2000;
        this._treeRetryMaxDelayMs = (settings && settings.haDiscoveryTreeRetryMaxDelayMs) || 60000;
        this._treeRequestTimeoutMs = (settings && settings.haDiscoveryTreeRequestTimeoutMs) || 8000;

        // Re-fetch budget for trees that were accepted (they carry device
        // data) but still contain units with empty <Groups> because C-Gate
        // hasn't finished syncing group bindings (issue #25). Bounded so
        // networks with legitimately group-less units stop re-fetching; the
        // signature fingerprints the tree that scheduled the pending fetch so
        // an unchanged re-fetch result stops the cycle early.
        // networkId -> { attempts, handle, signature }
        this._treeResyncState = new Map();
        this._maxTreeResyncAttempts = (settings && settings.haDiscoveryMaxTreeResyncAttempts) || 3;
        this._treeResyncInitialDelayMs = (settings && settings.haDiscoveryTreeResyncInitialDelayMs) || 30000;
        this._treeResyncMaxDelayMs = (settings && settings.haDiscoveryTreeResyncMaxDelayMs) || 120000;

        // Tracks per-network HA Discovery health. The status field is used to
        // de-dup repeated state publishes; configPublished gates the (one-shot)
        // HA Discovery config payload so we don't republish it on every
        // transition. networkId -> { status, configPublished }
        this._networkDiscoveryEntities = new Map();

        // Native Air Conditioning (172) thermostats are discovered event-driven
        // (not from TREEXML) — the first time a thermostat's source unit appears
        // in the aircon stream we publish its climate entity once. Tracks
        // "network/app/sourceUnit" keys already published this session.
        this._nativeAirconSeen = new Set();

        // Temperature Broadcast (app 25) groups are likewise discovered
        // event-driven the first time a sensor broadcasts. Tracks
        // "network/app/group" keys already published this session.
        this._temperatureSeen = new Set();

        // Network IDs whose CNI/PCI connectivity binary_sensor config has been
        // published this session (event-driven, idempotent).
        this._cniDiscoverySeen = new Set();

        // Discovery config topics that are published event-driven (native aircon
        // climate entities and CNI connectivity binary_sensors), NOT from a
        // TREEXML run. They share the `cgateweb_{network}_` unique-id prefix with
        // tree-discovered entities, so the per-network stale-topic cleanup in
        // _publishDiscoveryFromTree would otherwise wrongly clear them (they are
        // never part of a tree run's _currentRunTopics) — making thermostats and
        // connectivity sensors vanish whenever a tree refresh runs after they
        // were announced. Tracked here so the cleanup can skip them.
        this._eventDrivenDiscoveryTopics = new Set();
    }

    /**
     * Replace the label data (used for hot-reload).
     * Accepts either a full labelData object or a plain Map for backward compatibility.
     * @param {Object|Map<string, string>} labelData
     */
    updateLabels(labelData) {
        this._applyLabelData(labelData);
        const parts = [`${this.labelMap.size} labels`];
        if (this.typeOverrides.size > 0) parts.push(`${this.typeOverrides.size} type overrides`);
        if (this.entityIds.size > 0) parts.push(`${this.entityIds.size} entity IDs`);
        if (this.exclude.size > 0) parts.push(`${this.exclude.size} excluded`);
        this.logger.info(`Label data updated (${parts.join(', ')})`);
    }

    _applyLabelData(labelData) {
        if (labelData instanceof Map) {
            this.labelMap = labelData;
            this.typeOverrides = new Map();
            this.entityIds = new Map();
            this.exclude = new Set();
            this.areas = new Map();
        } else if (labelData && typeof labelData === 'object') {
            this.labelMap = labelData.labels || new Map();
            this.typeOverrides = labelData.typeOverrides || new Map();
            this.entityIds = labelData.entityIds || new Map();
            this.exclude = labelData.exclude || new Set();
            this.areas = labelData.areas || new Map();
        } else {
            this.labelMap = new Map();
            this.typeOverrides = new Map();
            this.entityIds = new Map();
            this.exclude = new Set();
            this.areas = new Map();
        }
    }

    /** @this {HaDiscovery & HaDiscoveryMixinMethods} */
    trigger(discoveredNetworks = null) {
        if (!this.settings.ha_discovery_enabled) {
            return;
        }

        this.logger.info(`HA Discovery enabled, querying network trees...`);
        let networksToDiscover = this.settings.ha_discovery_networks;

        // If no networks explicitly configured, fall back to auto-discovered networks
        if ((!networksToDiscover || networksToDiscover.length === 0) && discoveredNetworks && discoveredNetworks.length > 0) {
            this.logger.info(`No HA discovery networks configured, using auto-discovered networks: [${discoveredNetworks.join(', ')}]`);
            networksToDiscover = discoveredNetworks;
        }

        // If specific networks aren't configured, attempt to use the network
        // from the getallnetapp setting (if specified).
        if (networksToDiscover.length === 0 && this.settings.getallnetapp) {
            const networkIdMatch = String(this.settings.getallnetapp).match(/^(\d+)/);
            if (networkIdMatch) {
                this.logger.info(`No HA discovery networks configured, using network from getallnetapp: ${networkIdMatch[1]}`);
                networksToDiscover = [networkIdMatch[1]];
            } else {
                this.logger.warn(`No HA discovery networks configured and could not determine network from getallnetapp (${this.settings.getallnetapp}). HA Discovery will not run.`);
                return;
            }
        } else if (networksToDiscover.length === 0) {
             this.logger.warn(`No HA discovery networks configured. HA Discovery will not run.`);
             return;
        }

        // Request TreeXML for each configured network
        networksToDiscover.forEach(networkId => {
            this.queueTreeRequest(networkId);
        });
    }

    /**
     * Triggers a discovery refresh for a network that has just become
     * available in C-Gate (driven by a "Network created" async event on the
     * command port). Gated by the same scope rules as `trigger()`: when
     * `ha_discovery_networks` is configured, only those networks refresh;
     * otherwise we let any network through (matching the auto-discovery path).
     *
     * Idempotent against the v1.8.1 retry: `queueTreeRequest` cancels any
     * pending retry and de-duplicates the pending queue, so a Network created
     * event mid-backoff just short-circuits the wait.
     * @this {HaDiscovery & HaDiscoveryMixinMethods}
     */
    handleNetworkCreated(networkId) {
        if (!this.settings.ha_discovery_enabled) return;
        const networkKey = String(networkId);
        const configured = this.settings.ha_discovery_networks || [];
        if (configured.length > 0 && !configured.map(String).includes(networkKey)) {
            this.logger.debug(`Network ${networkKey} created but not in ha_discovery_networks; skipping refresh`);
            return;
        }
        this.logger.info(`Network ${networkKey} created in C-Gate; refreshing HA Discovery`);
        this.queueTreeRequest(networkKey);
    }

    /**
     * Counterpart to handleNetworkCreated for C-Gate's "Network sync ok" event
     * (code 762): the network has finished synchronising with the C-Bus
     * interface, so the tree is now fully populated. Re-fetch it so groups
     * that were still empty (unsynced) at startup are discovered without a
     * manual gettree (issue #25). Gated by the same scope rules as
     * handleNetworkCreated; queueTreeRequest de-duplicates against any
     * in-flight tree and cancels a pending retry.
     * @this {HaDiscovery & HaDiscoveryMixinMethods}
     */
    handleNetworkSyncComplete(networkId) {
        if (!this.settings.ha_discovery_enabled) return;
        const networkKey = String(networkId);
        const configured = this.settings.ha_discovery_networks || [];
        if (configured.length > 0 && !configured.map(String).includes(networkKey)) {
            this.logger.debug(`Network ${networkKey} sync complete but not in ha_discovery_networks; skipping refresh`);
            return;
        }
        this.logger.info(`Network ${networkKey} reported sync complete (C-Gate event 762); refreshing HA Discovery`);
        // The completed sync supersedes any pending empty-Groups re-fetch;
        // the fresh TREEXML re-evaluates completeness from a clean budget.
        this._clearTreeResyncState(networkKey);
        this.queueTreeRequest(networkKey);
    }

    /**
     * Counterpart to handleNetworkCreated: when C-Gate signals that a network
     * has been removed/deleted, clear all retained HA Discovery config topics
     * for that network so the entities don't linger in HA forever. Empty
     * retained payloads tell HA Discovery to delete the entity. Also cancels
     * any in-flight TREEXML request and clears internal state for the network.
     * @this {HaDiscovery & HaDiscoveryMixinMethods}
     */
    handleNetworkRemoved(networkId) {
        if (!this.settings.ha_discovery_enabled) return;
        const networkKey = String(networkId);

        // Cancel any in-flight or pending discovery for this network.
        this._clearTreeState(networkKey);
        this._clearTreeResyncState(networkKey);
        this._treeParseEpoch.delete(networkKey);
        this._parsingNetworks.delete(networkKey);
        const pendingIdx = this.pendingTreeNetworks.indexOf(networkKey);
        if (pendingIdx >= 0) this.pendingTreeNetworks.splice(pendingIdx, 1);

        // Clear all entity discovery configs that we previously published for
        // this network. HA Discovery convention: an empty retained payload on
        // the config topic removes the entity.
        const networkPrefix = `cgateweb_${networkKey}_`;
        const topicsToRemove = [];
        for (const topic of this._publishedTopics) {
            if (topic.includes(`/${networkPrefix}`)) {
                topicsToRemove.push(topic);
            }
        }
        for (const topic of topicsToRemove) {
            this._publish(topic, '', MQTT_RETAINED_STATE_OPTIONS);
            this._publishedTopics.delete(topic);
        }

        // Remove the per-network discovery health diagnostic sensor itself.
        const diagEntry = this._networkDiscoveryEntities.get(networkKey);
        if (diagEntry && diagEntry.configPublished) {
            const diagConfigTopic = `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_SENSOR}/cgateweb_discovery_${networkKey}/${HA_DISCOVERY_SUFFIX}`;
            this._publish(diagConfigTopic, '', MQTT_RETAINED_STATE_OPTIONS);
        }
        this._networkDiscoveryEntities.delete(networkKey);

        this.logger.info(
            `Network ${networkKey} removed from C-Gate; cleared ${topicsToRemove.length} entity ` +
            `discovery topic(s)${diagEntry ? ' + diagnostic sensor' : ''}`
        );
    }

    /** @this {HaDiscovery & HaDiscoveryMixinMethods} */
    _publishDiscoveryFromTree(networkId, treeData) {
        this.logger.info(`Generating HA Discovery messages for network ${networkId}...`);
        const startTime = Date.now();

        const networkData = findNetworkData(networkId, treeData);
        if (!networkData) {
             this.logger.warn(`TreeXML for network ${networkId}: could not find network data. Top-level keys: ${JSON.stringify(Object.keys(treeData || {}))}`);
             return;
        }

        // Snapshot label data references so a concurrent updateLabels() call
        // cannot swap them out mid-operation, preventing inconsistent reads.
        // Lives on the instance for the duration of this synchronous discovery
        // run; helper methods read this._labelSnapshot rather than receiving
        // it as a parameter on every call. Cleared at the end of the run.
        this._labelSnapshot = {
            labelMap: this.labelMap,
            typeOverrides: this.typeOverrides,
            entityIds: this.entityIds,
            exclude: this.exclude,
            areas: this.areas
        };

        // Wrap the synchronous discovery run so per-run state (label snapshot,
        // current-run topic set) is always cleared even if a helper throws
        // mid-run. Otherwise stale references could be read by later code.
        try {
            this._runDiscoveryFromTree(networkId, networkData, startTime);
        } finally {
            this._labelSnapshot = null;
            this._currentRunTopics = null;
        }
    }

    /** @this {HaDiscovery & HaDiscoveryMixinMethods} */
    _runDiscoveryFromTree(networkId, networkData, startTime) {
        let units = networkData.Unit || [];
        if (!Array.isArray(units)) {
            units = [units];
        }

        const lightingAppId = DEFAULT_CBUS_APP_LIGHTING;
        const coverAppId = this.settings.ha_discovery_cover_app_id;
        const switchAppId = this.settings.ha_discovery_switch_app_id;
        const relayAppId = this.settings.ha_discovery_relay_app_id;
        const pirAppId = this.settings.ha_discovery_pir_app_id;
        const triggerAppId = this.settings.ha_discovery_trigger_app_id;
        const hvacAppId = this.settings.ha_discovery_hvac_app_id;
        const tiltAppId = this.settings.ha_discovery_cover_tilt_app_id;
        const targetApps = [lightingAppId, coverAppId, switchAppId, relayAppId, pirAppId, triggerAppId, hvacAppId, tiltAppId].filter(Boolean).map(String);
        this.discoveryCount = 0;
        this.labelStats = { custom: 0, treexml: 0, fallback: 0 };

        // Track which discovery config topics are published in this run so that
        // stale topics (from excluded or type-changed devices) can be cleared.
        this._currentRunTopics = new Set();

        // C-Gate TREEXML returns two formats depending on version/path:
        //   Structured: unit.Application = [{ ApplicationAddress, Group: [{GroupAddress, Label}] }]
        //   Flat:       unit.Application = "56, 255", unit.Groups = "103,104,105"
        // groupsByApp maps appId -> Map<groupId, groupObject>
        const groupsByApp = new Map();

        units.forEach(unit => {
            if (!unit) return;
            collectUnitGroups(unit, groupsByApp, targetApps);
        });

        for (const [appId, groupMap] of groupsByApp) {
            const groups = Array.from(groupMap.values());
            if (String(appId) === String(lightingAppId)) {
                this._processLightingGroups(networkId, appId, groups);
            } else {
                this._processEnableControlGroups(networkId, appId, groups);
            }
        }

        // Supplement with labeled groups not found in TREEXML.
        // C-Gate's flat TREEXML format omits groups not assigned to specific units,
        // but labels.json may define groups that are valid and controllable.
        this._supplementFromLabels(networkId, lightingAppId, groupsByApp);

        // Clear any previously published discovery topics for this network that were
        // not republished in this run (device excluded or type changed since last run).
        // Event-driven topics (native aircon climate, CNI connectivity) share the
        // network unique-id prefix but are not produced by a tree run, so they are
        // skipped here — otherwise a tree refresh would wrongly clear thermostats
        // and connectivity sensors that are still valid.
        const networkUniqueIdPrefix = `cgateweb_${networkId}_`;
        const isStaleTreeTopic = (topic) =>
            topic.includes(`/${networkUniqueIdPrefix}`) &&
            !this._currentRunTopics.has(topic) &&
            !this._eventDrivenDiscoveryTopics.has(topic);
        // Clear each stale topic (empty retained payload) and drop it from the
        // session-wide set in a single pass. Snapshot the set first to avoid
        // deleting from a collection during iteration; _publish does not mutate it.
        for (const topic of [...this._publishedTopics]) {
            if (isStaleTreeTopic(topic)) {
                this.logger.debug(`Clearing stale discovery topic: ${topic}`);
                this._publish(topic, '', MQTT_RETAINED_STATE_OPTIONS);
                this._publishedTopics.delete(topic);
            }
        }

        // Merge the current run's topics into the session-wide set.
        for (const topic of this._currentRunTopics) {
            this._publishedTopics.add(topic);
        }

        const duration = Date.now() - startTime;
        const { custom, treexml, fallback } = this.labelStats;
        if (this.discoveryCount === 0) {
            // The tree was accepted as synced (real units were present, so this is
            // not the issue #17 "still syncing" case) yet produced no entities.
            // That happens when C-Gate returns units with no group addresses
            // (empty <Groups>) and no labels file supplies them — there is simply
            // nothing addressable to expose to HA. Warn with the cause and remedy
            // rather than logging a quiet "0 entities" that looks like success.
            this.logger.warn(
                `HA Discovery for network ${networkId} published 0 entities (took ${duration}ms). ` +
                `The C-Gate tree listed units but no group addresses (empty <Groups>), and no labels supplied any. ` +
                `Import your C-Bus Toolkit project labels (C-Bus Labels in the web UI) so the group addresses are known, ` +
                `or verify the network's groups are populated in C-Gate.`
            );
        } else {
            this.logger.info(`HA Discovery completed for network ${networkId}. Published ${this.discoveryCount} entities (took ${duration}ms). Labels: ${custom} custom, ${treexml} from TREEXML, ${fallback} fallback`);
        }
    }

    /**
     * Create discovery entities for labeled groups not already found in TREEXML.
     * The flat TREEXML format may omit groups not assigned to specific units,
     * but they are still valid and controllable on the C-Bus network.
     * @this {HaDiscovery & HaDiscoveryMixinMethods}
     */
    _supplementFromLabels(networkId, lightingAppId, groupsByApp) {
        const { labelMap, exclude } = this._labelSnapshot;
        if (!labelMap || labelMap.size === 0) return;

        const prefix = `${networkId}/${lightingAppId}/`;
        const existingGroups = groupsByApp.get(String(lightingAppId));
        const existingIds = existingGroups ? new Set(existingGroups.keys()) : new Set();
        let supplementCount = 0;

        for (const [labelKey] of labelMap) {
            if (!labelKey.startsWith(prefix)) continue;
            const groupId = labelKey.substring(prefix.length);
            if (existingIds.has(groupId)) continue;
            if (exclude.has(labelKey)) continue;

            this._processLightingGroups(networkId, lightingAppId, [{ GroupAddress: groupId }]);
            supplementCount++;
        }

        if (supplementCount > 0) {
            this.logger.info(`Supplemented ${supplementCount} additional groups from label data for network ${networkId}`);
        }
    }

}

Object.assign(HaDiscovery.prototype, require('./haDiscoveryTreeSession'));
Object.assign(HaDiscovery.prototype, require('./haDiscoveryPublishers'));
module.exports = HaDiscovery;
