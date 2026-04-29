const { createLogger } = require('./logger');
const { MQTT_TOPIC_STATUS, entityIdFields, HA_COMPONENT_SENSOR, HA_DEVICE_VIA } = require('./constants');

/**
 * Periodically checks for C-Bus devices that have not reported a state change
 * within a configurable window and publishes the results as a Home Assistant
 * sensor entity via MQTT Discovery.
 *
 * Only devices that have reported at least once (i.e. have a lastSeen entry)
 * are considered — groups that have never reported are ignored because they
 * may be genuinely unused.
 *
 * Settings consumed (with defaults):
 *   stale_device_detection_enabled  {boolean} true
 *   stale_device_threshold_hours    {number}  24
 *   stale_device_check_interval_sec {number}  3600
 *   ha_discovery_prefix             {string}  'homeassistant'
 */
class StaleDeviceDetector {
    /**
     * @param {Object} options
     * @param {Object} options.deviceStateManager - DeviceStateManager instance
     * @param {Object} options.mqttClient         - Object with publish(topic, payload, opts) method
     * @param {Object} options.settings           - Application settings
     * @param {Object} [options.labelLoader]      - LabelLoader instance (optional)
     * @param {Object} [options.logger]           - Logger instance (optional)
     */
    constructor({ deviceStateManager, mqttClient, settings, labelLoader, logger }) {
        this.deviceStateManager = deviceStateManager;
        this.mqttClient = mqttClient;
        this.settings = settings || {};
        this.labelLoader = labelLoader || null;
        this.logger = logger || createLogger({ component: 'StaleDeviceDetector' });
        this._timerId = null;
    }

    /**
     * Start periodic stale-device checks.
     * Publishes HA discovery on first call, then runs an immediate check
     * followed by checks on the configured interval.
     */
    start() {
        if (!this.settings.stale_device_detection_enabled) {
            return;
        }

        const intervalSec = Math.max(60, Number(this.settings.stale_device_check_interval_sec) || 3600);

        this._publishDiscovery();
        this._check();

        if (this._timerId) {
            clearInterval(this._timerId);
        }
        this._timerId = setInterval(() => {
            this._check();
        }, intervalSec * 1000).unref();
    }

    /**
     * Stop the periodic check timer.
     */
    stop() {
        if (this._timerId) {
            clearInterval(this._timerId);
            this._timerId = null;
        }
    }

    /**
     * Run a single stale-device check and publish results.
     * @private
     */
    _check() {
        try {
            const thresholdMs = Math.max(1, Number(this.settings.stale_device_threshold_hours) || 24) * 60 * 60 * 1000;
            const staleDevices = this._getStaleDevices(thresholdMs);
            this._publishStaleCount(staleDevices.length, staleDevices);
        } catch (error) {
            this.logger.warn(`StaleDeviceDetector._check failed: ${error.message}`);
        }
    }

    /**
     * Return an array of stale device info objects for devices whose lastSeen
     * timestamp is older than thresholdMs ago.
     *
     * @param {number} thresholdMs - Age threshold in milliseconds
     * @returns {Array<{address: string, label: string, last_seen: string, hours_ago: number}>}
     * @private
     */
    _getStaleDevices(thresholdMs) {
        const now = Date.now();
        const cutoff = now - thresholdMs;
        const allLastSeen = this.deviceStateManager.getAllLastSeen();
        const labels = this.labelLoader ? this.labelLoader.getLabels() : new Map();
        const stale = [];

        for (const [address, ts] of allLastSeen) {
            if (ts < cutoff) {
                const hoursAgo = Math.round(((now - ts) / (60 * 60 * 1000)) * 10) / 10;
                stale.push({
                    address,
                    label: labels.get(address) || address,
                    last_seen: new Date(ts).toISOString(),
                    hours_ago: hoursAgo
                });
            }
        }

        return stale;
    }

    /**
     * Publish the stale device count to the state topic and full details to the
     * attributes topic.
     *
     * @param {number} count          - Number of stale devices
     * @param {Array}  staleDevices   - Array of stale device info objects
     * @private
     */
    _publishStaleCount(count, staleDevices) {
        const thresholdHours = Math.max(1, Number(this.settings.stale_device_threshold_hours) || 24);
        const opts = { retain: true, qos: 0 };

        this.mqttClient.publish('cbus/bridge/stale_devices', String(count), opts);

        const attributes = {
            stale_devices: staleDevices,
            threshold_hours: thresholdHours,
            checked_at: new Date().toISOString()
        };
        this.mqttClient.publish('cbus/bridge/stale_devices_detail', JSON.stringify(attributes), opts);
    }

    /**
     * Publish the HA MQTT Discovery payload for the stale-devices sensor.
     * @private
     */
    _publishDiscovery() {
        const prefix = this.settings.ha_discovery_prefix || 'homeassistant';
        const topic = `${prefix}/${HA_COMPONENT_SENSOR}/cgateweb_stale_devices/config`;
        const payload = {
            name: 'C-Bus Stale Devices',
            unique_id: 'cgateweb_stale_devices',
            ...entityIdFields(HA_COMPONENT_SENSOR, 'cgateweb_stale_devices'),
            state_topic: 'cbus/bridge/stale_devices',
            json_attributes_topic: 'cbus/bridge/stale_devices_detail',
            unit_of_measurement: 'devices',
            icon: 'mdi:alert-circle-outline',
            entity_category: 'diagnostic',
            availability_topic: MQTT_TOPIC_STATUS,
            payload_available: 'Online',
            payload_not_available: 'Offline',
            device: {
                identifiers: [HA_DEVICE_VIA],
                name: 'cgateweb Bridge',
                manufacturer: 'Clipsal C-Bus via cgateweb',
                model: 'Bridge Diagnostics'
            }
        };
        this.mqttClient.publish(topic, JSON.stringify(payload), { retain: true, qos: 0 });
    }
}

module.exports = StaleDeviceDetector;
