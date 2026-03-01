const {
    HA_COMPONENT_COVER,
    HA_COMPONENT_SWITCH,
    HA_DEVICE_CLASS_SHUTTER,
    HA_DEVICE_CLASS_OUTLET,
    HA_MODEL_COVER,
    HA_MODEL_SWITCH,
    HA_MODEL_RELAY,
    HA_MODEL_PIR,
    MQTT_STATE_ON,
    MQTT_STATE_OFF
} = require('./constants');

function getDiscoveryTypeForApp(settings, appAddress) {
    const appStr = String(appAddress);
    if (settings.ha_discovery_cover_app_id && appStr === String(settings.ha_discovery_cover_app_id)) {
        return 'cover';
    }
    if (settings.ha_discovery_switch_app_id && appStr === String(settings.ha_discovery_switch_app_id)) {
        return 'switch';
    }
    if (settings.ha_discovery_relay_app_id && appStr === String(settings.ha_discovery_relay_app_id)) {
        return 'relay';
    }
    if (settings.ha_discovery_pir_app_id && appStr === String(settings.ha_discovery_pir_app_id)) {
        return 'pir';
    }
    return null;
}

function getDiscoveryConfig(type) {
    const configs = {
        cover: {
            component: HA_COMPONENT_COVER,
            defaultType: 'Cover',
            model: HA_MODEL_COVER,
            deviceClass: HA_DEVICE_CLASS_SHUTTER,
            positionSupport: true,
            payloads: {
                payload_open: MQTT_STATE_ON,
                payload_close: MQTT_STATE_OFF,
                state_open: MQTT_STATE_ON,
                state_closed: MQTT_STATE_OFF
            }
        },
        switch: {
            component: HA_COMPONENT_SWITCH,
            defaultType: 'Switch',
            model: HA_MODEL_SWITCH,
            payloads: {
                payload_on: MQTT_STATE_ON,
                payload_off: MQTT_STATE_OFF,
                state_on: MQTT_STATE_ON,
                state_off: MQTT_STATE_OFF
            }
        },
        relay: {
            component: HA_COMPONENT_SWITCH,
            defaultType: 'Relay',
            model: HA_MODEL_RELAY,
            deviceClass: HA_DEVICE_CLASS_OUTLET,
            payloads: {
                payload_on: MQTT_STATE_ON,
                payload_off: MQTT_STATE_OFF,
                state_on: MQTT_STATE_ON,
                state_off: MQTT_STATE_OFF
            }
        },
        pir: {
            component: 'binary_sensor',
            defaultType: 'PIR',
            model: HA_MODEL_PIR,
            deviceClass: 'motion',
            payloads: {
                payload_on: MQTT_STATE_ON,
                payload_off: MQTT_STATE_OFF
            },
            omitCommandTopic: true
        }
    };
    return configs[type];
}

module.exports = {
    getDiscoveryTypeForApp,
    getDiscoveryConfig
};
