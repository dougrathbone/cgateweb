const { createLogger } = require('./logger');
const { MQTT_TOPIC_STATUS } = require('./constants');

class HaBridgeDiagnostics {
    constructor(settings, publishFn, getStatusFn, logger = null) {
        this.settings = settings || {};
        this._publish = publishFn;
        this._getStatus = getStatusFn;
        this.logger = logger || createLogger({ component: 'HaBridgeDiagnostics' });
        this._intervalId = null;
        this._discoveryPublished = false;
    }

    start() {
        if (!this.settings.ha_bridge_diagnostics_enabled) {
            return;
        }

        const intervalSeconds = Math.max(10, Number(this.settings.ha_bridge_diagnostics_interval_sec) || 60);
        if (this._intervalId) {
            clearInterval(this._intervalId);
        }
        this._intervalId = setInterval(() => {
            this.publishNow('interval');
        }, intervalSeconds * 1000);
    }

    stop() {
        if (this._intervalId) {
            clearInterval(this._intervalId);
            this._intervalId = null;
        }
    }

    publishNow(reason = 'manual') {
        if (!this.settings.ha_bridge_diagnostics_enabled) {
            return;
        }
        if (typeof this._publish !== 'function' || typeof this._getStatus !== 'function') {
            return;
        }

        try {
            if (!this._discoveryPublished) {
                this._publishDiscovery();
                this._discoveryPublished = true;
            }
            this._publishState();
        } catch (error) {
            this.logger.warn(`Failed to publish bridge diagnostics (${reason}): ${error.message}`);
        }
    }

    _publishDiscovery() {
        const diagnostics = [
            { key: 'ready', component: 'binary_sensor', name: 'Bridge Ready', icon: 'mdi:check-network-outline' },
            { key: 'lifecycle_state', component: 'sensor', name: 'Bridge Lifecycle', icon: 'mdi:state-machine' },
            { key: 'mqtt_connected', component: 'binary_sensor', name: 'MQTT Connected', icon: 'mdi:lan-connect' },
            { key: 'event_connected', component: 'binary_sensor', name: 'Event Connection', icon: 'mdi:lan-connect' },
            { key: 'command_pool_healthy', component: 'sensor', name: 'Healthy Command Connections', icon: 'mdi:pool' },
            { key: 'command_queue_depth', component: 'sensor', name: 'Command Queue Depth', icon: 'mdi:queue-first-in-last-out' },
            { key: 'reconnect_indicator', component: 'sensor', name: 'Reconnect Indicator', icon: 'mdi:restart-alert' }
        ];

        for (const entity of diagnostics) {
            const topic = `${this.settings.ha_discovery_prefix}/${entity.component}/cgateweb_bridge_${entity.key}/config`;
            const stateTopic = `cbus/read/bridge/diagnostics/${entity.key}/state`;
            const payload = {
                name: entity.name,
                unique_id: `cgateweb_bridge_${entity.key}`,
                object_id: `cgateweb_bridge_${entity.key}`,
                state_topic: stateTopic,
                availability_topic: MQTT_TOPIC_STATUS,
                payload_available: 'Online',
                payload_not_available: 'Offline',
                entity_category: 'diagnostic',
                icon: entity.icon,
                ...(entity.component === 'binary_sensor' && {
                    payload_on: 'ON',
                    payload_off: 'OFF'
                }),
                device: {
                    identifiers: ['cgateweb_bridge'],
                    name: 'cgateweb Bridge',
                    manufacturer: 'Clipsal C-Bus via cgateweb',
                    model: 'Bridge Diagnostics'
                }
            };
            this._publish(topic, JSON.stringify(payload), { retain: true, qos: 0 });
        }
    }

    _publishState() {
        const status = this._getStatus() || {};
        const commandPool = status.connections?.commandPool || {};
        const queueDepth = status.metrics?.commandQueue?.depth || 0;
        const eventReconnectAttempts = Number(status.connections?.eventReconnectAttempts || 0);
        const pendingReconnects = Number(commandPool.pendingReconnects || 0);

        const reconnectIndicator = `event:${eventReconnectAttempts},pool:${pendingReconnects}`;
        const values = {
            ready: status.ready ? 'ON' : 'OFF',
            lifecycle_state: status.lifecycle?.state || 'unknown',
            mqtt_connected: status.connections?.mqtt ? 'ON' : 'OFF',
            event_connected: status.connections?.event ? 'ON' : 'OFF',
            command_pool_healthy: String(Number(commandPool.healthyConnections || 0)),
            command_queue_depth: String(Number(queueDepth)),
            reconnect_indicator: reconnectIndicator
        };

        for (const [key, value] of Object.entries(values)) {
            const topic = `cbus/read/bridge/diagnostics/${key}/state`;
            this._publish(topic, String(value), { retain: true, qos: 0 });
        }
    }
}

module.exports = HaBridgeDiagnostics;
