// @ts-check
const {
    HA_COMPONENT_COVER,
    HA_COMPONENT_SWITCH,
    HA_COMPONENT_CLIMATE,
    HA_COMPONENT_EVENT,
    HA_COMPONENT_BUTTON,
    HA_COMPONENT_SCENE,
    HA_COMPONENT_BINARY_SENSOR,
    HA_DEVICE_CLASS_SHUTTER,
    HA_DEVICE_CLASS_OUTLET,
    HA_MODEL_COVER,
    HA_MODEL_SWITCH,
    HA_MODEL_RELAY,
    HA_MODEL_PIR,
    HA_MODEL_TRIGGER,
    HA_MODEL_HVAC,
    MQTT_STATE_ON,
    MQTT_STATE_OFF
} = require('./constants');

// [setting key, discovery type] — the first configured app id that matches
// the address wins (order preserves the original if-chain).
const APP_ID_TYPE_TABLE = [
    ['ha_discovery_cover_app_id', 'cover'],
    ['ha_discovery_switch_app_id', 'switch'],
    ['ha_discovery_relay_app_id', 'relay'],
    ['ha_discovery_pir_app_id', 'pir'],
    ['ha_discovery_trigger_app_id', 'trigger'],
    ['ha_discovery_hvac_app_id', 'hvac']
];

function getDiscoveryTypeForApp(settings, appAddress) {
    const appStr = String(appAddress);
    for (const [settingKey, type] of APP_ID_TYPE_TABLE) {
        if (settings[settingKey] && appStr === String(settings[settingKey])) {
            return type;
        }
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
            component: HA_COMPONENT_BINARY_SENSOR,
            defaultType: 'PIR',
            model: HA_MODEL_PIR,
            deviceClass: 'motion',
            payloads: {
                payload_on: MQTT_STATE_ON,
                payload_off: MQTT_STATE_OFF
            },
            omitCommandTopic: true
        },
        trigger: {
            component: HA_COMPONENT_EVENT,
            defaultType: 'Trigger',
            model: HA_MODEL_TRIGGER,
            payloads: {
                event_types: ['trigger']
            },
            omitCommandTopic: true,
            isTrigger: true
        },
        trigger_button: {
            component: HA_COMPONENT_BUTTON,
            defaultType: 'Trigger',
            model: HA_MODEL_TRIGGER,
            payloads: {
                payload_press: MQTT_STATE_ON
            },
            isTriggerButton: true
        },
        hvac: {
            component: HA_COMPONENT_CLIMATE,
            defaultType: 'HVAC Zone',
            model: HA_MODEL_HVAC,
            isHvac: true,
            omitCommandTopic: true  // HVAC uses dedicated topic structure, not a single command_topic
        },
        scene: {
            component: HA_COMPONENT_SCENE,
            defaultType: 'Scene',
            model: HA_MODEL_TRIGGER,
            omitStateTopic: true,
            omitCommandTopic: false,
            isScene: true
        }
    };
    return configs[type];
}

module.exports = {
    getDiscoveryTypeForApp,
    getDiscoveryConfig
};
