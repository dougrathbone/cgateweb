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

        if (getallNetworks.length > 0 && this.bridge.settings.getallperiod) {
            if (this.bridge.periodicGetAllInterval) {
                clearInterval(this.bridge.periodicGetAllInterval);
            }
            this.bridge.log(`Starting periodic 'get all' every ${this.bridge.settings.getallperiod} seconds for networks: ${getallNetworks.join(', ')}.`);
            this.bridge.periodicGetAllInterval = setInterval(() => {
                this.bridge.log(`Getting all periodic values for networks: ${getallNetworks.join(', ')}...`);
                for (const netapp of getallNetworks) {
                    this.bridge.cgateCommandQueue.add(
                        `${CGATE_CMD_GET} //${this.bridge.settings.cbusname}/${netapp}/* ${CGATE_PARAM_LEVEL}${NEWLINE}`
                    );
                }
            }, this.bridge.settings.getallperiod * 1000).unref();
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

    stop() {
        if (this.bridge.periodicGetAllInterval) {
            clearInterval(this.bridge.periodicGetAllInterval);
            this.bridge.periodicGetAllInterval = null;
        }

        if (this.bridge._onLabelsChanged) {
            this.bridge.labelLoader.removeListener('labels-changed', this.bridge._onLabelsChanged);
            this.bridge._onLabelsChanged = null;
        }
        this.bridge.labelLoader.unwatch();
    }
}

module.exports = BridgeInitializationService;
