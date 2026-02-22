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

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `mqtt_host` | string | `core-mosquitto` | MQTT broker hostname/IP. Defaults to the HA Mosquitto add-on. |
| `mqtt_port` | integer | `1883` | MQTT broker port |
| `mqtt_username` | string | (empty) | MQTT username (optional) |
| `mqtt_password` | password | (empty) | MQTT password (optional) |

### C-Bus Monitoring

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `getall_networks` | list | `[]` | List of C-Bus network IDs to monitor (e.g., `[254]`) |
| `getall_on_start` | boolean | `false` | Request all device states on startup |
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
| `ha_discovery_networks` | list | `[]` | Networks to scan for discovery (uses `getall_networks` if empty) |
| `ha_discovery_cover_app_id` | integer | `203` | C-Bus app ID for covers (blinds/shutters) |
| `ha_discovery_switch_app_id` | integer | (null) | C-Bus app ID for switches (optional) |

## Example Configuration

### Remote mode (external C-Gate server)

```yaml
cgate_mode: "remote"
cgate_host: "192.168.1.100"
cgate_port: 20023
cgate_event_port: 20025
cgate_project: "HOME"

mqtt_host: "core-mosquitto"
mqtt_port: 1883
mqtt_username: "homeassistant"
mqtt_password: "your_mqtt_password"

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

mqtt_host: "core-mosquitto"
mqtt_port: 1883
mqtt_username: "homeassistant"
mqtt_password: "your_mqtt_password"

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
2. Check `ha_discovery_networks` includes your C-Bus network IDs
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
