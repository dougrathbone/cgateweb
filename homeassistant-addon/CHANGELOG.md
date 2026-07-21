# Changelog

All notable changes to the C-Gate Web Bridge Home Assistant add-on will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.17.2] - 2026-07-21

### Added

- **Web UI brute-force protection.** Failed API-key attempts now get their own stricter rate-limit bucket (default 20/min per client, tunable via `web_auth_failure_rate_limit_per_minute`); repeated failures return 429 instead of unlimited 401s. Successful authentications are unaffected.

### Fixed

- **A throwing route handler can no longer crash the process after writing response headers.** A second `writeHead` would have raised `ERR_HTTP_HEADERS_SENT` into an unhandled rejection; the error handler now just ends the response.

### Changed

- **Add-on base images bumped to Alpine 3.21** (3.19 is end-of-support, so its package repo was frozen and unpatched). Java layout verified per-arch: openjdk17 on x86_64/aarch64, openjdk8 fallback on armv7/armhf/i386.
- Internal: dead code pruned (unused `CgateManager`, three dead constants); `.DS_Store` and `coverage/` added to the repo `.gitignore`.

## [1.17.1] - 2026-07-21

### Fixed

- **Target humidity now appears on climate entities.** The discovery payload used `humidity_state_topic`, which is not a valid MQTT climate key and was silently ignored; it now uses `target_humidity_state_topic` (verified against the current `climate.mqtt` documentation).
- **Setpoint and fan-mode writes no longer power on an off thermostat.** Both fell back to heat mode when the unit was off, so adjusting the target on an off climate card started the plant. The writes are now ignored with a warning when the unit is off (selecting a mode remains the way to turn it on).
- **Fan speed survives automatic fan-mode writes.** Switching the fan to `automatic` zeroed the learned Aux Level, so a later `continuous` write reverted to default speed; the learned speed bits are now preserved and re-applied.

## [1.17.0] - 2026-07-20

### Added

- **Discovery type from entity-id label prefix (#35).** New opt-in `ha_discovery_type_from_label_prefix` setting: groups named with their intended Home Assistant entity id (`cover.bedroom_shutter`, `switch.porch_light`, `light.bedroom_downlights`) are discovered as that type. Supported prefixes match the `type_overrides` vocabulary (`light.`, `cover.`, `switch.`, `relay.`, `pir.`); a manual override still wins. Available in the add-on UI, off by default.
- **Source unit per group (#35).** Every C-Bus event's originating unit (`#sourceunit`) is published to `cbus/read/{net}/{app}/{group}/source_unit`, so automations can react to a physical switch press specifically or filter out bridge/CNI-originated writes. Events without a source (e.g. sync updates) publish nothing.

## [1.16.3] - 2026-07-20

### Added

- **Clear warning when managed C-Gate has no project database (#28).** Startup now warns explicitly when managed mode finds no Toolkit `.db` anywhere — naming the symptom (`401 Network not found` on every network command), the fix (place `<PROJECT>.db` in `/share/cgate/tag/` and restart), and the common confusion behind it (importing labels into the Web UI does not install the C-Bus project). The alpha USB-serial docs gained a matching Troubleshooting note.

### Fixed

- **Serial diagnostics query `PORT IFLIST` instead of bare `IFLIST` (#28).** C-Gate rejected the latter with `400 Syntax Error`; the interface-list command is `PORT IFLIST` per the manual (§4.5.152).

## [1.16.2] - 2026-07-20

### Added

- **Sync-complete (762) events now reach the bridge (#25).** The command session opens with `EVENT e6s0c0` (C-Gate manual §4.5.83): level-6 events such as "Network sync ok" are now delivered, so HA Discovery re-fetches the tree the moment a network finishes syncing instead of waiting out the bounded polling cycle. Verified on a live C-Gate v3.3.2: 762 is broadcast to all event-enabled sessions and triggers the immediate refresh.

### Fixed

- **Async event lines in the digit-level (`#e#`) format are parsed.** With a digit event level, C-Gate prefixes async events by channel (`#e#`/`#s#`/`#c#`) and some timestamps omit milliseconds; the command-port parser dropped those lines at debug, which would also have broken the existing 742 Network-created handling once the level changed.

## [1.16.1] - 2026-07-19

### Added

- **Tree re-fetch diagnostics now name the unassigned units (#25).** The empty-`<Groups>` re-fetch scheduling, budget-exhausted, and unchanged-tree stop messages list the affected units (e.g. `15 SENLL, 16 SENLL, 20 SENTEMP`) so installations with permanently group-less input units (sensors whose bindings never appear in TREEXML) self-identify in logs.

## [1.16.0] - 2026-07-19

### Added

- **Home Assistant discovery for Temperature Broadcast (app 25) sensors.** Temperature groups now announce a HA `sensor` (device class temperature, °C) the first time each sensor broadcasts — no configuration needed beyond `ha_discovery_enabled`.
- **Plant and sensor fault entities for native aircon.** Each Air Conditioning (172) thermostat gets `Plant problem` and `Temperature sensor problem` binary_sensors attached to its climate device, driven by the plant error state (spec §25.6.6/§25.6.5) and temperature sensor status (§25.6.12), with matching `problem`/`sensor_problem` MQTT topics.
- **Aircon humidity application (read-only, spec-derived).** `zone_humidity`, `set_zone_humidity_mode` and `zone_humidity_plant_status` are decoded and published as `current_humidity`, `humidity_mode`, `humidity_setpoint` and `humidity_action` topics, wired into the climate entity's humidity state. Field layouts follow the verified HVAC conventions but have no live captures yet; humidity writes are deliberately not implemented.
- **Fan mode control for native aircon.** `cbus/write/<net>/172/<unit>/fanmode` accepts `automatic`/`continuous` (Aux Level per spec §25.6.11), exposed as `fan_mode_command_topic` when control is enabled; learned fan-speed bits are preserved on writes.
- **Raw-level fan speed and evaporative comfort level topics.** `fan_speed_pct` (0-100% of plant capacity, §25.12.8) and `comfort_level` (§25.12.7, spec-default mapping) for native thermostats.
- **AIRCON REFRESH on first sight of a zone group** (control-enabled installs only), per the spec's mimic-device guidance (§25.8.3/§25.12.11) and rate-limited to once per zone group per session. The textual verb follows the verified AIRCON command convention but is not yet verified against a live C-Gate HELP.

### Fixed

- **Sub-zero aircon temperatures now decode.** Zone temperatures are signed 2's complement (§25.5.1); both C-Gate renderings are normalised, and a degraded or failed temperature sensor publishes its status instead of a bogus reading.
- **Raw levels are no longer misread as setpoints.** The Level-is-Raw flag (§25.6.3) is honoured — the fan-only `32512` is ~99% fan output, not a 127°C setpoint or a "no setpoint" sentinel.
- **Aircon writes echo the thermostat's own configuration.** Setback/guard/aux-used flags and the Aux Level are learned from broadcasts and echoed on writes instead of being silently reset; setpoints are kept per operating type (§25.12.11); and rapid setpoint adjustments are debounced into a single command per the spec's anti-echo guidance (§25.12.11).
- **Ingress path trimming no longer uses a ReDoS-prone regex.**

### Changed

- Internal: `@ts-check` enabled across the remaining source modules, GitHub Actions dependencies bumped, legacy perf snapshots removed.

## [1.15.15] - 2026-07-19

### Fixed

- **Tree re-fetch no longer loops when units legitimately have no groups (#25).** The initial-sync fallback re-fetches TREEXML when units report no group addresses, which for genuinely unassigned units ran the full 30s/60s/120s cycle every startup, republishing the same entities each time. Each scheduled re-fetch now fingerprints the tree's group data and stops early when a re-fetch comes back identical, logging that those units are treated as unassigned.

### Changed

- Internal: the integration test now dumps the addon, supervisor and mqtt container logs when a run fails, and its readiness timeout is env-overridable.

## [1.15.14] - 2026-07-19

### Added

- **HVAC plant error reporting, decoded from the official protocol spec.** Air Conditioning (172) plant status now exposes the Error/Expansion status flags and the previously-ignored HVAC Error Code, published as `error` and `error_description` topics under `cbus/read/<net>/172/<unit>/` with named descriptions from the spec (heater/cooler/fan failure, sensor failure, service/filter required). A non-zero error code also logs a warning once per unit until it clears.
- **HVAC fan speed and fan mode.** Zone mode events now decode the Aux Level into `fan_speed` (raw 0-63) and `fan_mode` (`automatic`/`continuous`) topics, and native climate entities expose read-only fan mode. Fan mode is not settable; the control path does not write the Aux Level.

### Fixed

- **Processing error logs no longer drop the details.** Errors while handling C-Gate command/event lines logged neither the error nor the offending line; both are now included.

## [1.15.13] - 2026-07-19

### Added

- **Serial device dropdown for the USB-serial PCI alpha (#28).** `cgate_serial_device` now renders as a dropdown of serial devices detected on the host instead of a free-text field. Custom paths (e.g. `/dev/serial/by-id/...`, which survives replugging) remain possible via the YAML config editor. Startup also logs an inventory of detected serial devices when the option is set, so a wrong pick shows what actually exists.
- **Startup diagnostics for the serial alpha (#28).** With `cgate_serial_device` set in managed mode, startup logs the selected device's resolved target and C-Gate's own `PORT LIST`/`IFLIST` output in a paste-ready block for issue reports. Diagnostics never block or break startup.

### Fixed

- **Default managed-mode C-Gate download is now integrity-checked.** The built-in download URL is verified against a sha256 pinned in the install script instead of proceeding warn-only. A user-set `cgate_download_sha256` still overrides, and custom URLs without one already failed hard.
- **Web server shutdown no longer hangs test workers.** A `close()` racing an in-flight `start()` silently failed and left the server listening; `close()` now awaits the start first.

### Changed

- Internal: `@ts-check` now covers the stateful core (bridge, C-Gate connection, MQTT manager, device state, and the HA discovery modules); ~185 type errors fixed via JSDoc only, no runtime changes.

## [1.15.12] - 2026-07-18

### Added

- **Alpha USB-serial PC Interface passthrough for managed mode (#28).** A new opt-in, hidden `cgate_serial_device` option passes a USB PCI (5500PC/5500PCU) attached to the Home Assistant host through to the C-Gate instance running inside the add-on (`uart: true` lets the Supervisor map host serial devices into the container). Off by default and deliberately absent from `options`, so upgrades change nothing for existing users. Startup validates the configured path and fails fast with a readable error. Experimental: known limitations (Windows-saved COMx port names in the Toolkit project, untested on ARM) are documented in DOCS.md — report results on issue #28.
- Documented that USB PC Interfaces also work today via remote mode (self-hosted C-Gate on any machine with the dongle attached).

## [1.15.11] - 2026-07-18

### Fixed

- **Label save/import failing with "Unauthorized" from the ingress side panel (#33).** The add-on relied on an `INGRESS_ENTRY` environment variable that the Supervisor never sets (it only injects `SUPERVISOR_TOKEN`), so with no `web_api_key` configured every label save, import, and the status tab failed authorization through ingress. The bridge now discovers its ingress path from the Supervisor API at startup, so side-panel saves authorize as intended — and the label UI surfaces a failed save instead of silently dropping it.
- **Groups missing on initial sync are now discovered automatically (#25).** When C-Gate is still syncing with the C-Bus network at startup, TREEXML returns units with empty group lists and those groups previously stayed missing until a manual `gettree`. The bridge now re-fetches the tree when C-Gate reports network sync complete (event 762) and, since 762 is only emitted at event level 6, also schedules a bounded re-fetch (30s→60s→120s) whenever an accepted tree still contains unsynced units.
- **Malformed address segments in command topics are rejected.** Network/application/group segments must be 1-3 digits; values like `254abc` were previously accepted and silently truncated.

### Changed

- **Custom managed-mode C-Gate downloads now require a checksum.** A custom `cgate_download_url` without `cgate_download_sha256` fails the install with a clear error instead of only warning. If you use a custom URL, set its sha256 before upgrading.
- Internal: web server split into `src/web/` modules, `@ts-check` enabled on the connection pool and command router, and local `npm run lint` now enforces zero warnings like CI.

## [1.15.10] - 2026-07-12

### Fixed

- **Manual `gettree` no longer creates duplicate `unknown` entities (#25).** A `cbus/write/<net>///gettree` was sending TREEXML twice — once directly from the command router and once via the tracked HA Discovery path — so C-Gate returned two tree responses. The second was misattributed to an `unknown` network, duplicating every entity (e.g. `cgateweb_unknown_56_115` alongside `cgateweb_254_56_115`). The router now issues exactly one tracked TREEXML, and any unattributable tree response is dropped instead of published.
- Docs typo: the tree control topic is `cbus/write/<net>///gettree`, not `tree` (README, CLAUDE.md).

## [1.15.9] - 2026-07-11

### Fixed

- **Distribution publish no longer skips when the optional C-Gate upload integration job is skipped.** The deploy job now uses `always()` plus explicit success checks on required gates (GitHub Actions otherwise skips deploy whenever any upstream job was skipped).

## [1.15.8] - 2026-07-11

### Fixed

- **aarch64 add-on image builds no longer crash during `npm ci` under QEMU.** Production deps are installed on the build-host arch (pure JS/WASM) via BuildKit `BUILDPLATFORM`, then copied into the target image.
- ESLint unused-variable warning in webServer tests that blocked the distribution test job (and therefore skipped C-Gate integration).

### Changed

- CI/distribution add-on image builds use Docker Buildx with explicit target platforms.

## [1.15.7] - 2026-07-11

### Fixed

- **armv7 add-on images build again.** Alpine 3.19 has no OpenJDK 17 package on armv7; the Dockerfile now falls back to OpenJDK 8 on arches that lack OpenJDK 17 so distribution can publish (unblocking the failed 1.15.6 ship).
- **Sensitive web reads and SSE require the same auth as mutations** (`/api/labels`, status, dashboard, areas, export, event stream). `/healthz` and `/readyz` stay public. Ingress URL is no longer logged at startup.
- Uploaded C-Gate zips without `cgate_download_sha256` now log the same integrity-skip warning as the download path.

### Changed

- Distribution publish runs only from `v*` tags (not arbitrary `workflow_dispatch` refs) and uses workflow concurrency to avoid overlapping deploys.
- Pool reconnect backoff honours `reconnectinitialdelay` / `reconnectmaxdelay`. New tunables: `initDebounceMs`, `webSseKeepaliveMs`, `eventLogMaxEntries`, `mqttPendingPublishMaxEntries`.
- Runtime warns when `mqttRejectUnauthorized` is false (MITM risk). Operator docs cover MQTT broker ACL requirements.
- Internal: HaDiscovery tree/publishers split into modules; addon option mapping is table-driven. No intentional behaviour change from those refactors.

### Tests

- ThrottledQueue priority/gating/onDrop coverage and bridge command-queue pool gating tests.

## [1.15.6] - 2026-07-11

### Fixed

- **Web mutation auth no longer trusts a spoofed `X-Ingress-Path` on the direct port.** Ingress requests must match the configured ingress path and include `X-Hass-Source: core.ingress`. Host port 8080 is no longer mapped by default (ingress still works); set `web_api_key` if you re-expose the port.
- **PUT `/api/labels` now strips prototype-polluting keys** the same way PATCH already did.
- **Network auto-discovery skips the project-level `tree` probe** when `getall_networks` / `ha_discovery_networks` are already configured, avoiding the recurring C-Gate 402 on typical HA installs. Residual 402 responses log at debug.
- **Startup no longer WARNs about MQTT publish queueing before the first connect.** Mid-session disconnects still warn. Retained publishes continue to queue and replay.
- **MQTT authentication failure no longer restart-loops the Home Assistant add-on.** Standalone still exits fatally; add-on mode stays alive, throttles the banner, and retries.
- **Unsafe C-Gate project names and LOGIN credentials are rejected** so newlines/spaces cannot inject extra commands on the C-Gate socket.
- **Failed C-Gate command sends publish a warning** on `hello/cgateweb/warnings` instead of failing silently.
- **Stale TreeXML parse callbacks are ignored** after a newer request for the same network, and overlapping TREEXML requests are deduped across session and parse windows.

### Changed

- Concurrent SSE event-stream connections are capped (default 32) to limit DoS on an exposed web port.
- Distribution releases now require multi-arch add-on image builds and C-Gate integration tests (plus schema/i18n validation and typecheck) before publishing.

## [1.15.5] - 2026-07-10

### Added

- **New auto-type discovery options are now configurable from the add-on UI.** `ha_discovery_auto_type`, `ha_discovery_auto_type_name_heuristics`, and `ha_discovery_auto_type_cover_keywords` can be set directly in the add-on configuration (previously only reachable via a standalone settings file).
- **Multi-architecture images.** The add-on image is now built for `amd64`, `aarch64`, and `armv7`.
- Reconnect and timeout intervals that were previously hard-coded (MQTT reconnect/connect timeouts, C-Gate max reconnect attempts, cover ramp update interval) are now overridable settings.

### Fixed

- **Temperature Broadcast (application 25) readings are now published.** Decoded temperature events were parsed but never reached MQTT; they are now published to their dedicated reading topic.
- **Network auto-discovery now honours its documented default for standalone deployments.** A camelCase/snake_case mismatch (`autoDiscoverNetworks` vs `auto_discover_networks`) left auto-discovery silently disabled for `settings.js`-based installs; it now defaults to on, matching the add-on and the documentation.
- **Home Assistant discovery no longer leaks internal label state** when a discovery pass throws partway through, preventing stale data on the next run.
- **The web server reports a proper error** instead of a broken response when a static asset fails to stream.
- Corrected the Home Assistant add-on installation instructions in the README.

### Changed

- Removed the unimplemented `setvalue` MQTT command from the accepted command set (it had no defined behaviour).
- Hardened the release workflow so version-sync, add-on validation, static checks, and tests must pass before an image is published.
- Internal refactoring and additional CI guards (schema/translation parity, type checking) with no change to runtime behaviour.

## [1.15.4] - 2026-06-29

### Fixed

- **Hardened the synced-tree check against incomplete unit data.** A structured TREEXML `Application` entry that carried a group but no application address was wrongly counted as a real device (the network-management comparison treated a missing id as non-management), so discovery could accept a tree as synced while producing no entities. The check now requires a resolvable application id, matching the group-collection logic. (#16 follow-up)

## [1.15.3] - 2026-06-29

### Fixed

- **Light statuses now update in managed mode.** The managed-mode installer wrote `event-port=20025` into C-GateConfig.txt, which collides with C-Gate's `load-change-port` (also 20025) — the real-time status stream cgateweb reads on port 20025. C-Gate then served the wrong stream there, so status changes never reached Home Assistant and all entities stayed `Unknown`. The installer no longer sets `event-port` (C-Gate keeps its default 20024, leaving the status stream on 20025), and it strips any previously persisted `event-port=20025` so existing broken installs self-heal on the next start. (#21)
- **Discovery waits for C-Bus groups to finish syncing.** On networks that sync progressively, C-Gate briefly returns load units that advertise an application (e.g. lighting) but have no group bindings yet. Discovery treated that as synced, published 0 entities, and stopped retrying before the groups arrived, so devices never appeared without a manual tree refresh. A unit now counts as a real device only when it carries group addresses on a non-management application; an all-empty tree is treated as still-syncing and retried until the groups appear. (#16)

## [1.15.2] - 2026-06-28

### Fixed

- **Discovery now explains a zero-entity result instead of failing silently.** When C-Gate returns a fully-synced network tree whose units carry no group addresses (empty `<Groups>`) and no labels file supplies them, discovery has nothing addressable to expose and previously logged a quiet "Published 0 entities" that looked like success. It now logs a warning naming the cause and the remedy (import your C-Bus Toolkit project labels via the web UI so the group addresses are known). (#16)

## [1.15.1] - 2026-06-28

### Fixed

- **HA Discovery now works on C-Gate 3.7.1.** The TreeXML request was sent with a bare network number (`TREEXML 254`), which C-Gate 3.3.2 tolerated but C-Gate 3.7.1 rejects with `401 Bad object or device ID`. Discovery therefore never received a device tree and no entities appeared. The request is now project-qualified (`TREEXML //<project>/254`), the same addressing every other C-Gate command already uses; this also works on 3.3.2, so it applies unconditionally. (#23)

## [1.15.0] - 2026-06-28

### Added

- **You can now upgrade the managed C-Gate version without losing your project.** Previously, once C-Gate was installed it stayed on the add-on's persistent storage forever — the installer only refreshed config and never replaced the binary, so there was no way to move off the bundled 3.3.2 (a user with a 3.7.1-format project DB ended up with an empty tree and no entities, because 3.3.2 cannot read it). Two upgrade paths are now available in managed mode: turn on the new **Force C-Gate Reinstall** (`cgate_force_reinstall`) option to reinstall from the configured source on the next start, or — in upload mode — simply drop a newer C-Gate `.zip` into `/share/cgate/` and it is detected and installed automatically. Your project databases (`Projects/`) and C-Gate config are preserved across the reinstall. (#16)

## [1.14.9] - 2026-06-21

### Fixed

- **Native HVAC thermostats and CNI connectivity sensors no longer vanish after a tree refresh.** Native Air Conditioning (172) climate entities and CNI connectivity binary_sensors are published event-driven (when a thermostat broadcast or interface-state event arrives), but they share the `cgateweb_{network}_` unique-id prefix with TREEXML-discovered entities. The per-network stale-topic cleanup that runs after each TreeXML discovery treated them as stale and cleared them, since they are never part of a tree run. On networks that re-scan the tree at startup (now more common with the 1.14.8 sync-retry), thermostats would disappear on reboot. Event-driven discovery topics are now tracked separately and excluded from the tree cleanup.

### Changed

- **Clarified the "Air Conditioning Control" setting description.** It now states that thermostats still appear as read-only climate entities without it; enabling it only adds set mode/temperature commands (which write to live heating/cooling and add C-Bus traffic). This setting is not required for thermostats to be visible in Home Assistant.

## [1.14.8] - 2026-06-21

### Fixed

- **HA Discovery no longer completes with zero entities while the network is still syncing.** At startup C-Gate briefly returns a network tree containing only its interface/management unit (the CNI, on C-Bus application 255 with no groups) before the load units finish syncing. The empty-tree retry added in 1.14.4 only caught a completely empty tree, so this management-only tree was accepted as a (zero-device) success: discovery published 0 entities and stopped retrying, and the real devices that synced moments later never appeared until a manual `gettree`. A tree carrying only network-management units is now treated as "still syncing" and retried with backoff until the load units arrive. (#17)

## [1.14.7] - 2026-06-17

### Fixed

- **Clear error message for unsupported label-import files instead of a cryptic XML parse error.** Selecting a non-project file (e.g. a genuine `.cbr` Comic Book RAR, which the Android-friendly file picker can offer) previously handed binary bytes to the XML parser and produced a baffling "Non-whitespace before first tag" error. The importer now detects the format by content and rejects anything that isn't a `.cbz`, `.xml`, or `.db` with an actionable message telling you to export the project as one of those. A `.cbz` that was misnamed (e.g. gained a `.cbr` suffix in transfer) still imports, since detection is content-based, not extension-based.

## [1.14.6] - 2026-06-17

### Fixed

- **Label import file picker now works in the Home Assistant Android app.** The import file input restricted selection to `.cbz`/`.xml`, which Android's picker greyed out (those extensions have no reliable MIME mapping on Android), so the file couldn't be selected. The picker now accepts the project file (incl. `.db`) on mobile; the server still validates the actual content.

## [1.14.5] - 2026-06-17

### Fixed

- **CBZ import now works with C-Bus Toolkit 1.17.x.** Newer Toolkit exports a `.cbz` containing a **SQLite project database** (a `.db`), not XML — so the importer kept reporting "no XML file". The label importer now reads a SQLite project database directly (inside a `.cbz`, or as a bare `.db`), reconstructing the network/app/group names from the database. Older XML/`.cbz` exports continue to work unchanged.

## [1.14.4] - 2026-06-17

### Fixed

- **HA Discovery now finds your devices on startup, not only after a manual refresh.** When a C-Bus network had not finished syncing its units yet, C-Gate returned an empty tree and cgateweb accepted it as a (zero-device) success, so no entities appeared until you published to a `gettree` topic. An empty tree is now treated as "network still syncing" and retried with backoff until the populated tree arrives. (#16)
- **No more phantom `unknown` network.** Duplicate TreeXML requests for the same network (the initial scan plus the "network created" event) caused a second response to be misattributed to an `unknown` network, publishing a stray tree topic and discovery sensor. Duplicate in-flight requests are now suppressed.

## [1.14.3] - 2026-06-16

### Fixed

- **Managed mode now actually loads your C-Gate project.** Project database files were being synced into C-Gate's `tag/` directory, but C-Gate 3.x loads projects from `Projects/<NAME>/<NAME>.db`. Managed C-Gate therefore started with **no project loaded** — every command returned `401 Bad object or device ID` and Home Assistant Discovery found nothing. cgateweb now places `<NAME>.db` in `Projects/<NAME>/` and sets `project.start` so C-Gate auto-loads and starts the project on boot. (#16)
- **Project configuration is reapplied on every start.** Previously the project name / port settings were only written during a *fresh* C-Gate install, so existing and upgrading managed installs never received them. The configuration step now runs on every container start (the C-Gate download/extract is still skipped when already installed).

### Internal

- **End-to-end managed-mode test verifies the project loads.** The integration test now talks to C-Gate's command port and asserts the project reaches `state=started` with its database parsed (App 56 Lighting), so a "project not loaded" regression fails CI instead of silently soft-passing. A sample project fixture is committed for the test. Live entity-discovery assertions require real C-Bus hardware (`CGATEWEB_E2E_EXPECT_LIVE=1`); simulating a CNI for full discovery in CI is tracked as future work.

## [1.14.2] - 2026-06-16

### Fixed

- **Thermostat card temperature range matches the hardware.** The HVAC climate card (and the control clamp) is now bounded to 10–32 °C instead of 0–50, so Home Assistant no longer lets you request a value the thermostat silently rejects.
- **Thermostat cards update instantly.** When you change mode/temperature from HA, cgateweb now reflects the new state immediately instead of waiting for the thermostat's next broadcast.
- **Mirrored controller can be hidden.** A PAC/controller that re-broadcasts a ward (showing up as a duplicate climate card) can now be removed by adding its unit to the label exclude list — its entity is cleared from HA.
- **Lights named like covers stay lights.** A group such as "Garage Door Lamps" is no longer auto-classified as a cover when its label also names a light.
- **CBZ import works with newer C-Bus Toolkit exports.** Archives from Toolkit 1.17.6 (e.g. an uppercase `.XML` entry) now import; the project XML is matched case-insensitively and content-sniffed as a fallback.
- **No more spurious aircon parse warnings** for unconsumed Air Conditioning lines.

## [1.14.1] - 2026-06-15

### Fixed

- **Clearer message when cgateweb can't reach C-Gate.** A connection that never establishes now logs *what to check* — host/port reachability, the C-Gate machine's firewall, and C-Gate's `access.txt` — instead of a bare "socket timed out", making setup problems far easier to diagnose.
- **HVAC setpoint no longer lost when a thermostat turns off.** Native C-Bus thermostats broadcast a sentinel setpoint of 0 on "off"; cgateweb now keeps the last active target instead of reporting 0°C.
- **Air Conditioning control toggle reads correctly in standalone mode.** `cbus_aircon_control_enabled` supplied as a string (e.g. a hand-edited `settings.js`) is now coerced properly.
- **Status-page event table escapes labels and addresses.** Values in the live events table are HTML-escaped so label text can't be interpreted as markup (XSS hardening).
- **Secrets are kept out of logs.** Any password/token/secret-keyed value passed to the logger is replaced with `[REDACTED]` before output, as defence in depth.
- **Faster failover signalling.** When the last command connection drops, the pool is reported unhealthy immediately rather than waiting up to 30s for the next health check.

### Internal

- Extracted the HVAC temperature encoding into a shared helper, logged previously-swallowed errors, and stopped the network auto-discovery timer from delaying shutdown.
- Hardened CI: the production add-on image is now built on every PR, `config.yaml` upgrade-safety and 17-language translation parity are validated, workflows/shell/Dockerfiles are linted, `GITHUB_TOKEN` is scoped read-only, and Dependabot is enabled. Added tests for the connection pool, the HA notifier error paths, and the config/translation validators. Minimum Node bumped to 20.

## [1.14.0] - 2026-06-14

### Added

- **Control your C-Bus thermostats from Home Assistant.** Building on the read-only HVAC support, you can now set the **mode and target temperature** of native C-Bus Air Conditioning thermostats directly from the Home Assistant climate card. It's **opt-in** via the new **Air Conditioning Control** option (`cbus_aircon_control_enabled`, off by default) because it writes to live heating/cooling. When enabled, cgateweb sends the native C-Gate `AIRCON` commands, targeting each thermostat correctly even when several share a zone group. No touchscreen, Wiser, or extra hardware required.

### Internal

- Hardened the add-on startup scripts with shell strict mode and refactored the HA-discovery lighting path for clarity (no functional change).

## [1.13.1] - 2026-06-13

### Added

- **C-Bus network connectivity binary sensor.** Each monitored C-Bus network now also exposes a Home Assistant `binary_sensor` (device class *connectivity*) reflecting its CNI/PCI link — so you can alert or automate on a network going offline, not just read it on the status page.
- **Optional offline notification.** New `cni_offline_notification` setting (off by default): when enabled, cgateweb raises a Home Assistant persistent notification if a network's CNI/PCI link goes offline and dismisses it when the link recovers.

## [1.13.0] - 2026-06-13

### Added

- **C-Bus network / CNI connectivity on the status page.** cgateweb now detects when the CNI (or PCI) link between C-Gate and the C-Bus network drops — an outage that was previously invisible because C-Gate keeps its connection to cgateweb up the whole time. It polls each network's interface state (read-only) and shows a **"C-Bus Networks (CNI)"** indicator on the status page (highlighted when a link is down), and logs a warning on dropout and an info message on recovery. Poll interval is configurable via `cniMonitorIntervalMs` (default 30s; set to 0 to disable).

## [1.12.1] - 2026-06-13

### Fixed

- **Air Conditioning option now translated in every language.** The `cbus_aircon_app_id` setting (added in 1.11.0) was only present in English, so non-English users saw an untranslated label. Added translations for all 16 other supported languages.
- **Hardened the label edit API.** `PATCH /api/labels` now skips prototype-polluting keys (`__proto__`/`constructor`/`prototype`) from request bodies as defence in depth.

### Changed

- **Web UI timeouts are now tunable.** Three previously-hardcoded web-server values are configurable settings (defaults unchanged): the diagnostics "active device" window (`web_active_device_window_ms`), the HA areas cache TTL (`web_ha_areas_cache_ttl_ms`), and the HA Supervisor API timeout (`web_ha_api_timeout_ms`).

## [1.12.0] - 2026-06-13

### Added

- **Air Conditioning (172): thermostats now appear automatically in Home Assistant.** When the native Air Conditioning feature is enabled (`cbus_aircon_app_id`) and HA Discovery is on, cgateweb now publishes a Home Assistant **climate** entity for each thermostat the first time it is seen on the bus (event-driven, keyed by the thermostat's source unit). The entity shows current temperature, target setpoint, operating mode (`off`/`heat`/`cool`/`auto`/`fan_only`), and the live running action (`heating`/`cooling`/`fan`/`idle`). Custom names from the label file are used (key `{network}/172/{sourceUnit}`).

### Notes

- This first release is **read-only** — the thermostat card displays state but does not yet send control commands. Write control (set mode/setpoint from HA) is a deliberate next step pending verification of the native app-172 command format against hardware.

## [1.11.4] - 2026-06-13

### Fixed

- **Air Conditioning (172): no bogus setpoint in Fan Only mode.** In Fan Only mode the thermostat reports the `0x7F00` (32512) "no setpoint" sentinel; cgateweb was decoding this as a spurious 127 °C target. The setpoint is now correctly omitted when outside the plausible range (>0 °C and ≤50 °C). Only affects the opt-in `cbus_aircon_app_id` feature.

### Added

- **Air Conditioning (172): live running action (`hvac_action`).** cgateweb now decodes the `zone_hvac_plant_status` broadcast and publishes the plant's current activity to `cbus/read/{network}/172/{sourceUnit}/action` (`heating`/`cooling`/`fan`/`idle`) — suitable for a Home Assistant climate entity's `hvac_action`.
- **Verified HVAC mode codes.** The `cool` (2), `auto`/heat-cool (3) and `fan_only` (4) operating modes — previously best-effort — are now confirmed against real thermostat captures (Clipsal 5070THP / 5070THB).

## [1.11.3] - 2026-06-10

### Added

- **Air Conditioning (172): mode, setpoint, and multiple thermostats.** Building on 1.11.x's temperature reading, cgateweb now also decodes the operating **mode** (`off`/`heat` verified; `cool`/`auto`/`fan_only` best-effort pending hardware confirmation), the target **setpoint** (°C = raw/256), and the zone-group on/off **state** from the C-Bus Air Conditioning application. Multiple thermostats on the same network/application are now supported: topics are keyed by the thermostat's **source unit** so two units sharing a zone group no longer collide.

### Changed

- **Air Conditioning read topics are now keyed by source unit, not zone group.** Temperature now publishes to `cbus/read/{network}/172/{sourceUnit}/current_temperature` (plus `/setpoint`, `/mode`, `/state`). This corrects multi-thermostat collisions. Only affects the opt-in `cbus_aircon_app_id` feature introduced in 1.11.0.

## [1.11.1] - 2026-06-06

### Fixed

- **Restore add-on distribution for the 1.11.0 Air Conditioning feature.** The 1.11.0 tag failed its distribution build on a strict-equality (`eqeqeq`) lint warning in the new Air Conditioning decoder, so the add-on never updated. Corrected the comparison; the native Air Conditioning (172) temperature feature from 1.11.0 ships in 1.11.1.

## [1.11.0] - 2026-06-06

### Added

- **Native C-Bus Air Conditioning (172) room temperature.** cgateweb now decodes the C-Bus Air Conditioning application's `zone_temperature` broadcasts (encoding °C = raw/256) and publishes the reading to `cbus/read/{network}/172/{zoneGroup}/current_temperature`. Enable by setting `cbus_aircon_app_id` to your Air Conditioning app id (typically `172`); it is off by default. This is read-only temperature for now — HVAC mode and setpoint are not yet decoded. Note this is the *real* C-Bus Air Conditioning application, distinct from the lighting-bridge "HVAC-via-lighting" pattern used by `ha_discovery_hvac_app_id`.

### Fixed

- **Add-on docs incorrectly cited C-Bus application `201` as the HVAC app.** Application 201 does not exist in standard C-Bus; the real Air Conditioning application is `172`. Documentation corrected.

## [1.10.1] - 2026-05-31

### Fixed

- **Cover "stop" button did nothing.** Home Assistant's MQTT cover platform has no dedicated stop topic — it publishes `payload_stop` ("STOP") to the cover's command (`switch`) topic, not the `stop` topic cgateweb advertised in discovery. The bridge previously treated `STOP` as an invalid switch payload and silently dropped it, so blinds would open/close but never stop mid-travel. `STOP` on the switch topic is now routed to the cover-stop handler (`TERMINATERAMP`), which also cancels any in-progress interpolated position ramp.

## [1.10.0] - 2026-05-30

### Added

- **Automatic cover detection.** Groups on the Lighting application (56) whose label contains a cover keyword (`blind`, `shutter`, `shade`, `awning`, `curtain`, `roller`, `garage door`) are now discovered as Home Assistant `cover` entities instead of `light`. This fixes the common case where shutter relays share the lighting application with real lights and previously all appeared as lights. Classification is conservative and label-only: a manual `type_overrides` entry and application-id mappings always take precedence; auto-detection only ever upgrades the default `light`. Configurable via `ha_discovery_auto_type` (default on), `ha_discovery_auto_type_name_heuristics`, and `ha_discovery_auto_type_cover_keywords`.

### Fixed

- **`.cbz` import "Failed Unauthorised" through HA Ingress.** The web UI import endpoint now trusts requests proxied through Home Assistant Ingress when no API key is configured, so importing a C-Bus project from the add-on UI works out of the box. A configured `web_api_key` is still always enforced, and direct (non-ingress) requests remain blocked unless explicitly allowed.
- **HVAC type overrides produced a broken thermostat.** Reclassifying a lighting group to `hvac` via `type_overrides` now publishes a full climate payload (temperature/mode topics) instead of a generic payload missing the thermostat controls.

## [1.9.4] - 2026-05-27

### Security

- **API key comparison is now constant-time** (`crypto.timingSafeEqual`). Removes the timing oracle the previous `===` comparison exposed.
- **`.cbz` import is guarded against zip-bombs**. The parser pre-flights the sum of declared decompressed sizes for every ZIP entry against a 100MB cap (overridable via constructor) before extracting anything, so a small upload cannot blow up RAM. Defence-in-depth path-traversal guard on internal entry names extracted alongside.
- **HTTP security headers** added on every response: `Content-Security-Policy` (locks resource loading to same-origin, killing the common third-party-script XSS payload pattern without breaking the bundled inline UI) and `Referrer-Policy: no-referrer` (prevents leaking the HA Ingress-tokenised URL to any external resource).
- **Managed-mode install pre-flights ZIP entry names** for path-traversal (`..`) or absolute paths via a new `_cgateweb_verify_zip_safe` helper in `cgate-install.sh`. Runs before each `unzip` call. Modern unzip already strips these but the explicit guard makes any future tooling regression visible.

### Mobile / Responsive

- **Web UI is now responsive across all common viewport sizes** for both direct LAN access and HA Companion App (iframe-embedded via HA Ingress). Previously had zero `@media` breakpoints. Includes:
  - `viewport-fit=cover` + `env(safe-area-inset-*)` padding for notched phones.
  - `font-size: 16px` on all form inputs - eliminates the iOS auto-zoom-on-focus behaviour that previously fired every time a user tapped a label.
  - Touch targets enlarged on touch-primary devices (row checkboxes 22×22, buttons min-height 44px) per WCAG 2.5.5 / iOS HIG. Desktop mouse users keep the compact layout.
  - `<= 768px`: main labels table becomes horizontally scrollable; Entity ID and "unsaved" columns hide; tab bar tightens; toast spans full width.
  - `<= 480px`: Type column also hides; add-row and bulk toolbar stack vertically; header collapses; status bar single-column.
  - Area dropdown is constrained to viewport width on narrow screens so it can't shoot off the right edge.

## [1.9.3] - 2026-05-27

### Fixed

- **Editing labels (or areas / type overrides / entity IDs / exclusions) via the Web UI did not update Home Assistant device names**. `LabelLoader.save()` wrote the file and updated internal state but never emitted `labels-changed` directly. The only emit site was the `fs.watch` callback, which is gated by a 1000ms self-write grace period to prevent double-processing - so for in-process saves (PUT/PATCH `/api/labels`, POST `/api/labels/import`), the event was silently suppressed. The downstream listener that re-triggers HA Discovery therefore never fired, and HA never saw the updated entity configs.
  - `save()` now emits `labels-changed` directly with the full `getLabelData()` payload (labels, areas, typeOverrides, entityIds, exclude). The file-watcher path still correctly suppresses the resulting fs event within the grace window, so there's no double-fire.
  - The same fix automatically covers areas, type overrides, entity IDs, and the exclude list - all flow through the single `save()` codepath.

## [1.9.2] - 2026-05-26

### Changed

- **Log noise reduction**: demoted two high-volume INFO log lines to DEBUG. Both fire per-event and dominated production log volume (~45% of lines in a typical sampled window). Real startup/shutdown/state-transition messages stay at INFO so they remain easy to spot; users who need the per-command trace can set `log_level: debug` in the add-on config.
  - `MqttCommandRouter` "MQTT Recv: ..." (every received MQTT write/switch/ramp command)
  - `BridgeInitializationService` "Getting all periodic values for ..." (every periodic getall poll fire)

## [1.9.1] - 2026-05-24

### Performance

- **Managed-mode JVM tuned for the small-heap, low-throughput control-plane workload**. Adds `-XX:+UseSerialGC` (Serial GC's overhead is ~30-50MB lower than the default G1 for a 64-256MB heap), `-XX:TieredStopAtLevel=1` (skip the C2 server JIT - C-Gate is not throughput-critical and tier-1 C1 is faster to warm up), and `-Djava.net.preferIPv4Stack=true` (eliminate unused IPv6 DNS roundtrips during socket setup). Expected impact on Pi/NAS managed-mode deploys: ~30-50MB lower JVM RSS plus ~2-5s faster cold start. Remote-mode users are unaffected.
- **Node.js V8 heap capped at 256MB via `--max-old-space-size=256`**. Node defaults to a fraction of host memory (often 1.5-4GB on shared HA hardware), which means a runaway leak or unbounded cache only OOMs after starving other addons. 256MB sits ~2-3x above the observed ~100-110MB steady-state RSS and makes worst-case behaviour predictable (clean process OOM and s6 restart vs slow host degradation).
- **Web server start deferred past the readiness signal**. The label-editing web UI was on the await chain before `connectionManager.start()`, adding measurable latency to the startup-to-ready window. The web server now starts in the background after readiness fires; failure still logs a warning but never blocks the bridge.
- **HA Discovery and auto-network-discovery deferred off the readiness path**. Previously `lifecycle_state=ready` published only after the post-connect work (including a potentially 5s auto-discovery wait for the tree response) finished. Now readiness publishes as soon as connection health is confirmed; auto-discovery / initial getall / HA Discovery TreeXML sweep run in the background. Users with the default `autoDiscoverNetworks=true` see up to 5s less ready-signal latency.
- **`DeviceStateManager` device-level / last-seen maps now bounded** (`deviceStateMaxEntries`, default 5000, floor 100) with FIFO-on-insert eviction. Matches the existing pattern used by `eventPublisher._topicCache`. Defense-in-depth against long-uptime growth; no behaviour change for any realistic install.

### Build / Image

- **Multi-stage Dockerfile** drops `npm` from the runtime image (~50-80MB saved). The builder stage installs npm, runs `npm ci`, cleans the cache; the runtime stage only carries `nodejs + openjdk17 + curl + unzip + netcat-openbsd` plus the resolved `node_modules`.
- **`.dockerignore` at the repo root** excludes `.git/`, `tests/`, `test-env/`, `coverage/`, `tools/`, IDE state, and the host's `node_modules` (which can contain platform-incompatible native binaries) from the build context.

### CI

- **`package.json` / `config.yaml` version drift now gates the build** via a new `version-sync` CI job. Previously documented in CLAUDE.md as a manual step that had caused stale deploys.
- **GitHub Actions pinned to commit SHAs** for `actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, and `softprops/action-gh-release`. Pin updates become explicit changes instead of silent absorption of upstream tag movements.
- **HACS deploy token moved out of the rendered `git clone` URL** in `hacs-distribution.yml` (now passed via `env:`).
- **`HEALTHCHECK` added to the addon Dockerfile**: TCP probe on port 8080 with a 180s start-period (covers managed-mode first-boot C-Gate download).
- **Integration test now passes end-to-end and is no longer masked by `continue-on-error`**. Switched from `podman compose` (which delegated to a daemon-socket-requiring docker-compose plugin on Linux) to `podman-compose` (the Python wrapper that was already pip-installed in the workflow), then softened four project-dependent assertions that the previous flaky-mask had hidden so the no-project test fixture passes cleanly.

### Fixed

- **`perf/raw.json` no longer tracked** (regenerated benchmark output causing constant 190-line / 190-line diff churn in every working tree).

### Tests

- Closed three real coverage gaps surfaced by an audit: cgateConnectionPool end-to-end cascade-exhaustion, web-server OPTIONS-preflight rejection from a disallowed origin, web-server GET traffic exemption from the mutation rate limit.

## [1.9.0] - 2026-05-24

### Added
- **Tunable HA Discovery TreeXML retry settings**: four new keys in `settings.js` allow ops to tune the discovery startup-race retry budget without forking. `haDiscoveryMaxTreeRetryAttempts` (default 8), `haDiscoveryTreeRetryInitialDelayMs` (default 2000), `haDiscoveryTreeRetryMaxDelayMs` (default 60000), `haDiscoveryTreeRequestTimeoutMs` (default 8000). Defaults are unchanged from prior behaviour.
- **Tunable web UI body-size limit**: `webMaxBodySizeBytes` setting (default 10MB) controls the max accepted POST/PUT/PATCH body on the label-editing API. Useful for unusually large `.cbz` uploads on permissive deployments.

### Fixed
- **Stuck HA Discovery on malformed TreeXML**: when `parseString` failed (truncated payload, encoding glitch, C-Gate restart mid-stream), the discovery network previously sat in `DISCOVERING` state forever - no retry, no `PAUSED` transition, no diagnostic signal. The parse error now flows through the same retry-with-backoff mechanism as 401 Network not found, eventually transitioning to `PAUSED` after the retry budget is exhausted.

### Changed
- **Internal: `labelSnapshot` lifted to instance property in `HaDiscovery`**. Eliminates a positional parameter that was threaded through seven helper methods (23+ call sites). No external behaviour change.
- **Internal: exponential-backoff calculation extracted to `src/backoff.js`**. Replaces three subtly different inline formulas in `cgateConnectionPool.js`, `cgateConnection.js`, and `haDiscovery.js`. No behaviour change at the three call sites.

### Operations / CI
- **Added a CI gate that fails the build when `package.json` and `homeassistant-addon/config.yaml` versions disagree**. Previously documented as manual-and-error-prone in `CLAUDE.md`; now enforced.
- **GitHub Actions versions pinned to commit SHAs** for `actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, and `softprops/action-gh-release`. Pin updates become explicit code changes instead of silent absorption of upstream tag movements.
- **HACS deploy token moved out of the rendered git-clone URL** in `hacs-distribution.yml`, into the run step's `env:` block. Eliminates the risk of token leakage via verbose-mode logging.
- **`HEALTHCHECK` added to the addon Dockerfile**. TCP-probes the always-on cgateweb web UI port after a 180s start-period (allows for managed-mode first-boot C-Gate download). Mostly diagnostic under HA Supervisor, but useful for visibility.

## [1.8.10] - 2026-05-24

### Added
- **Managed mode project sync from `/share/cgate/tag/`**: a new `cont-init` script syncs pre-built C-Gate project database files into the managed C-Gate `tag/` directory on every container start. Place `<PROJECTNAME>.db` (built in C-Bus Toolkit or copied from another C-Gate install) into `/share/cgate/tag/`, restart the add-on, and managed C-Gate will serve the project so TreeXML / HA Discovery succeed. The sync is timestamp-aware (`source -nt dest`) so C-Gate state written between restarts is never clobbered by a stale share copy.
- **Web UI import response now flags itself as labels-only**: `POST /api/labels/import` returns `scope: "labels-only"` and a `notice` field explaining that the `.cbz`/`.xml` import does not load the C-Gate project itself, with a pointer to the managed-mode `.db` workflow. Avoids the trap where users assumed importing in the Web UI was sufficient to populate managed C-Gate (issue #9).

### Documentation
- New "Loading your C-Gate project in managed mode" section in `DOCS.md` explaining the `.db` sync workflow and why `.cbz` import alone is insufficient.

## [1.8.9] - 2026-05-09

### Added
- **MIT LICENSE bundled with the distribution repo**: the release workflow now copies the MIT license into both the `cgateweb-homeassistant` repo root and the add-on subfolder so the licensing terms are visible alongside the installable add-on (and so the repo passes OSI-license listing checks for awesome-home-assistant).

## [1.8.8] - 2026-05-07

### Fixed
- **Managed mode install failed with "Invalid download URL scheme: null"**: when running the add-on in managed mode without overriding `cgate_download_url`, the install script would log `Downloading C-Gate from: null` and abort. Root cause: `bashio::config 'cgate_download_url' ''` returns the literal string `"null"` for unset optional fields (upstream bashio's `${2:-null}` rewrites an empty default to `"null"`), so the script's `[[ -z … ]]` empty-check never fired and the hardcoded fallback URL was never applied. The install script now treats both empty and `"null"` as unset for `cgate_download_url` and `cgate_download_sha256`, and the URL/SHA resolution is extracted into helpers covered by unit tests.

## [1.8.7] - 2026-05-05

### Fixed
- **Startup-race silent publish drops**: HA Discovery configs and initial state values published before the MQTT broker was fully connected were silently dropped — `MqttManager.publish()` incremented a counter but never replayed the lost messages. Affected entities sat at `unavailable` in Home Assistant indefinitely (until C-Gate happened to emit a fresh event for that group while MQTT was up). `cgateweb`'s own startup path is the largest culprit: `cgateWebBridge.start()` calls `_updateBridgeReadiness('startup')` and `haBridgeDiagnostics.publishNow('startup')` before the broker connects, so ~38 retained publishes per restart go to /dev/null.
- `MqttManager` now keeps a bounded retain-aware queue of publishes attempted while disconnected. Map semantics give us newest-wins-per-topic so a stale `level=0` is correctly overwritten by a fresh `level=128` if both queue during the same disconnect window. The queue is bounded (default 1000 entries; configurable via `mqttPendingPublishMaxEntries`) and oldest entries are evicted with a warning if the broker stays unreachable. On (re)connect, the queue is flushed and the count is logged. Non-retained publishes (one-shot events whose meaning would be invalidated by replay) are still dropped — only retained state is queued.

## [1.8.6] - 2026-05-05

### Added
- **Network removed cleanup**: counterpart to the v1.8.5 "Network created" handler. When C-Gate signals that a network has been removed or deleted (async system event 742, "Network removed" / "Network deleted"), HA Discovery now publishes empty retained payloads to every previously-published entity config topic for that network — including the per-network discovery diagnostic sensor itself — so HA tears the entities down instead of leaving them sitting Offline forever. Any in-flight TREEXML retry for the removed network is canceled.

## [1.8.5] - 2026-05-04

### Added
- **Event-driven HA Discovery refresh**: when a network finishes loading in C-Gate (async system event 742, "Network created"), HA Discovery now refreshes the network's tree the moment it becomes available, instead of waiting for the v1.8.1 retry backoff to fire. This eliminates the discovery delay on cold starts where C-Gate initialises a few seconds after opening its TCP port. The retry remains as belt-and-braces.

### Changed
- **Command response parser hardening**: the parser now recognises C-Gate's timestamp-prefixed async event lines (e.g. `20260504-193110.569 742 //PROJECT/254 ... Network created ...`) by stripping the leading timestamp before parsing. The parser also pins response codes to positions 0-2 of the line, eliminating mis-parses caused by hyphens elsewhere in the payload (UUIDs, etc.). Validity range expanded from 1xx-6xx to 1xx-9xx so 7xx/8xx async events route correctly. Behaviour for canonical lines like `200-OK` is unchanged.

## [1.8.4] - 2026-05-04

### Added
- **Per-network discovery health sensor**: HA Discovery now publishes a "Discovery (Network N)" diagnostic sensor for each configured network, with three states — `discovering` (request in flight or retry pending), `ok` (last TreeXML succeeded), or `paused` (retry budget exhausted from the v1.8.1 startup-race protection). The sensor lives under the existing cgateweb Bridge device in HA, so users can see at a glance whether auto-discovery is healthy without trawling the add-on logs. State publishes are de-duplicated; the HA Discovery config payload is published once per network.

## [1.8.3] - 2026-05-04

### Refactor
- **HA Discovery retry state**: collapsed the parallel `_treeWatchdogs` and `_treeRetryState` Maps in `HaDiscovery` into a single `_treeRequestState` Map (`networkId -> { attempts, watchdogHandle, retryHandle }`), eliminating duplicate lookups, an awkward `keepAttempts` boolean parameter, and three near-duplicate cleanup helpers. Behaviour is unchanged.
- Removed unnecessary `typeof === 'function'` guards around `haDiscovery.handleCommandError` and `haDiscovery.stop` calls in `BridgeInitializationService`; the methods are part of the class contract and the bridge holds a locally constructed instance.

## [1.8.2] - 2026-05-04

### Fixed
- **C-Gate config keys**: `cgate-install.sh` was writing `CommandInterface.port` and `EventInterface.port` into `C-GateConfig.txt`, but C-Gate uses `command-port` and `event-port`. C-Gate logged "Invalid key" warnings on every startup and any user-customized ports were silently dropped, so the addon kept using C-Gate defaults regardless of the configured `cgate_port` / `cgate_event_port` values. The script now writes the correct keys, anchors its grep checks with `^…=` so comment headers in `C-GateConfig.txt` don't produce false-positive matches, and strips any legacy invalid keys left over from earlier installs.

## [1.8.1] - 2026-05-04

### Fixed
- **HA Discovery startup race**: C-Gate accepts TCP connections on the command port before its project's networks are loaded, so the initial `TREEXML` query could return `401 Network not found` and HA Discovery would silently give up — devices never appeared in Home Assistant even though events flowed normally. `HaDiscovery` now retries failed TreeXML requests with exponential backoff (2s → 60s, up to 8 attempts), driven both by the `401 Network not found` fast-fail and an 8s no-response watchdog. After the retry limit, a clear warning explains how to recover via `cbus/write/<network>///gettree`.

## [1.8.0] - 2026-04-29

### Changed
- **MQTT pre-connect log noise**: when the bridge starts before the MQTT broker is reachable, `MqttManager` now warns once per disconnect window instead of per-publish. On reconnect, a single rolled-up info line reports how many publishes were dropped while disconnected. Eliminates ~17 startup warnings per restart and bounds spam if the broker stays unreachable.
- **Network auto-discovery fallback**: when `tree //PROJECT` returns a 4xx/5xx (e.g. C-Gate 402 "Operation not supported"), the discovery handler now claims the response so the default error logger does not also fire, and the discovery messages are demoted from WARN/ERROR to INFO since the fallback to configured `getall_networks` is the expected path on C-Gate versions that do not support project-level tree queries.

### Refactor
- Extracted entity-id field construction (`default_entity_id` + `object_id`) into a shared `entityIdFields(component, objectId)` helper in `src/constants.js` and replaced six inline callsites across `haDiscovery`, `haBridgeDiagnostics`, and `staleDeviceDetector`.
- Replaced raw `'sensor'`, `'binary_sensor'`, and `'cgateweb_bridge'` string literals with `HA_COMPONENT_SENSOR`, `HA_COMPONENT_BINARY_SENSOR`, and `HA_DEVICE_VIA` constants for consistency with the rest of the HA discovery code.

## [1.7.2] - 2026-04-19

### Fixed
- **Fresh-install Import failure**: the add-on now falls back to `/config/cgateweb-labels.json` when no `cbus_label_file` option is set and no label file exists at auto-detect paths. Previously, importing a Clipsal project file on a fresh install failed with "No label file path configured". Dropped `/share/cgate/labels.json` from auto-detect since `/share` is mounted read-only.
- **Standalone Import error message**: when the label file path really is unset (standalone mode), the Import endpoint now returns a 400 with an actionable message pointing at `cbus_label_file` instead of a generic failure.
- **Doubled toast prefix**: removed the server-side "Import failed: " prefix that was duplicating the client-side prefix in error toasts.

## [1.7.1] - 2026-04-14

### Fixed
- **Backwards compatibility**: retain `object_id` alongside `default_entity_id` in MQTT discovery payloads so Home Assistant versions prior to 2025.10 continue to work. Unknown keys are silently ignored by both old and new HA versions.

## [1.7.0] - 2026-04-14

### Fixed
- **HA 2026.4 compatibility**: Home Assistant 2026.4 removed support for the deprecated `object_id` field in MQTT discovery. Replaced with `default_entity_id` (which includes the domain prefix, e.g. `light.kitchen_light`) across `haDiscovery`, `haBridgeDiagnostics`, and `staleDeviceDetector`.

## [1.6.1] - 2026-04-05

### Fixed
- **Area picker**: fetch areas via HA template API (registry endpoint removed in HA 2026.x); dropdown now shows full area names without icons
- **Save toast**: show actual label count instead of "undefined"
- **Tab bar scrollbar**: removed spurious scrollbar on tab bar

## [1.6.0] - 2026-04-05

### Changed
- **Tabbed web interface**: replaced collapsible sections with tabs — Status, Device Labels, Live Events, Import/Export. State is preserved between tab switches.

### Fixed
- **Live Events accordion**: was not toggling due to double click handler conflict
- **Area column width**: widened to prevent text truncation

### Security
- **Managed C-Gate hardening**: HTTPS-only download URLs, curl timeouts, 500MB file size cap, symlink rejection, file permission hardening, Java memory limits

### Improved
- **CI modernization**: GitHub Actions updated to v5/v7, test matrix Node 20+22, no deprecation warnings
- **Test coverage**: 1153 tests, 92.7% coverage — added tests for address validation, signal handlers, event filtering, tab interface

## [1.5.5] - 2026-04-04

### Improved
- **Translation refinements**: improved translations for Czech, Danish, Norwegian, Polish, Swedish, and Ukrainian

## [1.5.4] - 2026-04-04

### Added
- **Complete translations**: all 16 non-English translation files updated to match the full en.yaml configuration schema (previously missing 20+ fields added in recent releases)
- **Test coverage**: new tests for bridge diagnostics consolidated stats, line processor buffer cap, connection pool recovery via `connectionAdded`, ConfigLoader unknown settings key warning, web API dashboard/areas endpoints, CORS enforcement, and security headers

## [1.5.3] - 2026-04-04

### Security
- **CORS origin leak**: disallowed origins no longer receive an `Access-Control-Allow-Origin` header; previously fell back to the first allowed origin, enabling cross-site API access from any website
- **Rate limit bypass**: rate limiting now uses the TCP socket address instead of the spoofable `X-Forwarded-For` header
- **MIME sniffing**: added `X-Content-Type-Options: nosniff` header to all responses

### Fixed
- **Searchable area dropdown**: area field in the label editor is now a searchable dropdown showing existing areas from Home Assistant and the label file, preventing duplicate/inconsistent area names
- **HA area registry API**: use POST (not GET) for the Supervisor area registry endpoint; add 30-second cache to avoid repeated API calls
- **Area dropdown UX**: prevent double-commit on click/Tab/Escape; allow ArrowUp to deselect; fix `API_BASE` variable reference
- **MQTT reconnection**: clear `_connecting` flag on connection close so the bridge can reconnect after a failed initial connection attempt
- **Cover state**: handle null `rawLevel` on plain `on` action (without level) by falling back to the action, matching the lighting path
- **HVAC mode**: revert `rawLevel===0` off detection — C-Bus level 0 maps to 0°C setpoint, not an off state; only the explicit `off` action sets mode to off
- **730 event parsing**: search for ` level=` (space-prefixed) to avoid matching inside other key names
- **Tree message buffer**: cap at 500 entries to prevent unbounded growth when HA Discovery is disabled

### Changed
- Performance benchmarks updated: event throughput +30%, command throughput +58%, P95 latencies down 28-83%

## [1.5.2] - 2026-04-04

### Fixed
- **Upgrade failure**: users upgrading from v1.4.x got "Missing option 'getall_app_periods' in root" because array-type schema fields were removed from `options` defaults; HA Supervisor requires these to exist in the saved config for validation. Restored default values for `getall_networks`, `getall_app_periods`, `ha_discovery_networks`, and `web_allowed_origins`.

## [1.5.1] - 2026-04-04

### Fixed
- **730 event level parsing**: C-Gate 730 events include a UUID before the `level=N` field; the fast-path parser was extracting the leading digit from the UUID (e.g. `6` from `6c2b7f80-...`) instead of the correct level value, causing lights to appear permanently on in Home Assistant
- Cover and lighting ON/OFF state now uses raw C-Bus level instead of quantized percentage, fixing incorrect OFF state at very low brightness levels (1-2 out of 255)
- HVAC mode correctly reports `off` for ramp-to-zero commands
- haDiscovery race condition: tree responses arriving before HA Discovery initialized are now buffered and replayed instead of silently dropped
- Connection pool recovery: bridge no longer gets stuck after all pool connections go unhealthy then recover
- Socket state verified after drain timeout to prevent writing to destroyed sockets
- Try/catch in command data handler prevents a single malformed C-Gate line from crashing the processing loop

### Added
- Startup diagnostics summary: logs connections, networks, features, device types, and labels on boot
- MQTT consolidated stats topic (`cbus/read/bridge/stats`): JSON with version, uptime, connections, queue, publisher, and discovery stats
- Web dashboard endpoint (`GET /api/dashboard`): bridge health, device list with levels/labels, and recent event count
- Unknown settings key warnings in standalone mode (catches typos in settings.js)
- `cbusname` validation (rejects spaces, slashes, and quotes)
- Queue drop warnings published to `hello/cgateweb/warnings` when the command queue is full
- Configurable INCREASE/DECREASE timeout (`relativeLevelTimeoutMs`, default 5000ms)

### Changed
- HA addon config simplified from ~40 visible fields to 5 essentials; all other settings hidden by default and accessible via "Show unused optional configuration options"
- Improved addon config descriptions with defaults and auto-detection notes
- All resources properly cleaned up on bridge stop (event listeners, timers, ramp trackers, coalesce buffers)
- Input validation: C-Bus address ranges, 1MB line buffer cap, WebServer body read guards, rate limit memory cap
- TLS certificate errors now show clear file path in the error message

## [1.4.30] - 2026-03-29

### Fixed
- **Devices turning off on bridge restart**: the bridge was executing stale retained write commands replayed by the MQTT broker on reconnect (e.g. `cbus/write/254/56/5/ramp -> OFF`). Retained messages on write topics are now silently ignored on subscribe — only fresh commands from HA automations/UI are executed
- C-Gate 401/404 errors for getall on unconfigured apps (e.g. cover app 203 when no covers exist) now log as WARN instead of ERROR; 401 hint text corrected from "Unauthorized" to "Object Not Found or Unauthorized"

## [1.4.29] - 2026-03-29

### Added
- Real-time C-Bus event log in the label editor: a collapsible "Live Events" panel streams events via SSE (`GET /api/events/stream`), showing address, resolved label, level, and a visual bar; click any row to filter the main table to that device; pause/clear controls; auto-reconnects on disconnect; state persisted in localStorage
- Stale device detection: tracks last-seen timestamp per device; after `stale_device_threshold_hours` (default 24h) without an update, a HA `sensor` entity (`C-Bus Stale Devices`) shows the count with JSON attributes listing addresses, labels, and hours-since-last-seen; configurable via `stale_device_detection_enabled`, `stale_device_threshold_hours`, `stale_device_check_interval_sec`

## [1.4.28] - 2026-03-29

### Added
- Per-app configurable poll intervals via `getall_app_periods`: override the global `getall_period` per C-Bus application ID (e.g. poll HVAC every 5 min, covers every 1 min, lighting every hour); set `0` to disable polling for a specific app
- Cover position interpolation during ramps: when a ramp/position command targets a cover group, intermediate position values are published every 500ms so Home Assistant shows smooth blind movement; real C-Gate events always take priority and cancel the interpolation immediately; configurable via `cover_ramp_duration_sec` (default 5s)

## [1.4.27] - 2026-03-28

### Added
- Label editor undo/redo: full history stack (up to 50 steps) with Undo/Redo buttons showing step count, keyboard shortcuts (Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z), and toast feedback; all mutations are undoable (cell edits, type changes, exclude toggles, bulk operations, auto-fill areas, import)
- C-Gate project XML export: `GET /api/labels/export.xml` endpoint returns a TreeXML-compatible file grouping devices by network and application; "Export project XML" download button added to the UI
- C-Bus trigger groups now also published as Home Assistant `scene` entities via MQTT Discovery, enabling scene activation from the HA UI and automations; configurable via `ha_discovery_scene_enabled` (default: true)

### Fixed
- Jest `testPathIgnorePatterns` restored to `/.claude/` to correctly suppress worktree test files from running in the main test suite

## [1.4.26] - 2026-03-28

### Added
- Cover tilt support: configure a separate C-Bus app ID (`ha_discovery_cover_tilt_app_id`) for venetian/louvre blind tilt control; tilt position publishes to `cbus/read/{n}/{tiltApp}/{g}/tilt` and HA cover entities gain `tilt_status_topic` / `tilt_command_topic`
- Automatic C-Bus network discovery: on connect the bridge sends `tree //PROJECT` and parses network IDs as a fallback for `getall_networks` and `ha_discovery_networks`; configurable via `auto_discover_networks` (default: true)
- Label editor pagination: 25/50/100/All per-page selector (persisted in localStorage, default 50) with prev/next controls and "Showing X–Y of Z" count
- Label export: "Download backup" button downloads the current `labels.json` directly from the browser
- Auto-area suggestion: `guessArea()` detects room words in device labels (Office, Kitchen, Bedroom, etc.) and shows suggestions as placeholder text; "Auto-fill areas" button batch-applies guesses to unset rows

### Fixed
- Cover getall response parsing confirmed end-to-end correct; regression tests added to prevent future regressions (level=0/128/255 → position=0/50/100, state OFF/ON)

## [1.4.25] - 2026-03-28

### Fixed
- Area column now visible and editable in the label editor (inline click-to-edit, searches by area name)

## [1.4.24] - 2026-03-28

### Added
- Area/room assignment in label editor: set a room name per device (e.g. "Office") and it flows through as `suggested_area` in HA MQTT Discovery — Home Assistant auto-assigns entities to rooms on first discovery
- Documentation: HVAC (App 201), trigger groups (App 202), PIR, relay, and C-Bus application ID reference table added to DOCS.md

### Fixed
- Startup getall now polls all configured app IDs (covers, HVAC, triggers, switches) not just lighting (App 56) — cover positions and HVAC states are now known immediately after bridge restart
- Background timers now call `.unref()` so Jest tests exit cleanly without "worker process has failed to exit gracefully" warnings

## [1.4.23] - 2026-03-28

### Added
- C-Bus HVAC support (App 201): climate zones exposed as Home Assistant `climate` entities with current temperature, setpoint control, and mode (off/auto/cool/heat/fan_only)
- C-Bus trigger write-back: each trigger group now also publishes a companion HA `button` entity, allowing Home Assistant automations to fire C-Bus scenes/triggers
- Trigger groups now visible in the label editor with read-only type badge, editable label/entity-id, and exclude toggle
- Stale HA discovery cleanup: when a device is excluded or changes type, the old MQTT discovery message is automatically cleared so HA removes the stale entity
- Event connection keep-alive: periodic pings on the C-Gate event port (20025) detect silent TCP drops; configurable via `connection_keep_alive_interval_sec`

### Fixed
- Trigger groups in label editor are correctly identified and shown with purple badge; type cannot be accidentally changed

## [1.4.22] - 2026-03-28

### Added
- C-Bus trigger group support (App 202): trigger events now published as Home Assistant `event` entities, enabling automations from keypads and scenes
- Connection pool tuning settings in addon UI: `connection_pool_size`, `connection_health_check_interval_sec`, `connection_keep_alive_interval_sec`
- Label editor batch operations: multi-select rows with checkboxes, bulk type assignment (light/cover/switch), bulk exclude/include, Shift+click range selection
- Integration test now validates HA MQTT Discovery message format and required fields

### Fixed
- Cover entities now use `optimistic: false` in discovery payload so Home Assistant waits for confirmed position feedback before updating UI state

## [1.4.21] - 2026-03-28

### Added
- MQTT TLS/SSL support for external brokers: `mqtt_use_tls`, `mqtt_ca_file`, and `mqtt_reject_unauthorized` options are now configurable in the add-on UI
- Supports self-signed CA certificates, standard TLS (port 8883), and optional certificate verification bypass

## [1.4.20] - 2026-03-28

### Added
- C-Gate version shown as a diagnostic entity in Home Assistant (populated automatically from managed-mode install)
- Runtime status panel in the label editor now shows bridge version, uptime, lifecycle reason, and reconnect counts

### Fixed
- Multi-network support: `getall_networks` with more than one network now correctly polls all listed networks on startup and periodically, not just the first
- Integration test now runs on Linux CI without a podman machine (Linux containers run natively)

### Changed
- CI workflow now includes an integration test job (managed mode, downloads C-Gate) running on push to main

## [1.4.19] - 2026-03-28

### Fixed
- Multi-network support: `getall_networks` with more than one network now correctly polls all listed networks on startup and periodically, not just the first
- Bridge diagnostic entity names are now published correctly in MQTT discovery payloads
- Runtime status panel timer is correctly cleared when navigating away from the label editor page

### Changed
- CI workflow now includes an integration test job (managed mode, downloads C-Gate) running on push to main
- Integration test now runs on Linux CI without a podman machine (Linux containers run natively)

## [1.4.18] - 2026-03-28

### Fixed
- Corrected CI coverage threshold for `cgateConnectionPool` to match actual coverage (37.5%)

## [1.4.17] - 2026-03-28

### Fixed
- Removed no-useless-catch lint error in `lineProcessor`

## [1.4.16] - 2026-03-28

### Fixed
- Web server now binds to `0.0.0.0` in add-on mode, fixing 502 errors when accessing the label editor via HA Ingress; standalone mode retains `127.0.0.1` default; regression test added

## [1.4.15] - 2026-03-28

### Added
- End-to-end integration test (`test-env/integration-test.js`) validating the full managed-mode stack: C-Gate install, C-Gate start, MQTT readiness, C-Gate connectivity, bridge lifecycle, and a 10-second stability window

## [1.4.14] - 2026-03-28

### Fixed
- Managed mode: correctly handles the Schneider Electric download package (outer zip contains a nested C-Gate zip that must be extracted separately)
- Managed mode: updated default C-Gate download URL from dead Clipsal CDN to `download.se.com` (V3.3.2, publicly accessible)
- Better error logging when a C-Gate download fails, including HTTP status code and 404-specific guidance
- `test-env` updated with Dockerfile, mock HA Supervisor HTTP API, and podman-compose instructions

## [1.4.13] - 2026-03-28

### Fixed
- Managed mode: corrected C-Gate startup flags (`-s` only, removing invalid `-p`/`-e`/`-nogui` flags that caused an infinite restart loop)
- `cgate-install.sh` now writes `CommandInterface.port` and `EventInterface.port` into `C-GateConfig.txt` during installation so custom ports take effect

### Added
- Local test environment (`test-env/`) with docker-compose, Mosquitto broker config, and options templates (managed-upload, managed-download, remote) for validating managed mode without a real HA Supervisor

## [1.4.12] - 2026-03-10

### Added
- Bridge diagnostic entities published to Home Assistant via MQTT Discovery: ready state, lifecycle, MQTT/event connection status, command pool health, queue depth, and reconnect indicator

### Performance
- Reduced hot-path parsing overhead in line processor

## [1.4.11] - 2026-03-04

### Fixed
- Interactive command priority propagation: explicit interactive queue requests are no longer downgraded to standard priority

### Added
- Router regression coverage for command priority handling

## [1.4.10] - 2026-03-04

### Changed
- Version alignment: Home Assistant add-on version synced with application version for phase 1 performance release

## [1.4.9] - 2026-03-04

### Changed
- Version alignment: Home Assistant add-on version synced with application version for performance improvements release

## [1.4.8] - 2026-03-04

### Changed
- Hardened web API defaults: mutating endpoints now require authentication by default unless explicitly overridden
- Added configurable CORS allowlist support and explicit unsafe override toggle for unauthenticated writes
- Improved HA discovery TreeXML handling by isolating queued network context to avoid state bleed between requests
- Expanded bridge runtime status with lifecycle/readiness state and queue/pool health metrics, plus `/healthz` and `/readyz` endpoints
- Aligned CI and distribution release quality gates with lint (`--max-warnings=0`) and coverage checks

### Fixed
- Consolidated startup validation path to reduce duplicate config validation logic and drift
- Managed-mode C-Gate install now supports checksum verification and safer default local-only interface access

## [1.2.2] - 2026-02-28

### Fixed
- **Cover position publishing**: Type-overridden covers on the lighting app now correctly publish to the `position` MQTT topic, fixing non-functional position sliders in Home Assistant for blind/cover entities

## [1.2.1] - 2026-02-22

### Fixed
- **MQTT auth error messaging**: Authentication failures now display a clear, actionable error with environment-specific fix instructions (addon vs standalone) instead of a raw JSON error dump

## [1.2.0] - 2026-02-22

### Added
- **C-Bus label management**: Three-tier label resolution (custom JSON > C-Gate TREEXML > fallback)
- **Clipsal project file import**: Upload `.cbz`/`.xml` project files to extract device labels
- **Web-based label editor**: Real-time label editing UI accessible via HA Ingress (panel: "C-Bus Labels")
- **Type overrides**: Configure groups as `light`, `cover`, or `switch` to control HA entity type
- **Entity ID hints**: Preserve existing entity IDs during migration from manual YAML configuration
- **Group exclusion**: Exclude specific groups from HA MQTT Discovery
- **Hot-reload labels**: File watcher detects `labels.json` changes and republishes discovery
- **Migration tooling**: CLI tool (`tools/cgate-label-manager.js`) for C-Gate label inventory and management
- C-Gate mode configuration: `remote` (connect to external C-Gate) or `managed` (run C-Gate locally)
- MQTT auto-detection from Home Assistant Supervisor API
- Configuration UI translations for 17 languages
- s6-overlay process supervision for managed C-Gate mode

### Changed
- HA Discovery now sets entity-level `name` to `null` to prevent doubled friendly names
- Stale retained MQTT discovery messages are automatically cleared when type overrides change entity type
- Discovery supplements from `labels.json` when TREEXML returns incomplete data

### Fixed
- Labels-changed listener leak on restart (now properly removed in `stop()`)
- Label file watcher now starts after haDiscovery initialization
- Label import preserves existing `type_overrides`, `entity_ids`, and `exclude` sections

## [1.1.0] - 2026-02-22

### Changed
- **MQTT publish throughput**: Removed 200ms throttle from MQTT publishing path. Events now publish directly to MQTT instead of queuing, reducing latency from 200-600ms to near-zero per event. "Get all" responses for 100 devices now complete in <1s instead of 40+ seconds.
- **Connection pool optimization**: Cached healthy connections array to eliminate per-command array allocation during round-robin selection.
- **Tree XML buffering**: Replaced O(n^2) string concatenation with O(n) array-based accumulation for HA Discovery tree parsing.
- **Shared loggers**: CBusEvent and CBusCommand now use module-level shared loggers, eliminating per-instance allocation overhead.

### Fixed
- **LineProcessor memory leak**: Fixed leak where reconnecting pool connections left orphaned PassThrough stream/readline pairs in the processor Map. Now keys by pool index and cleans up on reconnection.

## [1.0.0] - TBD

### Added
- Initial Home Assistant add-on implementation
- Automatic configuration from add-on options via ConfigLoader
- Support for dual installation modes (standalone vs add-on)
- Home Assistant MQTT Discovery integration
- Multi-architecture Docker image support (amd64, aarch64, armhf, armv7, i386)
- Comprehensive configuration validation
- User-friendly configuration UI in Home Assistant
- Automatic device discovery for lights, covers, and switches
- Host network access for C-Gate connectivity
- Comprehensive documentation and troubleshooting guide

---

**Note**: This add-on is based on the [cgateweb](https://github.com/dougrathbone/cgateweb) Node.js application. For the core application changelog, see the main repository.
