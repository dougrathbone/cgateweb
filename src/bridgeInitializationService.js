const HaDiscovery = require('./haDiscovery');
const {
    CGATE_CMD_GET,
    CGATE_PARAM_LEVEL,
    NEWLINE,
    DEFAULT_CBUS_APP_LIGHTING
} = require('./constants');

class BridgeInitializationService {
    constructor(bridge) {
        this.bridge = bridge;
    }

    handleAllConnected() {
        const now = Date.now();
        if (now - this.bridge._lastInitTime < 10000) {
            this.bridge.log('ALL CONNECTED (duplicate within 10s, skipping re-initialization)');
            return;
        }
        this.bridge._lastInitTime = now;
        this.bridge.log('ALL CONNECTED - Initializing services...');

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
                this.bridge.haDiscovery.trigger();
            };
            this.bridge.labelLoader.on('labels-changed', this.bridge._onLabelsChanged);
            this.bridge.labelLoader.watch();
        }

        if (this.bridge.settings.ha_discovery_enabled) {
            this.bridge.haDiscovery.trigger();
        }

        this.bridge._updateBridgeReadiness('all-connected');
    }

    _resolveGetallNetworks() {
        const settings = this.bridge.settings;
        if (Array.isArray(settings.getall_networks) && settings.getall_networks.length > 0) {
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
            for (const network of settings.getall_networks) {
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
