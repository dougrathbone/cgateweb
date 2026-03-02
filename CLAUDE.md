# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

cgateweb is a Node.js MQTT bridge for C-Bus lighting systems that connects to C-Gate over TCP and publishes events to an MQTT broker. It supports Home Assistant MQTT Discovery for automatic device configuration.

## Development Commands

- **Start application**: `npm start` or `node index.js`
- **Run tests**: `npm test`
- **Run tests with coverage**: `npm test -- --coverage`
- **Install dependencies**: `npm install`

## Development Guidelines

**IMPORTANT**: Before making any source code commits, you MUST run the full test suite (`npm test`) and ensure all tests pass. No code should be committed with failing tests. This ensures code quality and prevents regressions in the codebase.

## Releasing / Home Assistant Add-on Distribution

This project uses a **two-repository model** for Home Assistant add-on distribution:

- **Source repo** (this repo): `dougrathbone/cgateweb` -- contains all source code, tests, and the add-on packaging under `homeassistant-addon/`.
- **Distribution repo**: `dougrathbone/cgateweb-homeassistant` -- the HA add-on repository that users add to Home Assistant. HA Supervisor checks this repo for version updates.

A GitHub Actions workflow (`.github/workflows/hacs-distribution.yml`) syncs code from this repo to the distribution repo. **It only triggers on git tag pushes matching `v*`** (or manual `workflow_dispatch`).

### Version bump and release process

When bumping the version (e.g., for a bug fix or feature release), you MUST:

1. Update the version in **both** `package.json` and `homeassistant-addon/config.yaml` (keep them in sync).
2. Commit and push the version bump.
3. **Create and push a git tag** matching the version: `git tag v<version> && git push origin v<version>` (e.g., `git tag v1.4.7 && git push origin v1.4.7`).

If you skip step 3, the distribution repo will NOT be updated, Home Assistant will not see the new version, and the add-on will not auto-update on user devices. This has caused stale deployments in the past.

## Architecture

### Core Components

- **index.js**: Main application entry point containing connection management, settings loading, C-Gate communication, MQTT handling, and Home Assistant discovery
- **settings.js**: Configuration file containing C-Gate server details, MQTT broker settings, and Home Assistant discovery options
- **install-service.js**: Systemd service installer for Linux deployment

### Key Architecture Patterns

- **Event-driven architecture**: Uses Node.js EventEmitter for handling C-Gate events and MQTT messages
- **Throttled message queue**: Implements message throttling to prevent overwhelming C-Gate with commands
- **Exponential backoff**: Connection retry logic with exponential backoff for resilient connectivity
- **Parser classes**: Dedicated parsing logic for C-Gate events and commands (CBusEvent, CBusCommand)

### Connection Management

The application uses optimized connection architecture:

#### Connection Pool (Commands)
- **Connection pool** (default port 20023): Pool of persistent TCP connections for C-Gate commands
- **Pool size**: Configurable (default: 3 connections)
- **Performance**: 50-80% faster command execution by eliminating connection setup overhead
- **Load balancing**: Round-robin distribution across healthy connections
- **Health monitoring**: Automatic health checks and failover
- **Keep-alive**: Periodic pings to maintain connection health

#### Event Connection (Single)
- **Event connection** (default port 20025): Single TCP connection for receiving real-time events
- Remains singular due to broadcast nature of C-Gate events

#### Connection Features
- **Automatic reconnection**: Exponential backoff with configurable retry limits
- **SSL/TLS support**: Experimental support for secure connections
- **Connection monitoring**: Real-time health tracking and reporting
- **Error handling**: Comprehensive error recovery and logging

### MQTT Topic Structure

- **Read topics**: `cbus/read/{network}/{app}/{group}/state|level`
- **Write topics**: `cbus/write/{network}/{app}/{group}/switch|ramp`
- **Control topics**: `cbus/write/{network}/{app}//getall`, `cbus/write/{network}///tree`
- **Status topic**: `hello/cgateweb` (Online/Offline with LWT)

### Home Assistant Discovery

Supports automatic discovery of C-Bus devices:
- **Lights**: Application 56 (Lighting) as light entities
- **Covers**: Configurable app ID as cover entities  
- **Switches/Relays/PIR**: Configurable app IDs as switch/binary_sensor entities
- Uses MQTT Discovery protocol with configurable prefix (default: `homeassistant`)

### Home Assistant Add-on Translations

The add-on configuration UI is translated into 17 languages via YAML files in `homeassistant-addon/translations/`. Each file contains translated `name` and `description` fields for all configuration options while keeping YAML keys and technical terms (C-Gate, C-Bus, MQTT, etc.) in English. Supported languages: en, de, es, fr, it, nl, pt, ru, zh, ja, ko, pl, sv, no, da, cs, uk. New translations should be added by copying `en.yaml` and translating the user-facing strings.

## Testing Standards

- Uses Jest testing framework
- Test files in `/tests` directory with `.test.js` suffix
- Follows Arrange-Act-Assert pattern
- Unit tests prioritized over integration tests
- Mock external dependencies (network, MQTT, timers)
- Run coverage reports to guide testing efforts

## Configuration

Settings are loaded from `settings.js` with fallback to defaults in `index.js`. Key configuration areas:
- C-Gate connection details (IP, ports, credentials)
- MQTT broker settings (host, credentials, retain flags)
- Home Assistant discovery settings (enabled apps, networks to scan)  
- Operational settings (logging, message intervals, reconnection delays)
- **Connection pool settings** (new performance optimization):
  - `connectionPoolSize`: Number of command connections (default: 3, min: 1)
  - `healthCheckInterval`: Health check frequency in ms (default: 30000, min: 5000)
  - `keepAliveInterval`: Keep-alive ping frequency in ms (default: 60000, min: 10000)
  - `connectionTimeout`: Connection establishment timeout in ms (default: 5000, min: 1000)
  - `maxRetries`: Maximum connection retry attempts (default: 3, min: 1)

## Error Handling

- Comprehensive error handling for network connections
- C-Gate error code parsing and logging
- MQTT connection resilience with LWT
- Settings validation on startup
- Graceful degradation when services are unavailable