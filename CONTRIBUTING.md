# Contributing to CGateWeb

Welcome! This guide will help you get started contributing to CGateWeb, a Node.js bridge that connects Clipsal C-Bus automation systems to MQTT for Home Assistant integration.

## Getting Started

### Prerequisites

- **Node.js 14+**: This project uses modern JavaScript features
- **C-Gate Server**: Clipsal's C-Bus automation gateway software
- **MQTT Broker**: Like Mosquitto or built into Home Assistant
- **Git**: For version control and contributing

### Development Setup

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd cgateweb
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Copy and configure settings**
   ```bash
   cp settings.js.example settings.js
   # Edit settings.js with your C-Gate and MQTT broker details
   ```

4. **Run tests**
   ```bash
   npm test
   ```

5. **Run the application**
   ```bash
   npm start
   ```

## Understanding the Codebase

### Architecture Overview

CGateWeb acts as a bidirectional bridge:

```
C-Bus Devices ←→ C-Gate Server ←→ CGateWeb ←→ MQTT Broker ←→ Home Assistant
```

### Key Components

- **`CgateWebBridge`** (`src/cgateWebBridge.js`): Main orchestration class
- **`CBusEvent`** (`src/cbusEvent.js`): Parses events from C-Gate
- **`CBusCommand`** (`src/cbusCommand.js`): Parses MQTT commands for C-Gate
- **`MqttManager`** (`src/mqttManager.js`): Handles MQTT connections
- **`CgateConnection`** (`src/cgateConnection.js`): Manages C-Gate socket connections
- **`HaDiscovery`** (`src/haDiscovery.js`): Home Assistant device discovery
- **`ThrottledQueue`** (`src/throttledQueue.js`): Rate-limited message processing

### C-Bus Concepts

Understanding C-Bus addressing is essential:

- **Network**: Typically 254 (default network)
- **Application**: Device type (56 = lighting, 36 = triggers, etc.)
- **Group**: Individual device/channel number
- **Level**: 0-255 brightness for lights (0 = off, 255 = full brightness)

Example: `254/56/4` = Network 254, Lighting Application, Group 4

### MQTT Message Flow

**Incoming Commands (MQTT → C-Gate):**
- MQTT: `cbus/write/254/56/4/switch` payload `ON`
- C-Gate: `on //PROJECT/254/56/4`

**Outgoing Events (C-Gate → MQTT):**
- C-Gate: `lighting on 254/56/4`
- MQTT: `cbus/read/254/56/4/state` payload `ON`

## Development Guidelines

### Code Style

- Use **descriptive variable names** that explain C-Bus concepts
- Follow **existing patterns** in the codebase
- Add **JSDoc comments** for public methods and complex logic
- Use **ES6+ features** (const/let, arrow functions, destructuring)
- Keep functions **focused and small**

### Testing Requirements

**Before submitting any changes:**

1. **Write tests first** for new functionality
2. **Run all tests**: `npm test`
3. **Ensure 100% test pass rate** (currently 134 tests)
4. **Update tests** when modifying existing functionality

### Test Structure

Tests use **Jest** with extensive mocking:

```javascript
// Example test pattern
describe('ClassName', () => {
  let mockDependency;
  
  beforeEach(() => {
    mockDependency = {
      method: jest.fn()
    };
  });
  
  it('should handle specific scenario', () => {
    // Arrange
    const instance = new ClassName(mockDependency);
    
    // Act
    const result = instance.method();
    
    // Assert
    expect(result).toBe(expectedValue);
    expect(mockDependency.method).toHaveBeenCalledWith(expectedArgs);
  });
});
```

### Common Development Tasks

#### Adding New C-Bus Command Types

1. Add command constant to `src/constants.js`
2. Update `CBusCommand._parsePayload()` method
3. Add handler method in `CgateWebBridge`
4. Write tests for the new command type

#### Adding New C-Gate Response Types

1. Add response code constant to `src/constants.js`
2. Update `CgateWebBridge._processCommandResponse()` switch statement
3. Implement response handler method
4. Write tests for the new response type

#### Debugging Connection Issues

Enable detailed logging in `settings.js`:
```javascript
logging: true  // Shows all MQTT and C-Gate messages
```

## Submitting Changes

### Pull Request Process

1. **Create feature branch**: `git checkout -b feature/your-feature-name`
2. **Make changes** with tests
3. **Verify tests pass**: `npm test`
4. **Commit with clear messages**: Focus on the "why" not just "what"
5. **Push and create PR**

### Commit Message Format

Use clear, descriptive commit messages:

```
Add support for C-Bus trigger commands

- Implement MQTT command parsing for trigger devices
- Add trigger command handlers in bridge
- Include comprehensive tests for trigger functionality

Resolves #123
```

### Code Review Checklist

- [ ] All tests pass
- [ ] New functionality has tests
- [ ] JSDoc comments added for public methods
- [ ] No breaking changes to existing API
- [ ] Error handling for edge cases
- [ ] Logging for debugging
- [ ] Settings validation if applicable

## Getting Help

### Understanding C-Bus

- **C-Gate Manual**: Essential reading for C-Bus concepts
- **C-Bus Toolkit**: GUI tool for testing C-Gate connections
- **Existing tests**: Great examples of expected behavior

### Common Issues

**"Connection refused to C-Gate"**
- Verify C-Gate is running and accessible
- Check firewall settings
- Confirm port numbers (typically 20023/20024)

**"MQTT publish failed"**
- Verify MQTT broker is running
- Check authentication credentials
- Test with MQTT client tools

**"Tests failing after changes"**
- Run `npm test` to see specific failures
- Check if you broke existing functionality
- Update test expectations if behavior intentionally changed

### Project Structure

```
cgateweb/
├── src/                    # Main source code
│   ├── cgateWebBridge.js  # Main bridge class
│   ├── cbusEvent.js       # C-Bus event parsing
│   ├── cbusCommand.js     # MQTT command parsing
│   ├── constants.js       # Shared constants
│   └── ...
├── tests/                 # Jest test files
├── settings.js.example    # Configuration template
├── index.js              # Application entry point
└── package.json          # Dependencies and scripts
```

## Contributing Philosophy

This project aims to be:

- **Reliable**: Robust error handling and comprehensive testing
- **Maintainable**: Clear code structure and documentation
- **Accessible**: Easy for newcomers to understand and contribute
- **Stable**: Changes shouldn't break existing integrations

Thank you for contributing to CGateWeb! Your help makes C-Bus automation more accessible to the open source community.