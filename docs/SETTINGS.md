# cgateweb Settings Reference

Complete reference for every runtime setting cgateweb reads, for both installation modes:

- **Standalone** — a Node service on your own host, configured by `settings.js` in the working directory. Keys are the runtime names (mostly lowercase or camelCase). Copy `settings.js.example` to `settings.js` to start.
- **Home Assistant add-on** — configured through the add-on options UI, which writes `/data/options.json`. Options are snake_case and are translated onto runtime keys by `src/config/ConfigLoader.js` and `src/config/addonOptionMap.js`.

The two names are often the same, sometimes different, and in a handful of cases **the units differ** (the add-on takes seconds, the runtime takes milliseconds). Those conversions are called out explicitly in each table.

Canonical defaults live in [`src/defaultSettings.js`](../src/defaultSettings.js). Every setting listed here has been verified against the code that reads it. Settings that exist in the defaults but are not read by anything are listed in [Defined but unused](#defined-but-unused); there are currently none.

Add-on users should also read [`homeassistant-addon/DOCS.md`](../homeassistant-addon/DOCS.md), which covers the add-on-only options (managed C-Gate install, external client access) in more depth.

---

## Contents

- [Minimal working settings.js](#minimal-working-settingsjs)
- [How settings are loaded](#how-settings-are-loaded)
- [Environment variable overrides](#environment-variable-overrides)
- [Reloading configuration (SIGUSR1)](#reloading-configuration-sigusr1)
- [C-Gate connection](#c-gate-connection)
- [MQTT broker](#mqtt-broker)
- [MQTT TLS](#mqtt-tls)
- [State polling (getall)](#state-polling-getall)
- [Home Assistant discovery](#home-assistant-discovery)
- [Entity type classification](#entity-type-classification)
- [C-Bus applications to entity types](#c-bus-applications-to-entity-types)
- [Covers](#covers)
- [Air Conditioning (application 172)](#air-conditioning-application-172)
- [Security (application 208)](#security-application-208)
- [Measurement (application 228)](#measurement-application-228)
- [Diagnostics and stale devices](#diagnostics-and-stale-devices)
- [Labels](#labels)
- [Web interface and API](#web-interface-and-api)
- [Logging](#logging)
- [Reliability and tuning](#reliability-and-tuning)
- [Managed C-Gate and USB serial (add-on only)](#managed-c-gate-and-usb-serial-add-on-only)
- [Add-on options with no runtime setting](#add-on-options-with-no-runtime-setting)
- [Security-sensitive settings](#security-sensitive-settings)
- [Defined but unused](#defined-but-unused)
- [Known traps and mismatches](#known-traps-and-mismatches)

---

## Minimal working settings.js

The smallest `settings.js` that starts and does something useful. `cbusip` must not be left at its placeholder (`your-cgate-ip`) or startup aborts.

```js
// settings.js
exports.cbusip = '192.168.1.100';   // C-Gate server
exports.cbusname = 'HOME';          // C-Gate project name (Toolkit spelling)
exports.mqtt = '192.168.1.10:1883'; // MQTT broker, host:port
```

Everything else falls back to `src/defaultSettings.js`. That gives you the default C-Gate ports (20023 command, 20025 event), an anonymous MQTT connection, no Home Assistant discovery, no polling, and the web UI on `127.0.0.1:8080`.

A realistic Home Assistant setup adds four more lines:

```js
exports.mqttusername = 'homeassistant';
exports.mqttpassword = 'secret';
exports.retainreads = true;
exports.ha_discovery_enabled = true;
exports.ha_discovery_networks = [254];
exports.getallonstart = true;
```

---

## How settings are loaded

1. `src/config/EnvironmentDetector.js` decides whether this is an add-on or a standalone install. Add-on is detected from `/data/options.json` plus `/data`, or from `SUPERVISOR_TOKEN` / `INGRESS_SESSION`.
2. Standalone: the first existing file of `./settings.js`, `<repo>/settings.js`, `./config/settings.js` is loaded with `require()`. If none exists, defaults are used with a warning.
3. The loaded object is merged over `src/defaultSettings.js` — anything you do not set keeps its default.
4. Unknown keys are **warned about but ignored**: `Unknown setting "<key>" in settings.js — check for typos.` This catches misspellings. See [Known traps](#known-traps-and-mismatches) for two keys that trigger this warning despite being real.
5. Environment variable overrides are applied last (see below).
6. `ConfigLoader.validate()` runs. Errors abort startup; warnings are logged.

If `settings.js` throws while loading, startup aborts unless `ALLOW_DEFAULT_FALLBACK=true` is set.

### Type coercion applied to standalone settings

`ConfigLoader._convertSettingsToStandardFormat` coerces the string `'true'`/`'false'` to booleans for `getallonstart`, `retainreads`, `logging`, `ha_discovery_enabled`, `eventPublishCoalesce` and `cbus_aircon_control_enabled`. Everything else is used as written, so a quoted number stays a string. App-ID settings are compared as strings in most places, so `'203'` and `203` both work.

---

## Environment variable overrides

Applied in `index.js` after settings load, so they beat both `settings.js` and add-on options. All are read as plain strings.

| Variable | Overrides | Notes |
|---|---|---|
| `MQTT_HOST` | `mqtt` | Whole `host:port` string, not just the host, despite the name. |
| `MQTT_USERNAME` | `mqttusername` | |
| `MQTT_PASSWORD` | `mqttpassword` | |
| `CGATE_IP` | `cbusip` | |
| `CGATE_USERNAME` | `cgateusername` | |
| `CGATE_PASSWORD` | `cgatepassword` | |
| `CGATE_PROJECT` | `cbusname` | |

Two more environment variables are read elsewhere:

| Variable | Read by | Effect |
|---|---|---|
| `ALLOW_DEFAULT_FALLBACK` | `index.js`, `ConfigLoader` | `true` (case-insensitive) lets a standalone install start on safe defaults when `settings.js` is missing/broken or validation fails, instead of exiting. Never applies in add-on mode. Useful for containers; keep it off in production so a bad edit fails loudly. |
| `LOG_LEVEL` | `src/logger.js` | Sets the level for every logger constructed without an explicit level. See [Logging](#logging) — this is not the same thing as the `log_level` setting. |

`NODE_ENV` also affects logging indirectly: `development` implies `debug` and pretty-printed metadata, `test` implies `warn`.

---

## Reloading configuration (SIGUSR1)

`index.js` installs a `SIGUSR1` handler, and the installed systemd unit wires `ExecReload=/bin/kill -USR1 $MAINPID`, so `systemctl reload cgateweb` triggers it.

What it actually does (`CgateWebBridge.reloadSettings`):

- Re-applies `log_level` to the bridge's loggers.
- Picks up changes to `messageinterval`, `commandMinIntervalMs`, `getallperiod` and `getall_app_periods`, rescheduling periodic getalls.
- **Re-reads the label file from disk** — this is the most useful part in practice.

Everything else (connections, ports, broker, discovery) needs a full restart.

> **Caveat:** the handler calls `configLoader.load()` without forcing a reload, and `ConfigLoader` caches the parsed config from startup. In practice `SIGUSR1` therefore reloads **labels**, but not edits you have just made to `settings.js`. Restart the service to apply a settings change.

---

## C-Gate connection

| Setting | Add-on option | Type | Default | Notes |
|---|---|---|---|---|
| `cbusip` | `cgate_host` | string | `your-cgate-ip` | IP or hostname of the C-Gate server. Must be changed — the placeholder values `your-cgate-ip`, `your.cgate.ip` and `x.x.x.x` fail validation and abort startup. In add-on managed mode this is forced to `127.0.0.1` and `cgate_host` is ignored. |
| `cbusname` | `cgate_project` | string | `CLIPSAL` (add-on: `HOME`) | C-Gate project name, exactly as spelled in C-Bus Toolkit. Validated: 1-32 characters, letters/digits/underscore only. |
| `cbuscommandport` | `cgate_port` | integer | `20023` | Command port. The connection pool opens `connectionPoolSize` sockets here. |
| `cbuseventport` | `cgate_event_port` | integer | **`20025`** | Status-change port, where all state updates arrive. **This is 20025, not 20024.** Point it at the wrong port and commands still work but no state ever comes back. |
| `cgateusername` | *standalone only* | string \| null | `null` | C-Gate access-control username. Sent on command connections only. Validated when set: 1-32 characters, letters/digits/underscore. |
| `cgatepassword` | *standalone only* | string \| null | `null` | Required whenever `cgateusername` is set. Validated: 1-64 printable ASCII, no spaces or control characters. |

---

## MQTT broker

| Setting | Add-on option | Type | Default | Notes |
|---|---|---|---|---|
| `mqtt` | `mqtt_host` + `mqtt_port` | string | `localhost:1883` | Broker address as `host:port`. **Composed in the add-on** from the two separate options; there is no single `mqtt` option there. |
| `mqttusername` | `mqtt_username` | string \| null | `null` | Add-on installs auto-detect this from the Supervisor MQTT service when left empty. |
| `mqttpassword` | `mqtt_password` | string \| null | `null` | As above. |
| `retainreads` | `retain_reads` | boolean | `false` | Set the MQTT retain flag on state/level publishes. Turn this on for Home Assistant so entities come back with a known state after a restart rather than `unknown`. |
| `haStatusTopic` | *standalone only* | string \| null | `null` | Home Assistant birth/will topic to subscribe to for restart detection. `null` derives `<ha_discovery_prefix>/status`. Only change it if you have customised HA's birth topic. |
| `mqttReconnectPeriodMs` | *standalone only* | integer (ms) | `5000` | Passed to mqtt.js as `reconnectPeriod`. |
| `mqttConnectTimeoutMs` | *standalone only* | integer (ms) | `30000` | Passed to mqtt.js as `connectTimeout`. Raise on a slow or distant broker. |
| `mqttPendingPublishMaxEntries` | *standalone only* | integer | `1000` | Bound on retained publishes queued while the broker is unreachable. Newest-wins per topic; oldest evicted when full. Floor of 10. |

---

## MQTT TLS

| Setting | Add-on option | Type | Default | Notes |
|---|---|---|---|---|
| `mqttUseTls` | `mqtt_use_tls` | boolean | `false` | Connect with `mqtts://` instead of `mqtt://` when the broker string has no scheme. Typically paired with port 8883. |
| `mqttCaFile` | `mqtt_ca_file` | string \| null | `null` | Path to a CA certificate for verifying the broker. Required for self-signed broker certificates. |
| `mqttCertFile` | *standalone only* | string \| null | `null` | Client certificate path, for brokers doing mutual TLS. No add-on option exists. |
| `mqttKeyFile` | *standalone only* | string \| null | `null` | Client private key path. Pairs with `mqttCertFile`. |
| `mqttRejectUnauthorized` | `mqtt_reject_unauthorized` | boolean | `true` | Set `false` to skip broker certificate verification. Only honoured when explicitly `false`. Disabling this exposes you to a man-in-the-middle; prefer `mqttCaFile` with a trusted CA. |

Setting any of `mqttCaFile` / `mqttCertFile` / `mqttKeyFile` enables the TLS option block regardless of `mqttUseTls`.

---

## State polling (getall)

C-Bus does not announce the state of every group at startup, so cgateweb asks for it. Which networks it asks depends, in priority order, on `getall_networks`, then auto-discovered networks, then `getallnetapp`.

| Setting | Add-on option | Type | Default | Notes |
|---|---|---|---|---|
| `getallonstart` | `getall_on_start` | boolean | `false` | Request every group's level on connect. Turn on so Home Assistant starts in sync. The add-on option is optional and absent from `config.yaml`'s `options` block, so it is off there too until you add it (the add-on DOCS table showing `true` describes the recommended value, not the shipped one). |
| `getallperiod` | `getall_period` | integer (**seconds**) | `null` | Repeat the full poll every N seconds; catches anything missed while the bridge or broker was down. `null` or `0` disables. Converted to ms internally. Same caveat as above: unset in the add-on until you add it. |
| `getall_app_periods` | `getall_app_periods` | object | `{}` | Per-application poll interval overrides, in seconds: `{ '56': 3600, '203': 0 }`. `0` disables polling for that app. **Shape differs:** the add-on takes a list of `{app_id, period_sec}` objects and ConfigLoader flattens it into this map; standalone takes the map directly. |
| `getallnetapp` | *derived* | string \| null | `null` | Single `network/application` pair, e.g. `'254/56'`. Legacy fallback used only when no network list is available. The add-on derives it as `<getall_networks[0]>/56`. |
| `autoDiscoverNetworks` | `auto_discover_networks` | boolean | `true` | Ask C-Gate which networks exist instead of hardcoding them. Skipped when `getall_networks` or `ha_discovery_networks` is already configured. Standalone accepts either `autoDiscoverNetworks` or the snake_case `auto_discover_networks`. |
| `getall_networks` | `getall_networks` | number[] | *(not in defaults)* | List of C-Bus network IDs to poll, e.g. `[254]`. Read by `bridgeInitializationService`, but absent from `src/defaultSettings.js`, so a standalone install setting it gets a spurious "Unknown setting" warning at startup. It still works. |
| `messageinterval` | `message_interval` | integer (ms) | `200` | Minimum gap between outbound C-Gate commands. Throttles bursts so C-Gate is not flooded. Clamped to a 10 ms floor; validation warns outside 10-10000. |
| `commandMinIntervalMs` | *standalone only* | integer (ms) | `10` | Floor on the adaptive command interval. Clamped to 5 ms minimum; validation warns outside 1-1000. |
| `maxQueueSize` | *standalone only* | integer | `1000` | Cap on the outbound command queue. Commands beyond this are dropped rather than growing memory without bound. |

The poll expands to `network/application` pairs covering lighting (56) plus whichever of `ha_discovery_cover_app_id`, `ha_discovery_hvac_app_id`, `ha_discovery_switch_app_id` and `ha_discovery_relay_app_id` are set. Trigger applications are deliberately excluded — they do not answer level reads and would return a 402 per group.

---

## Home Assistant discovery

| Setting | Add-on option | Type | Default | Notes |
|---|---|---|---|---|
| `ha_discovery_enabled` | `ha_discovery_enabled` | boolean | `false` (the add-on ships `true` in its `options` block) | Publish MQTT Discovery config messages so Home Assistant creates entities automatically. With this off, cgateweb is a plain MQTT bridge. |
| `ha_discovery_prefix` | `ha_discovery_prefix` | string | `homeassistant` | Discovery topic prefix. Must match HA's MQTT integration setting. Also determines the default `haStatusTopic`. |
| `ha_discovery_networks` | `ha_discovery_networks` | number[] | `[]` | Networks to scan for discovery. In the add-on this falls back to `getall_networks` when left empty. Also drives the security zone status sync. |
| `ha_discovery_scene_enabled` | `ha_discovery_scene_enabled` | boolean | `true` | Publish an HA `scene` entity per trigger group alongside the `event` and `button` entities. Set `false` to suppress scenes. |

> **Add-on gating:** most `ha_discovery_*` options are only applied when `ha_discovery_enabled` is on. The deliberate exceptions are `cbus_aircon_app_id`, `cbus_security_app_id`, the three `cbus_security_*_enabled` switches and `cbus_measurement_app_id` — those publish over plain MQTT and would otherwise silently stop working for MQTT-only installs.

---

## Entity type classification

Lighting (application 56) groups default to `light`. These settings decide when a group becomes something else. Precedence: manual `type_overrides` in the label file → label prefix → cover-name keywords → unit type.

| Setting | Add-on option | Type | Default | Notes |
|---|---|---|---|---|
| `ha_discovery_auto_type` | `ha_discovery_auto_type` | boolean | `true` | Master switch for automatic type detection on application 56. Setting `false` also disables the label-prefix and unit-type rules. |
| `ha_discovery_auto_type_name_heuristics` | `ha_discovery_auto_type_name_heuristics` | boolean | `true` | Classify covers by matching the group label against the keyword list below. |
| `ha_discovery_auto_type_cover_keywords` | `ha_discovery_auto_type_cover_keywords` | string[] | `['blind','shutter','shade','awning','curtain','roller','garage door']` | Replaces the default list when non-empty. Case-insensitive, matches plurals. |
| `ha_discovery_type_from_label_prefix` | `ha_discovery_type_from_label_prefix` | boolean | `false` | Treat an entity-id-style label prefix as the type: `cover.bedroom_shutter` becomes a cover. Recognised prefixes: `light.`, `cover.`, `switch.`, `relay.`, `pir.` Opt-in. |
| `ha_discovery_type_from_unit` | `ha_discovery_type_from_unit` | boolean | `false` | Derive the type from the C-Bus unit driving the group: dimmer channel to dimmable light, relay channel to on/off light, input-only unit to `binary_sensor`. Opt-in because enabling it can change the type of entities you already have. |
| `ha_discovery_security_device_class_keywords` | *standalone only* | object | *(not in defaults)* | Keyword to `device_class` map for security zone binary sensors, replacing the built-in list (`pir`/`motion` to motion, `garage` to garage_door, `door`, `window`, `smoke`). Read by `deviceTypeClassifier`, but absent from `src/defaultSettings.js`, so it triggers an "Unknown setting" warning. It still works. |

---

## C-Bus applications to entity types

Each of these maps one C-Bus application ID onto a Home Assistant entity type. All are off until set. Values are compared as strings, so `203` and `'203'` behave the same.

| Setting | Add-on option | Type | Default | Notes |
|---|---|---|---|---|
| `ha_discovery_cover_app_id` | `ha_discovery_cover_app_id` | string \| null | `null` | Groups become `cover` entities. `203` is the usual choice, but C-Bus calls 203 Enable Control — a general-purpose application. Only set it if your blinds really are on it. |
| `ha_discovery_cover_tilt_app_id` | `ha_discovery_cover_tilt_app_id` | string \| null | `null` | Separate application carrying slat tilt position; adds `tilt_status_topic` to cover entities. |
| `ha_discovery_switch_app_id` | `ha_discovery_switch_app_id` | string \| null | `null` | Groups become on/off `switch` entities. |
| `ha_discovery_relay_app_id` | *standalone only* | string \| null | `null` | Groups become relay-backed switch entities. **No add-on option exists** — add-on users cannot set this. |
| `ha_discovery_pir_app_id` | *standalone only* | string \| null | `null` | Groups become motion `binary_sensor` entities; also suppresses level tracking for that application. **No add-on option exists.** |
| `ha_discovery_trigger_app_id` | `ha_discovery_trigger_app_id` | string \| null | `null` | Keypad/scene trigger groups. Typically `202`. Publishes an `event` entity, a companion `button`, and a `scene` when `ha_discovery_scene_enabled`. Also gates the web UI's trigger label editing. |
| `ha_discovery_hvac_app_id` | `ha_discovery_hvac_app_id` | string \| null | `null` | Lighting-style HVAC application (level encodes temperature at 0.5 °C resolution). Distinct from the native Air Conditioning application below. |
| `ha_hvac_temperature_unit` | `ha_hvac_temperature_unit` | `'C'` \| `'F'` | `'C'` | Unit advertised on climate entities. Anything other than `F` is treated as `C`. |

---

## Covers

| Setting | Add-on option | Type | Default | Notes |
|---|---|---|---|---|
| `cover_ramp_duration_ms` | `cover_ramp_duration_sec` | integer (**ms**) | `5000` | Full open-to-close travel time, used to interpolate position during a ramp. **Unit conversion:** the add-on option is in *seconds* and is multiplied by 1000. Setting `cover_ramp_duration_sec: 5` gives `cover_ramp_duration_ms: 5000`. |
| `coverRampUpdateIntervalMs` | *standalone only* | integer (ms) | `500` | How often interpolated position updates are published during a ramp. Lower is smoother in the HA UI but noisier on MQTT. |

---

## Air Conditioning (application 172)

Native C-Bus Air Conditioning: thermostat temperature, mode, setpoint and fan state. **Control is security-sensitive** — it writes to live heating and cooling plant.

| Setting | Add-on option | Type | Default | Notes |
|---|---|---|---|---|
| `cbus_aircon_app_id` | `cbus_aircon_app_id` | string \| null | `null` | Application ID for native aircon reads, typically `172`. `null` disables both decoding and control. |
| `cbus_aircon_control_enabled` | `cbus_aircon_control_enabled` | boolean | `false` | **Security-sensitive.** Lets Home Assistant *set* mode and setpoint via AIRCON commands. Off by default because it actuates real plant. Requires `cbus_aircon_app_id`. Standalone string values are coerced, so `'false'` cannot accidentally enable it. |

---

## Security (application 208)

Zone sensors are read-only and on by default. Every write path is separately opt-in, because the risks differ. **All four control settings are security-sensitive.**

| Setting | Add-on option | Type | Default | Notes |
|---|---|---|---|---|
| `cbus_security_app_id` | `cbus_security_app_id` | string | `'208'` | Publishes one `binary_sensor` per zone (sealed/unsealed) and syncs zone state on connect. Set to `'0'` or empty to disable. Kept as a string precisely so `0` can disable it; the add-on maps an explicit `0` through rather than dropping it. |
| `cbus_security_control_enabled` | `cbus_security_control_enabled` | boolean | `false` | **Security-sensitive.** Allows ARM via the panel command topic. The C-Bus arm command carries no PIN, so anything that can publish to that topic can arm the panel. |
| `cbus_security_disarm_enabled` | `cbus_security_disarm_enabled` | boolean | `false` | **Security-sensitive.** Allows DISARM, on top of `cbus_security_control_enabled`. C-Bus has no disarm command — the PIN is replayed through keypad emulation, so **the PIN crosses your MQTT broker on every disarm**. Nothing stores it, but anyone who can read that topic learns it. Only enable on a broker you trust, ideally with TLS. |
| `cbus_security_bypass_enabled` | `cbus_security_bypass_enabled` | boolean | `false` | **Security-sensitive.** Allows forcing an arm past an open zone (the panel's `#` key), on top of `cbus_security_control_enabled`. Leaves the owner believing a zone is covered when it is not. Deliberately separate from disarm so you do not have to enable PIN-over-MQTT to get bypass. |
| `securityDisarmMaxAttempts` | *standalone only* | integer | `10` | Brute-force limit on disarm attempts per network/application in a sliding window. cgateweb cannot tell a right PIN from a wrong one, so every attempt counts. |
| `securityDisarmAttemptWindowMs` | *standalone only* | integer (ms) | `600000` (10 min) | The sliding window for the above. Deliberately runtime-only rather than an add-on option: it is a safety floor, and a UI field inviting people to raise it defeats the purpose. |

---

## Measurement (application 228)

| Setting | Add-on option | Type | Default | Notes |
|---|---|---|---|---|
| `cbus_measurement_app_id` | `cbus_measurement_app_id` | string \| null | `null` | Typically `228` (`$E4`). One flag gates **both directions**: decoding `measurement data` event lines to `cbus/read/{net}/228/{device}/{channel}/value` and `/unit`, and injecting readings via `cbus/write/{net}/228/{device}/{channel}/data` with a `value,multiplier,units` payload. Unlike aircon and security there is no separate control switch — measurement writes are how a scripted or virtual sensor publishes its own data, not a hardware-actuation risk. See [`docs/Measurement Application.md`](Measurement%20Application.md). |

---

## Diagnostics and stale devices

| Setting | Add-on option | Type | Default | Notes |
|---|---|---|---|---|
| `ha_bridge_diagnostics_enabled` | `ha_bridge_diagnostics_enabled` | boolean | `true` | Publish bridge health entities (connection state, queue depth, discovery counts) into Home Assistant. |
| `ha_bridge_diagnostics_interval_sec` | `ha_bridge_diagnostics_interval_sec` | integer (**seconds**) | `60` | Publish interval. Same unit on both sides — no conversion. Floor of 10 s. |
| `stale_device_detection_enabled` | `stale_device_detection_enabled` | boolean | `true` | Flag devices that have not reported for a long time. |
| `stale_device_threshold_hours` | `stale_device_threshold_hours` | integer (hours) | `24` | How long without an event before a device counts as stale. Floor of 1 hour. |
| `stale_device_check_interval_sec` | `stale_device_check_interval_sec` | integer (**seconds**) | `3600` | How often the check runs. Same unit on both sides. Floor of 60 s. |
| `cniMonitorIntervalMs` | *standalone only* | integer (ms) | `30000` | How often each network's CNI/PCI interface state is polled so a C-Gate-to-C-Bus dropout surfaces on the status page. `0` disables. |
| `cni_offline_notification` | `cni_offline_notification` | boolean | `false` | Raise a Home Assistant persistent notification when a CNI/PCI goes offline, dismissed on recovery. Requires the add-on environment (`SUPERVISOR_TOKEN`); inert standalone. |

---

## Labels

| Setting | Add-on option | Type | Default | Notes |
|---|---|---|---|---|
| `cbus_label_file` | `cbus_label_file` | string \| null | `null` | Path to the JSON file holding imported group labels, manual `type_overrides` and the web UI's saved edits. Without it, discovered entities get generic names and the web UI cannot save. The security panel state file is written alongside it. In the add-on this is auto-detected across `/homeassistant`, the legacy `/config` mount and `/data`, and a saved `/config/...` path is migrated to `/homeassistant/...` when the old one is gone. |

The label file itself is not a settings file, but note that `type_overrides` inside it takes precedence over every automatic type-classification setting above.

---

## Web interface and API

The web server hosts the status page and the label-editing API. Under the add-on it is reached through HA Ingress (which authenticates for you); standalone it is a plain HTTP server.

| Setting | Add-on option | Type | Default | Notes |
|---|---|---|---|---|
| `web_port` | *standalone only in practice* | integer | `8080` | Listen port. `addonOptionMap` has a `web_port` rule, but **`config.yaml` declares no such option**, so add-on users cannot set it; Ingress uses 8080 regardless. |
| `web_bind_host` | *forced in add-on* | string | `127.0.0.1` | Bind address. **Loopback by default deliberately** — the API can modify your labels. The add-on forces `0.0.0.0` because the Ingress proxy connects from outside the container's loopback. Change it standalone only if you understand what you are exposing. |
| `web_api_key` | `web_api_key` | string \| null | `null` | **Security-sensitive.** API key required for `POST`/`PUT`/`PATCH` on label endpoints when reached directly (not via Ingress). Set this whenever the port is reachable from anywhere but localhost. |
| `web_allow_unauthenticated_mutations` | `web_allow_unauthenticated_mutations` | boolean | `false` | **Security-sensitive.** Unsafe override allowing writes with no authentication at all. Anyone who can reach `web_port` can rewrite your labels. Leave off unless the port is genuinely isolated. |
| `web_allowed_origins` | `web_allowed_origins` | string[] \| string \| null | `null` | CORS allowlist of browser origins, e.g. `['https://ha.example.com']`. A comma-separated string is accepted standalone. Empty/null blocks all cross-origin access. |
| `web_mutation_rate_limit_per_minute` | `web_mutation_rate_limit_per_minute` | integer | `120` | Per-client write rate limit on mutating endpoints, over a fixed 60 s window. |
| `web_auth_failure_rate_limit_per_minute` | *standalone only* | integer | `20` | Stricter, separate bucket for **failed** authentication attempts, so an exposed `web_api_key` cannot be brute-forced unthrottled. |
| `web_max_sse_connections` | *standalone only* | integer | `32` | Cap on concurrent clients of the `/api/events/stream` SSE endpoint. A denial-of-service guard for exposed ports. |
| `webSseKeepaliveMs` | *standalone only* | integer (ms) | `15000` | SSE comment keepalive interval, so reverse proxies do not idle-close the stream. |
| `webMaxBodySizeBytes` | *standalone only* | integer (bytes) | `10485760` (10 MB) | Maximum `POST`/`PUT`/`PATCH` body size on the label API. The default covers typical `.cbz` project uploads. |
| `web_active_device_window_ms` | *standalone only* | integer (ms) | `86400000` (24 h) | Window within which a device counts as "active" in the status page device list. |
| `web_ha_areas_cache_ttl_ms` | *standalone only* | integer (ms) | `30000` | TTL for the cached Home Assistant areas list fetched from the Supervisor template API. |
| `web_ha_api_timeout_ms` | *standalone only* | integer (ms) | `5000` | Timeout for outbound calls from the web UI to the HA Supervisor API. |
| `eventLogMaxEntries` | *standalone only* | integer | `200` | In-memory ring buffer size for the web UI event log and SSE replay. Floor of 10. |

---

## Logging

| Setting | Add-on option | Type | Default | Notes |
|---|---|---|---|---|
| `log_level` | `log_level` | `'error'` \| `'warn'` \| `'info'` \| `'debug'` \| `'trace'` | `'info'` | The real logging control. Hot-reloadable via `SIGUSR1`. The add-on UI only offers `debug`, `info`, `warn`, `error` — `trace` is standalone-only. Anything unrecognised in the add-on falls back to `info`. |
| `logging` | *(none)* | boolean | `true` | **Does nothing.** It is only ever read as `settings.log_level \|\| (settings.logging ? 'info' : 'warn')`, and `log_level` always has a value because the defaults set it. The branch is unreachable. Kept for backwards compatibility with old `settings.js` files; set `log_level` instead. |

### The LOG_LEVEL environment variable

`log_level` is passed explicitly to only three loggers (`CgateWebBridge`, `EventPublisher`, `ConnectionManager`). Every other component — `MqttManager`, `HaDiscovery`, `WebServer`, `CgateConnection`, `CgateConnectionPool`, `LabelLoader` and the rest — constructs its logger without a level and therefore falls back to the `LOG_LEVEL` environment variable, or `info`.

So standalone, `exports.log_level = 'debug'` alone will **not** give you debug output from the connection or MQTT layers. Run with the environment variable as well:

```sh
LOG_LEVEL=debug npm start
```

The add-on does this for you: its service script exports `LOG_LEVEL` from the `log_level` option, so both paths agree there.

| Setting | Add-on option | Type | Default | Notes |
|---|---|---|---|---|
| `cbusRawEventLogApps` | *standalone only* | string[] | `[]` | Applications whose raw C-Gate event lines are logged verbatim and republished to `cbus/read/{net}/{app}/{group}/raw`. For capturing ground-truth protocol samples before writing a decoder (e.g. `['172']`). Empty disables. Leave empty in normal operation — it is noisy. |

---

## Reliability and tuning

Mostly standalone-only knobs. Defaults are chosen for a typical install; change them for slow hardware, large projects or fragile networks.

### Connection pool and reconnection

| Setting | Add-on option | Type | Default | Notes |
|---|---|---|---|---|
| `connectionPoolSize` | `connection_pool_size` | integer | `3` | Number of persistent command connections. Round-robin load balanced. Floor of 1. |
| `healthCheckInterval` | `connection_health_check_interval_sec` | integer (**ms**) | `30000` | Pool health-check frequency. **Unit conversion:** the add-on option is in *seconds* and is multiplied by 1000. Floor of 5000 ms. |
| `keepAliveInterval` | `connection_keep_alive_interval_sec` | integer (**ms**) | `60000` | Keep-alive ping interval for pooled command connections. **Unit conversion:** seconds to ms. The add-on option sets **both** this and `eventConnectionKeepAliveInterval`. |
| `eventConnectionKeepAliveInterval` | `connection_keep_alive_interval_sec` | integer (ms) | `60000` | Keep-alive for the single event connection. Takes precedence over `keepAliveInterval` for that connection. Floor of 10000 ms. |
| `connectionTimeout` | *standalone only* | integer (ms) | `5000` | Socket timeout for establishing a C-Gate connection, and the idle socket timeout thereafter. Floor of 1000 ms. |
| `maxRetries` | *standalone only* | integer | `3` | Reconnect attempts per pooled connection before the pool gives up on it. Floor of 1. |
| `cgateMaxReconnectAttempts` | *standalone only* | integer | `10` | Reconnect attempts for a standalone (non-pooled) C-Gate connection, i.e. the event connection. Pool members use `maxRetries` instead. |
| `reconnectinitialdelay` | *standalone only* | integer (ms) | `1000` | Initial exponential-backoff delay for C-Gate reconnection. Floor of 100 ms in the pool. |
| `reconnectmaxdelay` | *standalone only* | integer (ms) | `60000` | Backoff ceiling. Never lower than `reconnectinitialdelay`. |
| `initDebounceMs` | *standalone only* | integer (ms) | `10000` | Debounce window for bridge re-initialisation when all connections flap together, so a single outage does not fire duplicate getall/discovery passes. |

### Event publishing

| Setting | Add-on option | Type | Default | Notes |
|---|---|---|---|---|
| `eventPublishDedupWindowMs` | *standalone only* | integer (ms) | `0` (off) | Drop a publish if the identical payload went to the same topic within this window. Useful on noisy buses. Validation warns outside 0-60000. |
| `eventPublishDedupMaxEntries` | *standalone only* | integer | `5000` | Cap on the dedup cache. Floor of 100; validation warns below 100. |
| `eventPublishCoalesce` | *standalone only* | boolean | `false` | Buffer publishes per topic and flush the latest value, instead of publishing every intermediate value. Cuts broker traffic during ramps at the cost of some latency. |
| `topicCacheMaxEntries` | *standalone only* | integer | `5000` | Cap on the computed-topic string cache. Floor of 100. |
| `deviceStateMaxEntries` | *standalone only* | integer | `5000` | Cap on `DeviceStateManager`'s per-address level and last-seen maps. Bounds worst-case memory growth from device churn over long uptime. Floor of 100. |
| `relativeLevelTimeoutMs` | *standalone only* | integer (ms) | `5000` | How long a relative-level command (increase/decrease) waits for the current level to come back before giving up. |

### State resync

| Setting | Add-on option | Type | Default | Notes |
|---|---|---|---|---|
| `stateResyncOnHaRestart` | *standalone only* | boolean | `true` | Republish entity state when Home Assistant's birth message arrives. On by default: without it HA returns from a restart with entities stuck `unknown` until the next physical C-Bus event. |
| `stateResyncOnMqttReconnect` | *standalone only* | boolean | `true` | Same, for an MQTT broker reconnect. |
| `stateResyncDebounceMs` | *standalone only* | integer (ms) | `5000` | Collapse near-simultaneous triggers (a broker bounce that also restarts HA) into one pass. |

### Discovery tree retrieval

C-Gate accepts connections on the command port before its networks have loaded, so an early `TREEXML` can return `401 Network not found`. These bound the retry budget.

| Setting | Add-on option | Type | Default | Notes |
|---|---|---|---|---|
| `haDiscoveryMaxTreeRetryAttempts` | *standalone only* | integer | `8` | Retries when the tree request fails outright. |
| `haDiscoveryTreeRetryInitialDelayMs` | *standalone only* | integer (ms) | `2000` | Initial backoff between those retries. |
| `haDiscoveryTreeRetryMaxDelayMs` | *standalone only* | integer (ms) | `60000` | Backoff ceiling. |
| `haDiscoveryTreeRequestTimeoutMs` | *standalone only* | integer (ms) | `8000` | "No response at all" timeout for a tree request. |
| `haDiscoveryTreeStreamStallMs` | *standalone only* | integer (ms) | `8000` | How long a tree stream may go **silent mid-transfer** before counting as stalled. Reset by every data chunk, so it bounds idle time rather than total transfer time. Raise it only if a very large tree on slow hardware still reports "tree stream stalled". |
| `haDiscoveryMaxTreeResyncAttempts` | *standalone only* | integer | `3` | Re-fetches of an accepted tree that still had empty `<Groups>` because C-Gate had not finished syncing group bindings. |
| `haDiscoveryTreeResyncInitialDelayMs` | *standalone only* | integer (ms) | `30000` | Initial delay before the first re-fetch. |
| `haDiscoveryTreeResyncMaxDelayMs` | *standalone only* | integer (ms) | `120000` | Ceiling for re-fetch backoff. |

---

## Managed C-Gate and USB serial (add-on only)

Managed mode runs C-Gate inside the add-on container. None of this applies to a standalone install, where C-Gate is your own service.

| Setting | Add-on option | Type | Default | Notes |
|---|---|---|---|---|
| `cgate_mode` | `cgate_mode` | `'remote'` \| `'managed'` | `'remote'` | `managed` forces `cbusip` to `127.0.0.1`. Accepted in standalone `settings.js` without a typo warning, but only `serialDeviceRecovery` reads it. |
| `cgate_install_source` | `cgate_install_source` | `'download'` \| `'upload'` | `'download'` | Where the managed C-Gate zip comes from. Consumed by the container init scripts; validation warns if `upload` is chosen and `/share/cgate/` contains no `.zip`. |
| `cgate_download_url` | `cgate_download_url` | string | `''` | Override the default C-Gate download URL. |
| `cgate_serial_device` | `cgate_serial_device` | string \| null | `null` | Local USB PC Interface device path (beta). Only meaningful in managed mode. `null` means a network CNI, which makes all `serialRecovery*` settings below inert. Prefer a `/dev/serial/by-id/...` alias so it survives replugging. |
| `serialRecoveryEnabled` | *standalone only* | boolean | `true` | Recover from a USB PC Interface that renumbered while running. Only engages in managed mode with `cgate_serial_device` set **and** the device path gone or now pointing at a different port, so a CNI dropout never triggers it. |
| `serialRecoveryMaxAttempts` | *standalone only* | integer | `3` | Managed-C-Gate restarts per outage before giving up and asking the user to intervene. Floor of 1. |
| `serialRecoveryInitialDelayMs` | *standalone only* | integer (ms) | `5000` | Initial backoff between attempts within one outage. |
| `serialRecoveryMaxDelayMs` | *standalone only* | integer (ms) | `300000` (5 min) | Backoff ceiling, so a flapping interface cannot become a C-Gate restart loop. |
| `serialRecoveryStableWindowMs` | *standalone only* | integer (ms) | `900000` (15 min) | How long the interface must stay up before the next outage counts as new trouble and gets a fresh attempt budget. |
| `serialRecoveryTimeoutMs` | *standalone only* | integer (ms) | `15000` | Cap on the recovery helper's run time. The helper runs **synchronously** inside C-Gate response processing, so for its whole duration MQTT keepalive, pool health checks and every timer are stalled behind it. A real run costs 2-5 s. Clamped to a 1 s floor — `0` would mean "no timeout" and block indefinitely. |

The `serialRecovery*` settings are marked standalone-only because no add-on option exposes them, but they only do anything in the add-on's managed mode. They are runtime-tunable escape hatches rather than user-facing options.

---

## Add-on options with no runtime setting

These add-on options never reach the Node process; they are consumed by the container's init scripts. See [`homeassistant-addon/DOCS.md`](../homeassistant-addon/DOCS.md).

| Add-on option | Purpose |
|---|---|
| `cgate_download_sha256` | SHA256 of the C-Gate zip; installs fail on mismatch. |
| `cgate_force_reinstall` | Reinstall/upgrade managed C-Gate on the next start. |
| `cgate_external_clients` | Addresses allowed to connect to the managed C-Gate (for C-Bus Toolkit), each with an access `level`. C-Gate has no authentication on its ports. |

---

## Security-sensitive settings

Anything below can cause a write to real hardware, or removes a control on who may write. Review these deliberately.

| Setting | Risk |
|---|---|
| `cbus_aircon_control_enabled` | Home Assistant can change mode and setpoint on live heating/cooling plant. |
| `cbus_security_control_enabled` | Anything that can publish to the panel command topic can **arm** the alarm. The C-Bus arm command carries no PIN. |
| `cbus_security_disarm_enabled` | Adds **disarm**. The PIN is replayed through keypad emulation and therefore crosses the MQTT broker in the command payload on every disarm. Anyone who can read that topic learns the PIN. |
| `cbus_security_bypass_enabled` | Allows arming **past an open zone**. The panel reports armed while a door or window is not actually covered. |
| `web_allow_unauthenticated_mutations` | Removes authentication from the label-editing API entirely. Anyone who can reach `web_port` can rewrite labels. |
| `web_bind_host` | Moving off `127.0.0.1` exposes the API. Pair with `web_api_key`. |
| `web_api_key` | Leaving it `null` on an exposed port means writes are refused (safe) — but combined with the override above, writes are open. |
| `mqttRejectUnauthorized` | Setting `false` disables broker certificate verification and permits a man-in-the-middle. |
| `securityDisarmMaxAttempts` / `securityDisarmAttemptWindowMs` | Raising these weakens the brute-force floor on PIN attempts. Ten per ten minutes turns a 4-digit exhaustive search into roughly a week of continuous attempts. |

---

## Defined but unused

Every key in `src/defaultSettings.js` is read by code somewhere. There are currently **no** orphaned settings.

The one setting that is read but has no effect is `logging` — see [Logging](#logging). Its branch is unreachable because `log_level` is always populated from the defaults, so the setting does nothing. It is documented above rather than here because a value in an existing `settings.js` is harmless.

---

## Known traps and mismatches

1. **Event port is 20025.** Not 20024, despite the add-on declaring a `20024/tcp` port mapping for C-Gate's own event port. `cbuseventport` must be 20025.
2. **`logging` does nothing.** Use `log_level`.
3. **`log_level` does not cover every component.** Set the `LOG_LEVEL` environment variable too when debugging a standalone install — see [Logging](#logging).
4. **`SIGUSR1` reloads labels, not settings.** The config loader's cache is not invalidated. Restart to apply a `settings.js` change.
5. **Unit conversions between add-on and standalone names.** `connection_health_check_interval_sec` to `healthCheckInterval` (ms), `connection_keep_alive_interval_sec` to `keepAliveInterval` *and* `eventConnectionKeepAliveInterval` (ms), `cover_ramp_duration_sec` to `cover_ramp_duration_ms`. `message_interval`, `getall_period`, `ha_bridge_diagnostics_interval_sec`, `stale_device_check_interval_sec` and `stale_device_threshold_hours` are **not** converted.
6. **`getall_app_periods` changes shape.** Add-on: a list of `{app_id, period_sec}`. Standalone: a plain `{ '56': 3600 }` map.
7. **`mqtt` is composed in the add-on** from `mqtt_host` and `mqtt_port`; standalone it is a single `host:port` string.
8. **Two real settings trigger a false "Unknown setting" warning** in standalone mode, because they are read by code but missing from `src/defaultSettings.js`: `getall_networks` and `ha_discovery_security_device_class_keywords`. Both still work.
9. **`web_port` cannot be set in the add-on.** `addonOptionMap.js` has a mapping rule for it, but `homeassistant-addon/config.yaml` declares no such option, so the Supervisor never writes it into `/data/options.json`. The rule is dead.
10. **`ha_discovery_relay_app_id` and `ha_discovery_pir_app_id` are standalone-only.** There is no add-on option for either, so relay and PIR application mapping is unavailable in the add-on UI.
11. **`mqttCertFile` and `mqttKeyFile` are standalone-only.** The add-on exposes `mqtt_ca_file` but no client certificate or key option, so mutual TLS is not configurable there.
12. **`trace` is standalone-only.** The add-on's `log_level` schema is `list(debug|info|warn|error)`; anything else falls back to `info`.
13. **Most `ha_discovery_*` add-on options are ignored when `ha_discovery_enabled` is off.** The exceptions — `cbus_aircon_app_id`, `cbus_security_app_id`, the `cbus_security_*_enabled` switches and `cbus_measurement_app_id` — are deliberate, so MQTT-only installs keep working.
