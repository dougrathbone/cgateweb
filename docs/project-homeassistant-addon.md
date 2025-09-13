# Home Assistant HACS Addon Scope Document

## Project Overview
Create a Home Assistant Community Store (HACS) addon that packages the cgateweb service for seamless integration within Home Assistant environments.

## Objectives
- Package cgateweb as a native Home Assistant addon
- Simplify installation and configuration for Home Assistant users
- Maintain existing MQTT functionality while integrating with HA ecosystem
- Provide Home Assistant UI for configuration management

## Current cgateweb Architecture
- **Core**: Node.js MQTT bridge for Clipsal C-Bus systems
- **Components**: CgateWebBridge, CgateConnectionPool, MqttManager, HADiscovery
- **Configuration**: settings.js file with C-Gate and MQTT parameters
- **Dependencies**: Node.js runtime, MQTT broker connection, C-Gate telnet access

## HACS Addon Requirements

### Technical Structure
- **Base Image**: Home Assistant addon base with Node.js support
- **Configuration**: Home Assistant addon config.yaml schema
- **Networking**: Host network access for C-Gate telnet connections
- **Persistence**: Configuration and logs stored in addon data directory

### Configuration Integration
- Detect installation environment (standalone vs HA addon)
- When in HA addon: Read configuration from Home Assistant's configuration.yaml
- When standalone: Use existing settings.js approach
- Support configuration via Home Assistant UI when in addon mode
- Validate configuration before service startup
- Ensure zero configuration drift between installation methods

### Repository Structure
The Home Assistant addon will be developed as a subfolder within the main cgateweb repository:

```
cgateweb/                    # Main repository
├── src/                     # Core cgateweb source
├── tests/                   # Main test suite
├── docs/                    # Documentation
├── homeassistant-addon/     # HA addon subfolder
│   ├── config.yaml          # Addon metadata and options schema
│   ├── Dockerfile           # Container build instructions
│   ├── DOCS.md             # User documentation
│   ├── CHANGELOG.md        # Version history
│   ├── run.sh              # Startup script
│   ├── rootfs/             # Addon filesystem overlay
│   │   └── etc/services.d/cgateweb/
│   │       ├── run         # Service runner
│   │       └── finish      # Service cleanup
│   └── tests/              # Addon-specific tests
└── settings.js             # Standalone configuration
```

### Benefits of Subfolder Approach
- Single repository maintains both standalone and addon versions
- Shared source code reduces duplication
- Unified testing and CI/CD pipeline
- Easier maintenance and version synchronization
- Clear separation of concerns between core and addon-specific code

### Distribution Strategy
- **Main Repository**: Contains all source code and development
- **HACS Distribution Repository**: Separate repo containing only addon files for HACS
- **Automated Pipeline**: GitHub Actions copies addon files from main to distribution repo
- **Version Sync**: Main repo tags trigger automated releases in distribution repo
- **Benefits**: Clean HACS repository, centralized development, automated distribution

## Implementation Phases

### Phase 1: Core Addon Structure
- [ ] Create addon subfolder structure within main repository
- [ ] Define config.yaml schema mapping cgateweb settings
- [ ] Create Dockerfile based on HA addon base image
- [ ] Implement environment detection and dual configuration support
- [ ] Add unit tests for both standalone and addon configuration modes

### Phase 2: Service Integration
- [ ] Adapt cgateweb startup for addon environment
- [ ] Implement proper logging integration with HA supervisor
- [ ] Handle service lifecycle (start/stop/restart)
- [ ] Test basic functionality within HA environment

### Phase 3: HA-Specific Features
- [ ] Enhanced Home Assistant discovery integration
- [ ] Optional: Direct HA entity creation (bypass MQTT)
- [ ] Configuration validation and user-friendly error messages
- [ ] Health monitoring and status reporting

### Phase 4: Distribution
- [ ] Create HACS-compatible repository
- [ ] Documentation and installation guides
- [ ] Testing across different HA installations
- [ ] Community feedback integration

## Configuration Mapping
Current settings.js parameters to HA addon options:

| cgateweb Setting | HA Addon Option | Type | Description |
|------------------|----------------|------|-------------|
| cgate.host | cgate_host | string | C-Gate server hostname |
| cgate.port | cgate_port | int | C-Gate telnet port |
| cgate.controlPort | cgate_control_port | int | C-Gate control port |
| mqtt.brokerUrl | mqtt_broker_url | string | MQTT broker URL |
| mqtt.username | mqtt_username | string | MQTT username |
| mqtt.password | mqtt_password | password | MQTT password |
| networks | networks | list | C-Bus network configurations |

## Technical Considerations

### Dependencies
- Node.js runtime (addon base image)
- MQTT client libraries (existing)
- Home Assistant supervisor integration
- Network access to C-Gate and MQTT broker

### Security
- Secure credential storage via HA secrets
- Network isolation options
- Input validation for all configuration parameters
- Proper error handling and logging

### Performance
- Monitor resource usage within HA environment
- Optimize startup time
- Handle HA restarts gracefully
- Maintain existing connection pooling efficiency

## Success Criteria
- [ ] Addon installs cleanly via HACS
- [ ] Configuration through HA UI works intuitively
- [ ] All existing cgateweb functionality preserved
- [ ] C-Bus devices appear in Home Assistant via MQTT
- [ ] Addon handles HA system restarts properly
- [ ] Documentation enables easy user adoption

## Risks and Mitigation
- **Complexity**: HA addon ecosystem learning curve → Start with minimal viable addon
- **Testing**: Limited access to diverse HA setups → Provide clear testing guidelines
- **Maintenance**: Two codebases to maintain → Maximize code reuse between standalone and addon
- **Dependencies**: HA addon constraints → Validate compatibility early

## Complete Step-by-Step Implementation Plan

### Setup Phase (Days 1-2)
1. **Research and Environment Setup**
   - [ ] Study Home Assistant addon development documentation
   - [ ] Review existing HA addons for Node.js applications
   - [ ] Set up local Home Assistant test environment (Docker/VM)
   - [ ] Install Home Assistant CLI and addon development tools
   - [ ] Research HACS addon submission requirements

### Phase 1: Core Infrastructure (Days 3-7)
2. **Repository Structure**
   - [ ] Create `homeassistant-addon/config.yaml` with addon metadata
   - [ ] Define configuration schema mapping cgateweb settings to HA options
   - [ ] Create `homeassistant-addon/Dockerfile` based on HA Node.js base image
   - [ ] Set up `homeassistant-addon/run.sh` startup script
   - [ ] Create `homeassistant-addon/DOCS.md` user documentation template

3. **Environment Detection System**
   - [ ] Create `src/config/EnvironmentDetector.js` to identify installation type
   - [ ] Implement `src/config/ConfigLoader.js` for dual configuration support
   - [ ] Add HA configuration.yaml parsing logic
   - [ ] Maintain backward compatibility with settings.js
   - [ ] Add configuration validation for both modes

4. **Testing Infrastructure**
   - [ ] Create `tests/config/environmentDetection.test.js`
   - [ ] Create `tests/config/configLoader.test.js` for both scenarios
   - [ ] Add mock HA environment for testing
   - [ ] Set up test fixtures for both installation types
   - [ ] Ensure existing tests still pass with dual config support

### Phase 2: HA Integration (Days 8-12)
5. **Addon Container Setup**
   - [ ] Configure proper Node.js version in Dockerfile
   - [ ] Set up service supervision with s6-overlay
   - [ ] Implement proper signal handling for container shutdown
   - [ ] Configure log output for HA supervisor integration
   - [ ] Set up health check endpoints

6. **Configuration UI Integration**
   - [ ] Map all settings.js options to HA addon config schema
   - [ ] Add input validation and error messages
   - [ ] Create configuration defaults and examples
   - [ ] Test configuration persistence across restarts
   - [ ] Implement configuration migration if needed

7. **Service Lifecycle Management**
   - [ ] Adapt startup sequence for addon environment
   - [ ] Handle HA supervisor start/stop/restart signals
   - [ ] Implement graceful shutdown procedures
   - [ ] Add startup dependency checks (MQTT broker, C-Gate)
   - [ ] Test service resilience during HA restarts

### Phase 3: Enhanced Features (Days 13-17)
8. **HA-Specific Optimizations**
   - [ ] Enhance Home Assistant MQTT discovery integration
   - [ ] Add HA-specific device metadata and categories
   - [ ] Implement addon status reporting to HA supervisor
   - [ ] Add configuration validation with user-friendly error messages
   - [ ] Optimize resource usage for container environment

9. **Monitoring and Diagnostics**
   - [ ] Add health monitoring endpoints
   - [ ] Implement connection status reporting
   - [ ] Add diagnostic information collection
   - [ ] Create troubleshooting documentation
   - [ ] Set up proper error logging and alerting

### Phase 4: Testing and Quality (Days 18-21)
10. **Comprehensive Testing**
    - [ ] Test addon installation in clean HA environment
    - [ ] Verify all cgateweb functionality works in addon mode
    - [ ] Test configuration changes through HA UI
    - [ ] Validate MQTT discovery and device creation
    - [ ] Test addon updates and configuration migration
    - [ ] Performance testing in container environment

11. **Integration Testing**
    - [ ] Test with various HA versions (current stable, beta)
    - [ ] Test with different MQTT brokers (Mosquitto, external)
    - [ ] Test with multiple C-Gate configurations
    - [ ] Verify compatibility with HA backups/restore
    - [ ] Test addon removal and cleanup

### Phase 5: Documentation and Distribution (Days 22-25)
12. **Documentation Completion**
    - [ ] Complete `homeassistant-addon/DOCS.md` with installation guide
    - [ ] Create `homeassistant-addon/CHANGELOG.md`
    - [ ] Update main README.md with addon information
    - [ ] Create troubleshooting guide
    - [ ] Document configuration migration from standalone

13. **HACS Distribution Repository Setup**
    - [ ] Create separate HACS distribution repository (e.g., `cgateweb-homeassistant`)
    - [ ] Set up GitHub Actions for automated distribution builds
    - [ ] Configure build pipeline to copy addon files from main repo
    - [ ] Set up automated tagging and releases for HACS repo
    - [ ] Create repository metadata for HACS compatibility
    - [ ] Test automated distribution pipeline

### Phase 6: Release and Support (Days 26-30)
14. **Beta Release**
    - [ ] Trigger automated distribution build to HACS repo
    - [ ] Create beta release in HACS distribution repository
    - [ ] Set up issue tracking for feedback (link back to main repo)
    - [ ] Monitor performance and resource usage
    - [ ] Collect user feedback and bug reports
    - [ ] Iterate on configuration and usability

15. **Production Release**
    - [ ] Submit HACS distribution repository to HACS community store
    - [ ] Set up automated releases triggered by main repo tags
    - [ ] Create official release announcement
    - [ ] Monitor installation success rates
    - [ ] Provide user support and documentation updates
    - [ ] Plan ongoing maintenance and updates

### Continuous Tasks
- [ ] **Code Quality**: Run `npm test` after every change
- [ ] **Documentation**: Keep docs in sync with code changes
- [ ] **Version Control**: Use meaningful commit messages
- [ ] **Security**: Regular dependency updates and security reviews
- [ ] **Community**: Respond to issues and feature requests
- [ ] **Distribution**: Automated builds push to HACS repository on main repo changes

### Success Metrics
- [ ] Addon installs without errors on fresh HA instance
- [ ] All existing cgateweb functionality works in addon mode
- [ ] Configuration through HA UI is intuitive
- [ ] Zero test failures in both standalone and addon modes
- [ ] Community adoption and positive feedback
- [ ] Performance metrics within acceptable ranges

## Build and Distribution Pipeline

### GitHub Actions Workflow
```yaml
# .github/workflows/hacs-distribution.yml
name: HACS Distribution
on:
  push:
    tags: ['v*']
  workflow_dispatch:

jobs:
  distribute:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout main repo
      - name: Copy addon files to distribution repo
      - name: Create release in HACS distribution repo
      - name: Update HACS repository metadata
```

### Distribution Repository Structure
```
cgateweb-homeassistant/          # HACS distribution repository
├── config.yaml                 # Addon configuration
├── Dockerfile                  # Container build
├── DOCS.md                     # User documentation
├── CHANGELOG.md                # Release history
├── run.sh                      # Startup script
├── rootfs/                     # Service files
└── repository.json             # HACS metadata
```

## Next Immediate Steps
1. **Day 1**: Research HA addon development and set up test environment
2. **Day 2**: Create basic addon structure and config schema  
3. **Day 3**: Implement environment detection system
4. **Day 4**: Add dual configuration support with tests
5. **Day 22**: Set up HACS distribution repository and automated pipeline
