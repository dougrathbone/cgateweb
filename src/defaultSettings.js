/**
 * Default settings for the cgateweb bridge.
 * These can be overridden by user settings in settings.js
 */
const defaultSettings = {
    mqtt: 'localhost:1883',
    cbusip: 'your-cgate-ip',
    cbusname: 'CLIPSAL',
    cbuscommandport: 20023,
    cbuseventport: 20025,
    cgateusername: null,
    cgatepassword: null,
    retainreads: false,
    logging: true,
    log_level: 'info',
    messageinterval: 200,
    commandMinIntervalMs: 10,
    maxQueueSize: 1000,
    getallnetapp: null,
    getallonstart: false,
    getallperiod: null,
    getall_app_periods: {},
    mqttusername: null,
    mqttpassword: null,
    mqttUseTls: false,
    mqttCaFile: null,
    mqttCertFile: null,
    mqttKeyFile: null,
    mqttRejectUnauthorized: true,
    reconnectinitialdelay: 1000,
    reconnectmaxdelay: 60000,
    connectionPoolSize: 3,
    healthCheckInterval: 30000,
    keepAliveInterval: 60000,
    eventConnectionKeepAliveInterval: 60000,
    connectionTimeout: 5000,
    maxRetries: 3,
    eventPublishDedupWindowMs: 0,
    eventPublishDedupMaxEntries: 5000,
    topicCacheMaxEntries: 5000,
    eventPublishCoalesce: false,
    auto_discover_networks: true,
    ha_discovery_enabled: false,
    ha_discovery_prefix: 'homeassistant',
    ha_discovery_networks: [],
    ha_discovery_cover_app_id: null,
    cover_ramp_duration_ms: 5000,
    ha_discovery_cover_tilt_app_id: null,
    ha_discovery_switch_app_id: null,
    ha_discovery_relay_app_id: null,
    ha_discovery_pir_app_id: null,
    ha_discovery_trigger_app_id: null,
    ha_discovery_scene_enabled: true,
    // Automatic device-type detection for groups on the Lighting application
    // (56). Phase 1: detect motorised covers (blinds/shutters) from the group
    // label. Only ever upgrades the lighting fallback — manual type_overrides
    // and application-id mappings always take precedence.
    ha_discovery_auto_type: true,
    ha_discovery_auto_type_name_heuristics: true,
    ha_discovery_auto_type_cover_keywords: [
        'blind', 'shutter', 'shade', 'awning', 'curtain', 'roller', 'garage door'
    ],
    ha_discovery_hvac_app_id: null,
    // C-Bus Air Conditioning app ID for native temperature reads (e.g. 172); null disables.
    cbus_aircon_app_id: null,
    ha_hvac_temperature_unit: 'C',
    ha_bridge_diagnostics_enabled: true,
    ha_bridge_diagnostics_interval_sec: 60,
    stale_device_detection_enabled: true,
    stale_device_threshold_hours: 24,
    stale_device_check_interval_sec: 3600,
    cbus_label_file: null,
    web_port: 8080,
    web_bind_host: '127.0.0.1',
    web_api_key: null,
    web_allow_unauthenticated_mutations: false,
    web_allowed_origins: null,
    web_mutation_rate_limit_per_minute: 120,
    // Web diagnostics: window (ms) within which a device counts as "active" in
    // the status page's device list. Default 24h.
    web_active_device_window_ms: 24 * 60 * 60 * 1000,
    // TTL (ms) for the cached Home Assistant areas list (Supervisor template API).
    web_ha_areas_cache_ttl_ms: 30000,
    // Timeout (ms) for outbound calls to the HA Supervisor API from the web UI.
    web_ha_api_timeout_ms: 5000,
    relativeLevelTimeoutMs: 5000,
    // HA Discovery TreeXML retry tuning. C-Gate accepts connections on the
    // command port before its networks are loaded, so an initial TREEXML can
    // return 401 "Network not found". These control the retry budget.
    haDiscoveryMaxTreeRetryAttempts: 8,
    haDiscoveryTreeRetryInitialDelayMs: 2000,
    haDiscoveryTreeRetryMaxDelayMs: 60000,
    haDiscoveryTreeRequestTimeoutMs: 8000,
    // Maximum size (bytes) for POST/PUT/PATCH request bodies on the web UI's
    // label-editing API. Default 10MB covers typical .cbz uploads.
    webMaxBodySizeBytes: 10 * 1024 * 1024,
    // Upper bound on DeviceStateManager's per-address level + last-seen maps.
    // Each entry is ~30 bytes; default 5000 covers any realistic install while
    // bounding worst-case growth from device churn over long uptime.
    deviceStateMaxEntries: 5000,
    // Apps whose raw C-Gate event lines should be logged verbatim (and published
    // to cbus/read/{net}/{app}/{group}/raw) for protocol capture. Empty = off.
    // Used to capture ground-truth samples for specialised applications
    // (e.g. 25 Temperature, 228 Measurement, 172 Air Conditioning) before
    // writing decoders. See docs/superpowers/specs/2026-06-02-native-cbus-hvac-support-design.md
    cbusRawEventLogApps: []
};

module.exports = { defaultSettings };
