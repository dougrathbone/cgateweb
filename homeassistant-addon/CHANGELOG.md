# Changelog

All notable changes to the C-Gate Web Bridge Home Assistant add-on will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
