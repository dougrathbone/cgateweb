// @ts-check
'use strict';

/**
 * Mechanical addon-option → runtime-settings mappings.
 *
 * Special cases (managed/remote C-Gate, MQTT host:port composition,
 * getall_app_periods shapes, label-file auto-detect, dual keep-alive
 * assignment, etc.) stay in ConfigLoader._convertAddonOptionsToSettings.
 */

const ADDON_OPTION_MAP = [
    { src: 'mqtt_username', dst: 'mqttusername', kind: 'copyTruthy' },
    { src: 'mqtt_password', dst: 'mqttpassword', kind: 'copyTruthy' },
    { src: 'mqtt_use_tls', dst: 'mqttUseTls', kind: 'setTrue' },
    { src: 'mqtt_ca_file', dst: 'mqttCaFile', kind: 'copyTruthy' },

    { src: 'getall_on_start', dst: 'getallonstart', kind: 'setTrue' },
    { src: 'getall_period', dst: 'getallperiod', kind: 'copyTruthy' },
    { src: 'retain_reads', dst: 'retainreads', kind: 'setTrue' },

    { src: 'ha_discovery_cover_app_id', dst: 'ha_discovery_cover_app_id', kind: 'stringifyTruthy', when: 'haDiscovery' },
    { src: 'ha_discovery_cover_tilt_app_id', dst: 'ha_discovery_cover_tilt_app_id', kind: 'stringifyTruthy', when: 'haDiscovery' },
    { src: 'ha_discovery_switch_app_id', dst: 'ha_discovery_switch_app_id', kind: 'stringifyTruthy', when: 'haDiscovery' },
    { src: 'ha_discovery_trigger_app_id', dst: 'ha_discovery_trigger_app_id', kind: 'stringifyTruthy', when: 'haDiscovery' },
    { src: 'ha_discovery_hvac_app_id', dst: 'ha_discovery_hvac_app_id', kind: 'stringifyTruthy', when: 'haDiscovery' },
    { src: 'cbus_aircon_app_id', dst: 'cbus_aircon_app_id', kind: 'stringifyTruthy', when: 'haDiscovery' },
    { src: 'ha_hvac_temperature_unit', dst: 'ha_hvac_temperature_unit', kind: 'copyTruthy', when: 'haDiscovery' },
    { src: 'ha_discovery_auto_type', dst: 'ha_discovery_auto_type', kind: 'boolDefined', when: 'haDiscovery' },
    { src: 'ha_discovery_auto_type_name_heuristics', dst: 'ha_discovery_auto_type_name_heuristics', kind: 'boolDefined', when: 'haDiscovery' },
    { src: 'ha_discovery_type_from_label_prefix', dst: 'ha_discovery_type_from_label_prefix', kind: 'boolDefined', when: 'haDiscovery' },
    { src: 'cbus_aircon_control_enabled', dst: 'cbus_aircon_control_enabled', kind: 'boolDefined', when: 'haDiscovery' },

    { src: 'ha_bridge_diagnostics_enabled', dst: 'ha_bridge_diagnostics_enabled', kind: 'boolDefined' },
    { src: 'ha_bridge_diagnostics_interval_sec', dst: 'ha_bridge_diagnostics_interval_sec', kind: 'copyDefined' },
    { src: 'stale_device_detection_enabled', dst: 'stale_device_detection_enabled', kind: 'boolDefined' },
    { src: 'stale_device_threshold_hours', dst: 'stale_device_threshold_hours', kind: 'copyDefined' },
    { src: 'stale_device_check_interval_sec', dst: 'stale_device_check_interval_sec', kind: 'copyDefined' },
    { src: 'cni_offline_notification', dst: 'cni_offline_notification', kind: 'boolDefined' },

    { src: 'connection_pool_size', dst: 'connectionPoolSize', kind: 'copyDefined' },
    { src: 'connection_health_check_interval_sec', dst: 'healthCheckInterval', kind: 'secToMs' },
    { src: 'cover_ramp_duration_sec', dst: 'cover_ramp_duration_ms', kind: 'secToMs' },

    { src: 'web_port', dst: 'web_port', kind: 'copyTruthy' },
    { src: 'web_api_key', dst: 'web_api_key', kind: 'copyTruthy' },
    { src: 'web_allow_unauthenticated_mutations', dst: 'web_allow_unauthenticated_mutations', kind: 'boolDefined' },
    { src: 'web_mutation_rate_limit_per_minute', dst: 'web_mutation_rate_limit_per_minute', kind: 'copyDefined' }
];

/**
 * Apply mechanical option mappings onto `config`.
 * @param {Object} config - Mutable runtime settings object
 * @param {Object} options - Raw addon options
 * @param {{ haDiscovery?: boolean }} [flags]
 */
function applyAddonOptionMap(config, options, flags = {}) {
    const haDiscovery = flags.haDiscovery === true;

    for (const rule of ADDON_OPTION_MAP) {
        if (rule.when === 'haDiscovery' && !haDiscovery) {
            continue;
        }
        const value = options[rule.src];
        switch (rule.kind) {
            case 'copyTruthy':
                if (value) {
                    config[rule.dst] = value;
                }
                break;
            case 'setTrue':
                if (value) {
                    config[rule.dst] = true;
                }
                break;
            case 'boolDefined':
                if (value !== undefined && value !== null) {
                    config[rule.dst] = value === true;
                }
                break;
            case 'copyDefined':
                if (value !== undefined && value !== null) {
                    config[rule.dst] = value;
                }
                break;
            case 'secToMs':
                if (value !== undefined && value !== null) {
                    config[rule.dst] = value * 1000;
                }
                break;
            case 'stringifyTruthy':
                if (value) {
                    config[rule.dst] = String(value);
                }
                break;
            default:
                break;
        }
    }
}

module.exports = {
    ADDON_OPTION_MAP,
    applyAddonOptionMap
};
