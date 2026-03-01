const HaDiscovery = require('./haDiscovery');
const {
    CGATE_CMD_GET,
    CGATE_PARAM_LEVEL,
    NEWLINE
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

        if (this.bridge.settings.getallnetapp && this.bridge.settings.getallonstart) {
            this.bridge.log(`Getting all initial values for ${this.bridge.settings.getallnetapp}...`);
            this.bridge.cgateCommandQueue.add(
                `${CGATE_CMD_GET} //${this.bridge.settings.cbusname}/${this.bridge.settings.getallnetapp}/* ${CGATE_PARAM_LEVEL}${NEWLINE}`
            );
        }

        if (this.bridge.settings.getallnetapp && this.bridge.settings.getallperiod) {
            if (this.bridge.periodicGetAllInterval) {
                clearInterval(this.bridge.periodicGetAllInterval);
            }
            this.bridge.log(`Starting periodic 'get all' every ${this.bridge.settings.getallperiod} seconds.`);
            this.bridge.periodicGetAllInterval = setInterval(() => {
                this.bridge.log(`Getting all periodic values for ${this.bridge.settings.getallnetapp}...`);
                this.bridge.cgateCommandQueue.add(
                    `${CGATE_CMD_GET} //${this.bridge.settings.cbusname}/${this.bridge.settings.getallnetapp}/* ${CGATE_PARAM_LEVEL}${NEWLINE}`
                );
            }, this.bridge.settings.getallperiod * 1000);
        }

        if (!this.bridge.haDiscovery) {
            this.bridge.haDiscovery = new HaDiscovery(
                this.bridge.settings,
                (topic, payload, options) => this.bridge.mqttManager.publish(topic, payload, options),
                (command) => this.bridge._sendCgateCommand(command),
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
