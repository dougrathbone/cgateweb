# Changelog

All notable changes to the C-Gate Web Bridge Home Assistant add-on will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial Home Assistant add-on implementation
- Automatic configuration generation from add-on options
- Support for dual installation modes (standalone vs add-on)
- Home Assistant MQTT Discovery integration
- Multi-architecture Docker image support (amd64, aarch64, armhf, armv7, i386)
- Comprehensive configuration validation
- User-friendly configuration UI in Home Assistant
- Automatic device discovery for lights, covers, and switches
- Integration with Home Assistant supervisor
- Host network access for C-Gate connectivity

### Changed
- Configuration now managed through Home Assistant UI instead of settings.js
- Environment detection automatically selects configuration method
- MQTT credentials securely handled through Home Assistant secrets

### Security
- Password fields properly masked in configuration UI
- Secure credential storage via Home Assistant add-on system

## [1.0.0] - TBD

### Added
- First stable release of Home Assistant add-on
- Full feature parity with standalone cgateweb installation
- Automated HACS distribution pipeline
- Comprehensive documentation and troubleshooting guide

---

**Note**: This add-on is based on the [cgateweb](https://github.com/dougrathbone/cgateweb) Node.js application. For the core application changelog, see the main repository.
