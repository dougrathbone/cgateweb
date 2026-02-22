# Home Assistant Add-on: C-Gate Web Bridge

Bridge between Clipsal C-Bus automation systems and MQTT/Home Assistant, providing seamless integration of C-Bus lighting, covers, and switches with Home Assistant.

## About

This add-on packages the cgateweb Node.js application as a Home Assistant add-on, allowing you to connect your Clipsal C-Bus automation system to Home Assistant via MQTT. The bridge automatically discovers C-Bus devices and creates corresponding Home Assistant entities.

The add-on supports two modes:

- **Remote mode** (default): Connects to a C-Gate server running elsewhere on your network.
- **Managed mode**: Downloads, installs, and runs C-Gate locally inside this add-on.

## Installation

1. Add this repository to your Home Assistant add-on store
2. Install the "C-Gate Web Bridge" add-on
3. Configure the add-on settings (see Configuration section below)
4. Start the add-on

## Configuration

### C-Gate Mode

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `cgate_mode` | list | `remote` | `remote` connects to an external C-Gate server. `managed` runs C-Gate locally inside the add-on. |

### C-Gate Connection Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `cgate_host` | string | (empty) | IP address of the C-Gate server (ignored in managed mode) |
| `cgate_port` | integer | `20023` | C-Gate command port |
| `cgate_event_port` | integer | `20025` | C-Gate event port for real-time device updates |
| `cgate_project` | string | `HOME` | C-Gate project name |

### C-Gate Managed Mode Settings

These settings only apply when `cgate_mode` is set to `managed`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `cgate_install_source` | list | `download` | `download` fetches C-Gate from the official Clipsal URL. `upload` uses a zip file you place in `/share/cgate/`. |
| `cgate_download_url` | string | (empty) | Override the default download URL for C-Gate. Leave empty to use the official Clipsal URL. |

#### Uploading C-Gate manually

If you choose `upload` as the install source:

1. Download the C-Gate Linux package from the [Clipsal downloads page](https://updates.clipsal.com/ClipsalSoftwareDownload/mainsite/cis/technical/downloads/index.html)
2. Place the `.zip` file in the `/share/cgate/` directory on your Home Assistant instance (accessible via the Samba, SSH, or File Editor add-ons)
3. Restart the add-on -- it will detect and install from the zip file

### MQTT Settings

MQTT connection details are **automatically detected** from the Mosquitto add-on. You do not need to configure these unless you are using an external MQTT broker.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `mqtt_host` | string | (auto) | MQTT broker hostname/IP. Auto-detected from Mosquitto add-on. |
| `mqtt_port` | integer | (auto) | MQTT broker port. Auto-detected from Mosquitto add-on. |
| `mqtt_username` | string | (auto) | MQTT username. Auto-detected from Mosquitto add-on. |
| `mqtt_password` | password | (auto) | MQTT password. Auto-detected from Mosquitto add-on. |

### C-Bus Monitoring

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `getall_networks` | list | `[254]` | List of C-Bus network IDs to monitor |
| `getall_on_start` | boolean | `true` | Request all device states on startup |
| `getall_period` | integer | `3600` | How often to request all states (seconds) |
| `retain_reads` | boolean | `false` | Set MQTT retain flag for state messages |
| `message_interval` | integer | `200` | Delay between C-Gate commands (milliseconds) |

### Logging

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `log_level` | list | `info` | Log level: `debug`, `info`, `warn`, `error` |

### Home Assistant Discovery

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `ha_discovery_enabled` | boolean | `true` | Enable automatic device discovery |
| `ha_discovery_prefix` | string | `homeassistant` | MQTT discovery topic prefix |
| `ha_discovery_networks` | list | `[254]` | Networks to scan for discovery (uses `getall_networks` if empty) |
| `ha_discovery_cover_app_id` | integer | `203` | C-Bus app ID for covers (blinds/shutters) |
| `ha_discovery_switch_app_id` | integer | (null) | C-Bus app ID for switches (optional) |

## Finding Your C-Bus Network ID

Several settings require your C-Bus **network ID** -- a number between 1 and 255 that identifies a physical C-Bus network. Most residential installations have a single network numbered **254** (the factory default), which is why this add-on defaults to `[254]`.

You only need to change this if your installer configured a non-standard network number, or if your system has multiple C-Bus networks.

### How to find it

**Option 1: C-Gate Toolkit (recommended)**

1. Open the C-Gate Toolkit application and connect to your C-Gate server
2. Expand your project in the left-hand tree
3. The network numbers are listed directly under the project node (e.g., "Network 254")

**Option 2: C-Bus Toolkit (CBAT / Clipsal Toolkit)**

1. Open your C-Bus Toolkit project file
2. Go to **Project** > **Network List**
3. The "Network Number" column shows your network IDs

**Option 3: C-Gate command line**

Connect to C-Gate on port 20023 (telnet or netcat) and run:

```
tree //YOUR_PROJECT
```

This lists all networks under the project. Look for lines like `//HOME/254` -- the number after the last slash is your network ID.

### Multiple networks

If your installation has more than one C-Bus network (e.g., a main lighting network and a separate network for HVAC), list all network IDs you want to monitor:

```yaml
getall_networks:
  - 254
  - 1
ha_discovery_networks:
  - 254
  - 1
```

## Example Configuration

### Remote mode (external C-Gate server)

Minimal configuration -- MQTT is auto-detected from the Mosquitto add-on:

```yaml
cgate_mode: "remote"
cgate_host: "192.168.1.100"
cgate_project: "HOME"
```

With all options shown:

```yaml
cgate_mode: "remote"
cgate_host: "192.168.1.100"
cgate_port: 20023
cgate_event_port: 20025
cgate_project: "HOME"

# MQTT (only needed for external brokers, auto-detected for Mosquitto add-on)
# mqtt_host: "my-broker.local"
# mqtt_port: 1883
# mqtt_username: "user"
# mqtt_password: "pass"

getall_networks: [254]
getall_on_start: true
getall_period: 3600

ha_discovery_enabled: true
ha_discovery_networks: [254]
ha_discovery_cover_app_id: 203

log_level: "info"
```

### Managed mode (C-Gate runs inside the add-on)

```yaml
cgate_mode: "managed"
cgate_install_source: "download"
cgate_project: "HOME"

getall_networks: [254]
getall_on_start: true

ha_discovery_enabled: true
ha_discovery_networks: [254]

log_level: "info"
```

## MQTT Topics

The add-on publishes and subscribes to MQTT topics in the following format:

### State Topics (Published by add-on)
- `cbus/read/{network}/{app}/{group}/state` - ON/OFF state
- `cbus/read/{network}/{app}/{group}/level` - Brightness level (0-100)

### Command Topics (Subscribed by add-on)
- `cbus/write/{network}/{app}/{group}/switch` - ON/OFF commands
- `cbus/write/{network}/{app}/{group}/ramp` - Brightness commands (0-100)

### Discovery Topics (Published by add-on)
- `homeassistant/light/cgateweb_{network}_{app}_{group}/config` - Light discovery
- `homeassistant/cover/cgateweb_{network}_{app}_{group}/config` - Cover discovery
- `homeassistant/switch/cgateweb_{network}_{app}_{group}/config` - Switch discovery

## Device Discovery

When `ha_discovery_enabled` is true, the add-on automatically:

1. Scans configured C-Bus networks for devices
2. Creates Home Assistant entities for:
   - **Lights** (App 56): Dimmable lighting groups
   - **Covers** (App 203 or configured): Blinds, shutters, garage doors
   - **Switches** (configurable app): Generic on/off devices
3. Updates device names from C-Gate labels
4. Publishes discovery configuration to MQTT

## Networking

This add-on uses `host_network: true` to allow direct access to:
- C-Gate server (ports 20023 and 20025)
- MQTT broker
- Any other network services your C-Bus system requires

## Troubleshooting

### Add-on won't start
1. Check that C-Gate server is running and accessible (remote mode)
2. Verify MQTT broker is reachable
3. Check add-on logs for specific error messages
4. Ensure network configuration allows connections to required ports

### No devices discovered
1. Verify `ha_discovery_enabled` is `true`
2. Check `ha_discovery_networks` includes your C-Bus network IDs (default is `[254]` -- see "Finding Your C-Bus Network ID" above if your network uses a different number)
3. Ensure C-Gate project is loaded and devices are configured
4. Check MQTT discovery topic prefix matches Home Assistant configuration

### Devices not responding
1. Verify MQTT topics are being published (use MQTT client to monitor)
2. Check C-Gate connection is stable
3. Ensure device addresses match C-Bus configuration
4. Verify `getall_networks` includes the relevant networks

### Managed mode: C-Gate won't install
1. Check add-on logs for download errors
2. Verify internet connectivity from the add-on
3. Try `upload` mode and place the zip file in `/share/cgate/` manually
4. Ensure the C-Gate zip file is a valid Linux package

### Performance issues
1. Increase `message_interval` to reduce C-Gate command frequency
2. Disable `getall_on_start` if not needed
3. Increase `getall_period` to reduce periodic state requests
4. Check network latency between add-on and C-Gate server

## Support

For issues, feature requests, and contributions:
- GitHub: https://github.com/dougrathbone/cgateweb
- Report bugs via GitHub Issues
- Check existing issues before creating new ones

## Version History

See CHANGELOG.md for detailed version history and changes.
