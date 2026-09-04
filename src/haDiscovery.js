// @ts-check
const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');
const { findNetworkData, collectUnitGroups, collectUnitTypeData, networkHasUnsyncedUnits } = require('./haDiscoveryTree');
const { parseSecurityZoneLabelKey, securityZoneLabelKey } = require('./securityZoneLabels');
const { resolveSetting } = require('./config/schema');
const {
    DEFAULT_CBUS_APP_LIGHTING,
    MQTT_RETAINED_STATE_OPTIONS,
    HA_COMPONENT_SENSOR,
    HA_DISCOVERY_SUFFIX
} = require('./constants');

// Discovery config topics end in this; used to recognise them in the _publish
// wrapper that records payloads for replay after a broker restart.
const CONFIG_TOPIC_SUFFIX = `/${HA_DISCOVERY_SUFFIX}`;

/**
 * Methods mixed into HaDiscovery.prototype from haDiscoveryTreeSession.js,
 * haDiscoveryPublishers.js and haDiscoveryPublishersSecurity.js at module load
 * (see the Object.assign calls at the bottom of this file). Declared here so
 * calls into the mixin modules type-check; the implementations live in those
 * modules.
 * @typedef {Object} HaDiscoveryMixinMethods
 * @property {(networkId: string|number) => void} queueTreeRequest
 * @property {(networkId: string) => void} _clearTreeState
 * @property {(networkId: string) => void} _clearTreeResyncState
 * @property {(networkId: string|number, appId: string|number, groups: Array<Object>) => void} _processLightingGroups
 * @property {(networkId: string|number, appAddress: string|number, groups: Array<Object>) => void} _processEnableControlGroups
 * @property {(network: string|number, appId: string|number, zone: string|number) => boolean} ensureSecurityZoneDiscovery
 * @property {(network: string|number, appId: string|number, group: string|number) => boolean} ensureUnlistedGroupDiscovery
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
        // Retained discovery config payloads by topic, so they can be replayed
        // after an MQTT broker restart drops them (issue #44). Recorded in the
        // _publish wrapper below rather than at each of the ~16 call sites that
        // publish a config, so the cache cannot drift out of sync with them.
        // Bounded by entity count: a few hundred payloads of roughly 500 bytes.
        this._publishedConfigPayloads = new Map();
        this._rawPublish = publishFn;
        this._publish = (topic, payload, options) => {
            if (typeof topic === 'string' && topic.endsWith(CONFIG_TOPIC_SUFFIX)) {
                // An empty payload is a retraction — forget it, don't replay it.
                if (payload) this._publishedConfigPayloads.set(topic, payload);
                else this._publishedConfigPayloads.delete(topic);
            }
            return publishFn(topic, payload, options);
        };
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
        this._maxTreeRetryAttempts = resolveSetting(settings || {}, 'haDiscoveryMaxTreeRetryAttempts');
        this._treeRetryInitialDelayMs = resolveSetting(settings || {}, 'haDiscoveryTreeRetryInitialDelayMs');
        this._treeRetryMaxDelayMs = resolveSetting(settings || {}, 'haDiscoveryTreeRetryMaxDelayMs');
        this._treeRequestTimeoutMs = resolveSetting(settings || {}, 'haDiscoveryTreeRequestTimeoutMs');
        // When stream-stall is unset, reuse the request timeout so existing
        // installs that only tuned the latter still see matching behaviour.
        this._treeStreamStallMs = settings && settings.haDiscoveryTreeStreamStallMs !== undefined
            ? resolveSetting(settings, 'haDiscoveryTreeStreamStallMs')
            : this._treeRequestTimeoutMs;

        // Re-fetch budget for trees that were accepted (they carry device
        // data) but still contain units with empty <Groups> because C-Gate
        // hasn't finished syncing group bindings (issue #25). Bounded so
        // networks with legitimately group-less units stop re-fetching; the
        // signature fingerprints the tree that scheduled the pending fetch so
        // an unchanged re-fetch result stops the cycle early.
        // networkId -> { attempts, handle, signature }
        this._treeResyncState = new Map();
        this._maxTreeResyncAttempts = resolveSetting(settings || {}, 'haDiscoveryMaxTreeResyncAttempts');
        this._treeResyncInitialDelayMs = resolveSetting(settings || {}, 'haDiscoveryTreeResyncInitialDelayMs');
        this._treeResyncMaxDelayMs = resolveSetting(settings || {}, 'haDiscoveryTreeResyncMaxDelayMs');

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

        // Security (app 208) zones are discovered event-driven (first zone
        // event or status report) and from application-1 labels during tree
        // runs. Tracks "network/app/zone" keys already published this session.
        this._securityZoneSeen = new Set();

        // Lighting-style groups announced from live bus traffic rather than
        // TREEXML (opt-in ha_discovery_unlisted_groups). Tracks
        // "network/app/group" keys already handled this session.
        this._unlistedGroupSeen = new Set();
        this._treeDiscoveredGroups = new Set();
        // Topics published for unlisted groups, keyed by "network/app/group".
        // Survives restarts via a JSON file next to the label file so turning
        // the option off can retract leftover retained configs (#63).
        this._unlistedGroupTopics = new Map();
        this._loadUnlistedDiscoveryStore();
        if (this.settings.ha_discovery_unlisted_groups) {
            for (const key of this._unlistedGroupTopics.keys()) {
                this._unlistedGroupSeen.add(key);
            }
        }

        // Measurement (app 228) channels are discovered event-driven (first
        // reading for that device/channel). Tracks "network/app/device/channel"
        // keys already published this session.
        this._measurementSeen = new Set();

        // Security panel-wide trouble sensors (mains, battery, tamper, panic,
        // phone line, arm failure, fire), announced as one group per network on
        // first security traffic. Tracks "network/app/panel" keys.
        this._securityPanelSeen = new Set();

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
     * Re-send every discovery config published this session, retained.
     *
     * A broker restart without retained-message persistence loses the configs,
     * and Home Assistant then has no entities at all until the next tree run.
     * Replaying the cached payloads restores them exactly, without re-running
     * TREEXML and its retry/epoch machinery (issue #44).
     *
     * @returns {number} configs republished
     */
    republishDiscoveryConfigs() {
        let count = 0;
        for (const [topic, payload] of this._publishedConfigPayloads) {
            // Raw publish: going through this._publish would re-record each
            // entry with the value we are iterating, for no benefit.
            this._rawPublish(topic, payload, MQTT_RETAINED_STATE_OPTIONS);
            count++;
        }
        if (count > 0) this.logger.info(`Republished ${count} HA Discovery config(s)`);
        this.syncUnlistedGroupDiscovery();
        return count;
    }

    /**
     * Replace the label data (used for hot-reload).
     * Accepts either a full labelData object or a plain Map for backward compatibility.
     * Security zones additionally get their discovery config republished when
     * their application-1 label changed, so a Toolkit zone rename reaches Home
     * Assistant without waiting for the next tree run (issue #42 feedback).
     * @param {Object|Map<string, string>} labelData
     * @this {HaDiscovery & HaDiscoveryMixinMethods}
     */
    updateLabels(labelData) {
        const previousLabels = this.labelMap;
        this._applyLabelData(labelData);
        this._republishRenamedSecurityZones(previousLabels);
        const parts = [`${this.labelMap.size} labels`];
        if (this.typeOverrides.size > 0) parts.push(`${this.typeOverrides.size} type overrides`);
        if (this.entityIds.size > 0) parts.push(`${this.entityIds.size} entity IDs`);
        if (this.exclude.size > 0) parts.push(`${this.exclude.size} excluded`);
        this.logger.info(`Label data updated (${parts.join(', ')})`);
        this._retractExcludedUnlistedGroups();
        this.syncUnlistedGroupDiscovery();
    }

    /**
     * Path of the unlisted-discovery topic store, or null when no label file
     * is configured (no writable directory is known).
     * @returns {string|null}
     * @private
     */
    _unlistedDiscoveryStorePath() {
        const labelFile = this.settings && this.settings.cbus_label_file;
        if (!labelFile || typeof labelFile !== 'string') return null;
        return path.join(path.dirname(labelFile), 'unlisted-discovery.json');
    }

    /**
     * @private
     */
    _loadUnlistedDiscoveryStore() {
        const filePath = this._unlistedDiscoveryStorePath();
        if (!filePath) return;
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
            for (const [key, topics] of Object.entries(parsed)) {
                if (typeof key !== 'string' || !Array.isArray(topics)) continue;
                const clean = topics.filter((t) => typeof t === 'string' && t.endsWith(CONFIG_TOPIC_SUFFIX));
                if (clean.length) this._unlistedGroupTopics.set(key, clean);
            }
        } catch (err) {
            if (err.code !== 'ENOENT') {
                this.logger.warn(`Could not read unlisted discovery store (${err.message}); starting empty`);
            }
        }
    }

    /**
     * @private
     */
    _persistUnlistedDiscoveryStore() {
        const filePath = this._unlistedDiscoveryStorePath();
        if (!filePath) return;
        try {
            const obj = {};
            for (const [key, topics] of this._unlistedGroupTopics) {
                obj[key] = topics;
            }
            fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
        } catch (err) {
            this.logger.warn(`Could not write unlisted discovery store (${err.message})`);
        }
    }

    /**
     * Record discovery topics published for an unlisted group so they can be
     * retracted later (option off, exclude, restart).
     * @param {string} key
     * @param {Iterable<string>} topics
     * @private
     */
    _rememberUnlistedGroupTopics(key, topics) {
        const list = [...topics].filter((t) => typeof t === 'string' && t.endsWith(CONFIG_TOPIC_SUFFIX));
        if (!list.length) return;
        this._unlistedGroupTopics.set(key, list);
        this._persistUnlistedDiscoveryStore();
    }

    /**
     * Retract one unlisted group's configs. No-op if we never published it.
     * @param {string} key
     * @private
     */
    _retractUnlistedGroupKey(key) {
        const topics = this._unlistedGroupTopics.get(key);
        if (!topics) return;
        for (const topic of topics) {
            this._publish(topic, '', MQTT_RETAINED_STATE_OPTIONS);
            this._publishedTopics.delete(topic);
            this._eventDrivenDiscoveryTopics.delete(topic);
        }
        this._unlistedGroupTopics.delete(key);
        this._unlistedGroupSeen.delete(key);
        this._persistUnlistedDiscoveryStore();
    }

    /**
     * Retract unlisted groups that are now on the exclude list.
     * @private
     */
    _retractExcludedUnlistedGroups() {
        for (const key of [...this._unlistedGroupTopics.keys()]) {
            if (this.exclude.has(key)) this._retractUnlistedGroupKey(key);
        }
    }

    /**
     * Groups that later appeared in TREEXML are real Toolkit groups now; stop
     * treating them as unlisted so turning the option off does not retract them.
     * @private
     */
    _promoteUnlistedGroupsNowInTree() {
        let changed = false;
        for (const key of [...this._unlistedGroupTopics.keys()]) {
            if (!this._treeDiscoveredGroups.has(key)) continue;
            this._unlistedGroupTopics.delete(key);
            this._unlistedGroupSeen.delete(key);
            changed = true;
        }
        if (changed) this._persistUnlistedDiscoveryStore();
    }

    /**
     * Retract leftover unlisted-group discovery when the option is off.
     * Safe to call before MQTT is connected (publishFn queues or no-ops) and
     * again after connect so a restart with the option off clears the broker.
     * @returns {number} configs retracted
     */
    syncUnlistedGroupDiscovery() {
        this._promoteUnlistedGroupsNowInTree();
        if (this.settings.ha_discovery_unlisted_groups) return 0;
        let count = 0;
        for (const key of [...this._unlistedGroupTopics.keys()]) {
            const topics = this._unlistedGroupTopics.get(key) || [];
            count += topics.length;
            this._retractUnlistedGroupKey(key);
        }
        if (count > 0) {
            this.logger.info(`Retracted ${count} leftover unlisted-group discovery config(s)`);
        }
        return count;
    }

    /**
     * Re-announce security zones whose application-1 label just changed (web
     * save or file reload — both flow through updateLabels). Clears the
     * zone's Seen key and republishes its discovery config; the unique_id is
     * unchanged, so Home Assistant updates the entity's name and device class
     * in place. Labels removed outright only clear the Seen key, so a future
     * zone event re-announces with the fallback name.
     *
     * @param {Map<string, string>} previousLabels - Label map before this update.
     * @this {HaDiscovery & HaDiscoveryMixinMethods}
     * @private
     */
    _republishRenamedSecurityZones(previousLabels) {
        const appId = this.settings.cbus_security_app_id;
        if (!appId || String(appId) === '0') return;
        if (!previousLabels) return;

        let republished = 0;
        for (const [labelKey, newLabel] of this.labelMap) {
            const parsed = parseSecurityZoneLabelKey(labelKey);
            if (!parsed) continue;
            if (previousLabels.get(labelKey) === newLabel) continue;
            const seenKey = `${parsed.network}/${appId}/${parsed.zone}`;
            this._securityZoneSeen.delete(seenKey);
            if (this.ensureSecurityZoneDiscovery(parsed.network, appId, parsed.zone)) {
                republished++;
            }
        }

        // Labels that disappeared entirely: drop the Seen key so the zone is
        // re-announced (with its fallback name) on its next event.
        for (const [labelKey] of previousLabels) {
            const parsed = parseSecurityZoneLabelKey(labelKey);
            if (!parsed) continue;
            if (this.labelMap.has(labelKey)) continue;
            this._securityZoneSeen.delete(`${parsed.network}/${appId}/${parsed.zone}`);
        }

        if (republished > 0) {
            this.logger.info(`Republished ${republished} security zone discovery config(s) after label changes`);
        }
    }

    /**
     * Store a C-Gate zone_name as an application-1 label when Toolkit did not
     * already supply one, then re-announce the zone so Home Assistant picks
     * up the name. Does not overwrite an existing label.
     *
     * @param {string|number} network
     * @param {string|number} zone
     * @param {string} name
     * @returns {boolean} true if a discovery config was (re)published
     * @this {HaDiscovery & HaDiscoveryMixinMethods}
     */
    applySecurityZoneName(network, zone, name) {
        const trimmed = typeof name === 'string' ? name.trim() : '';
        if (!trimmed) return false;
        const appId = this.settings.cbus_security_app_id;
        if (!appId || String(appId) === '0') return false;
        const labelKey = securityZoneLabelKey(network, zone);
        const existing = this.labelMap.get(labelKey);
        if (existing) return false;
        this.labelMap.set(labelKey, trimmed);
        const seenKey = `${network}/${appId}/${zone}`;
        this._securityZoneSeen.delete(seenKey);
        return this.ensureSecurityZoneDiscovery(network, appId, zone);
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
        const configured = resolveSetting(this.settings, 'ha_discovery_networks');
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
        const configured = resolveSetting(this.settings, 'ha_discovery_networks');
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

    /**
     * Snapshot the current label maps so a concurrent updateLabels() cannot
     * swap them mid-run. Helpers read this._labelSnapshot rather than taking
     * it as a parameter on every call.
     * @returns {{ labelMap: Map<string, string>, typeOverrides: Map<string, string>, entityIds: Map<string, string>, exclude: Set<string>, areas: Map<string, string> }}
     * @private
     */
    _captureLabelSnapshot() {
        return {
            labelMap: this.labelMap,
            typeOverrides: this.typeOverrides,
            entityIds: this.entityIds,
            exclude: this.exclude,
            areas: this.areas
        };
    }

    /**
     * Run fn with per-run discovery state (label snapshot and topic set).
     * Nested calls reuse the outer snapshot and topic set; only the outermost
     * call installs and clears them. That way an event-driven unlisted-group
     * publish mid-TREEXML cannot wipe the tree run's snapshot or unit index.
     *
     * @template T
     * @param {(ctx: { outermost: boolean, ownTopics: boolean }) => T} fn
     * @returns {T}
     */
    _withDiscoveryRun(fn) {
        const outermost = this._labelSnapshot === null || this._labelSnapshot === undefined;
        if (outermost) {
            this._labelSnapshot = this._captureLabelSnapshot();
        }
        const ownTopics = this._currentRunTopics === null || this._currentRunTopics === undefined;
        if (ownTopics) {
            this._currentRunTopics = new Set();
        }
        try {
            return fn({ outermost, ownTopics });
        } finally {
            if (ownTopics) {
                this._currentRunTopics = null;
            }
            if (outermost) {
                this._labelSnapshot = null;
                this._unitTypeIndex = null;
                this._treeIncomplete = false;
            }
        }
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

        this._withDiscoveryRun(() => {
            this._runDiscoveryFromTree(networkId, networkData, startTime);
        });
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

        // Topic set is installed by _withDiscoveryRun so nested event-driven
        // publishers (unlisted groups) can reuse it instead of rolling their own.

        // C-Gate TREEXML returns two formats depending on version/path:
        //   Structured: unit.Application = [{ ApplicationAddress, Group: [{GroupAddress, Label}] }]
        //   Flat:       unit.Application = "56, 255", unit.Groups = "103,104,105"
        // groupsByApp maps appId -> Map<groupId, groupObject>
        const groupsByApp = new Map();

        units.forEach(unit => {
            if (!unit) return;
            collectUnitGroups(unit, groupsByApp, targetApps);
        });

        // Which unit types drive each group, so a group can be classified by its
        // hardware instead of by its name (issues #38, #37). Run-scoped instance
        // Run-scoped instance state, cleared in _withDiscoveryRun's finally like
        // _labelSnapshot. Only built when the feature is on — it is pure cost
        // otherwise, and with it off the classifier ignores the index anyway.
        if (this.settings.ha_discovery_type_from_unit) {
            const { index, unknownTypes: unknown } = collectUnitTypeData(networkData, targetApps);
            this._unitTypeIndex = index;
            // This runs before the caller's own unsynced-units check (which only
            // decides whether to schedule a re-fetch), so a mid-sync tree does
            // reach classification. An input unit whose <Groups> has synced
            // while the load unit's has not looks input-only, and concluding
            // binary_sensor there retracts a real load's light config. Hold that
            // conclusion back until the tree is complete.
            this._treeIncomplete = networkHasUnsyncedUnits(networkData);

            // Only types on units that actually drive a discovered group are
            // reported: the message asks users to report them so they can be
            // classified, and a unit bound to no discovered application has
            // nothing to classify. Logging those was noise on every run
            // (gettree refreshes included) and drew issue reports about
            // measurement-only units and interfaces.
            if (unknown.length) {
                this.logger.info(
                    `Unit types not recognised for classification on network ${networkId}: ${unknown.join(', ')}. ` +
                    'Groups driven only by these units keep their default type. ' +
                    'Please report them on https://github.com/dougrathbone/cgateweb/issues/37'
                );
            }
        }

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

        // Security zones never appear in TREEXML at all (the security panel is
        // not a C-Bus unit with a <Groups> list); their labels live under
        // application 1, so announce one binary_sensor per labeled zone.
        this._supplementSecurityZonesFromLabels(networkId);

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

        this.syncUnlistedGroupDiscovery();

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

    /**
     * Announce one HA binary_sensor per security zone known from the label
     * data. Zone labels live under application 1 (`{net}/1/{zone}` keys — the
     * Toolkit import already ingests them); the entities are keyed on the
     * security app (208). Zones get announced at startup even before the first
     * zone event — important because zone events can be rare. Gated on
     * cbus_security_app_id (empty/'0' disables).
     * @this {HaDiscovery & HaDiscoveryMixinMethods}
     */
    _supplementSecurityZonesFromLabels(networkId) {
        const appId = this.settings.cbus_security_app_id;
        if (!appId || String(appId) === '0') return;
        const { labelMap } = this._labelSnapshot;
        if (!labelMap || labelMap.size === 0) return;

        let supplementCount = 0;

        for (const [labelKey] of labelMap) {
            // The parser validates the key shape and the zone number, so
            // malformed app-1 entries (e.g. '254/1/FrontDoor') are skipped
            // instead of producing bogus entities.
            const parsed = parseSecurityZoneLabelKey(labelKey);
            if (!parsed || parsed.network !== String(networkId)) continue;
            // ensureSecurityZoneDiscovery is idempotent and honours exclusions.
            if (this.ensureSecurityZoneDiscovery(networkId, appId, parsed.zone)) {
                supplementCount++;
            }
        }

        if (supplementCount > 0) {
            this.logger.info(`Supplemented ${supplementCount} security zones from label data for network ${networkId}`);
        }
    }

}

Object.assign(HaDiscovery.prototype, require('./haDiscoveryTreeSession'));
Object.assign(HaDiscovery.prototype, require('./haDiscoveryPublishers'));
Object.assign(HaDiscovery.prototype, require('./haDiscoveryPublishersSecurity'));
module.exports = HaDiscovery;
