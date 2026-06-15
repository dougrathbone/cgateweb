const HaDiscovery = require('./haDiscovery');
const { createLogger } = require('./logger');
const {
    CGATE_CMD_GET,
    CGATE_PARAM_LEVEL,
    NEWLINE,
    DEFAULT_CBUS_APP_LIGHTING
} = require('./constants');

/**
 * Drives post-connection initialization (auto-discovery, initial/periodic
 * getall, CNI monitoring, HA Discovery setup) without reaching into and
 * mutating bridge internals.
 *
 * The service owns its own lifecycle state (debounce timestamp, periodic/CNI
 * timers, the labels-changed listener it registers). State the bridge owns and
 * exposes to other collaborators -- `discoveredNetworks` and `haDiscovery` --
 * is read back through injected getters and written back through injected
 * setters at the exact point in the init flow it changes today, so the bridge's
 * live accessors (`getHaDiscovery`, `_getBridgeStatus`, the mqttCommandRouter
 * handlers) keep observing the same values at the same moments.
 *
 * `handleAllConnected()` additionally returns an InitResult describing the state
 * it produced so the bridge has an explicit contract to apply, in addition to
 * the in-flight setter calls that preserve timing.
 */
class BridgeInitializationService {
    /**
     * @param {Object} deps
     * @param {Object} deps.settings - bridge settings (shared reference; read live)
     * @param {Object} deps.commandQueue - C-Gate command queue ({ add })
     * @param {Object} deps.mqttManager - MQTT manager ({ publish })
     * @param {Object} deps.labelLoader - label loader for HA Discovery labels
     * @param {Object} [deps.logger] - logger; defaults to a component logger
     * @param {Function} deps.getCommandResponseProcessor - () => commandResponseProcessor (live)
     * @param {Function} deps.getDiscoveredNetworks - () => current discovered networks (live)
     * @param {Function} deps.getHaDiscovery - () => current haDiscovery instance (live)
     * @param {Function} deps.applyDiscoveredNetworks - (networks) => set bridge.discoveredNetworks now
     * @param {Function} deps.applyHaDiscovery - (haDiscovery) => set bridge.haDiscovery (+ wire processor) now
     * @param {Function} deps.updateReadiness - (reason) => signal bridge readiness
     */
    constructor(deps) {
        this.settings = deps.settings;
        this.commandQueue = deps.commandQueue;
        this.mqttManager = deps.mqttManager;
        this.labelLoader = deps.labelLoader;
        this.logger = deps.logger || createLogger({ component: 'BridgeInitializationService' });
        // The bridge's logger (component 'bridge'); used for the handful of
        // messages that historically went through bridge.log so the log
        // component label is unchanged. Falls back to this.logger.info.
        this._log = deps.log || ((message) => this.logger.info(message));
        this._getCommandResponseProcessor = deps.getCommandResponseProcessor;
        this._getDiscoveredNetworks = deps.getDiscoveredNetworks;
        this._getHaDiscovery = deps.getHaDiscovery;
        this._applyDiscoveredNetworks = deps.applyDiscoveredNetworks;
        this._applyHaDiscovery = deps.applyHaDiscovery;
        this._updateReadiness = deps.updateReadiness;

        // Service-owned lifecycle state (nothing outside the service reads these).
        this._lastInitTime = 0;
        this._periodicGetAllInterval = null;
        this._cniMonitorTimer = null;
        this._onLabelsChanged = null;
        this._perAppTimers = new Map();
    }

    /**
     * Runs the post-connect initialization sequence and returns an InitResult
     * describing the state the bridge owns. The same state is also applied
     * in-flight through the injected setters so the bridge's live accessors see
     * it at the exact moment it changes today.
     *
     * @returns {Promise<{discoveredNetworks: (number[]|null), haDiscovery: (Object|null), onLabelsChanged: (Function|null)}>}
     *          An InitResult, or null when the call was debounced (no work ran).
     */
    async handleAllConnected() {
        const now = Date.now();
        if (now - this._lastInitTime < 10000) {
            this._log('ALL CONNECTED (duplicate within 10s, skipping re-initialization)');
            return null;
        }
        this._lastInitTime = now;
        this._log('ALL CONNECTED - Initializing services...');

        // Signal readiness up-front. All connection-health checks have already
        // passed by the time this handler fires, and the post-connect work
        // below (auto-discover, initial getall, HA Discovery TreeXML sweep) is
        // initialization that doesn't gate the bridge's ability to serve. The
        // production caller does not await this function, so moving the signal
        // up lets the readiness MQTT publish land on the wire before the
        // (potentially 5s) auto-discovery wait. Tests that await the function
        // still observe all work completing as before.
        this._updateReadiness('all-connected');

        // Auto-discover networks from C-Gate if enabled and no explicit config overrides it
        if (this.settings.autoDiscoverNetworks) {
            await this._discoverNetworks();
        }

        const getallNetworks = this._resolveGetallNetworks();

        if (getallNetworks.length > 0 && this.settings.getallonstart) {
            this._log(`Getting all initial values for networks: ${getallNetworks.join(', ')}...`);
            for (const netapp of getallNetworks) {
                this.commandQueue.add(
                    `${CGATE_CMD_GET} //${this.settings.cbusname}/${netapp}/* ${CGATE_PARAM_LEVEL}${NEWLINE}`
                );
            }
        }

        if (getallNetworks.length > 0 && (this.settings.getallperiod || this.settings.getall_app_periods)) {
            this._scheduleAllGetalls(getallNetworks);
        }

        // Monitor CNI/PCI connectivity per network (independent of getall).
        this._startNetworkInterfaceMonitoring();

        if (!this._getHaDiscovery()) {
            const haDiscovery = new HaDiscovery(
                this.settings,
                (topic, payload, options) => this.mqttManager.publish(topic, payload, options),
                (command) => this.commandQueue.add(command, { priority: 'bulk' }),
                this.labelLoader.getLabelData()
            );
            // Apply at the same moment it became non-null before: this wires the
            // command response processor and makes the bridge's live haDiscovery
            // accessors return the instance for the remainder of init.
            this._applyHaDiscovery(haDiscovery);

            this._onLabelsChanged = (labelData) => {
                this._log(`Labels reloaded (${labelData.labels.size} labels), re-triggering HA Discovery`);
                const hd = this._getHaDiscovery();
                hd.updateLabels(labelData);
                hd.trigger(this._getDiscoveredNetworks() || null);
            };
            this.labelLoader.on('labels-changed', this._onLabelsChanged);
            this.labelLoader.watch();
        }

        if (this.settings.ha_discovery_enabled) {
            this._getHaDiscovery().trigger(this._getDiscoveredNetworks() || null);
        }

        this._logStartupSummary();

        return {
            discoveredNetworks: this._getDiscoveredNetworks(),
            haDiscovery: this._getHaDiscovery(),
            onLabelsChanged: this._onLabelsChanged
        };
    }

    _logStartupSummary() {
        const s = this.settings;
        const lines = ['--- Startup Summary ---'];

        // Connections
        lines.push(`  C-Gate: ${s.cbusip}:${s.cbuscommandport} (pool: ${s.connectionPoolSize}), event port: ${s.cbuseventport}`);
        lines.push(`  MQTT: ${s.mqtt}${s.mqttusername ? ' (authenticated)' : ''}`);

        // Networks
        const nets = this._getDiscoveredNetworks();
        if (nets && nets.length > 0) {
            lines.push(`  Networks: ${nets.join(', ')} (auto-discovered)`);
        } else if (s.ha_discovery_networks && s.ha_discovery_networks.length > 0) {
            lines.push(`  Networks: ${s.ha_discovery_networks.join(', ')} (configured)`);
        }

        // Features
        const features = [];
        if (s.ha_discovery_enabled) features.push('HA Discovery');
        if (s.ha_bridge_diagnostics_enabled) features.push('Bridge Diagnostics');
        if (s.stale_device_detection_enabled) features.push('Stale Device Detection');
        if (s.getallonstart) features.push('Get-All on Start');
        if (s.getallperiod) features.push(`Periodic Poll (${s.getallperiod}s)`);
        if (s.eventPublishCoalesce) features.push('Event Coalescing');
        if (s.eventPublishDedupWindowMs > 0) features.push(`Dedup (${s.eventPublishDedupWindowMs}ms)`);
        lines.push(`  Features: ${features.length > 0 ? features.join(', ') : 'none'}`);

        // Device types
        const types = [];
        if (s.ha_discovery_cover_app_id) types.push(`covers(app ${s.ha_discovery_cover_app_id})`);
        if (s.ha_discovery_switch_app_id) types.push(`switches(app ${s.ha_discovery_switch_app_id})`);
        if (s.ha_discovery_pir_app_id) types.push(`PIR(app ${s.ha_discovery_pir_app_id})`);
        if (s.ha_discovery_trigger_app_id) types.push(`triggers(app ${s.ha_discovery_trigger_app_id})`);
        if (s.ha_discovery_hvac_app_id) types.push(`HVAC(app ${s.ha_discovery_hvac_app_id})`);
        if (types.length > 0) {
            lines.push(`  Device types: lights + ${types.join(', ')}`);
        }

        // Labels
        const labelCount = this.labelLoader.getLabelsObject ? Object.keys(this.labelLoader.getLabelsObject()).length : 0;
        if (labelCount > 0) {
            lines.push(`  Labels: ${labelCount} custom labels loaded`);
        }

        // Web
        lines.push(`  Web UI: http://${s.web_bind_host || '127.0.0.1'}:${s.web_port || 8080}/`);

        lines.push('--- Ready ---');
        for (const line of lines) {
            this.logger.info(line);
        }
    }

    /**
     * Returns the poll interval in milliseconds for a given app ID.
     * Checks getall_app_periods[appId] first, falls back to getallperiod.
     * Returns 0 if the app should not be polled.
     */
    _getIntervalForApp(appId) {
        const appPeriods = this.settings.getall_app_periods;
        const key = String(appId);
        if (appPeriods && Object.prototype.hasOwnProperty.call(appPeriods, key)) {
            return appPeriods[key] * 1000;
        }
        return (this.settings.getallperiod || 0) * 1000;
    }

    /**
     * Schedules a recurring poll for a specific network/app path.
     * Replaces any existing timer for that path.
     */
    _scheduleGetallForApp(networkAppPath, intervalMs) {
        if (this._perAppTimers.has(networkAppPath)) {
            clearInterval(this._perAppTimers.get(networkAppPath));
            this._perAppTimers.delete(networkAppPath);
        }
        if (!intervalMs) {
            return;
        }
        this._log(`Starting periodic 'get all' for ${networkAppPath} every ${intervalMs / 1000} seconds.`);
        const handle = setInterval(() => {
            this.logger.debug(`Getting all periodic values for ${networkAppPath}...`);
            this.commandQueue.add(
                `${CGATE_CMD_GET} //${this.settings.cbusname}/${networkAppPath}/* ${CGATE_PARAM_LEVEL}${NEWLINE}`
            );
        }, intervalMs).unref();
        this._perAppTimers.set(networkAppPath, handle);
    }

    /**
     * Schedules per-app timers for all unique network×app combinations.
     * Stops existing timers first. Apps with interval=0 are skipped.
     */
    _scheduleAllGetalls(getallNetworks) {
        // Clear old single-interval timer (backwards-compat)
        if (this._periodicGetAllInterval) {
            clearInterval(this._periodicGetAllInterval);
            this._periodicGetAllInterval = null;
        }
        // Clear existing per-app timers
        for (const handle of this._perAppTimers.values()) {
            clearInterval(handle);
        }
        this._perAppTimers.clear();

        for (const netapp of getallNetworks) {
            const appId = netapp.split('/')[1];
            const intervalMs = this._getIntervalForApp(appId);
            this._scheduleGetallForApp(netapp, intervalMs);
        }
    }

    /**
     * Sends `tree //PROJECT` to C-Gate and parses the response to find all network IDs.
     * Applies the discovered network IDs to the bridge.
     * Falls back silently if the command fails or returns no networks.
     */
    async _discoverNetworks() {
        const cbusname = this.settings.cbusname;
        const command = `tree //${cbusname}${NEWLINE}`;

        return new Promise((resolve) => {
            const collectedLines = [];
            const TIMEOUT_MS = 5000;

            // Register a handler on the command response processor to intercept responses
            const processor = this._getCommandResponseProcessor();
            if (!processor) {
                this.logger.warn('Network auto-discovery: commandResponseProcessor not available, skipping');
                resolve();
                return;
            }

            let settled = false;
            const timeoutRef = { handle: null };

            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutRef.handle);
                processor.networkDiscoveryHandler = null;

                // Parse collected lines for network IDs: lines like "//HOME/254" or "//HOME/1"
                // C-Gate response format: statusData is "//PROJECT/NETWORKID" (numeric network IDs only)
                const projectPrefix = `//${cbusname}/`;
                const networkPattern = new RegExp(`^${projectPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`);
                const networks = [];
                for (const line of collectedLines) {
                    const match = line.match(networkPattern);
                    if (match) {
                        const id = parseInt(match[1], 10);
                        if (!isNaN(id) && !networks.includes(id)) {
                            networks.push(id);
                        }
                    }
                }

                if (networks.length > 0) {
                    this._applyDiscoveredNetworks(networks);
                    this.logger.info(`Auto-discovered C-Bus networks: [${networks.join(', ')}]`);
                } else {
                    this.logger.info('Network auto-discovery returned no networks; falling back to configured values');
                    this._applyDiscoveredNetworks(null);
                }
                resolve();
            };

            // C-Gate tree response: each level of the tree comes back as a 200 response line.
            // After the last tree line, C-Gate sends a "200-OK" or similar terminal response.
            // We collect lines that match //PROJECT/NNN and stop on a 4xx/5xx error or timeout.
            // Returning true claims the response so the default error logger doesn't also fire.
            processor.networkDiscoveryHandler = (responseCode, statusData) => {
                if (responseCode === '200') {
                    collectedLines.push(statusData);
                    return false;
                } else if (responseCode.startsWith('4') || responseCode.startsWith('5')) {
                    this.logger.info(`Network auto-discovery: C-Gate ${responseCode} ${statusData}; using configured networks`);
                    finish();
                    return true;
                }
                return false;
            };

            timeoutRef.handle = setTimeout(() => {
                this.logger.debug('Network auto-discovery: timeout, resolving with collected lines');
                finish();
            }, TIMEOUT_MS);
            // Don't let this startup-discovery timer keep the process alive on shutdown.
            timeoutRef.handle.unref?.();

            // Queue the tree command (direct add, bypassing throttle priority so it runs first)
            this.commandQueue.add(command);
        });
    }

    /**
     * Resolve the C-Bus network IDs to monitor for CNI/PCI connectivity:
     * auto-discovered networks first, then configured getall/discovery networks,
     * finally the network from getallnetapp. Returns unique numeric-id strings.
     */
    _resolveMonitorNetworkIds() {
        const s = this.settings;
        const ids = new Set();
        const add = (arr) => {
            if (!Array.isArray(arr)) return;
            for (const n of arr) {
                const m = String(n).match(/\d+/);
                if (m) ids.add(m[0]);
            }
        };
        const discoveredNetworks = this._getDiscoveredNetworks();
        if (discoveredNetworks && discoveredNetworks.length > 0) {
            add(discoveredNetworks);
        }
        add(s.getall_networks);
        add(s.ha_discovery_networks);
        if (ids.size === 0 && s.getallnetapp) {
            const m = String(s.getallnetapp).match(/^(\d+)/);
            if (m) ids.add(m[1]);
        }
        return [...ids];
    }

    /**
     * Queue read-only GETs for each network's InterfaceState + State. Responses
     * flow back through CommandResponseProcessor → NetworkInterfaceMonitor.
     */
    _pollNetworkInterfaceStates(networkIds) {
        for (const net of networkIds) {
            const base = `//${this.settings.cbusname}/${net}`;
            this.commandQueue.add(`${CGATE_CMD_GET} ${base} InterfaceState${NEWLINE}`);
            this.commandQueue.add(`${CGATE_CMD_GET} ${base} State${NEWLINE}`);
        }
    }

    /**
     * Poll network interface (CNI) state once now and then on an interval, so a
     * CNI dropout between C-Gate and the C-Bus network surfaces on the status
     * page even though cgateweb's TCP link to C-Gate stays up.
     */
    _startNetworkInterfaceMonitoring() {
        const intervalMs = this.settings.cniMonitorIntervalMs;
        if (!intervalMs || intervalMs <= 0) return;
        const networkIds = this._resolveMonitorNetworkIds();
        if (networkIds.length === 0) {
            this.logger.debug('CNI monitoring: no networks resolved; skipping.');
            return;
        }
        this._pollNetworkInterfaceStates(networkIds); // initial reading
        if (this._cniMonitorTimer) clearInterval(this._cniMonitorTimer);
        this._cniMonitorTimer = setInterval(
            () => this._pollNetworkInterfaceStates(networkIds),
            intervalMs
        ).unref();
        this._log(`Monitoring C-Bus network interface (CNI) state for [${networkIds.join(', ')}] every ${intervalMs / 1000}s.`);
    }

    _resolveGetallNetworks() {
        const settings = this.settings;

        // Determine effective network list: explicit config takes priority, then auto-discovered
        let networks = null;
        const discoveredNetworks = this._getDiscoveredNetworks();
        if (Array.isArray(settings.getall_networks) && settings.getall_networks.length > 0) {
            networks = settings.getall_networks;
        } else if (discoveredNetworks && discoveredNetworks.length > 0) {
            networks = discoveredNetworks;
        }

        if (networks) {
            const appIds = new Set([DEFAULT_CBUS_APP_LIGHTING]);
            const optionalAppSettings = [
                'ha_discovery_cover_app_id',
                'ha_discovery_hvac_app_id',
                'ha_discovery_trigger_app_id',
                'ha_discovery_switch_app_id',
                'ha_discovery_relay_app_id'
            ];
            for (const key of optionalAppSettings) {
                if (settings[key]) {
                    appIds.add(String(settings[key]));
                }
            }
            const results = [];
            for (const network of networks) {
                for (const appId of appIds) {
                    results.push(`${network}/${appId}`);
                }
            }
            return results;
        }
        if (settings.getallnetapp) {
            return [settings.getallnetapp];
        }
        return [];
    }

    /**
     * Handles C-Gate command errors. If a 401 (not found) is received for a path
     * that is being periodically polled, the polling timer is cancelled to prevent
     * recurring error logs for apps that don't exist on this C-Bus installation.
     * Also forwards 401 errors to HaDiscovery so it can retry TreeXML requests
     * that fail because C-Gate hasn't finished loading networks at startup.
     */
    handleCommandError(code, statusData) {
        const haDiscovery = this._getHaDiscovery();
        if (haDiscovery) {
            haDiscovery.handleCommandError(code, statusData);
        }

        if (code !== '401') return;
        // Extract network/app path from statusData like:
        // "Bad object or device ID: //CLIPSAL/254/203/* (Object not found)"
        const match = statusData && statusData.match(/\/\/[^/]+\/(\d+\/\d+)\/\*/);
        if (!match) return;
        const netapp = match[1];
        if (this._perAppTimers.has(netapp)) {
            clearInterval(this._perAppTimers.get(netapp));
            this._perAppTimers.delete(netapp);
            this.logger.warn(`Stopped periodic poll for ${netapp}: app not found on C-Bus system (401). Remove it from your configuration to suppress this message.`);
        }
    }

    stop() {
        if (this._periodicGetAllInterval) {
            clearInterval(this._periodicGetAllInterval);
            this._periodicGetAllInterval = null;
        }

        for (const handle of this._perAppTimers.values()) {
            clearInterval(handle);
        }
        this._perAppTimers.clear();

        if (this._cniMonitorTimer) {
            clearInterval(this._cniMonitorTimer);
            this._cniMonitorTimer = null;
        }

        if (this._onLabelsChanged) {
            this.labelLoader.removeListener('labels-changed', this._onLabelsChanged);
            this._onLabelsChanged = null;
        }
        this.labelLoader.unwatch();

        const haDiscovery = this._getHaDiscovery();
        if (haDiscovery) {
            haDiscovery.stop();
            haDiscovery.removeAllListeners?.();
            // Clearing the bridge's haDiscovery + processor wiring on stop.
            this._applyHaDiscovery(null);
        }
    }
}

module.exports = BridgeInitializationService;
