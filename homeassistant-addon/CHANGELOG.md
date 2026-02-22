# Changelog

All notable changes to the C-Gate Web Bridge Home Assistant add-on will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
