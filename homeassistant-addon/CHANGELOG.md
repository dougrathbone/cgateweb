# Changelog

All notable changes to the C-Gate Web Bridge Home Assistant add-on will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Managed mode: corrected C-Gate startup flags (`-s` only, removing invalid `-p`/`-e`/`-nogui` flags that caused an infinite restart loop)
- Managed mode: updated default C-Gate download URL to current Schneider Electric location (old Clipsal CDN returned 404)
- Managed mode: correctly handles the Schneider download package (outer zip contains a nested C-Gate zip that must be extracted separately)
- Web server now binds to `0.0.0.0` in add-on mode, fixing 502 errors when accessing the label editor via HA Ingress
- Bridge diagnostic entity names are now published correctly in MQTT discovery payloads
- Runtime status panel timer is correctly cleared when navigating away from the label editor page

### Added
- Local Podman-based test environment for validating managed mode end-to-end without a real Home Assistant installation
- Better error logging when a C-Gate download fails, including HTTP status code and 404-specific guidance
- End-to-end integration test that validates the full managed-mode stack (C-Gate install, MQTT connectivity, bridge lifecycle)

## [1.4.12] - 2026-03-10

### Added
- Bridge diagnostic entities published to Home Assistant via MQTT Discovery: ready state, lifecycle, MQTT/event connection status, command pool health, queue depth, and reconnect indicator

### Performance
- Reduced hot-path parsing overhead in line processor

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
