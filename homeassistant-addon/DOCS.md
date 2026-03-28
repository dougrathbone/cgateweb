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
| `cgate_download_sha256` | string | (empty) | Optional SHA256 checksum to verify downloaded/uploaded C-Gate zip integrity before install. |

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

### MQTT TLS Settings

These settings are only needed when connecting to an external MQTT broker that requires TLS encryption. The built-in Mosquitto add-on does not require TLS configuration.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `mqtt_use_tls` | boolean | `false` | Connect using TLS (mqtts://). Enable for brokers that require encrypted connections, typically on port 8883. |
| `mqtt_ca_file` | string | (empty) | Path to a CA certificate file for verifying the broker's certificate. Required for self-signed broker certificates. Store certs in `/ssl/` on Home Assistant (e.g., `/ssl/ca.crt`). |
| `mqtt_reject_unauthorized` | boolean | `true` | Reject connections if the broker certificate cannot be verified. Disable only when using a self-signed certificate without a CA file. |

#### Example: external broker with self-signed certificate

```yaml
mqtt_host: "mqtt.example.com"
mqtt_port: 8883
mqtt_use_tls: true
mqtt_ca_file: "/ssl/mqtt-ca.crt"
mqtt_reject_unauthorized: true
```

#### Example: external broker with TLS, no certificate verification

```yaml
mqtt_host: "mqtt.example.com"
mqtt_port: 8883
mqtt_use_tls: true
mqtt_reject_unauthorized: false
```

### C-Bus Monitoring

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `auto_discover_networks` | boolean | `true` | Automatically discover C-Bus network IDs from C-Gate on connect |
| `getall_networks` | list | `[254]` | List of C-Bus network IDs to monitor (overrides auto-discovery) |
| `getall_on_start` | boolean | `true` | Request all device states on startup |
| `getall_period` | integer | `3600` | How often to request all states (seconds) |
| `retain_reads` | boolean | `false` | Set MQTT retain flag for state messages |
| `message_interval` | integer | `200` | Delay between C-Gate commands (milliseconds) |

#### Network auto-discovery

When `auto_discover_networks` is `true` (the default), the add-on queries `tree //PROJECT` on connect and parses the response to find all C-Bus network IDs. The discovered networks are used for device polling and HA Discovery unless you have explicitly configured `getall_networks` or `ha_discovery_networks`.

This means most users do not need to set `getall_networks` or `ha_discovery_networks` at all — the add-on finds your networks automatically.

Disable auto-discovery (`auto_discover_networks: false`) if:
- You want to restrict polling/discovery to a specific subset of networks
- Your C-Gate version does not support the `tree` command
- You observe unexpected behaviour caused by auto-discovery picking up networks you do not want monitored

### Logging

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `log_level` | list | `info` | Log level: `debug`, `info`, `warn`, `error` |

### Web/API Security

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `web_api_key` | password | (empty) | API key required for write operations (`PUT/PATCH/POST`) on label-management endpoints. |
| `web_allow_unauthenticated_mutations` | boolean | `false` | Unsafe override to allow write operations without API key authentication. |
| `web_allowed_origins` | list | `[]` | Optional CORS allowlist of browser origins (e.g. `https://ha.example.com`). Empty disables cross-origin access. |
| `web_mutation_rate_limit_per_minute` | integer | `120` | Per-client write rate limit for label mutation endpoints. |

### Home Assistant Discovery

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `ha_discovery_enabled` | boolean | `true` | Enable automatic device discovery |
| `ha_discovery_prefix` | string | `homeassistant` | MQTT discovery topic prefix |
| `ha_discovery_networks` | list | `[254]` | Networks to scan for discovery (uses `getall_networks` if empty) |
| `ha_discovery_cover_app_id` | integer | `203` | C-Bus app ID for covers (blinds/shutters). Set to `203` (Enable Control) by default. Leave empty to disable. |
| `ha_discovery_switch_app_id` | integer | (null) | C-Bus app ID for switches (optional). Leave empty to disable switch discovery. |
| `ha_discovery_trigger_app_id` | integer | (null) | C-Bus app ID for trigger groups (keypads, scene buttons). Typically `202`. Each group is exposed as an HA `event` entity, a companion `button` entity, and (when `ha_discovery_scene_enabled` is `true`) a `scene` entity. Leave empty to disable. |
| `ha_discovery_scene_enabled` | boolean | `true` | Publish an HA `scene` entity for each C-Bus trigger group in addition to the `event` and `button` entities. Set to `false` to suppress scene entities. |
| `ha_discovery_hvac_app_id` | integer | (null) | C-Bus app ID for HVAC/climate zones. The standard C-Bus HVAC application is `201`. Each group is exposed as an HA `climate` entity. Leave empty to disable. |
| `ha_hvac_temperature_unit` | list | `C` | Temperature unit for HVAC climate entities: `C` for Celsius, `F` for Fahrenheit. |
| `ha_bridge_diagnostics_enabled` | boolean | `true` | Publish bridge health/diagnostic entities to Home Assistant via MQTT Discovery |
| `ha_bridge_diagnostics_interval_sec` | integer | `60` | How often to refresh bridge diagnostic states (seconds) |

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
- `homeassistant/event/cgateweb_{network}_{app}_{group}/config` - Trigger group event discovery
- `homeassistant/button/cgateweb_{network}_{app}_{group}/config` - Trigger group button discovery
- `homeassistant/scene/cgateweb_{network}_{app}_{group}_scene/config` - Trigger group scene discovery
- `homeassistant/climate/cgateweb_{network}_{app}_{group}/config` - HVAC climate discovery
- `homeassistant/sensor/cgateweb_bridge_*/config` - Bridge diagnostics discovery
- `homeassistant/binary_sensor/cgateweb_bridge_*/config` - Bridge connectivity discovery

### Bridge Diagnostics Topics (Published by add-on)
- `cbus/read/bridge/diagnostics/ready/state`
- `cbus/read/bridge/diagnostics/lifecycle_state/state`
- `cbus/read/bridge/diagnostics/mqtt_connected/state`
- `cbus/read/bridge/diagnostics/event_connected/state`
- `cbus/read/bridge/diagnostics/command_pool_healthy/state`
- `cbus/read/bridge/diagnostics/command_queue_depth/state`
- `cbus/read/bridge/diagnostics/reconnect_indicator/state`
- `cbus/read/bridge/diagnostics/cgate_version/state` (managed mode only)

## Device Discovery

When `ha_discovery_enabled` is true, the add-on automatically:

1. Scans configured C-Bus networks for devices
2. Creates Home Assistant entities for:
   - **Lights** (App 56): Dimmable lighting groups — always enabled
   - **Covers** (App 203 or configured): Blinds, shutters, garage doors
   - **Switches** (configurable app): Generic on/off devices
   - **Triggers** (App 202 or configured): Keypads and scene buttons, exposed as HA `event` + `button` entity pairs — opt-in via `ha_discovery_trigger_app_id`
   - **HVAC zones** (App 201 or configured): Heating/cooling zones as HA `climate` entities — opt-in via `ha_discovery_hvac_app_id`
3. Updates device names from C-Gate labels
4. Publishes discovery configuration to MQTT

## C-Bus Application IDs

C-Bus organises device functions into numbered **applications**. Each application defines the behaviour of a group of C-Bus group addresses (devices). Knowing the application ID for each device type lets you configure discovery correctly.

| App ID | C-Bus Application | HA Entity Type | Discovery setting |
|--------|-------------------|----------------|-------------------|
| 56 | Lighting | `light` | Always enabled |
| 201 | HVAC | `climate` | Opt-in via `ha_discovery_hvac_app_id` |
| 202 | Trigger groups | `event` + `button` | Opt-in via `ha_discovery_trigger_app_id` |
| 203 | Enable Control (covers) | `cover` | `ha_discovery_cover_app_id: 203` (default) |
| Custom | Enable Control (switches) | `switch` | Opt-in via `ha_discovery_switch_app_id` |

The app ID values above are the C-Bus standard defaults. Some installations use non-standard IDs — check your C-Bus Toolkit project if a device type is not being discovered.

### Trigger groups note

Each trigger group address is published as **two** Home Assistant entities:

- An **`event`** entity that fires when the keypad button is pressed physically on the C-Bus network.
- A **`button`** entity that allows Home Assistant to fire the scene programmatically.

To enable trigger discovery, set `ha_discovery_trigger_app_id: 202` (or your actual trigger application ID).

### HVAC note

HVAC climate entities use a temperature encoding based on community reports: 0.5 °C resolution across a 0–50 °C range (or equivalent in Fahrenheit). **Hardware validation is strongly recommended** before relying on HVAC setpoints, as the exact encoding may vary between thermostat models. Do not change a setpoint until you have confirmed that the encoding matches your specific hardware.

Set `ha_discovery_hvac_app_id: 201` to enable HVAC discovery. Use `ha_hvac_temperature_unit` to select `C` (Celsius, default) or `F` (Fahrenheit).

## Networking

This add-on runs with `host_network: false`.

- Ingress is enabled and routes the label editor UI through Home Assistant.
- Port `8080/tcp` is exposed by the add-on for direct access if needed.
- Outbound connections to remote C-Gate and MQTT still work normally from the add-on container.

If you expose `8080`, set `web_api_key` and keep `web_allow_unauthenticated_mutations: false`.

## Advanced: Connection Pool

These settings control the pool of TCP connections used to send commands to C-Gate. The defaults work well for most installations and do not need to be changed.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `connection_pool_size` | integer | `3` | Number of parallel TCP connections to C-Gate for sending commands. Increase for high-throughput installations; reduce to `1` for older C-Gate versions that do not handle concurrent connections well. |
| `connection_health_check_interval_sec` | integer | `30` | How often (seconds) to verify that C-Gate command connections are healthy. Lower values detect failures faster at the cost of slightly more background traffic. |
| `connection_keep_alive_interval_sec` | integer | `60` | How often (seconds) to send keep-alive pings to C-Gate connections. Reduce this value on unstable networks where silent TCP drops are observed. |

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

## Language Support

The add-on configuration UI is available in 17 languages. Home Assistant automatically displays option names and descriptions in your configured language:

- English, German (Deutsch), Spanish (Español), French (Français), Italian (Italiano)
- Dutch (Nederlands), Portuguese (Português), Russian (Русский), Ukrainian (Українська)
- Chinese Simplified (简体中文), Japanese (日本語), Korean (한국어)
- Polish (Polski), Swedish (Svenska), Norwegian (Norsk), Danish (Dansk), Czech (Čeština)

Translation files are located in `translations/` within the add-on directory. To contribute a new translation, copy `translations/en.yaml` to a new file named with the appropriate language code (e.g., `fi.yaml` for Finnish) and translate the `name` and `description` fields.

## Support

For issues, feature requests, and contributions:
- GitHub: https://github.com/dougrathbone/cgateweb
- Report bugs via GitHub Issues
- Check existing issues before creating new ones

## Version History

See CHANGELOG.md for detailed version history and changes.
