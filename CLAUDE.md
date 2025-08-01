# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

cgateweb is a Node.js MQTT bridge for C-Bus lighting systems that connects to C-Gate over TCP and publishes events to an MQTT broker. It supports Home Assistant MQTT Discovery for automatic device configuration.

## Development Commands

- **Start application**: `npm start` or `node index.js`
- **Run tests**: `npm test`
- **Run tests with coverage**: `npm test -- --coverage`
- **Install dependencies**: `npm install`

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

The application maintains two TCP connections to C-Gate:
- **Command connection** (default port 20023): For sending commands to C-Gate
- **Event connection** (default port 20025): For receiving real-time events from C-Gate

Both connections implement:
- Automatic reconnection with exponential backoff
- SSL/TLS support (experimental)
- Connection state monitoring
- Error handling and recovery

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

## Error Handling

- Comprehensive error handling for network connections
- C-Gate error code parsing and logging
- MQTT connection resilience with LWT
- Settings validation on startup
- Graceful degradation when services are unavailable