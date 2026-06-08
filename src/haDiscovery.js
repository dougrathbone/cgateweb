const parseString = require('xml2js').parseString;
const { createLogger } = require('./logger');
const { getDiscoveryTypeForApp, getDiscoveryConfig } = require('./haDiscoveryConfigs');
const { classifyLightingGroup } = require('./deviceTypeClassifier');
const { findNetworkData, collectUnitGroups } = require('./haDiscoveryTree');
const { backoffDelay } = require('./backoff');
const {
    DEFAULT_CBUS_APP_LIGHTING,
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
    MQTT_TOPIC_SUFFIX_DISCOVERY_STATUS,
    MQTT_TOPIC_STATUS,
    MQTT_RETAINED_STATE_OPTIONS,
    HA_COMPONENT_LIGHT,
    HA_COMPONENT_BUTTON,
    HA_COMPONENT_CLIMATE,
    HA_COMPONENT_SCENE,
    HA_COMPONENT_SENSOR,
    HA_DISCOVERY_SUFFIX,
    HA_DEVICE_VIA,
    HA_DEVICE_MANUFACTURER,
    HA_MODEL_LIGHTING,
    HA_MODEL_TRIGGER,
    HA_ORIGIN_NAME,
    HA_ORIGIN_SW_VERSION,
    HA_ORIGIN_SUPPORT_URL,
    DISCOVERY_STATE_DISCOVERING,
    DISCOVERY_STATE_OK,
    DISCOVERY_STATE_PAUSED,
    CGATE_CMD_TREEXML,
    NEWLINE,
    entityIdFields
} = require('./constants');

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
        this._maxTreeRetryAttempts = (settings && settings.haDiscoveryMaxTreeRetryAttempts) || 8;
        this._treeRetryInitialDelayMs = (settings && settings.haDiscoveryTreeRetryInitialDelayMs) || 2000;
        this._treeRetryMaxDelayMs = (settings && settings.haDiscoveryTreeRetryMaxDelayMs) || 60000;
        this._treeRequestTimeoutMs = (settings && settings.haDiscoveryTreeRequestTimeoutMs) || 8000;

        // Tracks per-network HA Discovery health. The status field is used to
        // de-dup repeated state publishes; configPublished gates the (one-shot)
        // HA Discovery config payload so we don't republish it on every
        // transition. networkId -> { status, configPublished }
        this._networkDiscoveryEntities = new Map();
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
     * Counterpart to handleNetworkCreated: when C-Gate signals that a network
     * has been removed/deleted, clear all retained HA Discovery config topics
     * for that network so the entities don't linger in HA forever. Empty
     * retained payloads tell HA Discovery to delete the entity. Also cancels
     * any in-flight TREEXML request and clears internal state for the network.
     */
    handleNetworkRemoved(networkId) {
        if (!this.settings.ha_discovery_enabled) return;
        const networkKey = String(networkId);

        // Cancel any in-flight or pending discovery for this network.
        this._clearTreeState(networkKey);
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

    queueTreeRequest(networkId) {
        const normalizedNetwork = String(networkId);
        const state = this._getOrCreateTreeState(normalizedNetwork);

        // Sending a fresh request: clear any pending retry but keep the
        // attempts counter so backoff continues if this attempt also fails.
        this._clearTimer(state, 'retryHandle');

        this._setDiscoveryStatus(normalizedNetwork, DISCOVERY_STATE_DISCOVERING);
        this.logger.info(`Requesting TreeXML for network ${normalizedNetwork}...`);

        // Avoid duplicate pending entries when a retry races a late response.
        if (!this.pendingTreeNetworks.includes(normalizedNetwork)) {
            this.pendingTreeNetworks.push(normalizedNetwork);
        }

        this._clearTimer(state, 'watchdogHandle');
        state.watchdogHandle = this._setTimer(this._treeRequestTimeoutMs, () => {
            state.watchdogHandle = null;
            this._handleTreeRequestFailure(normalizedNetwork, 'no response within timeout');
        });

        this._sendCommand(`${CGATE_CMD_TREEXML} ${normalizedNetwork}${NEWLINE}`);
    }

    _getOrCreateTreeState(networkId) {
        let state = this._treeRequestState.get(networkId);
        if (!state) {
            state = { attempts: 0, watchdogHandle: null, retryHandle: null };
            this._treeRequestState.set(networkId, state);
        }
        return state;
    }

    _clearTreeState(networkId) {
        const state = this._treeRequestState.get(networkId);
        if (!state) return;
        this._clearTimer(state, 'watchdogHandle');
        this._clearTimer(state, 'retryHandle');
        this._treeRequestState.delete(networkId);
    }

    _clearTimer(state, key) {
        if (state[key]) {
            clearTimeout(state[key]);
            state[key] = null;
        }
    }

    _setTimer(delayMs, fn) {
        const handle = setTimeout(fn, delayMs);
        if (typeof handle.unref === 'function') handle.unref();
        return handle;
    }

    /**
     * Receives a 4xx/5xx C-Gate command error and, if it indicates that an
     * in-flight TreeXML request failed because the network isn't loaded yet,
     * fast-fails the head of the pending queue and schedules a retry.
     *
     * Tree-related "Network not found" errors come back without a path
     * ("401 Bad object or device ID: Network not found"), whereas getall errors
     * include a path ("401 Bad object or device ID: //PROJECT/254/56/* (...)").
     * That difference lets us distinguish the two.
     */
    handleCommandError(code, statusData) {
        if (code !== '401') return;
        const data = statusData || '';
        if (!/Network not found/i.test(data)) return;
        if (/\/\/[^/]+\/\d+/.test(data)) return;
        if (this.pendingTreeNetworks.length === 0) return;

        const failedNetwork = this.pendingTreeNetworks.shift();
        const state = this._treeRequestState.get(failedNetwork);
        if (state) this._clearTimer(state, 'watchdogHandle');
        this._handleTreeRequestFailure(failedNetwork, '401 Network not found');
    }

    _handleTreeRequestFailure(networkId, reason) {
        const state = this._getOrCreateTreeState(networkId);
        state.attempts += 1;

        if (state.attempts > this._maxTreeRetryAttempts) {
            this.logger.warn(
                `HA Discovery: TreeXML for network ${networkId} failed after ${this._maxTreeRetryAttempts} attempts (${reason}). ` +
                `Auto-discovery for this network is paused. ` +
                `Verify the network is configured and reachable in C-Gate, then restart the bridge or publish to cbus/write/${networkId}///gettree to retry.`
            );
            this._clearTreeState(networkId);
            this._setDiscoveryStatus(networkId, DISCOVERY_STATE_PAUSED);
            return;
        }

        const delay = backoffDelay(state.attempts - 1, {
            initialMs: this._treeRetryInitialDelayMs,
            maxMs: this._treeRetryMaxDelayMs,
            jitter: false
        });

        this.logger.warn(
            `HA Discovery: TreeXML for network ${networkId} failed (${reason}). ` +
            `Retrying in ${Math.round(delay / 1000)}s (attempt ${state.attempts}/${this._maxTreeRetryAttempts}). ` +
            `This typically means C-Gate is still loading networks at startup.`
        );

        this._clearTimer(state, 'retryHandle');
        state.retryHandle = this._setTimer(delay, () => {
            state.retryHandle = null;
            this.queueTreeRequest(networkId);
        });
    }

    /**
     * Cancels all retry timers and watchdogs and clears per-network state.
     * Call on bridge shutdown.
     */
    stop() {
        for (const networkId of [...this._treeRequestState.keys()]) {
            this._clearTreeState(networkId);
        }
        this._networkDiscoveryEntities.clear();
    }

    /**
     * Publishes a per-network "Discovery (Network N)" diagnostic sensor to HA
     * via MQTT Discovery. Idempotent — only publishes the config payload once
     * per network for the lifetime of this instance.
     */
    _publishDiscoveryStatusConfig(entry, networkKey) {
        if (entry.configPublished) return;

        const uniqueId = `cgateweb_discovery_${networkKey}`;
        const stateTopic = `${MQTT_TOPIC_PREFIX_READ}/${networkKey}///${MQTT_TOPIC_SUFFIX_DISCOVERY_STATUS}`;
        const configTopic = `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_SENSOR}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`;
        const payload = {
            name: `Discovery (Network ${networkKey})`,
            unique_id: uniqueId,
            ...entityIdFields(HA_COMPONENT_SENSOR, uniqueId),
            state_topic: stateTopic,
            availability_topic: MQTT_TOPIC_STATUS,
            payload_available: 'Online',
            payload_not_available: 'Offline',
            entity_category: 'diagnostic',
            icon: 'mdi:radar',
            device: {
                identifiers: [HA_DEVICE_VIA],
                name: 'cgateweb Bridge',
                manufacturer: HA_DEVICE_MANUFACTURER,
                model: 'Bridge Diagnostics'
            },
            origin: {
                name: HA_ORIGIN_NAME,
                sw_version: HA_ORIGIN_SW_VERSION,
                support_url: HA_ORIGIN_SUPPORT_URL
            }
        };

        this._publish(configTopic, JSON.stringify(payload), MQTT_RETAINED_STATE_OPTIONS);
        entry.configPublished = true;
    }

    /**
     * Updates the per-network discovery status. Publishes the HA Discovery
     * config the first time a network is seen, then publishes the state to the
     * sensor's state topic. Skips republishes when the state hasn't changed.
     *
     * @param {string|number} networkId
     * @param {('discovering'|'ok'|'paused')} status
     */
    _setDiscoveryStatus(networkId, status) {
        if (!this.settings.ha_discovery_enabled) return;
        const networkKey = String(networkId);
        let entry = this._networkDiscoveryEntities.get(networkKey);
        if (!entry) {
            entry = { status: null, configPublished: false };
            this._networkDiscoveryEntities.set(networkKey, entry);
        }
        if (entry.status === status) return;

        this._publishDiscoveryStatusConfig(entry, networkKey);
        const previous = entry.status;
        entry.status = status;

        const stateTopic = `${MQTT_TOPIC_PREFIX_READ}/${networkKey}///${MQTT_TOPIC_SUFFIX_DISCOVERY_STATUS}`;
        this._publish(stateTopic, status, MQTT_RETAINED_STATE_OPTIONS);
        this.logger.debug(`Discovery status for network ${networkKey}: ${previous || 'init'} -> ${status}`);
    }

    handleTreeStart(_statusData) {
        if (this.activeTreeSession && this.activeTreeSession.bufferParts.length > 0) {
            this.logger.warn(`Received a new TreeXML start before previous tree completed; dropping incomplete tree for network ${this.activeTreeSession.network}`);
        }

        const nextNetwork = this.pendingTreeNetworks.shift() || this.treeNetwork || 'unknown';
        const networkKey = String(nextNetwork);

        // The request succeeded — drop watchdog and any pending retry so a
        // late retry doesn't issue a redundant TREEXML, and reset the attempts
        // counter for any future failure on this network.
        this._clearTreeState(networkKey);

        this.activeTreeSession = {
            network: networkKey,
            bufferParts: []
        };

        this.treeNetwork = this.activeTreeSession.network;
        this.treeBufferParts = this.activeTreeSession.bufferParts;
        this.logger.info(`Started receiving TreeXML. Network: ${this.treeNetwork}`);
    }

    handleTreeData(statusData) {
        if (!this.activeTreeSession) {
            this.logger.warn('Received TreeXML data without active tree session; creating fallback session.');
            this.handleTreeStart('');
        }
        this.activeTreeSession.bufferParts.push(statusData);
    }

    handleTreeEnd(_statusData) {
        if (!this.activeTreeSession) {
            // Backward-compatibility fallback for existing tests/callers that
            // still set treeNetwork/treeBufferParts directly.
            if (this.treeNetwork && Array.isArray(this.treeBufferParts)) {
                this.activeTreeSession = {
                    network: String(this.treeNetwork),
                    bufferParts: [...this.treeBufferParts]
                };
            } else {
                this.logger.warn('Received TreeXML end (344) but no active tree session was set.');
                return;
            }
        }

        const { network, bufferParts } = this.activeTreeSession;
        const treeXmlData = bufferParts.join(NEWLINE) + (bufferParts.length > 0 ? NEWLINE : '');
        this.logger.info(`Finished receiving TreeXML. Network: ${network}. Size: ${treeXmlData.length} bytes. Parsing...`);
        const networkForTree = network;
        
        // Clear buffer and network context immediately
        this.activeTreeSession = null;
        this.treeBufferParts = []; 
        this.treeNetwork = null; 

        if (!networkForTree || !treeXmlData) {
             this.logger.warn(`Received TreeXML end (344) but no buffer or network context was set.`);
             return;
        }

        // Log before parsing
        this.logger.info(`Starting XML parsing for network ${networkForTree}...`);
        const startTime = Date.now();

        parseString(treeXmlData, { explicitArray: false }, (err, result) => {
            const duration = Date.now() - startTime;
            if (err) {
                this.logger.error(`Error parsing TreeXML for network ${networkForTree} (took ${duration}ms): ${err.message || err}`, {
                    xmlLength: treeXmlData.length,
                    xmlPreview: treeXmlData.slice(0, 200),
                    line: err.line,
                    column: err.column
                });
                // Surface the parse failure to the retry mechanism so a malformed
                // response from C-Gate (truncated, mid-restart, encoding glitch)
                // doesn't leave discovery silently stuck. Same backoff budget as
                // 401-on-tree applies; we'll PAUSE after the retry limit.
                this._handleTreeRequestFailure(networkForTree, `parse error: ${err.message || err}`);
            } else {
                this.logger.info(`Parsed TreeXML for network ${networkForTree} (took ${duration}ms)`);

                // Publish standard tree topic
                this._publish(
                    `${MQTT_TOPIC_PREFIX_READ}/${networkForTree}///tree`,
                    JSON.stringify(result),
                    MQTT_RETAINED_STATE_OPTIONS
                );

                // Generate HA Discovery messages
                this._publishDiscoveryFromTree(networkForTree, result);

                this._setDiscoveryStatus(networkForTree, DISCOVERY_STATE_OK);
            }
        });
    }

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
        const networkUniqueIdPrefix = `cgateweb_${networkId}_`;
        for (const topic of this._publishedTopics) {
            if (topic.includes(`/${networkUniqueIdPrefix}`) && !this._currentRunTopics.has(topic)) {
                this.logger.debug(`Clearing stale discovery topic: ${topic}`);
                this._publish(topic, '', MQTT_RETAINED_STATE_OPTIONS);
            }
        }

        // Merge the current run's topics into the session-wide set and remove
        // any stale topics that were just cleared. Snapshot the set first to avoid
        // deleting from a collection during iteration.
        for (const topic of [...this._publishedTopics]) {
            if (topic.includes(`/${networkUniqueIdPrefix}`) && !this._currentRunTopics.has(topic)) {
                this._publishedTopics.delete(topic);
            }
        }
        for (const topic of this._currentRunTopics) {
            this._publishedTopics.add(topic);
        }
        this._currentRunTopics = null;

        const duration = Date.now() - startTime;
        const { custom, treexml, fallback } = this.labelStats;
        this.logger.info(`HA Discovery completed for network ${networkId}. Published ${this.discoveryCount} entities (took ${duration}ms). Labels: ${custom} custom, ${treexml} from TREEXML, ${fallback} fallback`);

        // Clear snapshot so any later code that reaches for it without an
        // active discovery run fails loudly rather than reading stale data.
        this._labelSnapshot = null;
    }

    /**
     * Create discovery entities for labeled groups not already found in TREEXML.
     * The flat TREEXML format may omit groups not assigned to specific units,
     * but they are still valid and controllable on the C-Bus network.
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

    _processLightingGroups(networkId, appId, groups) {
        const { labelMap, typeOverrides, entityIds, exclude, areas } = this._labelSnapshot;
        const groupArray = Array.isArray(groups) ? groups : [groups];
        
        groupArray.forEach(group => {
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

            // Resolve an effective type. Manual type_overrides have absolute
            // priority; auto-detection only fills in when there is no override
            // and only ever upgrades the lighting fallback (it never returns
            // 'light'). Application-id mappings are handled in
            // _processEnableControlGroups and never reach this lighting path.
            const labelForClassification = labelMap.get(labelKey) || group.Label || '';
            let resolvedType = typeOverrides.get(labelKey);
            if (!resolvedType) {
                resolvedType = classifyLightingGroup(labelForClassification, this.settings);
            }
            if (resolvedType && resolvedType !== 'light') {
                const config = getDiscoveryConfig(resolvedType);
                if (config) {
                    this.logger.debug(`Resolved type: ${labelKey} -> ${resolvedType}`);
                    if (config.isHvac) {
                        // HVAC needs the dedicated climate payload (temperature/mode
                        // topics); the generic builder would publish a broken
                        // climate entity with no thermostat controls.
                        this._createHvacDiscovery(networkId, appId, groupId, group.Label);
                    } else {
                        this._createDiscovery(networkId, appId, groupId, group.Label, config);
                    }
                    // Remove any stale retained light config for this group.
                    // This covers the case where the type changes within the same session
                    // (e.g. first run saw it as a light; this run resolves a non-light type).
                    const uniqueId = `cgateweb_${networkId}_${appId}_${groupId}`;
                    const staleTopic = `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_LIGHT}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`;
                    this._publish(staleTopic, '', MQTT_RETAINED_STATE_OPTIONS);
                    // Ensure the stale light topic is not retained in _publishedTopics
                    this._publishedTopics.delete(staleTopic);
                    return;
                }
                this.logger.warn(`Unknown resolved type "${resolvedType}" for ${labelKey}, falling back to light`);
            }

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
                device: {
                    identifiers: [uniqueId],
                    name: finalLabel,
                    manufacturer: HA_DEVICE_MANUFACTURER,
                    model: HA_MODEL_LIGHTING,
                    via_device: HA_DEVICE_VIA,
                    ...(area && { suggested_area: area })
                },
                origin: {
                    name: HA_ORIGIN_NAME,
                    sw_version: HA_ORIGIN_SW_VERSION,
                    support_url: HA_ORIGIN_SUPPORT_URL
                }
            };

            this._publish(discoveryTopic, JSON.stringify(payload), MQTT_RETAINED_STATE_OPTIONS);
            if (this._currentRunTopics) this._currentRunTopics.add(discoveryTopic);
            this.discoveryCount++;
        });
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
            min_temp: 0,
            max_temp: 50,
            temp_step: 0.5,

            qos: 0,
            // command topics must NOT be retained (see _createDiscovery note)
            device: {
                identifiers: [uniqueId],
                name: finalLabel,
                manufacturer: HA_DEVICE_MANUFACTURER,
                model: 'HVAC Zone (Air Conditioning)',
                via_device: HA_DEVICE_VIA,
                ...(area && { suggested_area: area })
            },
            origin: {
                name: HA_ORIGIN_NAME,
                sw_version: HA_ORIGIN_SW_VERSION,
                support_url: HA_ORIGIN_SUPPORT_URL
            }
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
            device: {
                identifiers: [uniqueId],
                name: finalLabel,
                manufacturer: HA_DEVICE_MANUFACTURER,
                model: config.model,
                via_device: HA_DEVICE_VIA,
                ...(area && { suggested_area: area })
            },
            origin: {
                name: HA_ORIGIN_NAME,
                sw_version: HA_ORIGIN_SW_VERSION,
                support_url: HA_ORIGIN_SUPPORT_URL
            }
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
            device: {
                identifiers: [`cgateweb_${networkId}_${appId}_${groupId}`],
                name: label,
                manufacturer: HA_DEVICE_MANUFACTURER,
                model: HA_MODEL_TRIGGER,
                via_device: HA_DEVICE_VIA
            },
            origin: {
                name: HA_ORIGIN_NAME,
                sw_version: HA_ORIGIN_SW_VERSION,
                support_url: HA_ORIGIN_SUPPORT_URL
            }
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
            device: {
                identifiers: [`cgateweb_${networkId}_${appId}_${groupId}`],
                name: label,
                manufacturer: HA_DEVICE_MANUFACTURER,
                model: HA_MODEL_TRIGGER,
                via_device: HA_DEVICE_VIA
            },
            origin: {
                name: HA_ORIGIN_NAME,
                sw_version: HA_ORIGIN_SW_VERSION,
                support_url: HA_ORIGIN_SUPPORT_URL
            }
        };

        this._publish(discoveryTopic, JSON.stringify(payload), MQTT_RETAINED_STATE_OPTIONS);
        this.discoveryCount++;
    }

}

module.exports = HaDiscovery;