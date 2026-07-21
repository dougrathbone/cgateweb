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

> **Using a USB PC Interface (5500PC/5500PCU)?** The setup that works today is
> **remote mode**: run C-Gate on any Windows or Linux machine with the USB
> dongle attached, then point this add-on at it (`cgate_mode: remote`,
> `cgate_host` = that machine's IP). Managed mode additionally has opt-in
> alpha serial passthrough — see "Alpha: USB-serial PCI support" below.

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
| `cgate_download_sha256` | string | (empty) | Optional SHA256 of the C-Gate zip. When set, download and upload installs fail on mismatch. Downloads from the built-in default URL are verified against a checksum pinned in the install script; setting this overrides that pin (the escape hatch if Clipsal re-releases the zip). Required for a custom `cgate_download_url`; uploads without it proceed with a log warning and no integrity check. |
| `cgate_force_reinstall` | boolean | `false` | Reinstall/upgrade C-Gate from the install source on the next start. Once C-Gate is installed it is normally kept as is across restarts; turn this on to replace it (for example to move to a newer C-Gate version). Your project DBs and config are preserved. Turn it back off after the upgrade, or C-Gate reinstalls on every boot. |
| `cgate_serial_device` | device | (empty) | **ALPHA — opt-in.** Dropdown of the serial devices detected on the HA host (e.g. `/dev/ttyUSB0` or a `/dev/serial/by-id/...` alias). Hidden optional field; leave empty unless you are testing the alpha. See "Alpha: USB-serial PCI support" below. |

#### Uploading C-Gate manually

If you choose `upload` as the install source:

1. Download the C-Gate Linux package from the [Clipsal downloads page](https://updates.clipsal.com/ClipsalSoftwareDownload/mainsite/cis/technical/downloads/index.html)
2. Place the `.zip` file in the `/share/cgate/` directory on your Home Assistant instance (accessible via the Samba, SSH, or File Editor add-ons)
3. Restart the add-on -- it will detect and install from the zip file

#### Upgrading C-Gate after it is already installed

C-Gate is installed once onto the add-on's persistent `/data` volume and then
left in place across restarts (only its config is refreshed each boot). To move
to a different C-Gate version:

- **Upload mode**: drop the newer `.zip` into `/share/cgate/` and restart. The
  add-on notices the newer zip and reinstalls automatically.
- **Either mode**: turn on `cgate_force_reinstall`, restart to reinstall from the
  install source, then turn it back off.

Both paths preserve your project databases (`Projects/`) and C-Gate config
across the reinstall.

#### Loading your C-Gate project in managed mode

Installing C-Gate (above) gives you a running C-Gate process but does **not**
populate it with your project. C-Gate loads each project from a database file
at `Projects/<PROJECTNAME>/<PROJECTNAME>.db` inside its install directory (the
location set by C-Gate's `project.default.dir`). If that project is missing,
requests like `tree 254` return `401 Bad object or device ID` and Home
Assistant Discovery cannot find any devices.

The supported workflow for managed mode is:

1. Build your project in C-Bus Toolkit on a Windows machine, or copy it from an
   existing C-Gate install. The file you need is `<PROJECTNAME>.db` from
   C-Gate's `tag/` directory (where `<PROJECTNAME>` matches the `cgate_project`
   add-on option, case-sensitive).
2. Place the `.db` file in `/share/cgate/tag/` on your Home Assistant instance
   (accessible via the Samba, SSH, or File Editor add-ons). Create the
   directory if it does not exist.
3. Restart the add-on. On startup it copies each `/share/cgate/tag/<NAME>.db`
   into `Projects/<NAME>/<NAME>.db` where C-Gate expects it, and sets
   `project.start=<cgate_project>` so C-Gate loads and starts the project
   automatically.

The sync only overwrites the project `.db` when the `/share/cgate/tag/` copy is
newer, so you will not lose state that managed C-Gate writes back between
restarts. To force a re-sync, `touch` the file in `/share/cgate/tag/` before
restarting.

**Note on the web UI's `.cbz` / `.xml` / `.db` import**: the add-on's built-in
Web UI (C-Bus Labels) imports labels only - it extracts network/application/group
names so they appear as MQTT Discovery friendly names. It accepts a Toolkit
XML export, an older `.cbz` (zipped XML), and the newer C-Bus Toolkit 1.17.x
`.cbz`/`.db` form (a SQLite project database) - the labels are read straight
from the database. It does **not** load the actual C-Gate project; making
managed C-Gate serve your project still uses the `.db` workflow above.

#### Alpha: USB-serial PCI support

> **Status: ALPHA — opt-in, off by default, and largely untested.** Please
> report success or failure on
> [GitHub issue #28](https://github.com/dougrathbone/cgateweb/issues/28).

Managed mode can pass a USB PC Interface (5500PC/5500PCU) attached to your
Home Assistant host through to the C-Gate instance running inside the add-on.
The add-on declares `uart: true`, so the Supervisor maps the host's serial
devices into the container automatically — no manual device mapping is needed.

**Requirements**

- `cgate_mode: managed` (in remote mode C-Gate runs elsewhere, so a local
  serial device is never used)
- A USB PC Interface plugged into the Home Assistant host
- A C-Bus Toolkit project that defines a **serial PC Interface** for the
  network — the network↔interface binding lives in the project `.db`, not in
  any C-Gate config file, so this add-on cannot set it up for you

**Enabling**

1. In the add-on's **Configuration** tab, click **Show unused optional
   configuration options** and find **Serial PCI Device (Alpha)**. The field
   renders as a dropdown listing the serial devices the Supervisor detects on
   your host (`/dev/ttyUSB*`, `/dev/ttyACM*`, and their stable
   `/dev/serial/by-id/...` aliases). Prefer a `/dev/serial/by-id/...` entry —
   it survives replugging the dongle into a different USB port. Not sure which
   entry is your PC Interface? Check **Settings → System → Hardware →
   ⋮ (top right) → All hardware**.
2. If your device does not appear in the dropdown, or you want to enter a
   custom path, switch the configuration editor to YAML mode (⋮ top right →
   **Edit in YAML**) and add:
   ```yaml
   cgate_serial_device: /dev/ttyUSB0
   ```
3. Restart the add-on. Startup validates the path, logs an inventory of the
   serial devices it detected, and fails fast with a readable error if the
   value is not a `/dev/` path or the device does not exist.

**Diagnostics**

When `cgate_serial_device` is set, startup logs extra detail so you (and
issue #28) can see what the host and C-Gate actually see:

- At add-on initialisation: the configured device with its `ls -l` details
  and resolved symlink target (so a `/dev/serial/by-id/` path shows the real
  `ttyUSB*`/`ttyACM*` node), plus an inventory of every detected
  `/dev/ttyUSB*`, `/dev/ttyACM*` and `/dev/serial/by-id/` entry.
- Once managed C-Gate is accepting commands: the output of the C-Gate
  `PORT LIST` and `PORT IFLIST` commands, showing which ports/interfaces C-Gate
  itself opened. This runs in the background and never blocks startup.

**Troubleshooting**

- **`401 Network not found` on every network command:** the C-Bus project is
  not installed in C-Gate. Importing labels into the Web UI does **not** do
  this — install the Toolkit `.db` into `/share/cgate/tag/` as described in
  "Loading your C-Gate project in managed mode" above and restart. Startup
  also logs an explicit warning when no project database is found.

When reporting a problem on
[GitHub issue #28](https://github.com/dougrathbone/cgateweb/issues/28),
restart the add-on and copy its full startup log (**Settings → Add-ons →
C-Gate Web Bridge → Log**) into your report — the diagnostics block is
clearly marked with a banner so you can see exactly what to include.

**Known limitations**

- **Projects saved on Windows reference `COMx` ports.** If your Toolkit
  project was built on Windows, its PC Interface entry points at a COM port
  that does not exist on Linux. Re-point the interface at the Linux device
  path in C-Bus Toolkit, then copy the `.db` over as described in "Loading
  your C-Gate project in managed mode" above.
- **Untested on ARM** (aarch64/armhf/armv7) and only lightly tested on
  amd64 — which is why this ships as an opt-in alpha.
- Whether a given dongle/USB chipset works depends on C-Gate's bundled serial
  support; not every combination may function.

If the alpha does not work for your setup, the remote-mode arrangement
described under "C-Gate Mode" above (C-Gate on any machine with the dongle)
remains the stable path for USB PC Interfaces.

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
| `mqtt_reject_unauthorized` | boolean | `true` | Reject connections if the broker certificate cannot be verified. Keep enabled whenever possible; disabling exposes a MITM risk — prefer `mqtt_ca_file` with a trusted CA instead. |

#### Example: external broker with self-signed certificate

```yaml
mqtt_host: "mqtt.example.com"
mqtt_port: 8883
mqtt_use_tls: true
mqtt_ca_file: "/ssl/mqtt-ca.crt"
mqtt_reject_unauthorized: true
```

#### Example: external broker with TLS, no certificate verification

> **Caution:** Disabling certificate verification (`mqtt_reject_unauthorized: false`) leaves the connection open to man-in-the-middle attacks. Prefer providing `mqtt_ca_file` instead.

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
| `getall_app_periods` | map | `{}` | Per-app poll interval overrides (seconds). Key is app ID (e.g. `"201"`), value is interval in seconds. Set to `0` to disable polling for that app. |
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
| `web_api_key` | password | (empty) | API key required for write operations (`PUT/PATCH/POST`) on label-management endpoints when accessed **directly** (not via Ingress). Requests through Home Assistant Ingress are already authenticated by HA and do not need this key. |
| `web_allow_unauthenticated_mutations` | boolean | `false` | Unsafe override to allow write operations without authentication on the **directly-exposed** port. Not needed for the Ingress UI. |
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
| `ha_discovery_auto_type` | boolean | `true` | Auto-detect device types for Lighting-application (56) groups. Currently detects motorised covers (blinds/shutters) from the group label. A manual `type_overrides` entry and application-id mappings always take precedence; auto-detection only upgrades the default `light`. |
| `ha_discovery_type_from_label_prefix` | boolean | `false` | Treat a group label starting with an entity-domain prefix as that device type for discovery (e.g. `cover.bedroom_shutter` → cover, `switch.porch_light` → switch). Supported prefixes: `light.`, `cover.`, `switch.`, `relay.`, `pir.` A manual `type_overrides` entry always wins. |
| `ha_discovery_auto_type_name_heuristics` | boolean | `true` | When `ha_discovery_auto_type` is on, classify covers by matching the group label against the cover keyword list. Set to `false` to turn keyword matching off. |
| `ha_discovery_auto_type_cover_keywords` | list | `[blind, shutter, shade, awning, curtain, roller, garage door]` | Keywords that mark a Lighting group as a cover. Matching is case-insensitive and catches plurals. |
| `ha_discovery_hvac_app_id` | integer | (null) | C-Bus app ID for a **lighting-compatible** HVAC group (PAC/touchscreen-exposed). This is NOT the native Air Conditioning application (172) — use it only for groups mirrored onto a lighting-style app by a PAC or touchscreen. Each group is exposed as an HA `climate` entity. Leave empty to disable. |
| `ha_hvac_temperature_unit` | list | `C` | Temperature unit for HVAC climate entities: `C` for Celsius, `F` for Fahrenheit. |
| `cbus_aircon_app_id` | integer | (null) | C-Bus Air Conditioning application id (e.g. `172`) for native thermostat data. Decodes `zone_temperature` (incl. sensor status), `set_zone_hvac_mode` (mode, setpoint, fan speed/mode, flags), `set_ward_on/off`, `zone_hvac_plant_status` (running action + plant error), and — spec-derived, no live captures yet — the humidity verbs (`zone_humidity`, `set_zone_humidity_mode`, `zone_humidity_plant_status`). Topics are keyed by the thermostat's **source unit** (not zone group) to support multiple thermostats: `cbus/read/{network}/172/{sourceUnit}/current_temperature`, `/setpoint`, `/mode` (`off`/`heat`/`cool`/`auto`/`fan_only`), `/state`, `/action`, `/fan_mode`, `/fan_speed`, `/fan_speed_pct`, `/comfort_level`, `/error`, `/error_description`, `/problem`, `/sensor_status`, `/sensor_problem`, `/current_humidity`, `/humidity_mode`, `/humidity_setpoint`, `/humidity_action`. An HA `climate` entity (with fan mode, humidity state) and `problem` binary_sensors for plant/sensor faults are auto-created per thermostat. Off by default. |
| `cbus_aircon_control_enabled` | boolean | `false` | Opt-in to **control** of native Air Conditioning thermostats (writes to live heating/cooling): enables `cbus/write/{network}/172/{sourceUnit}/setpoint` (°C), `/hvacmode` (`off`/`heat`/`cool`/`auto`/`fan_only`), and `/fanmode` (`automatic`/`continuous`), and adds command topics to the discovered climate entity. Setpoint writes are debounced (3s) per the protocol's echo guidance; flags, per-mode setpoints, and fan state learned from the thermostat are echoed on writes. Also sends `AIRCON REFRESH` when a zone group is first seen. |
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
- `cbus/read/{network}/{app}/{group}/source_unit` - The C-Bus unit that originated the last event for this group (omitted when the event has no source, e.g. sync updates)

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

### MQTT broker ACL (optional)

If your broker uses ACLs, grant the cgateweb user at least:

| Access | Topics |
|--------|--------|
| **Subscribe** | `cbus/write/#` |
| **Publish** | `cbus/read/#`, `cbus/bridge/#`, `hello/cgateweb` |
| **Publish** (HA Discovery) | `{ha_discovery_prefix}/#` (default `homeassistant/#`) |

Example Mosquitto ACL:

```
user cgateweb
topic readwrite cbus/#
topic write hello/cgateweb
topic write homeassistant/#
```

Tighten further if you prefer separate read/write rules. Home Assistant and other clients need complementary access to the same state/command topics.

### Bridge Diagnostics Topics (Published by add-on)
- `cbus/read/bridge/diagnostics/ready/state`
- `cbus/read/bridge/diagnostics/lifecycle_state/state`
- `cbus/read/bridge/diagnostics/mqtt_connected/state`
- `cbus/read/bridge/diagnostics/event_connected/state`
- `cbus/read/bridge/diagnostics/command_pool_healthy/state`
- `cbus/read/bridge/diagnostics/command_queue_depth/state`
- `cbus/read/bridge/diagnostics/reconnect_indicator/state`
- `cbus/read/bridge/diagnostics/cgate_version/state` (managed mode only)

### Stale Device Topics (Published by add-on)
- `cbus/bridge/stale_devices` — integer count of stale devices
- `cbus/bridge/stale_devices_detail` — JSON attributes with per-device details

## Device Discovery

When `ha_discovery_enabled` is true, the add-on automatically:

1. Scans configured C-Bus networks for devices
2. Creates Home Assistant entities for:
   - **Lights** (App 56): Dimmable lighting groups — always enabled
   - **Covers** (App 203 or configured): Blinds, shutters, garage doors
   - **Switches** (configurable app): Generic on/off devices
   - **Triggers** (App 202 or configured): Keypads and scene buttons, exposed as HA `event` + `button` entity pairs — opt-in via `ha_discovery_trigger_app_id`
   - **HVAC zones** (lighting-compatible HVAC group, configured): Heating/cooling zones as HA `climate` entities — opt-in via `ha_discovery_hvac_app_id` (PAC/touchscreen-exposed lighting-style group, NOT native Air Conditioning app 172)
3. Updates device names from C-Gate labels
4. Publishes discovery configuration to MQTT

## C-Bus Application IDs

C-Bus organises device functions into numbered **applications**. Each application defines the behaviour of a group of C-Bus group addresses (devices). Knowing the application ID for each device type lets you configure discovery correctly.

| App ID | C-Bus Application | HA Entity Type | Discovery setting |
|--------|-------------------|----------------|-------------------|
| 56 | Lighting | `light` | Always enabled |
| 172 | Air Conditioning (native) | `climate` entity (auto-created per thermostat) + state topics keyed by source unit | `cbus_aircon_app_id: 172` (+ `cbus_aircon_control_enabled` for control) |
| 202 | Trigger groups | `event` + `button` | Opt-in via `ha_discovery_trigger_app_id` |
| 203 | Enable Control (covers) | `cover` | `ha_discovery_cover_app_id: 203` (default) |
| Custom | Enable Control (switches) | `switch` | Opt-in via `ha_discovery_switch_app_id` |
| Custom | Lighting-compatible HVAC group (PAC/touchscreen-exposed) | `climate` | Opt-in via `ha_discovery_hvac_app_id` |

The app ID values above are the C-Bus standard defaults. Some installations use non-standard IDs — check your C-Bus Toolkit project if a device type is not being discovered.

### Trigger groups note

Each trigger group address is published as **two** Home Assistant entities:

- An **`event`** entity that fires when the keypad button is pressed physically on the C-Bus network.
- A **`button`** entity that allows Home Assistant to fire the scene programmatically.

To enable trigger discovery, set `ha_discovery_trigger_app_id: 202` (or your actual trigger application ID).

### HVAC note

HVAC climate entities use a temperature encoding based on community reports: 0.5 °C resolution across a 0–50 °C range (or equivalent in Fahrenheit). **Hardware validation is strongly recommended** before relying on HVAC setpoints, as the exact encoding may vary between thermostat models. Do not change a setpoint until you have confirmed that the encoding matches your specific hardware.

Set `ha_discovery_hvac_app_id` to the app ID of your lighting-compatible HVAC group (the app your PAC or touchscreen uses to expose HVAC control) to enable HVAC discovery — do NOT use the native Air Conditioning app `172` here. Use `ha_hvac_temperature_unit` to select `C` (Celsius, default) or `F` (Fahrenheit).

To read native thermostat data from the real C-Bus Air Conditioning application, set `cbus_aircon_app_id: 172`. cgateweb decodes room temperature, setpoint, operating mode, fan speed/mode, zone on/off state, plant running action, and plant error state from the AC application and publishes them keyed by the thermostat's source unit address:

- `cbus/read/{network}/172/{sourceUnit}/current_temperature` — room temperature in °C
- `cbus/read/{network}/172/{sourceUnit}/setpoint` — target setpoint in °C
- `cbus/read/{network}/172/{sourceUnit}/mode` — `off`, `heat`, `cool`, `auto`, `fan_only` (all verified against real hardware and the protocol spec)
- `cbus/read/{network}/172/{sourceUnit}/state` — `ON` / `OFF` (zone-group master on/off)
- `cbus/read/{network}/172/{sourceUnit}/action` — `heating` / `cooling` / `fan` / `idle` (live plant running state)
- `cbus/read/{network}/172/{sourceUnit}/fan_mode` — `automatic` / `continuous`; `cbus/read/{network}/172/{sourceUnit}/fan_speed` — raw 0–63 fan speed setting; `cbus/read/{network}/172/{sourceUnit}/fan_speed_pct` — fan speed % when it lives in the raw level
- `cbus/read/{network}/172/{sourceUnit}/error` + `/error_description` + `/problem` — plant error code, text, and problem state (0 = no error)
- `cbus/read/{network}/172/{sourceUnit}/sensor_status` + `/sensor_problem` — temperature sensor status (0 = ok) and problem state
- `cbus/read/{network}/172/{sourceUnit}/current_humidity`, `/humidity_mode`, `/humidity_setpoint`, `/humidity_action` — humidity application state (spec-derived; only present on installs with humidity plant)
- `cbus/read/{network}/172/{sourceUnit}/comfort_level` — evaporative comfort level (only for evaporative plant cooling)

Topics are keyed by **source unit** (the thermostat's unit address, e.g. `201`) rather than zone group, so installations with multiple thermostats sharing a zone group are correctly handled. An HA `climate` entity (with fan mode and humidity state) plus `Plant problem` and `Temperature sensor problem` binary_sensors are auto-created per thermostat.

Control is **opt-in** via `cbus_aircon_control_enabled` (off by default — it writes to live heating/cooling). When enabled: publish a target in °C to `cbus/write/{network}/172/{sourceUnit}/setpoint`, a mode (`off`/`heat`/`cool`/`auto`/`fan_only`) to `cbus/write/{network}/172/{sourceUnit}/hvacmode`, or a fan mode (`automatic`/`continuous`) to `cbus/write/{network}/172/{sourceUnit}/fanmode`. Setpoint writes are debounced to one command per 3s per the protocol's anti-echo guidance, and the thermostat's own flags, per-mode setpoints, and fan state are learned and echoed on writes.

## Networking

This add-on runs with `host_network: false`.

- Ingress is enabled and routes the label editor UI through Home Assistant. Requests arriving via Ingress are already authenticated by Home Assistant (the Supervisor injects an `X-Ingress-Path` header), so label edits and `.cbz`/XML imports work out of the box with no `web_api_key`. At startup the add-on discovers its ingress entry path from the Supervisor API (`/addons/self/info`) and trusts requests carrying it; if that lookup fails, ingress API access stays denied (401) and a warning is logged — set `web_api_key` as a fallback.
- Port `8080/tcp` is exposed by the add-on for direct access if needed.
- Outbound connections to remote C-Gate and MQTT still work normally from the add-on container.

If you expose `8080` for direct (non-Ingress) access, set `web_api_key` and keep `web_allow_unauthenticated_mutations: false`. Direct requests never carry the Ingress header, so they always require the key.

## Stale Device Detection

When enabled, the bridge periodically scans all C-Bus devices that have reported at least one state change and flags any whose last update is older than the configured threshold. Results are published as a Home Assistant `sensor` diagnostic entity called **C-Bus Stale Devices**.

Only devices that have reported at least once are checked. Groups that have never sent an event (e.g. genuinely unused addresses) are not flagged.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `stale_device_detection_enabled` | bool | `true` | Enable or disable stale device scanning. |
| `stale_device_threshold_hours` | integer | `24` | Hours without a state update before a device is considered stale. Valid range: 1–720. |
| `stale_device_check_interval_sec` | integer | `3600` | How often (seconds) to run the scan and update the sensor. Valid range: 60–86400. |

The sensor state is the count of stale devices (e.g. `3`). A JSON attributes payload is published to `cbus/bridge/stale_devices_detail` with a list of affected devices, their labels, last-seen timestamps, and how many hours ago they last reported.

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
