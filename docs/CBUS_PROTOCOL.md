# C-Bus Protocol Documentation

This document provides an overview of the C-Bus protocol as implemented in cgateweb, focusing on the interaction between the bridge and Clipsal C-Gate server.

## Overview

C-Bus is a microprocessor-based control and management system for buildings and homes. The cgateweb bridge communicates with C-Gate (Clipsal's C-Bus gateway software) via TCP sockets to control lighting, blinds, triggers, and other devices.

## Architecture

```
┌─────────────────┐    TCP/IP     ┌─────────────────┐    C-Bus     ┌─────────────────┐
│   cgateweb      │◄─────────────►│    C-Gate       │◄────────────►│   C-Bus Network │
│   (Bridge)      │               │   (Gateway)     │               │   (Devices)     │
└─────────────────┘               └─────────────────┘               └─────────────────┘
        ▲                                                                      
        │ MQTT                                                                
        ▼                                                                    
┌─────────────────┐                                                          
│  MQTT Broker    │                                                          
│ (Home Assistant)│                                                          
└─────────────────┘                                                          
```

## C-Gate Connection Types

### Command Connection (Port 20023)
- **Purpose**: Send commands to C-Bus devices
- **Protocol**: Request/Response over TCP
- **Connection Pool**: Uses multiple persistent connections for performance
- **Examples**: Turn lights on/off, set dimmer levels, control blinds

### Event Connection (Port 20025) 
- **Purpose**: Receive real-time events from C-Bus network
- **Protocol**: Streaming event notifications over TCP
- **Single Connection**: One persistent connection for event monitoring
- **Examples**: Device state changes, motion sensor triggers, switch presses

## C-Bus Addressing

C-Bus uses a hierarchical addressing scheme:

```
//<project>/<network>/<application>/<group>
//MyHome/254/56/4
```

- **Project**: C-Gate project name (e.g., "MyHome", "SHAC")
- **Network**: Network number (typically 254 for standard installations)
- **Application**: Application ID that defines device type
  - `56` = Lighting Application
  - `202` = Trigger Application  
  - `203` = Enable Control Application (blinds/curtains)
- **Group**: Individual device/group address (1-255)

## Application Types

### Lighting Application (56)
Controls lighting devices including on/off switches and dimmers.

**Commands:**
- `ON <group>` - Turn light on (255 level)
- `OFF <group>` - Turn light off (0 level)  
- `RAMP <group> <level>` - Set dimmer level (0-255)
- `RAMP <group> <level> <rate>` - Ramp to level over time

**Events:**
- `lighting on <network>/<app>/<group>` - Light turned on
- `lighting off <network>/<app>/<group>` - Light turned off
- `lighting ramp <network>/<app>/<group> <level>` - Light dimmed to level

### Enable Control Application (203)
Controls motorized devices like blinds, curtains, and garage doors.

**Commands:**
- `ON <group>` - Start opening/raising
- `OFF <group>` - Start closing/lowering
- `STOP <group>` - Stop movement

### Trigger Application (202)
Handles general automation triggers and sensors.

**Events:**
- `trigger on <network>/<app>/<group>` - Trigger activated
- `trigger off <network>/<app>/<group>` - Trigger deactivated

## Command Protocol

### Command Format
C-Gate commands follow this general format:
```
<COMMAND> <PATH> [<PARAMETERS>]\n
```

### Common Commands

#### GET Command
Retrieves current device states:
```
GET //MyHome/254/56/4 level
GET //MyHome/254/56/* level    // All devices in application
```

#### ON/OFF Commands  
Controls binary devices:
```
ON //MyHome/254/56/4
OFF //MyHome/254/56/4
```

#### RAMP Command
Controls dimmer devices:
```
RAMP //MyHome/254/56/4 128           // Set to 50% (128/255)
RAMP //MyHome/254/56/4 255 2s        // Ramp to 100% over 2 seconds
```

#### TREE Command
Retrieves network topology:
```
TREEXML 254    // Get XML description of network 254
```

### Response Format
C-Gate responses include status codes:
```
200 OK: <response_data>          // Success
400 Bad Request: <error_detail>  // Invalid command
404 Not Found: <error_detail>    // Device not found
```

## Event Protocol

### Event Format
Events are streamed continuously in this format:
```
<device_type> <action> <network>/<application>/<group> [<level>]
```

### Event Examples
```
lighting on 254/56/4                 // Light 4 turned on
lighting ramp 254/56/4 128           // Light 4 dimmed to 50%
trigger on 254/202/10                // Motion sensor triggered
enable on 254/203/2                  // Blind started opening
```

## MQTT Integration

### Topic Structure
MQTT topics follow this pattern:
```
cbus/write/<network>/<app>/<group>/<command>    // Commands TO C-Bus
cbus/read/<network>/<app>/<group>/state         // Status FROM C-Bus
cbus/read/<network>/<app>/<group>/level         // Level FROM C-Bus
```

### Command Translation
MQTT commands are translated to C-Gate commands:

| MQTT Topic | MQTT Payload | C-Gate Command |
|------------|--------------|----------------|
| `cbus/write/254/56/4/switch` | `ON` | `ON //Project/254/56/4` |
| `cbus/write/254/56/4/switch` | `OFF` | `OFF //Project/254/56/4` |
| `cbus/write/254/56/4/ramp` | `128` | `RAMP //Project/254/56/4 128` |
| `cbus/write/254/56/4/ramp` | `75,2s` | `RAMP //Project/254/56/4 192 2s` |

### Event Translation  
C-Bus events are published to MQTT:

| C-Bus Event | MQTT Topic | MQTT Payload |
|-------------|------------|--------------|
| `lighting on 254/56/4` | `cbus/read/254/56/4/state` | `ON` |
| `lighting ramp 254/56/4 128` | `cbus/read/254/56/4/level` | `128` |

## Error Handling

### Connection Errors
- **Timeout**: C-Gate not responding (check network/firewall)
- **Connection Refused**: C-Gate not running or wrong port
- **Authentication Failed**: Invalid C-Gate credentials

### Command Errors
- **400 Bad Request**: Invalid command syntax
- **401 Unauthorized**: C-Gate security restrictions
- **404 Not Found**: Device/group doesn't exist
- **406 Not Acceptable**: Command not supported by device

### Recovery Strategies
1. **Connection Pool**: Multiple connections provide redundancy
2. **Automatic Reconnection**: Exponential backoff reconnection
3. **Health Monitoring**: Regular keep-alive checks
4. **Queue Management**: Commands queued during disconnections

## Performance Optimization

### Connection Pooling
- **3 Command Connections**: Parallel command execution
- **Round-Robin Load Balancing**: Distributes load evenly
- **Health Monitoring**: Unhealthy connections replaced automatically

### Message Throttling
- **Configurable Interval**: Default 100ms between commands
- **Queue Management**: Commands queued during high load
- **Burst Protection**: Prevents overwhelming C-Gate

### Keep-Alive Strategy
- **Regular Pings**: Maintain connection health
- **Timeout Detection**: Detect failed connections quickly
- **Automatic Recovery**: Replace failed connections

## Troubleshooting

### Common Issues

1. **Commands Not Working**
   - Check C-Gate is running and accessible
   - Verify network/application/group addresses
   - Check command syntax and parameters

2. **Events Not Received**
   - Verify event connection to port 20025
   - Check C-Gate event configuration
   - Ensure network traffic isn't filtered

3. **Slow Response**
   - Check network latency to C-Gate
   - Verify connection pool health
   - Adjust message interval if needed

### Debug Logging
Enable detailed logging with:
```bash
LOG_LEVEL=debug npm start
```

This provides detailed information about:
- Command execution and responses
- Event processing and parsing
- Connection health and status
- MQTT message translation

## References

- [Clipsal C-Bus System Overview](https://www.clipsal.com/Trade/Products/ProductGroup?CategoryGuid=e4ba8c60-11b9-4077-9e97-05bdf81c9ee7)
- [C-Gate Server Manual](https://updates.clipsal.com/ClipsalSoftwareDownload/DL/downloads/OpenC-Bus/OpenC-Bus%20C-Gate%20Server%20Guide_1.15.7.pdf)
- [Home Assistant C-Bus Integration](https://www.home-assistant.io/integrations/cbus/)
