const parseString = require('xml2js').parseString;
const { findNetworkData, networkHasDeviceData } = require('./haDiscoveryTree');
const { buildOriginBlock } = require('./haDiscoveryPayloads');
const { backoffDelay } = require('./backoff');
const {
    MQTT_TOPIC_PREFIX_READ,
    MQTT_TOPIC_SUFFIX_DISCOVERY_STATUS,
    MQTT_TOPIC_STATUS,
    MQTT_RETAINED_STATE_OPTIONS,
    HA_COMPONENT_SENSOR,
    HA_DISCOVERY_SUFFIX,
    HA_DEVICE_VIA,
    HA_DEVICE_MANUFACTURER,
    DISCOVERY_STATE_DISCOVERING,
    DISCOVERY_STATE_OK,
    DISCOVERY_STATE_PAUSED,
    CGATE_CMD_TREEXML,
    NEWLINE,
    entityIdFields
} = require('./constants');

class _HaDiscoveryTreeSession {
    queueTreeRequest(networkId) {
        const normalizedNetwork = String(networkId);
        const state = this._getOrCreateTreeState(normalizedNetwork);

        // Sending a fresh request: clear any pending retry but keep the
        // attempts counter so backoff continues if this attempt also fails.
        this._clearTimer(state, 'retryHandle');

        this._setDiscoveryStatus(normalizedNetwork, DISCOVERY_STATE_DISCOVERING);

        // If a TREEXML for this network is already in flight (queued, streaming,
        // or parsing), don't send another. Overlapping trees for the same
        // network race the async parse callback and can corrupt retry state.
        if (this.pendingTreeNetworks.includes(normalizedNetwork)
            || (this.activeTreeSession && this.activeTreeSession.network === normalizedNetwork)
            || this._parsingNetworks.has(normalizedNetwork)) {
            this.logger.debug(`TreeXML for network ${normalizedNetwork} already in flight; skipping duplicate request`);
            return;
        }

        this.logger.info(`Requesting TreeXML for network ${normalizedNetwork}...`);
        this.pendingTreeNetworks.push(normalizedNetwork);

        const nextEpoch = (this._treeParseEpoch.get(normalizedNetwork) || 0) + 1;
        this._treeParseEpoch.set(normalizedNetwork, nextEpoch);

        this._clearTimer(state, 'watchdogHandle');
        state.watchdogHandle = this._setTimer(this._treeRequestTimeoutMs, () => {
            state.watchdogHandle = null;
            this._handleTreeRequestFailure(normalizedNetwork, 'no response within timeout');
        });

        // Project-qualify the network address (//PROJECT/NET). C-Gate 3.7.1
        // rejects a bare network number ("TREEXML 254" -> 401 Bad object or
        // device ID); the qualified form is what every other cgateweb command
        // already uses and works on 3.3.2 too (#23).
        this._sendCommand(`${CGATE_CMD_TREEXML} //${this.settings.cbusname}/${normalizedNetwork}${NEWLINE}`);
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
        // Drop any in-flight queue entry for this network (the watchdog-timeout
        // path leaves one behind) so the scheduled retry's queueTreeRequest is
        // not suppressed by the duplicate-request guard. Idempotent for the
        // 401/empty-tree paths, which already removed it in handleCommandError /
        // handleTreeStart.
        const pendingIdx = this.pendingTreeNetworks.indexOf(String(networkId));
        if (pendingIdx >= 0) this.pendingTreeNetworks.splice(pendingIdx, 1);

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
            origin: buildOriginBlock()
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

        // A response started arriving — drop the watchdog and any pending retry
        // so a late retry doesn't issue a redundant TREEXML. Keep the attempts
        // counter: an empty/unsynced tree (handled in handleTreeEnd) is not a
        // real success, so its backoff must keep progressing rather than reset
        // every time C-Gate returns another empty tree. The counter is reset
        // only once a tree with actual network data lands (handleTreeEnd).
        const startState = this._treeRequestState.get(networkKey);
        if (startState) {
            this._clearTimer(startState, 'watchdogHandle');
            this._clearTimer(startState, 'retryHandle');
        }

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

        // Defensive: a tree response we could not attribute to a real network
        // (pending queue empty and no prior treeNetwork) falls back to the
        // literal 'unknown' network in handleTreeStart. Publishing discovery for
        // it would create bogus cgateweb_unknown_* entities whose state topics
        // (cbus/read/unknown/...) never receive data. This should not happen now
        // that a gettree issues exactly one tracked TREEXML, but guard against
        // any stray/duplicate tree response rather than polluting HA (issue #25).
        if (networkForTree === 'unknown') {
            this.logger.warn(
                `Received a TreeXML response that could not be attributed to a requested network; ` +
                `dropping it instead of publishing 'unknown' entities. ` +
                `This usually means an unexpected/duplicate TREEXML response arrived.`
            );
            return;
        }

        // Log before parsing
        this.logger.info(`Starting XML parsing for network ${networkForTree}...`);
        const startTime = Date.now();
        const parseEpoch = this._treeParseEpoch.get(networkForTree) || 0;
        this._parsingNetworks.add(networkForTree);

        this._parseTreeXml(treeXmlData, (err, result) => {
            try {
                if ((this._treeParseEpoch.get(networkForTree) || 0) !== parseEpoch) {
                    this.logger.debug(`Ignoring stale TreeXML parse for network ${networkForTree}`);
                    return;
                }

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

                    // A network that exists in C-Gate but hasn't finished syncing
                    // its units yet returns an empty <Network></Network> (the
                    // network's State is still "new"). findNetworkData can't locate
                    // the network in that tree. Treat it as transient and retry with
                    // backoff rather than marking discovery ok with zero devices —
                    // otherwise no entities appear at startup until a manual gettree
                    // once the network has synced.
                    //
                    // Mid-sync C-Gate also returns a tree containing ONLY the network
                    // interface/management unit (Application 255, no groups) before
                    // the load units sync. findNetworkData finds that network, but it
                    // carries no addressable devices — accepting it published 0
                    // entities and stopped retrying, so real devices that synced
                    // moments later never appeared (issue #17). networkHasDeviceData
                    // treats a management-only tree as "still syncing" too.
                    const networkData = findNetworkData(networkForTree, result);
                    if (!networkData || !networkHasDeviceData(networkData)) {
                        this.logger.info(
                            `TreeXML for network ${networkForTree} contained no device data yet ` +
                            `(only network-management units present — network still syncing?); scheduling a retry.`
                        );
                        this._handleTreeRequestFailure(networkForTree, 'empty tree - network not synced yet');
                        return;
                    }

                    // Real tree data landed: this attempt succeeded, so clear the
                    // retry/backoff state for the network before publishing.
                    this._clearTreeState(networkForTree);

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
            } finally {
                this._parsingNetworks.delete(networkForTree);
            }
        });
    }

    /**
     * Parse TreeXML via xml2js. Extracted so tests can defer the callback and
     * exercise stale-parse / in-flight dedupe without fighting the module-level
     * parseString binding.
     * @param {string} treeXmlData
     * @param {Function} callback
     * @private
     */
    _parseTreeXml(treeXmlData, callback) {
        parseString(treeXmlData, { explicitArray: false }, callback);
    }
}

const methods = {};
for (const name of Object.getOwnPropertyNames(_HaDiscoveryTreeSession.prototype)) {
    if (name === 'constructor') continue;
    methods[name] = _HaDiscoveryTreeSession.prototype[name];
}
module.exports = methods;
