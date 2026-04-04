const HaDiscovery = require('./haDiscovery');
const { createLogger } = require('./logger');
const {
    CGATE_CMD_GET,
    CGATE_PARAM_LEVEL,
    NEWLINE,
    DEFAULT_CBUS_APP_LIGHTING
} = require('./constants');

class BridgeInitializationService {
    constructor(bridge) {
        this.bridge = bridge;
        this.logger = createLogger({ component: 'BridgeInitializationService' });
        this._perAppTimers = new Map();
    }

    async handleAllConnected() {
        const now = Date.now();
        if (now - this.bridge._lastInitTime < 10000) {
            this.bridge.log('ALL CONNECTED (duplicate within 10s, skipping re-initialization)');
            return;
        }
        this.bridge._lastInitTime = now;
        this.bridge.log('ALL CONNECTED - Initializing services...');

        // Auto-discover networks from C-Gate if enabled and no explicit config overrides it
        if (this.bridge.settings.autoDiscoverNetworks) {
            await this._discoverNetworks();
        }

        const getallNetworks = this._resolveGetallNetworks();

        if (getallNetworks.length > 0 && this.bridge.settings.getallonstart) {
            this.bridge.log(`Getting all initial values for networks: ${getallNetworks.join(', ')}...`);
            for (const netapp of getallNetworks) {
                this.bridge.cgateCommandQueue.add(
                    `${CGATE_CMD_GET} //${this.bridge.settings.cbusname}/${netapp}/* ${CGATE_PARAM_LEVEL}${NEWLINE}`
                );
            }
        }

        if (getallNetworks.length > 0 && (this.bridge.settings.getallperiod || this.bridge.settings.getall_app_periods)) {
            this._scheduleAllGetalls(getallNetworks);
        }

        if (!this.bridge.haDiscovery) {
            this.bridge.haDiscovery = new HaDiscovery(
                this.bridge.settings,
                (topic, payload, options) => this.bridge.mqttManager.publish(topic, payload, options),
                (command) => this.bridge.cgateCommandQueue.add(command, { priority: 'bulk' }),
                this.bridge.labelLoader.getLabelData()
            );
            this.bridge.commandResponseProcessor.haDiscovery = this.bridge.haDiscovery;

            this.bridge._onLabelsChanged = (labelData) => {
                this.bridge.logger.info(`Labels reloaded (${labelData.labels.size} labels), re-triggering HA Discovery`);
                this.bridge.haDiscovery.updateLabels(labelData);
                this.bridge.haDiscovery.trigger(this.bridge.discoveredNetworks || null);
            };
            this.bridge.labelLoader.on('labels-changed', this.bridge._onLabelsChanged);
            this.bridge.labelLoader.watch();
        }

        if (this.bridge.settings.ha_discovery_enabled) {
            this.bridge.haDiscovery.trigger(this.bridge.discoveredNetworks || null);
        }

        this.bridge._updateBridgeReadiness('all-connected');
        this._logStartupSummary();
    }

    _logStartupSummary() {
        const s = this.bridge.settings;
        const lines = ['--- Startup Summary ---'];

        // Connections
        lines.push(`  C-Gate: ${s.cbusip}:${s.cbuscommandport} (pool: ${s.connectionPoolSize}), event port: ${s.cbuseventport}`);
        lines.push(`  MQTT: ${s.mqtt}${s.mqttusername ? ' (authenticated)' : ''}`);

        // Networks
        const nets = this.bridge.discoveredNetworks;
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
        const labelCount = this.bridge.labelLoader.getLabelsObject ? Object.keys(this.bridge.labelLoader.getLabelsObject()).length : 0;
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
        const appPeriods = this.bridge.settings.getall_app_periods;
        const key = String(appId);
        if (appPeriods && Object.prototype.hasOwnProperty.call(appPeriods, key)) {
            return appPeriods[key] * 1000;
        }
        return (this.bridge.settings.getallperiod || 0) * 1000;
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
        this.bridge.log(`Starting periodic 'get all' for ${networkAppPath} every ${intervalMs / 1000} seconds.`);
        const handle = setInterval(() => {
            this.bridge.log(`Getting all periodic values for ${networkAppPath}...`);
            this.bridge.cgateCommandQueue.add(
                `${CGATE_CMD_GET} //${this.bridge.settings.cbusname}/${networkAppPath}/* ${CGATE_PARAM_LEVEL}${NEWLINE}`
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
        if (this.bridge.periodicGetAllInterval) {
            clearInterval(this.bridge.periodicGetAllInterval);
            this.bridge.periodicGetAllInterval = null;
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
     * Stores discovered network IDs on `this.bridge.discoveredNetworks`.
     * Falls back silently if the command fails or returns no networks.
     */
    async _discoverNetworks() {
        const cbusname = this.bridge.settings.cbusname;
        const command = `tree //${cbusname}${NEWLINE}`;

        return new Promise((resolve) => {
            const collectedLines = [];
            const TIMEOUT_MS = 5000;

            // Register a handler on the command response processor to intercept responses
            const processor = this.bridge.commandResponseProcessor;
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
                    this.bridge.discoveredNetworks = networks;
                    this.logger.info(`Auto-discovered C-Bus networks: [${networks.join(', ')}]`);
                } else {
                    this.logger.warn('Network auto-discovery returned no networks; using configured values');
                    this.bridge.discoveredNetworks = null;
                }
                resolve();
            };

            // C-Gate tree response: each level of the tree comes back as a 200 response line.
            // After the last tree line, C-Gate sends a "200-OK" or similar terminal response.
            // We collect lines that match //PROJECT/NNN and stop on a 4xx/5xx error or timeout.
            processor.networkDiscoveryHandler = (responseCode, statusData) => {
                if (responseCode === '200') {
                    collectedLines.push(statusData);
                } else if (responseCode.startsWith('4') || responseCode.startsWith('5')) {
                    // Error response — discovery failed
                    this.logger.warn(`Network auto-discovery failed with C-Gate error ${responseCode}: ${statusData}`);
                    finish();
                }
                // Other codes (300, etc.) are ignored during discovery
            };

            timeoutRef.handle = setTimeout(() => {
                this.logger.debug('Network auto-discovery: timeout, resolving with collected lines');
                finish();
            }, TIMEOUT_MS);

            // Queue the tree command (direct add, bypassing throttle priority so it runs first)
            this.bridge.cgateCommandQueue.add(command);
        });
    }

    _resolveGetallNetworks() {
        const settings = this.bridge.settings;

        // Determine effective network list: explicit config takes priority, then auto-discovered
        let networks = null;
        if (Array.isArray(settings.getall_networks) && settings.getall_networks.length > 0) {
            networks = settings.getall_networks;
        } else if (this.bridge.discoveredNetworks && this.bridge.discoveredNetworks.length > 0) {
            networks = this.bridge.discoveredNetworks;
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
     */
    handleCommandError(code, statusData) {
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
        if (this.bridge.periodicGetAllInterval) {
            clearInterval(this.bridge.periodicGetAllInterval);
            this.bridge.periodicGetAllInterval = null;
        }

        for (const handle of this._perAppTimers.values()) {
            clearInterval(handle);
        }
        this._perAppTimers.clear();

        if (this.bridge._onLabelsChanged) {
            this.bridge.labelLoader.removeListener('labels-changed', this.bridge._onLabelsChanged);
            this.bridge._onLabelsChanged = null;
        }
        this.bridge.labelLoader.unwatch();

        if (this.bridge.haDiscovery) {
            this.bridge.haDiscovery.removeAllListeners?.();
            this.bridge.haDiscovery = null;
            this.bridge.commandResponseProcessor.haDiscovery = null;
        }
    }
}

module.exports = BridgeInitializationService;
