'use strict';

const haNotifier = require('./haNotifier');
const { MQTT_TOPIC_PREFIX_READ, MQTT_STATE_ON, MQTT_STATE_OFF } = require('./constants');

/**
 * Owns the CNI/PCI online/offline state machine for each C-Bus network.
 * A network-state poll response flows in via handleReading(); this records it
 * in the NetworkInterfaceMonitor, publishes the retained connectivity state on
 * transitions, and (when cni_offline_notification is enabled) raises/dismisses
 * a Home Assistant persistent notification. Behaviour is unchanged from the
 * original CgateWebBridge implementation.
 */
class CniNotificationManager {
    constructor({ networkInterfaceMonitor, mqttManager, getHaDiscovery, logger, settings, mqttOptions }) {
        this.networkInterfaceMonitor = networkInterfaceMonitor;
        this.mqttManager = mqttManager;
        // haDiscovery is initialized after the bridge constructor runs, so read it
        // live via an accessor to preserve the original late-binding behaviour.
        this.getHaDiscovery = getHaDiscovery;
        this.logger = logger;
        this.settings = settings;
        this.mqttOptions = mqttOptions;
    }

    handleReading(networkId, reading) {
        const result = this.networkInterfaceMonitor.update(networkId, reading);

        // Keep the connectivity binary_sensor's discovery config present (idempotent).
        const haDiscovery = this.getHaDiscovery();
        if (haDiscovery) {
            haDiscovery.ensureNetworkConnectivityDiscovery(networkId);
        }

        if (result.changed && result.online !== null) {
            this.mqttManager.publish(
                `${MQTT_TOPIC_PREFIX_READ}/${networkId}/cni/state`,
                result.online ? MQTT_STATE_ON : MQTT_STATE_OFF,
                { ...this.mqttOptions, retain: true }
            );

            if (this.settings.cni_offline_notification) {
                if (result.online === false) {
                    this._notifyCniOffline(networkId, result.interfaceState);
                } else {
                    this._dismissCniNotification(networkId);
                }
            }
        }
    }

    _notifyCniOffline(networkId, interfaceState) {
        const token = process.env.SUPERVISOR_TOKEN;
        if (!token) {
            this.logger.debug('cni_offline_notification enabled but no SUPERVISOR_TOKEN available; skipping HA notification.');
            return;
        }
        haNotifier.createPersistentNotification({
            notificationId: `cgateweb_cni_${networkId}`,
            title: 'C-Bus network offline',
            message: `The CNI/PCI link for C-Bus network ${networkId} has gone offline (InterfaceState=${interfaceState}). ` +
                'C-Bus devices on this network are unreachable until it reconnects.',
            token
        }).then((r) => {
            if (r.statusCode >= 200 && r.statusCode < 300) {
                this.logger.info(`Raised Home Assistant notification: C-Bus network ${networkId} offline.`);
            } else {
                this.logger.warn(`HA persistent_notification.create returned ${r.statusCode} for network ${networkId}.`);
            }
        }).catch((e) => this.logger.warn(`Failed to send HA CNI notification for network ${networkId}: ${e.message}`));
    }

    _dismissCniNotification(networkId) {
        const token = process.env.SUPERVISOR_TOKEN;
        if (!token) return;
        haNotifier.dismissPersistentNotification({
            notificationId: `cgateweb_cni_${networkId}`,
            token
        }).catch((e) => this.logger.debug(`Failed to dismiss HA CNI notification for network ${networkId}: ${e.message}`));
    }
}

module.exports = CniNotificationManager;
