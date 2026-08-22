// @ts-check
'use strict';

/**
 * Declarative schema for every runtime setting cgateweb reads.
 *
 * This is the single source of truth for the setting names, their types,
 * their defaults, the units they are expressed in, which front-end offers
 * them, and — crucially — WHY several of them are the way they are.
 * `src/defaultSettings.js` derives its exported object from here, so a
 * setting cannot exist at runtime without being described here.
 *
 * The key names are deliberately inconsistent (`cbusip`, `getallonstart`,
 * `ha_discovery_enabled`, `commandMinIntervalMs`). They are the names users
 * already have in their `settings.js` files and in saved add-on options, so
 * they are frozen: tidying them would break live installs.
 *
 * Field meanings:
 *   key         - canonical runtime setting name, exactly as consumers read it.
 *   type        - 'string' | 'number' | 'boolean' | 'array' | 'object' | 'enum'.
 *   default     - the shipped default (identical to the historic literal).
 *   nullable    - true when null is a meaningful value (usually "feature off").
 *   values      - permitted members, for 'enum'.
 *   unit        - 'ms' | 's' | 'hours' | 'none'.
 *   exposure    - 'both' | 'standalone' | 'addon': which front-ends offer it.
 *                 'standalone' means there is no add-on option for it, so
 *                 add-on users cannot set it from the UI (the setting is
 *                 still read at runtime).
 *   reason      - why a decision was made: why a default is what it is, why a
 *                 flag is opt-in, why the exposure is restricted.
 *   description - the plain-English explanation of what the setting does.
 *   aliases     - other names a standalone settings.js may use for this exact
 *                 setting. See ALIAS RULE below.
 *
 * ALIAS RULE
 * ----------
 * An alias exists so someone who read the add-on documentation and typed the
 * add-on option name into settings.js gets the setting they meant instead of a
 * "unknown setting, check for typos" warning and silence.
 *
 * An add-on option may only be listed as an alias when it maps to EXACTLY ONE
 * runtime key with NO transformation of the value. Add-on options that
 * compose (mqtt_host + mqtt_port -> mqtt), fan out to two runtime keys
 * (connection_keep_alive_interval_sec), convert units (*_sec -> *Ms) or change
 * shape (getall_app_periods' object list) must NOT be aliased: accepting the
 * name without the conversion would silently store a wrong value, which is
 * worse than the warning the user gets today.
 *
 * NOTE: this module is intentionally free of dependencies and side effects.
 */

/**
 * @typedef {'string'|'number'|'boolean'|'array'|'object'|'enum'} SettingType
 * @typedef {'ms'|'s'|'hours'|'none'} SettingUnit
 * @typedef {'both'|'standalone'|'addon'} SettingExposure
 */

/**
 * @typedef {Object} SettingSchemaEntry
 * @property {string} key
 * @property {SettingType} type
 * @property {*} default
 * @property {SettingUnit} unit
 * @property {SettingExposure} exposure
 * @property {string} description
 * @property {boolean} [nullable]
 * @property {string[]} [values]
 * @property {string} [reason]
 * @property {string[]} [aliases]
 */

/**
 * The reason shared by every setting that exists only as a runtime knob.
 *
 * These are deliberately not add-on options: the defaults suit a typical
 * install, and they exist to be turned when someone has slow hardware, a very
 * large project, a fragile network or an unusual broker. Putting them in the
 * add-on UI would present a wall of tuning fields to users who should never
 * need them. Standalone installs can still set any of them in settings.js.
 */
const TUNING_ONLY_REASON = 'No add-on option: a runtime tuning knob rather than a user-facing setting. '
    + 'The default suits a typical install; it exists for slow hardware, very large projects, '
    + 'fragile networks or unusual brokers, and standalone installs can override it in settings.js.';

/**
 * Every runtime setting, keyed by its canonical name (each entry repeats the
 * name in `key` so entries stay self-describing when iterated).
 *
 * Deliberately NOT annotated with `@type`: the inferred literal type is what
 * lets `RuntimeSettings` below derive a precise per-setting type for the
 * defaults object, which is how consumers keep their existing type checking.
 * `@satisfies` gives the field checking without widening the inference.
 *
 * @satisfies {Record<string, SettingSchemaEntry>}
 */
const SETTINGS_SCHEMA = {
    // --- MQTT broker / C-Gate connection ------------------------------------
    mqtt: {
        key: 'mqtt',
        type: 'string',
        default: 'localhost:1883',
        unit: 'none',
        exposure: 'both',
        description: 'MQTT broker address as host:port.',
        reason: 'The add-on has no single mqtt option; ConfigLoader composes this string from the separate mqtt_host and mqtt_port options.'
    },
    cbusip: {
        key: 'cbusip',
        type: 'string',
        default: 'your-cgate-ip',
        unit: 'none',
        exposure: 'both',
        description: 'IP address or hostname of the C-Gate server.',
        reason: 'The placeholder default must be changed: placeholder values fail validation and abort startup rather than silently connecting nowhere. In add-on managed mode it is forced to 127.0.0.1 because C-Gate runs in the container.',
        // The add-on's managed-mode override (force 127.0.0.1) is a property of
        // that mode, not of the option: in a standalone settings.js there is no
        // managed mode, so cgate_host means cbusip and nothing else.
        aliases: ['cgate_host']
    },
    cbusname: {
        key: 'cbusname',
        type: 'string',
        default: 'CLIPSAL',
        unit: 'none',
        exposure: 'both',
        description: 'C-Gate project name, spelled exactly as it is in C-Bus Toolkit.',
        aliases: ['cgate_project']
    },
    cbuscommandport: {
        key: 'cbuscommandport',
        type: 'number',
        default: 20023,
        unit: 'none',
        exposure: 'both',
        description: 'C-Gate command port. The connection pool opens connectionPoolSize sockets here.',
        aliases: ['cgate_port']
    },
    cbuseventport: {
        key: 'cbuseventport',
        type: 'number',
        default: 20025,
        unit: 'none',
        exposure: 'both',
        description: 'C-Gate status-change (event) port, where all state updates arrive. This is 20025, not 20024.',
        aliases: ['cgate_event_port']
    },
    cgateusername: {
        key: 'cgateusername',
        type: 'string',
        default: null,
        nullable: true,
        unit: 'none',
        exposure: 'standalone',
        description: 'C-Gate access-control username, sent on command connections only.',
        reason: 'No add-on option exists: the add-on either runs C-Gate itself (managed mode) or talks to a C-Gate on the local network.'
    },
    cgatepassword: {
        key: 'cgatepassword',
        type: 'string',
        default: null,
        nullable: true,
        unit: 'none',
        exposure: 'standalone',
        description: 'C-Gate access-control password. Required whenever cgateusername is set.',
        reason: 'Standalone-only for the same reason as cgateusername.'
    },
    retainreads: {
        key: 'retainreads',
        type: 'boolean',
        default: false,
        unit: 'none',
        exposure: 'both',
        description: 'Set the MQTT retain flag on state/level publishes so Home Assistant entities come back with a known state after a restart.',
        aliases: ['retain_reads']
    },
    logging: {
        key: 'logging',
        type: 'boolean',
        default: true,
        unit: 'none',
        exposure: 'standalone',
        description: 'Legacy logging on/off flag.',
        reason: 'Effectively inert: resolveLogLevelFromSettings uses the schema default for log_level (info), so the legacy logging fallback is unreachable. Kept for backwards compatibility with old settings.js files. The add-on derives it from log_level instead of offering it.'
    },
    log_level: {
        key: 'log_level',
        type: 'enum',
        default: 'info',
        values: ['error', 'warn', 'info', 'debug', 'trace'],
        unit: 'none',
        exposure: 'both',
        description: 'Logging verbosity. Hot-reloadable via SIGUSR1.',
        reason: 'The add-on UI only offers debug/info/warn/error; trace is standalone-only, and an unrecognised add-on value falls back to info.'
    },
    messageinterval: {
        key: 'messageinterval',
        type: 'number',
        default: 200,
        unit: 'ms',
        exposure: 'both',
        description: 'Minimum gap between outbound C-Gate commands, so bursts do not flood C-Gate.',
        // Milliseconds on both sides - the add-on option is not one of the *_sec ones.
        aliases: ['message_interval']
    },
    commandMinIntervalMs: {
        key: 'commandMinIntervalMs',
        type: 'number',
        default: 10,
        unit: 'ms',
        exposure: 'standalone',
        description: 'Floor on the adaptive command interval.',
        reason: TUNING_ONLY_REASON
    },
    maxQueueSize: {
        key: 'maxQueueSize',
        type: 'number',
        default: 1000,
        unit: 'none',
        exposure: 'standalone',
        description: 'Cap on the outbound command queue.',
        reason: 'Commands beyond the cap are dropped rather than letting the queue grow memory without bound.'
    },
    getallnetapp: {
        key: 'getallnetapp',
        type: 'string',
        default: null,
        nullable: true,
        unit: 'none',
        exposure: 'standalone',
        description: 'Single network/application pair for state polling, e.g. "254/56".',
        reason: 'Legacy fallback used only when no network list is available; the add-on derives it from getall_networks[0] rather than exposing it.'
    },
    getallonstart: {
        key: 'getallonstart',
        type: 'boolean',
        default: false,
        unit: 'none',
        exposure: 'both',
        description: 'Request every group\'s level on connect so Home Assistant starts in sync.',
        aliases: ['getall_on_start']
    },
    getallperiod: {
        key: 'getallperiod',
        type: 'number',
        default: null,
        nullable: true,
        unit: 's',
        exposure: 'both',
        description: 'Repeat the full level poll every N seconds; catches anything missed while the bridge or broker was down. null or 0 disables.',
        reason: 'Seconds despite the suffix-less name — the name predates the unit convention and is frozen because users have it in their settings files.',
        // Seconds on both sides, so the alias needs no conversion.
        aliases: ['getall_period']
    },
    getall_app_periods: {
        key: 'getall_app_periods',
        type: 'object',
        default: {},
        unit: 'none',
        exposure: 'both',
        description: 'Per-application poll interval overrides in seconds, e.g. { "56": 3600, "203": 0 }. 0 disables polling for that app.',
        reason: 'Shape differs by front-end: the add-on takes a list of { app_id, period_sec } objects which ConfigLoader flattens into this map; standalone takes the map directly.'
    },
    mqttusername: {
        key: 'mqttusername',
        type: 'string',
        default: null,
        nullable: true,
        unit: 'none',
        exposure: 'both',
        description: 'MQTT broker username. Add-on installs auto-detect this from the Supervisor MQTT service when left empty.',
        aliases: ['mqtt_username']
    },
    mqttpassword: {
        key: 'mqttpassword',
        type: 'string',
        default: null,
        nullable: true,
        unit: 'none',
        exposure: 'both',
        description: 'MQTT broker password. Add-on installs auto-detect this from the Supervisor MQTT service when left empty.',
        aliases: ['mqtt_password']
    },
    mqttUseTls: {
        key: 'mqttUseTls',
        type: 'boolean',
        default: false,
        unit: 'none',
        exposure: 'both',
        description: 'Connect with mqtts:// instead of mqtt:// when the broker string carries no scheme.',
        aliases: ['mqtt_use_tls']
    },
    mqttCaFile: {
        key: 'mqttCaFile',
        type: 'string',
        default: null,
        nullable: true,
        unit: 'none',
        exposure: 'both',
        description: 'Path to a CA certificate for verifying the broker. Required for self-signed broker certificates.',
        aliases: ['mqtt_ca_file']
    },
    mqttCertFile: {
        key: 'mqttCertFile',
        type: 'string',
        default: null,
        nullable: true,
        unit: 'none',
        exposure: 'standalone',
        description: 'Client certificate path, for brokers doing mutual TLS.',
        reason: 'The add-on exposes mqtt_ca_file but no client certificate/key option, so mutual TLS is not configurable there.'
    },
    mqttKeyFile: {
        key: 'mqttKeyFile',
        type: 'string',
        default: null,
        nullable: true,
        unit: 'none',
        exposure: 'standalone',
        description: 'Client private key path. Pairs with mqttCertFile.',
        reason: 'Standalone-only for the same reason as mqttCertFile.'
    },
    mqttRejectUnauthorized: {
        key: 'mqttRejectUnauthorized',
        type: 'boolean',
        default: true,
        unit: 'none',
        exposure: 'both',
        description: 'Verify the broker\'s TLS certificate.',
        reason: 'Security-sensitive: setting it false permits a man-in-the-middle, so it is only honoured when explicitly false and prefers mqttCaFile with a trusted CA as the fix for self-signed certificates.',
        aliases: ['mqtt_reject_unauthorized']
    },
    reconnectinitialdelay: {
        key: 'reconnectinitialdelay',
        type: 'number',
        default: 1000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'Initial exponential-backoff delay for C-Gate reconnection.',
        reason: TUNING_ONLY_REASON
    },
    reconnectmaxdelay: {
        key: 'reconnectmaxdelay',
        type: 'number',
        default: 60000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'Ceiling for C-Gate reconnection backoff. Never lower than reconnectinitialdelay.',
        reason: TUNING_ONLY_REASON
    },
    cgateMaxReconnectAttempts: {
        key: 'cgateMaxReconnectAttempts',
        type: 'number',
        default: 10,
        unit: 'none',
        exposure: 'standalone',
        description: 'Max reconnection attempts for a standalone (non-pooled) C-Gate connection before it gives up.',
        reason: 'Pool-managed connections are governed by the pool (maxRetries) instead.'
    },
    mqttReconnectPeriodMs: {
        key: 'mqttReconnectPeriodMs',
        type: 'number',
        default: 5000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'MQTT client reconnect period, passed to mqtt.js connect options as reconnectPeriod.',
        reason: TUNING_ONLY_REASON
    },
    mqttConnectTimeoutMs: {
        key: 'mqttConnectTimeoutMs',
        type: 'number',
        default: 30000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'MQTT client connect timeout, passed to mqtt.js connect options as connectTimeout. Raise on a slow or distant broker.',
        reason: TUNING_ONLY_REASON
    },
    connectionPoolSize: {
        key: 'connectionPoolSize',
        type: 'number',
        default: 3,
        unit: 'none',
        exposure: 'both',
        description: 'Number of persistent C-Gate command connections, round-robin load balanced.',
        aliases: ['connection_pool_size']
    },
    healthCheckInterval: {
        key: 'healthCheckInterval',
        type: 'number',
        default: 30000,
        unit: 'ms',
        exposure: 'both',
        description: 'Connection-pool health-check frequency.',
        reason: 'The add-on option connection_health_check_interval_sec is in seconds and is multiplied by 1000 on the way in.'
    },
    keepAliveInterval: {
        key: 'keepAliveInterval',
        type: 'number',
        default: 60000,
        unit: 'ms',
        exposure: 'both',
        description: 'Keep-alive ping interval for pooled command connections.',
        reason: 'The add-on option connection_keep_alive_interval_sec is in seconds and sets both this and eventConnectionKeepAliveInterval.'
    },
    eventConnectionKeepAliveInterval: {
        key: 'eventConnectionKeepAliveInterval',
        type: 'number',
        default: 60000,
        unit: 'ms',
        exposure: 'both',
        description: 'Keep-alive interval for the single event connection; takes precedence over keepAliveInterval for that connection.',
        reason: 'Not offered separately in the add-on: connection_keep_alive_interval_sec sets it alongside keepAliveInterval.'
    },
    connectionTimeout: {
        key: 'connectionTimeout',
        type: 'number',
        default: 5000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'Socket timeout for establishing a C-Gate connection, and the idle socket timeout thereafter.',
        reason: TUNING_ONLY_REASON
    },
    maxRetries: {
        key: 'maxRetries',
        type: 'number',
        default: 3,
        unit: 'none',
        exposure: 'standalone',
        description: 'Reconnect attempts per pooled connection before the pool gives up on it.',
        reason: TUNING_ONLY_REASON
    },
    connectionPoolShutdownForceCloseMs: {
        key: 'connectionPoolShutdownForceCloseMs',
        type: 'number',
        default: 1000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'How long stop() waits for each pooled connection to close before forcing the shutdown promise to resolve.',
        reason: TUNING_ONLY_REASON
    },
    connectionPoolUnhealthyRecheckMs: {
        key: 'connectionPoolUnhealthyRecheckMs',
        type: 'number',
        default: 1000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'Delay before re-checking a pooled connection that was marked potentially unhealthy after a failed send.',
        reason: TUNING_ONLY_REASON
    },
    eventPublishDedupWindowMs: {
        key: 'eventPublishDedupWindowMs',
        type: 'number',
        default: 0,
        unit: 'ms',
        exposure: 'standalone',
        description: 'Drop a publish if the identical payload went to the same topic within this window. 0 disables. Useful on noisy buses.',
        reason: TUNING_ONLY_REASON
    },
    eventPublishDedupMaxEntries: {
        key: 'eventPublishDedupMaxEntries',
        type: 'number',
        default: 5000,
        unit: 'none',
        exposure: 'standalone',
        description: 'Cap on the publish dedup cache.',
        reason: TUNING_ONLY_REASON
    },
    topicCacheMaxEntries: {
        key: 'topicCacheMaxEntries',
        type: 'number',
        default: 5000,
        unit: 'none',
        exposure: 'standalone',
        description: 'Cap on the computed-topic string cache.',
        reason: TUNING_ONLY_REASON
    },
    eventPublishCoalesce: {
        key: 'eventPublishCoalesce',
        type: 'boolean',
        default: false,
        unit: 'none',
        exposure: 'standalone',
        description: 'Buffer publishes per topic and flush the latest value instead of publishing every intermediate value. Cuts broker traffic during ramps at the cost of some latency.',
        reason: TUNING_ONLY_REASON
    },
    autoDiscoverNetworks: {
        key: 'autoDiscoverNetworks',
        type: 'boolean',
        default: true,
        unit: 'none',
        exposure: 'both',
        description: 'Ask C-Gate which networks exist instead of hardcoding them. Skipped when getall_networks or ha_discovery_networks is already configured.',
        reason: 'Runtime consumers read the camelCase autoDiscoverNetworks. The HA add-on exposes this as the snake_case auto_discover_networks option, which ConfigLoader maps to camelCase; standalone settings.js may use either form.',
        // The original alias, and the one this whole mechanism generalises:
        // ConfigLoader used to special-case exactly this pair.
        aliases: ['auto_discover_networks']
    },
    networkDiscoveryTimeoutMs: {
        key: 'networkDiscoveryTimeoutMs',
        type: 'number',
        default: 5000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'How long auto-discovery waits for C-Gate tree //PROJECT responses before applying whatever networks were collected.',
        reason: TUNING_ONLY_REASON
    },

    // --- Home Assistant discovery -------------------------------------------
    ha_discovery_enabled: {
        key: 'ha_discovery_enabled',
        type: 'boolean',
        default: false,
        unit: 'none',
        exposure: 'both',
        description: 'Publish MQTT Discovery config messages so Home Assistant creates entities automatically. With this off, cgateweb is a plain MQTT bridge.',
        reason: 'Off in the runtime defaults; the add-on ships true in its options block because discovery is the point of installing the add-on.'
    },
    ha_discovery_prefix: {
        key: 'ha_discovery_prefix',
        type: 'string',
        default: 'homeassistant',
        unit: 'none',
        exposure: 'both',
        description: 'MQTT Discovery topic prefix. Must match Home Assistant\'s MQTT integration setting; also determines the default haStatusTopic.'
    },
    ha_discovery_networks: {
        key: 'ha_discovery_networks',
        type: 'array',
        default: [],
        unit: 'none',
        exposure: 'both',
        description: 'C-Bus networks to scan for discovery. In the add-on this falls back to getall_networks when left empty. Also drives the security zone status sync.'
    },
    getall_networks: {
        key: 'getall_networks',
        type: 'array',
        default: [],
        unit: 'none',
        exposure: 'both',
        description: 'Networks to include in getall level polling. Empty means "use whatever was auto-discovered" (bridgeInitializationService._resolveGetallNetworks).',
        reason: 'Declared here because it is genuinely read: without an entry the unknown-key check would tell anyone who sets it that it is a typo and will be ignored, which was false on both counts.'
    },
    ha_discovery_cover_app_id: {
        key: 'ha_discovery_cover_app_id',
        type: 'string',
        default: null,
        nullable: true,
        unit: 'none',
        exposure: 'both',
        description: 'C-Bus application ID whose groups become cover entities. null disables.',
        reason: '203 is the usual choice, but C-Bus calls 203 Enable Control - a general-purpose application - so it is off until the user confirms their blinds really are on it.'
    },
    cover_ramp_duration_ms: {
        key: 'cover_ramp_duration_ms',
        type: 'number',
        default: 5000,
        unit: 'ms',
        exposure: 'both',
        description: 'Full open-to-close travel time for a cover, used to interpolate position during a ramp.',
        reason: 'The add-on option cover_ramp_duration_sec is in seconds and is multiplied by 1000 on the way in.'
    },
    coverRampUpdateIntervalMs: {
        key: 'coverRampUpdateIntervalMs',
        type: 'number',
        default: 500,
        unit: 'ms',
        exposure: 'standalone',
        description: 'How often the cover ramp tracker emits interpolated position updates during a ramp so Home Assistant shows smooth progress.',
        reason: TUNING_ONLY_REASON
    },
    ha_discovery_cover_tilt_app_id: {
        key: 'ha_discovery_cover_tilt_app_id',
        type: 'string',
        default: null,
        nullable: true,
        unit: 'none',
        exposure: 'both',
        description: 'Separate C-Bus application carrying slat tilt position; adds a tilt status topic to cover entities. null disables.'
    },
    ha_discovery_switch_app_id: {
        key: 'ha_discovery_switch_app_id',
        type: 'string',
        default: null,
        nullable: true,
        unit: 'none',
        exposure: 'both',
        description: 'C-Bus application ID whose groups become on/off switch entities. null disables.'
    },
    ha_discovery_relay_app_id: {
        key: 'ha_discovery_relay_app_id',
        type: 'string',
        default: null,
        nullable: true,
        unit: 'none',
        exposure: 'standalone',
        description: 'C-Bus application ID whose groups become relay-backed switch entities. null disables.',
        reason: 'No add-on option exists, so relay application mapping is unavailable in the add-on UI.'
    },
    ha_discovery_pir_app_id: {
        key: 'ha_discovery_pir_app_id',
        type: 'string',
        default: null,
        nullable: true,
        unit: 'none',
        exposure: 'standalone',
        description: 'C-Bus application ID whose groups become motion binary_sensor entities; also suppresses level tracking for that application. null disables.',
        reason: 'No add-on option exists, so PIR application mapping is unavailable in the add-on UI.'
    },
    ha_discovery_trigger_app_id: {
        key: 'ha_discovery_trigger_app_id',
        type: 'string',
        default: null,
        nullable: true,
        unit: 'none',
        exposure: 'both',
        description: 'Keypad/scene trigger application (typically 202). Publishes an event entity, a companion button, and a scene when ha_discovery_scene_enabled. Also gates the web UI\'s trigger label editing.'
    },
    ha_discovery_scene_enabled: {
        key: 'ha_discovery_scene_enabled',
        type: 'boolean',
        default: true,
        unit: 'none',
        exposure: 'both',
        description: 'Publish a Home Assistant scene entity per trigger group alongside the event and button entities.'
    },
    ha_discovery_auto_type: {
        key: 'ha_discovery_auto_type',
        type: 'boolean',
        default: true,
        unit: 'none',
        exposure: 'both',
        description: 'Automatic device-type detection for groups on the Lighting application (56). Phase 1: detect motorised covers (blinds/shutters) from the group label.',
        reason: 'Only ever upgrades the lighting fallback - manual type_overrides and application-id mappings always take precedence.'
    },
    ha_discovery_auto_type_name_heuristics: {
        key: 'ha_discovery_auto_type_name_heuristics',
        type: 'boolean',
        default: true,
        unit: 'none',
        exposure: 'both',
        description: 'Classify covers by matching the group label against ha_discovery_auto_type_cover_keywords.'
    },
    ha_discovery_auto_type_cover_keywords: {
        key: 'ha_discovery_auto_type_cover_keywords',
        type: 'array',
        default: [
            'blind', 'shutter', 'shade', 'awning', 'curtain', 'roller', 'garage door'
        ],
        unit: 'none',
        exposure: 'both',
        description: 'Label keywords that mark a Lighting group as a motorised cover. Case-insensitive, matches plurals. A non-empty user list replaces this one.'
    },
    ha_discovery_type_from_label_prefix: {
        key: 'ha_discovery_type_from_label_prefix',
        type: 'boolean',
        default: false,
        unit: 'none',
        exposure: 'both',
        description: 'Resolve a group\'s discovery type from an entity-id-style label prefix (e.g. "cover.bedroom_shutter" -> cover) for users who name C-Bus groups with their intended HA entity id (issue #35).',
        reason: 'Opt-in; manual type_overrides still win.'
    },
    ha_discovery_type_from_unit: {
        key: 'ha_discovery_type_from_unit',
        type: 'boolean',
        default: false,
        unit: 'none',
        exposure: 'both',
        description: 'Resolve a group\'s discovery type from the C-Bus unit that drives it (issues #38, #37): dimmer channels become dimmable lights, relay channels on/off lights, and groups driven only by an input unit (bus coupler, key input) become binary sensors.',
        reason: 'Opt-in, because enabling it can change which entity a group already published as. Precedence: manual type_overrides win first, then the cover-name keyword heuristics, then this unit-type classification. Cover names outrank unit type because a relay can equally drive a light, a motorised blind or an irrigation valve - a name that positively identifies a cover is better evidence than the hardware type. Unrecognised unit types are left alone.'
    },
    ha_discovery_hvac_app_id: {
        key: 'ha_discovery_hvac_app_id',
        type: 'string',
        default: null,
        nullable: true,
        unit: 'none',
        exposure: 'both',
        description: 'Lighting-style HVAC application (level encodes temperature at 0.5 degC resolution). Distinct from the native Air Conditioning application. null disables.'
    },

    // --- Air Conditioning (native, application 172) -------------------------
    cbus_aircon_app_id: {
        key: 'cbus_aircon_app_id',
        type: 'string',
        default: null,
        nullable: true,
        unit: 'none',
        exposure: 'both',
        description: 'C-Bus Air Conditioning app ID for native temperature reads (e.g. 172); null disables.'
    },
    cbus_aircon_control_enabled: {
        key: 'cbus_aircon_control_enabled',
        type: 'boolean',
        default: false,
        unit: 'none',
        exposure: 'both',
        description: 'Allow Home Assistant to CONTROL native Air Conditioning thermostats (set mode/setpoint) via AIRCON commands.',
        reason: 'Opt-in. Off by default - it writes to live heating/cooling. Requires cbus_aircon_app_id to be set.'
    },

    // --- Security (application 208) -----------------------------------------
    cbus_security_app_id: {
        key: 'cbus_security_app_id',
        type: 'string',
        default: '208',
        unit: 'none',
        exposure: 'both',
        description: 'C-Bus Security app ID for zone sensors (default 208). Publishes one binary_sensor per zone (sealed/unsealed) and syncs zone state via security status_request on connect. Empty or \'0\' disables.',
        reason: 'Kept as a string precisely so 0 can disable it; the add-on maps an explicit 0 through rather than dropping it as falsy.'
    },
    ha_discovery_security_device_class_keywords: {
        key: 'ha_discovery_security_device_class_keywords',
        type: 'object',
        default: {},
        unit: 'none',
        exposure: 'standalone',
        description: 'Override the label keywords that map a security zone to a Home Assistant device class (e.g. { garage: \'garage_door\' }). Empty falls back to the built-in keyword table in deviceTypeClassifier.',
        reason: 'Declared for the same reason as getall_networks: it is read, so it must not be reported as a typo.'
    },
    cbus_security_control_enabled: {
        key: 'cbus_security_control_enabled',
        type: 'boolean',
        default: false,
        unit: 'none',
        exposure: 'both',
        description: 'Allow Home Assistant to ARM the security panel via `security arm` commands.',
        reason: 'Opt-in. Off by default - the write carries no PIN on the bus, so anything that can publish to the command topic can arm the panel. Requires cbus_security_app_id to be set.'
    },
    cbus_security_disarm_enabled: {
        key: 'cbus_security_disarm_enabled',
        type: 'boolean',
        default: false,
        unit: 'none',
        exposure: 'both',
        description: 'Allow DISARM as well, on top of cbus_security_control_enabled.',
        reason: 'Deliberately a second switch rather than part of the first, because the two directions are not equally risky - arming cannot let anyone in. Disarming has no C-Bus command; it is done by replaying the PIN through `security emulate_keypad` (#51). Home Assistant collects the PIN on its own keypad and sends it in the MQTT command payload, so the PIN crosses the broker on every disarm. Nothing stores it, but anyone who can read that topic can learn it. Only enable on a broker you trust, ideally with TLS.'
    },
    cbus_security_bypass_enabled: {
        key: 'cbus_security_bypass_enabled',
        type: 'boolean',
        default: false,
        unit: 'none',
        exposure: 'both',
        description: 'Allow forcing an arm past an open zone (the panel\'s \'#\' key), via the alarm card\'s custom-bypass action or the bypass button. Opt-in on top of cbus_security_control_enabled.',
        reason: 'Its own switch rather than riding on control, because "arm the alarm" and "arm the alarm even though a door is open" are different promises - the second leaves the owner believing a zone is covered when it is not. Deliberately NOT folded into cbus_security_disarm_enabled either: someone who wants bypass should not have to enable PIN-over-MQTT disarm, which is the more dangerous of the two, just to get it.'
    },
    securityDisarmMaxAttempts: {
        key: 'securityDisarmMaxAttempts',
        type: 'number',
        default: 10,
        unit: 'none',
        exposure: 'standalone',
        description: 'Brute-force limit on disarm attempts, per network/application, in a sliding window. cgateweb cannot tell a right PIN from a wrong one - only the panel knows - so every attempt counts, successful or not.',
        reason: 'Without this, anything able to publish to the panel command topic can walk the whole PIN space: the bridge would happily type thousands of codes per minute at the panel through Emulate Keypad. 10 per 10 minutes is far more than a household generates (a wrong entry or two, then the right one) and turns a 4-digit exhaustive search into roughly a week of continuous attempts, on a topic anyone watching would notice. A runtime tunable rather than an add-on option on purpose: this is a safety floor, and a UI field inviting people to raise it defeats the point.'
    },
    securityDisarmAttemptWindowMs: {
        key: 'securityDisarmAttemptWindowMs',
        type: 'number',
        default: 600000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'Sliding window for the securityDisarmMaxAttempts brute-force limit (10 minutes).',
        reason: 'A runtime tunable rather than an add-on option on purpose: this is a safety floor, and a UI field inviting people to raise it defeats the point.'
    },

    // --- Measurement (application 228) --------------------------------------
    cbus_measurement_app_id: {
        key: 'cbus_measurement_app_id',
        type: 'string',
        default: null,
        nullable: true,
        unit: 'none',
        exposure: 'both',
        description: 'C-Bus Measurement app ID (default 228/$E4); null disables. Gates BOTH directions: decoding "measurement data ..." event lines to cbus/read/{net}/228/{device}/{channel}/value+unit, and injecting readings via cbus/write/{net}/228/{device}/{channel}/data (payload "value,multiplier,units").',
        reason: 'One flag for both, unlike Air Conditioning/Security\'s separate *_control_enabled gate - Measurement writes are how a scripted/virtual sensor gets its own data onto the bus (spec 28.2), not a hardware-actuation risk. See docs/Measurement Application.md.'
    },
    cbus_clock_enabled: {
        key: 'cbus_clock_enabled',
        type: 'boolean',
        default: false,
        unit: 'none',
        exposure: 'standalone',
        description: 'Decode C-Bus Clock and Timekeeping (app 223/$DF) broadcasts and publish the network date and time to cbus/read/{net}/223/clock/date and /time, plus two diagnostic sensors when discovery is on. Read-only: this never sets the network clock.',
        reason: 'Opt-in and standalone-only because the event-port format is under-evidenced: it is derived from two captured lines (commit 833b60e) and no vendor document in this repo specifies it, so the decoder fails closed and the feature stays off until more installs confirm it. Off by default also keeps a chatty per-tick broadcast off MQTT for the installs that do not want it. No add-on option yet - promote it to one once the format is confirmed on a second site.'
    },
    ha_hvac_temperature_unit: {
        key: 'ha_hvac_temperature_unit',
        type: 'enum',
        default: 'C',
        values: ['C', 'F'],
        unit: 'none',
        exposure: 'both',
        description: 'Temperature unit advertised on climate entities. Anything other than F is treated as C.'
    },

    // --- Diagnostics and stale devices --------------------------------------
    ha_bridge_diagnostics_enabled: {
        key: 'ha_bridge_diagnostics_enabled',
        type: 'boolean',
        default: true,
        unit: 'none',
        exposure: 'both',
        description: 'Publish bridge health entities (connection state, queue depth, discovery counts) into Home Assistant.'
    },
    ha_bridge_diagnostics_interval_sec: {
        key: 'ha_bridge_diagnostics_interval_sec',
        type: 'number',
        default: 60,
        unit: 's',
        exposure: 'both',
        description: 'How often bridge diagnostics are published. Seconds on both sides - no unit conversion.'
    },
    stale_device_detection_enabled: {
        key: 'stale_device_detection_enabled',
        type: 'boolean',
        default: true,
        unit: 'none',
        exposure: 'both',
        description: 'Flag devices that have not reported for a long time.'
    },
    stale_device_threshold_hours: {
        key: 'stale_device_threshold_hours',
        type: 'number',
        default: 24,
        unit: 'hours',
        exposure: 'both',
        description: 'How long without an event before a device counts as stale.'
    },
    stale_device_check_interval_sec: {
        key: 'stale_device_check_interval_sec',
        type: 'number',
        default: 3600,
        unit: 's',
        exposure: 'both',
        description: 'How often the stale-device check runs. Seconds on both sides - no unit conversion.'
    },

    // --- Labels --------------------------------------------------------------
    cbus_label_file: {
        key: 'cbus_label_file',
        type: 'string',
        default: null,
        nullable: true,
        unit: 'none',
        exposure: 'both',
        description: 'Path to the JSON file holding imported group labels, manual type_overrides and the web UI\'s saved edits. Without it, discovered entities get generic names and the web UI cannot save.',
        reason: 'null here, but the add-on never leaves it null: ConfigLoader auto-detects across /homeassistant, the legacy /config mount and /data, and falls back to a writable default so the first Import creates the file rather than erroring (#3, #44).'
    },
    labelWatchDebounceMs: {
        key: 'labelWatchDebounceMs',
        type: 'number',
        default: 500,
        unit: 'ms',
        exposure: 'standalone',
        description: 'Debounce window for label-file fs.watch events before reloading from disk.',
        reason: TUNING_ONLY_REASON
    },
    labelWatchSelfWriteGraceMs: {
        key: 'labelWatchSelfWriteGraceMs',
        type: 'number',
        default: 1000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'Ignore label-file watch events within this window after our own save(), so an in-process emit is not double-fired by the watcher.',
        reason: TUNING_ONLY_REASON
    },
    labelReloadRetryMs: {
        key: 'labelReloadRetryMs',
        type: 'number',
        default: 2000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'Delay before a single retry when a watched label file is briefly unreadable (e.g. during a Home Assistant backup).',
        reason: TUNING_ONLY_REASON
    },

    // --- Web interface and API ----------------------------------------------
    web_port: {
        key: 'web_port',
        type: 'number',
        default: 8080,
        unit: 'none',
        exposure: 'standalone',
        description: 'Listen port for the status page and label-editing API.',
        reason: 'Not offered as an add-on option: ingress_port and the Supervisor watchdog are both pinned to 8080, so a user-set port would break both. (addonOptionMap still carries a web_port rule so a future option would map, but config.yaml declares none.)'
    },
    web_bind_host: {
        key: 'web_bind_host',
        type: 'string',
        default: '127.0.0.1',
        unit: 'none',
        exposure: 'standalone',
        description: 'Address the web server binds to.',
        reason: 'Loopback by default deliberately - the API can modify labels. The add-on forces 0.0.0.0 because the HA ingress proxy connects from outside the container\'s loopback interface, so it is not a user option there.'
    },
    web_api_key: {
        key: 'web_api_key',
        type: 'string',
        default: null,
        nullable: true,
        unit: 'none',
        exposure: 'both',
        description: 'API key required for POST/PUT/PATCH on label endpoints when reached directly (not via Ingress).',
        reason: 'Security-sensitive: set it whenever the port is reachable from anywhere but localhost.'
    },
    web_allow_unauthenticated_mutations: {
        key: 'web_allow_unauthenticated_mutations',
        type: 'boolean',
        default: false,
        unit: 'none',
        exposure: 'both',
        description: 'Allow writes to the label API with no authentication at all. Ignored unless the web server binds loopback; the add-on binds 0.0.0.0 for Ingress, so use an API key for any host-mapped port.',
        reason: 'Security-sensitive unsafe override: anyone who can reach web_port can rewrite labels. The runtime also refuses the flag when bindHost is not loopback, so it cannot silently open the add-on host port.'
    },
    web_allowed_origins: {
        key: 'web_allowed_origins',
        type: 'array',
        default: null,
        nullable: true,
        unit: 'none',
        exposure: 'both',
        description: 'CORS allowlist of browser origins, e.g. ["https://ha.example.com"]. A comma-separated string is accepted standalone; empty/null blocks all cross-origin access.'
    },
    web_mutation_rate_limit_per_minute: {
        key: 'web_mutation_rate_limit_per_minute',
        type: 'number',
        default: 120,
        unit: 'none',
        exposure: 'both',
        description: 'Per-client write rate limit on mutating endpoints, over a fixed 60s window.'
    },
    web_read_rate_limit_per_minute: {
        key: 'web_read_rate_limit_per_minute',
        type: 'number',
        default: 300,
        unit: 'none',
        exposure: 'standalone',
        description: 'Per-client read rate limit on non-mutating web endpoints, over webRateLimitWindowMs.',
        reason: TUNING_ONLY_REASON
    },
    webRateLimitWindowMs: {
        key: 'webRateLimitWindowMs',
        type: 'number',
        default: 60000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'Sliding window length for web API per-client rate limits (mutation, read, and auth-failure buckets).',
        reason: TUNING_ONLY_REASON
    },
    ingressDiscoveryMaxBackoffMs: {
        key: 'ingressDiscoveryMaxBackoffMs',
        type: 'number',
        default: 8000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'Ceiling for the Supervisor ingress-path discovery retry backoff after add-on start.',
        reason: TUNING_ONLY_REASON
    },
    web_auth_failure_rate_limit_per_minute: {
        key: 'web_auth_failure_rate_limit_per_minute',
        type: 'number',
        default: 20,
        unit: 'none',
        exposure: 'standalone',
        description: 'Stricter bucket for failed web API authentication attempts (brute-force guard).',
        reason: 'Separate from web_mutation_rate_limit_per_minute so an exposed web_api_key cannot be brute-forced unthrottled. Runtime-only rather than an add-on option, for the same reason as the security disarm limits: it is a safety floor, and a UI field inviting people to raise it defeats the point.'
    },
    web_max_sse_connections: {
        key: 'web_max_sse_connections',
        type: 'number',
        default: 32,
        unit: 'none',
        exposure: 'standalone',
        description: 'Cap concurrent SSE clients on /api/events/stream (DoS guard on exposed ports).',
        reason: 'A denial-of-service floor rather than a preference, so it is runtime-only rather than an add-on option.'
    },
    webSseKeepaliveMs: {
        key: 'webSseKeepaliveMs',
        type: 'number',
        default: 15000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'SSE comment keepalive interval so proxies don\'t idle-close the stream.',
        reason: TUNING_ONLY_REASON
    },
    eventLogMaxEntries: {
        key: 'eventLogMaxEntries',
        type: 'number',
        default: 200,
        unit: 'none',
        exposure: 'standalone',
        description: 'In-memory ring buffer size for the web UI event log / SSE replay.',
        reason: TUNING_ONLY_REASON
    },

    // --- Reliability and tuning ----------------------------------------------
    initDebounceMs: {
        key: 'initDebounceMs',
        type: 'number',
        default: 10000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'Debounce window for bridge re-initialization when all connections flap reconnect within a short period (avoids duplicate getall/discovery).',
        reason: TUNING_ONLY_REASON
    },
    mqttPendingPublishMaxEntries: {
        key: 'mqttPendingPublishMaxEntries',
        type: 'number',
        default: 1000,
        unit: 'none',
        exposure: 'standalone',
        description: 'Bound on retained MQTT publishes queued while the broker is unreachable. Newest-wins per topic; oldest entries are evicted when full.',
        reason: TUNING_ONLY_REASON
    },
    stateResyncOnHaRestart: {
        key: 'stateResyncOnHaRestart',
        type: 'boolean',
        default: true,
        unit: 'none',
        exposure: 'standalone',
        description: 'Republish entity state after Home Assistant restarts (issue #44).',
        reason: 'An HA restart does not look like a bridge restart, so without this HA comes back with entities stuck unknown until the next physical C-Bus event. Defaults on: this is a fix, not an opt-in feature.'
    },
    stateResyncOnMqttReconnect: {
        key: 'stateResyncOnMqttReconnect',
        type: 'boolean',
        default: true,
        unit: 'none',
        exposure: 'standalone',
        description: 'Republish entity state after the MQTT broker restarts (issue #44).',
        reason: 'A broker restart does not look like a bridge restart, so without this HA comes back with entities stuck unknown until the next physical C-Bus event. Defaults on: this is a fix, not an opt-in feature.'
    },
    stateResyncDebounceMs: {
        key: 'stateResyncDebounceMs',
        type: 'number',
        default: 5000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'Collapse near-simultaneous resync triggers (a broker bounce that also restarts HA) into a single pass.',
        reason: TUNING_ONLY_REASON
    },
    haStatusTopic: {
        key: 'haStatusTopic',
        type: 'string',
        default: null,
        nullable: true,
        unit: 'none',
        exposure: 'standalone',
        description: 'Home Assistant\'s birth/will topic.',
        reason: 'Null derives it from ha_discovery_prefix, which is \'homeassistant/status\' by default and follows the prefix when a user has changed it.'
    },
    cniMonitorIntervalMs: {
        key: 'cniMonitorIntervalMs',
        type: 'number',
        default: 30000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'How often to poll each C-Bus network\'s CNI/PCI interface state so a dropout between C-Gate and the C-Bus network surfaces on the status page. Set to 0 to disable. Default 30s.',
        reason: TUNING_ONLY_REASON
    },
    cni_offline_notification: {
        key: 'cni_offline_notification',
        type: 'boolean',
        default: false,
        unit: 'none',
        exposure: 'both',
        description: 'When true, raise a Home Assistant persistent notification (via the Supervisor API) if a C-Bus network\'s CNI/PCI goes offline, and dismiss it on recovery.',
        reason: 'Requires the add-on environment (SUPERVISOR_TOKEN); inert standalone.'
    },
    haNotifierTimeoutMs: {
        key: 'haNotifierTimeoutMs',
        type: 'number',
        default: 5000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'Timeout for Home Assistant persistent-notification create/dismiss calls via the Supervisor Core API proxy.',
        reason: TUNING_ONLY_REASON
    },

    // --- Managed C-Gate and USB serial recovery ------------------------------
    cgate_serial_device: {
        key: 'cgate_serial_device',
        type: 'string',
        default: null,
        nullable: true,
        unit: 'none',
        exposure: 'both',
        description: 'Local USB PC Interface (managed mode only, issue #28). Set from the add-on\'s cgate_serial_device option.',
        reason: 'null means a CNI/network interface, which is what makes all the serialRecovery* handling inert.'
    },
    serialRecoveryEnabled: {
        key: 'serialRecoveryEnabled',
        type: 'boolean',
        default: true,
        unit: 'none',
        exposure: 'standalone',
        description: 'Recover from a USB PC Interface that renumbered while running (issue #28). Recovery re-resolves the device by its remembered identity, repoints the project database, and restarts managed C-Gate.',
        reason: 'Only engages in managed mode with cgate_serial_device set AND the device path either gone or now pointing at a different port, so a CNI dropout never triggers it. No add-on option exposes it: it is a runtime-tunable escape hatch rather than a user-facing option.'
    },
    serialRecoveryMaxAttempts: {
        key: 'serialRecoveryMaxAttempts',
        type: 'number',
        default: 3,
        unit: 'none',
        exposure: 'standalone',
        description: 'Restarts per outage before giving up and telling the user to reconnect the interface and restart the add-on.',
        reason: TUNING_ONLY_REASON
    },
    serialRecoveryInitialDelayMs: {
        key: 'serialRecoveryInitialDelayMs',
        type: 'number',
        default: 5000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'Initial backoff between serial recovery attempts within one outage.',
        reason: 'Exponential from the initial delay, capped at serialRecoveryMaxDelayMs, so a flapping interface cannot turn into a C-Gate restart loop.'
    },
    serialRecoveryMaxDelayMs: {
        key: 'serialRecoveryMaxDelayMs',
        type: 'number',
        default: 300000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'Ceiling for serial recovery backoff (5 minutes).',
        reason: 'Caps the exponential backoff so a flapping interface cannot turn into a C-Gate restart loop.'
    },
    serialRecoveryStableWindowMs: {
        key: 'serialRecoveryStableWindowMs',
        type: 'number',
        default: 900000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'How long the interface must have been back up for the next outage to count as new trouble and get a fresh attempt budget.',
        reason: TUNING_ONLY_REASON
    },
    serialRecoveryTimeoutMs: {
        key: 'serialRecoveryTimeoutMs',
        type: 'number',
        default: 15000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'Cap on the recovery helper\'s run time.',
        reason: 'The helper runs synchronously from inside C-Gate response processing, so for its whole duration MQTT keepalive and LWT, the connection-pool health checks and every timer are stalled behind it - the timeout is the only thing bounding that stall. A real run costs 2-5s (node startup, the resolver, sql.js per project database, the signal), so this is a few times the expected cost rather than the minute it used to be: long enough for a slow disk, short enough that a wedged helper does not look like a dead bridge. Clamped to a 1s floor, since 0 would mean "no timeout" to execFileSync and block indefinitely.'
    },

    // --- Web diagnostics / Supervisor calls ----------------------------------
    web_active_device_window_ms: {
        key: 'web_active_device_window_ms',
        type: 'number',
        default: 24 * 60 * 60 * 1000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'Web diagnostics: window within which a device counts as "active" in the status page\'s device list. Default 24h.',
        reason: TUNING_ONLY_REASON
    },
    web_ha_areas_cache_ttl_ms: {
        key: 'web_ha_areas_cache_ttl_ms',
        type: 'number',
        default: 30000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'TTL for the cached Home Assistant areas list (Supervisor template API).',
        reason: TUNING_ONLY_REASON
    },
    web_ha_api_timeout_ms: {
        key: 'web_ha_api_timeout_ms',
        type: 'number',
        default: 5000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'Timeout for outbound calls to the HA Supervisor API from the web UI.',
        reason: TUNING_ONLY_REASON
    },
    relativeLevelTimeoutMs: {
        key: 'relativeLevelTimeoutMs',
        type: 'number',
        default: 5000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'How long a relative-level command (increase/decrease) waits for the current level to come back before giving up.',
        reason: TUNING_ONLY_REASON
    },

    // --- HA Discovery tree retrieval -----------------------------------------
    haDiscoveryMaxTreeRetryAttempts: {
        key: 'haDiscoveryMaxTreeRetryAttempts',
        type: 'number',
        default: 8,
        unit: 'none',
        exposure: 'standalone',
        description: 'HA Discovery TreeXML retry budget: how many times a failed tree request is retried.',
        reason: 'C-Gate accepts connections on the command port before its networks are loaded, so an initial TREEXML can return 401 "Network not found". These control the retry budget.'
    },
    haDiscoveryTreeRetryInitialDelayMs: {
        key: 'haDiscoveryTreeRetryInitialDelayMs',
        type: 'number',
        default: 2000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'Initial backoff between TreeXML retries.',
        reason: TUNING_ONLY_REASON
    },
    haDiscoveryTreeRetryMaxDelayMs: {
        key: 'haDiscoveryTreeRetryMaxDelayMs',
        type: 'number',
        default: 60000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'Ceiling for TreeXML retry backoff.',
        reason: TUNING_ONLY_REASON
    },
    haDiscoveryTreeRequestTimeoutMs: {
        key: 'haDiscoveryTreeRequestTimeoutMs',
        type: 'number',
        default: 8000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'How long a TreeXML request may go without any response at all before it counts as failed.',
        reason: TUNING_ONLY_REASON
    },
    haDiscoveryTreeStreamStallMs: {
        key: 'haDiscoveryTreeStreamStallMs',
        type: 'number',
        default: 8000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'How long a TREEXML stream may go *silent* mid-transfer before it counts as stalled.',
        reason: 'Distinct from haDiscoveryTreeRequestTimeoutMs, which covers "no response at all": this clock is reset by every data chunk, so it bounds idle time rather than total transfer time. Raise it only if a very large tree on slow hardware still reports "tree stream stalled".'
    },
    haDiscoveryMaxTreeResyncAttempts: {
        key: 'haDiscoveryMaxTreeResyncAttempts',
        type: 'number',
        default: 3,
        unit: 'none',
        exposure: 'standalone',
        description: 'HA Discovery empty-Groups re-fetch budget (issue #25).',
        reason: 'A TREEXML can be accepted (real devices present) while other units still have empty <Groups> because C-Gate hasn\'t finished syncing group bindings. These control how often/long the tree is re-fetched to pick up the late groups when no C-Gate 762 sync-complete event arrives.'
    },
    haDiscoveryTreeResyncInitialDelayMs: {
        key: 'haDiscoveryTreeResyncInitialDelayMs',
        type: 'number',
        default: 30000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'Initial delay before the first empty-Groups tree re-fetch.',
        reason: TUNING_ONLY_REASON
    },
    haDiscoveryTreeResyncMaxDelayMs: {
        key: 'haDiscoveryTreeResyncMaxDelayMs',
        type: 'number',
        default: 120000,
        unit: 'ms',
        exposure: 'standalone',
        description: 'Ceiling for empty-Groups tree re-fetch backoff.',
        reason: TUNING_ONLY_REASON
    },

    // --- Memory bounds and protocol capture ----------------------------------
    webMaxBodySizeBytes: {
        key: 'webMaxBodySizeBytes',
        type: 'number',
        default: 10 * 1024 * 1024,
        unit: 'none',
        exposure: 'standalone',
        description: 'Maximum size (bytes) for POST/PUT/PATCH request bodies on the web UI\'s label-editing API. Default 10MB covers typical .cbz uploads.',
        reason: TUNING_ONLY_REASON
    },
    deviceStateMaxEntries: {
        key: 'deviceStateMaxEntries',
        type: 'number',
        default: 5000,
        unit: 'none',
        exposure: 'standalone',
        description: 'Upper bound on DeviceStateManager\'s per-address level + last-seen maps.',
        reason: 'Each entry is ~30 bytes; default 5000 covers any realistic install while bounding worst-case growth from device churn over long uptime.'
    },
    cbusRawEventLogApps: {
        key: 'cbusRawEventLogApps',
        type: 'array',
        default: [],
        unit: 'none',
        exposure: 'standalone',
        description: 'Apps whose raw C-Gate event lines should be logged verbatim (and published to cbus/read/{net}/{app}/{group}/raw) for protocol capture. Empty = off.',
        reason: 'Used to capture ground-truth samples for specialised applications (e.g. 25 Temperature, 228 Measurement, 172 Air Conditioning) before writing decoders. See docs/superpowers/specs/2026-06-02-native-cbus-hvac-support-design.md'
    }
};

/**
 * Config keys that are legitimately present on a loaded configuration object
 * but are NOT runtime settings: they have no default, so they cannot live in
 * SETTINGS_SCHEMA, yet code reads them and a user may set them.
 *
 * They belong in the known-key vocabulary for exactly the reason getall_networks
 * does: without them the loader would tell anyone who set one that it is a typo
 * that will be ignored, and both halves of that sentence would be false.
 */
const INTERNAL_CONFIG_KEYS = Object.freeze({
    // Written by ConfigLoader after loading; describes where the config came
    // from. MqttManager reads it to tell add-on installs from standalone ones.
    _environment: 'Provenance stamp written by ConfigLoader (type, path, loadedAt).',
    // Written by the add-on path so bridgeInitializationService can tell
    // "user chose these networks" from "these came from auto-discovery".
    _getall_networks_explicit: 'Marks getall_networks as explicitly configured rather than defaulted.',
    _ha_discovery_networks_explicit: 'Marks ha_discovery_networks as explicitly configured rather than defaulted.',
    // The managed/remote C-Gate trio. These have no runtime default: managed
    // mode only exists inside the add-on container, where ConfigLoader sets
    // them from the add-on options. SerialDeviceRecovery reads cgate_mode.
    cgate_mode: 'remote | managed. Managed means C-Gate runs inside the add-on container.',
    cgate_install_source: 'download | upload, for managed mode only.',
    cgate_download_url: 'Where managed mode downloads C-Gate from, when the source is download.'
});

/**
 * Keys whose name does not carry the suffix their unit implies.
 *
 * FROZEN LIST. These are existing warts kept for backwards compatibility:
 * renaming any of them would break every settings.js and saved add-on option
 * that uses them. It documents what already shipped - it must never grow. Any
 * NEW timing setting must be named with the suffix its unit implies
 * (`...Ms` / `..._ms`, `..._sec`, `..._hours`).
 *
 * - getallperiod                     seconds, name predates the convention
 * - messageinterval                  ms, ditto (lowercase legacy name)
 * - reconnectinitialdelay            ms, ditto
 * - reconnectmaxdelay                ms, ditto
 * - healthCheckInterval              ms, but the add-on option is *_sec, so the
 *                                    runtime name deliberately says neither
 * - keepAliveInterval                ms, same story
 * - eventConnectionKeepAliveInterval ms, same story
 * - connectionTimeout                ms, camelCase pool setting from before the
 *                                    convention existed
 */
const UNIT_SUFFIX_EXEMPT_KEYS = Object.freeze([
    'getallperiod',
    'messageinterval',
    'reconnectinitialdelay',
    'reconnectmaxdelay',
    'healthCheckInterval',
    'keepAliveInterval',
    'eventConnectionKeepAliveInterval',
    'connectionTimeout'
]);

/**
 * Suffixes accepted for each unit (case-sensitive on the camelCase forms).
 * @type {Record<string, string[]>}
 */
const UNIT_KEY_SUFFIXES = Object.freeze({
    ms: ['Ms', '_ms'],
    s: ['Sec', '_sec', '_s'],
    hours: ['Hours', '_hours']
});

/**
 * Deep-clone a default so that callers can never mutate the schema.
 * Every default is plain JSON-ish data, so structuredClone is sufficient.
 * @param {*} value
 * @returns {*}
 */
function cloneDefault(value) {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    return structuredClone(value);
}

/**
 * The runtime settings object: one property per schema entry, typed as that
 * entry's default. Derived from the schema so it can never drift from it.
 *
 * @typedef {{ [K in keyof typeof SETTINGS_SCHEMA]: (typeof SETTINGS_SCHEMA)[K]['default'] }} RuntimeSettings
 */

/**
 * Build the runtime defaults object from the schema, in schema order.
 *
 * Returns a fresh object (with deep-cloned array/object defaults) on every
 * call, so a consumer that mutates the settings it was handed cannot reach
 * back into the schema and change the defaults for everyone else.
 *
 * @returns {RuntimeSettings}
 */
function buildDefaults() {
    /** @type {Record<string, *>} */
    const defaults = {};
    for (const entry of Object.values(SETTINGS_SCHEMA)) {
        defaults[entry.key] = cloneDefault(entry.default);
    }
    return /** @type {RuntimeSettings} */ (defaults);
}

/**
 * Look up a single schema entry by its runtime key.
 * @param {string} key
 * @returns {SettingSchemaEntry|undefined}
 */
function getSchemaEntry(key) {
    return Object.values(SETTINGS_SCHEMA).find((entry) => entry.key === key);
}

/**
 * Every schema entry, as an array, for callers that just want to iterate.
 * @returns {SettingSchemaEntry[]}
 */
function listSchemaEntries() {
    return Object.values(SETTINGS_SCHEMA);
}

/**
 * Every alias, mapped to the canonical runtime key it stands for.
 *
 * Returned as a fresh Map so a caller cannot edit the schema by editing it.
 * See the ALIAS RULE at the top of this file for what may be listed.
 *
 * @returns {Map<string, string>} alias -> canonical key
 */
function listSettingAliases() {
    /** @type {Map<string, string>} */
    const aliases = new Map();
    for (const entry of listSchemaEntries()) {
        for (const alias of entry.aliases || []) {
            aliases.set(alias, entry.key);
        }
    }
    return aliases;
}

/**
 * Resolve any accepted name to its canonical runtime key.
 *
 * A canonical key resolves to itself; an alias resolves to the key it stands
 * for; anything else returns undefined.
 *
 * @param {string} name
 * @returns {string|undefined}
 */
function resolveSettingKey(name) {
    if (Object.prototype.hasOwnProperty.call(SETTINGS_SCHEMA, name)) {
        return SETTINGS_SCHEMA[/** @type {keyof typeof SETTINGS_SCHEMA} */ (name)].key;
    }
    return listSettingAliases().get(name);
}

/**
 * Read a runtime setting, falling back to the schema default when unset.
 *
 * This is the only supported way for runtime code to apply schema defaults.
 * It never uses `||`, so `0`, `false` and `''` are preserved as configured
 * values. `null` is returned only when the entry is nullable; otherwise a
 * null falls back to the default (same as "feature left at shipped value").
 *
 * @param {Object|null|undefined} settings
 * @param {string} key - canonical schema key (not an alias)
 * @returns {*}
 */
function resolveSetting(settings, key) {
    if (!Object.prototype.hasOwnProperty.call(SETTINGS_SCHEMA, key)) {
        throw new Error(`Unknown setting key: ${key}`);
    }
    const entry = /** @type {SettingSchemaEntry} */ (
        SETTINGS_SCHEMA[/** @type {keyof typeof SETTINGS_SCHEMA} */ (key)]
    );
    const value = settings !== null && settings !== undefined ? settings[key] : undefined;
    if (value === undefined) {
        return cloneDefault(entry.default);
    }
    if (value === null) {
        return entry.nullable ? null : cloneDefault(entry.default);
    }
    return value;
}

/**
 * resolveSetting, then Number() with a schema-default fallback for non-finite
 * values, then optionally Math.max(min, n).
 *
 * A typo like "sixty" becomes NaN; Math.max(min, NaN) is NaN, which would
 * disable setInterval floors and unbounded caches. Fall back to the schema
 * default so those call sites stay bounded.
 *
 * @param {Object|null|undefined} settings
 * @param {string} key
 * @param {{ min?: number }} [options]
 * @returns {number}
 */
function resolveClampedSetting(settings, key, options = {}) {
    const n = Number(resolveSetting(settings, key));
    const resolved = Number.isFinite(n) ? n : Number(resolveSetting({}, key));
    if (options.min !== undefined) {
        return Math.max(options.min, resolved);
    }
    return resolved;
}

/**
 * Every key that may legitimately appear on a configuration object: canonical
 * setting names, their aliases, and the internal keys above.
 *
 * This is the vocabulary ConfigLoader checks a user's settings.js against, so
 * it is derived rather than hand-maintained — a setting cannot be readable by
 * the code and simultaneously reported as an unknown typo.
 *
 * @returns {Set<string>}
 */
function listKnownConfigKeys() {
    const keys = new Set(Object.values(SETTINGS_SCHEMA).map((entry) => entry.key));
    for (const alias of listSettingAliases().keys()) {
        keys.add(alias);
    }
    for (const key of Object.keys(INTERNAL_CONFIG_KEYS)) {
        keys.add(key);
    }
    return keys;
}

module.exports = {
    SETTINGS_SCHEMA,
    INTERNAL_CONFIG_KEYS,
    listSchemaEntries,
    listSettingAliases,
    listKnownConfigKeys,
    resolveSettingKey,
    resolveSetting,
    resolveClampedSetting,
    UNIT_SUFFIX_EXEMPT_KEYS,
    UNIT_KEY_SUFFIXES,
    buildDefaults,
    getSchemaEntry,
    TUNING_ONLY_REASON
};
