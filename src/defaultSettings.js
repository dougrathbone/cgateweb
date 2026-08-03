// @ts-check
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
    // Max reconnection attempts for a standalone (non-pooled) C-Gate connection
    // before it gives up. Pool-managed connections are governed by the pool.
    cgateMaxReconnectAttempts: 10,
    // MQTT client reconnect/connect timing (passed to mqtt.js connect options).
    mqttReconnectPeriodMs: 5000,
    mqttConnectTimeoutMs: 30000,
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
    // Runtime consumers read the camelCase `autoDiscoverNetworks`. The HA add-on
    // exposes this as the snake_case `auto_discover_networks` option, which
    // ConfigLoader maps to camelCase; standalone settings.js may use either form.
    autoDiscoverNetworks: true,
    ha_discovery_enabled: false,
    ha_discovery_prefix: 'homeassistant',
    ha_discovery_networks: [],
    ha_discovery_cover_app_id: null,
    cover_ramp_duration_ms: 5000,
    // How often (ms) the cover ramp tracker emits interpolated position updates
    // during a ramp so Home Assistant shows smooth progress.
    coverRampUpdateIntervalMs: 500,
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
    // Resolve a group's discovery type from an entity-id-style label prefix
    // (e.g. "cover.bedroom_shutter" → cover) for users who name C-Bus groups
    // with their intended HA entity id (issue #35). Opt-in; manual
    // type_overrides still win.
    ha_discovery_type_from_label_prefix: false,
    // Resolve a group's discovery type from the C-Bus unit that drives it
    // (issues #38, #37): dimmer channels become dimmable lights, relay channels
    // on/off lights, and groups driven only by an input unit (bus coupler, key
    // input) become binary sensors. Opt-in, because enabling it can change which
    // entity a group already published as. Precedence: manual type_overrides
    // win first, then the cover-name keyword heuristics, then this unit-type
    // classification. Cover names outrank unit type because a relay can equally
    // drive a light, a motorised blind or an irrigation valve — a name that
    // positively identifies a cover is better evidence than the hardware type.
    // Unrecognised unit types are left alone.
    ha_discovery_type_from_unit: false,
    ha_discovery_hvac_app_id: null,
    // C-Bus Air Conditioning app ID for native temperature reads (e.g. 172); null disables.
    cbus_aircon_app_id: null,
    // Opt-in: allow Home Assistant to CONTROL native Air Conditioning thermostats
    // (set mode/setpoint) via AIRCON commands. Off by default — it writes to live
    // heating/cooling. Requires cbus_aircon_app_id to be set.
    cbus_aircon_control_enabled: false,
    // C-Bus Security app ID for zone sensors (default 208). Publishes one
    // binary_sensor per zone (sealed/unsealed) and syncs zone state via
    // security status_request on connect. Empty or '0' disables.
    cbus_security_app_id: '208',
    // Opt-in: allow Home Assistant to ARM/DISARM the security panel via
    // `security arm` commands. Off by default — the write carries no PIN on
    // the bus, so anything that can publish to the command topic can disarm
    // the panel. Requires cbus_security_app_id to be set.
    cbus_security_control_enabled: false,
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
    // Stricter bucket for failed web API authentication attempts (brute-force guard).
    web_auth_failure_rate_limit_per_minute: 20,
    // Cap concurrent SSE clients on /api/events/stream (DoS guard on exposed ports).
    web_max_sse_connections: 32,
    // SSE comment keepalive interval (ms) so proxies don't idle-close the stream.
    webSseKeepaliveMs: 15000,
    // In-memory ring buffer size for the web UI event log / SSE replay.
    eventLogMaxEntries: 200,
    // Debounce window (ms) for bridge re-initialization when all connections
    // flap reconnect within a short period (avoids duplicate getall/discovery).
    initDebounceMs: 10000,
    // Bound on retained MQTT publishes queued while the broker is unreachable.
    // Newest-wins per topic; oldest entries are evicted when full.
    mqttPendingPublishMaxEntries: 1000,
    // Republish entity state after Home Assistant or the MQTT broker restarts
    // (issue #44). Neither looks like a bridge restart, so without this HA comes
    // back with entities stuck unknown until the next physical C-Bus event.
    // Both default on: this is a fix, not an opt-in feature.
    stateResyncOnHaRestart: true,
    stateResyncOnMqttReconnect: true,
    // Collapse near-simultaneous resync triggers (a broker bounce that also
    // restarts HA) into a single pass.
    stateResyncDebounceMs: 5000,
    // Home Assistant's birth/will topic. Null derives it from
    // ha_discovery_prefix, which is 'homeassistant/status' by default and
    // follows the prefix when a user has changed it.
    haStatusTopic: null,
    // How often (ms) to poll each C-Bus network's CNI/PCI interface state so a
    // dropout between C-Gate and the C-Bus network surfaces on the status page.
    // Set to 0 to disable. Default 30s.
    cniMonitorIntervalMs: 30000,
    // When true, raise a Home Assistant persistent notification (via the
    // Supervisor API) if a C-Bus network's CNI/PCI goes offline, and dismiss it
    // on recovery. Requires the add-on environment (SUPERVISOR_TOKEN).
    cni_offline_notification: false,
    // Local USB PC Interface (managed mode only, issue #28). Set from the
    // add-on's cgate_serial_device option; null means a CNI/network interface,
    // which is what makes all the serialRecovery* handling below inert.
    cgate_serial_device: null,
    // Recover from a USB PC Interface that renumbered while running (issue #28).
    // Only engages in managed mode with cgate_serial_device set AND the device
    // path either gone or now pointing at a different port, so a CNI dropout
    // never triggers it. Recovery re-resolves the device by its remembered
    // identity, repoints the project database, and restarts managed C-Gate.
    serialRecoveryEnabled: true,
    // Restarts per outage before giving up and telling the user to reconnect the
    // interface and restart the add-on.
    serialRecoveryMaxAttempts: 3,
    // Backoff between attempts within one outage (exponential from the initial
    // delay, capped at the max), so a flapping interface cannot turn into a
    // C-Gate restart loop.
    serialRecoveryInitialDelayMs: 5000,
    serialRecoveryMaxDelayMs: 300000,
    // How long the interface must have been back up for the next outage to count
    // as new trouble and get a fresh attempt budget.
    serialRecoveryStableWindowMs: 900000,
    // Cap on the recovery helper's run time. The helper runs synchronously from
    // inside C-Gate response processing, so for its whole duration MQTT keepalive
    // and LWT, the connection-pool health checks and every timer are stalled
    // behind it - the timeout is the only thing bounding that stall. A real run
    // costs 2-5s (node startup, the resolver, sql.js per project database, the
    // signal), so this is a few times the expected cost rather than the minute it
    // used to be: long enough for a slow disk, short enough that a wedged helper
    // does not look like a dead bridge. Clamped to a 1s floor, since 0 would mean
    // "no timeout" to execFileSync and block indefinitely.
    serialRecoveryTimeoutMs: 15000,
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
    // HA Discovery empty-Groups re-fetch tuning (issue #25). A TREEXML can be
    // accepted (real devices present) while other units still have empty
    // <Groups> because C-Gate hasn't finished syncing group bindings. These
    // control how often/long the tree is re-fetched to pick up the late
    // groups when no C-Gate 762 sync-complete event arrives.
    haDiscoveryMaxTreeResyncAttempts: 3,
    haDiscoveryTreeResyncInitialDelayMs: 30000,
    haDiscoveryTreeResyncMaxDelayMs: 120000,
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
