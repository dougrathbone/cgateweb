# Changelog

All notable changes to the C-Gate Web Bridge Home Assistant add-on will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- C-Gate mode configuration: `remote` (connect to external C-Gate) or `managed` (run C-Gate locally)
- C-Gate managed mode with download from Clipsal or user-uploaded zip via `/share/cgate/`
- MQTT auto-detection from Home Assistant Supervisor API
- Event port configuration (`cgate_event_port`, default 20025)
- Architecture-specific build configuration (`build.yaml`)
- Addon icon and logo for Home Assistant UI
- English translations for all configuration options
- s6-overlay process supervision for managed C-Gate mode

### Changed
- Simplified `run.sh` to delegate config handling to ConfigLoader
- Default MQTT host changed to `core-mosquitto` for HA addon environment
- Replaced unused `cgate_control_port` with `cgate_event_port`
- Added `/share` mount for C-Gate zip upload support

### Removed
- Redundant settings.js generation from `run.sh` (ConfigLoader reads options.json directly)

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
