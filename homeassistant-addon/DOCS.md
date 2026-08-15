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
> serial passthrough (beta — field-tested with both interfaces) — see
> "USB-serial PCI support" below.

### C-Gate Connection Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `cgate_host` | string | (empty) | IP address of the C-Gate server (ignored in managed mode) |
| `cgate_port` | integer | `20023` | C-Gate command port. Leave at `20023` if you intend to expose managed C-Gate to external clients — Home Assistant can only map ports the add-on declares, and the declared port is `20023/tcp`. |
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
| `cgate_serial_device` | device | (empty) | **BETA — opt-in, field-tested with 5500PC and 5500PCU.** Dropdown of the serial devices detected on the HA host. Prefer a `/dev/serial/by-id/...` alias over a bare `/dev/ttyUSB0`: it survives replugging into another USB port. Hidden optional field; leave empty to disable. See "USB-serial PCI support" below. |
| `cgate_external_clients` | list of objects | `[]` | Addresses allowed to connect to the managed C-Gate (for tools such as C-Bus Toolkit), each with an `address` and a `level` of `monitor`, `operate` or `program`. Empty means the add-on itself only. **C-Gate has no authentication on its ports** — see "Letting external clients reach managed C-Gate" below before using this. |

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

**Only a `.db` file is loaded.** A `.cbz` or `.xml` placed in
`/share/cgate/tag/` will **not** be synced or loaded into C-Gate — the sync
step only ever looks for `<PROJECTNAME>.db`, and anything else is left where
it is with a startup log warning naming it.

The supported workflow for managed mode is:

1. Build your project in C-Bus Toolkit on a Windows machine, or copy it from an
   existing C-Gate install. The file you need is `<PROJECTNAME>.db` from
   C-Gate's `tag/` directory (where `<PROJECTNAME>` matches the `cgate_project`
   add-on option, case-sensitive) — **not** a Toolkit `.cbz`/XML export.
2. Place the `.db` file in `/share/cgate/tag/` on your Home Assistant instance
   (accessible via the Samba, SSH, or File Editor add-ons). Create the
   directory if it does not exist.
   > `/share` here is the **top-level** Home Assistant share. It is not the
   > same as a `share` folder you create inside your Home Assistant config
   > directory (what the File Editor add-on shows as `/homeassistant`) — files
   > placed there are invisible to this add-on.
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

#### USB-serial PCI support

> **Status: BETA — opt-in, off by default.** Field-tested with both the
> 5500PCU (native USB) and a 5500PC over a USB-to-serial adapter, including
> Windows-saved projects (their `COMx` interfaces are rewritten to your device
> automatically). Please report problems on
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
   configuration options** and find **Serial PCI Device (Beta)**. The field
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

**If the interface renumbers across a replug**

Linux hands out `/dev/ttyUSB*` names in the order devices appear, so a PC
Interface unplugged and plugged back in — into another port, or across a host
reboot — can come back under a different name than the one you configured. The
add-on now recovers from this in both places it can happen.

> **The reliable fix is to configure a `/dev/serial/by-id/...` path** rather
> than a bare `/dev/ttyUSB0`. That alias is derived from the device's own
> identity (vendor, product, serial number), so it follows the interface
> between USB ports and the problem never arises. Everything below is the
> safety net for when it does.

*At startup*, the add-on remembers the identity of the serial device it used on
the last good boot. If the configured path has gone missing, or now resolves to
a *different* device than the one remembered, startup re-finds the remembered
interface by its identity, repoints your project database at its new port, and
carries on — instead of failing startup or, worse, quietly driving whatever
unrelated device happens to have taken over that path.

*While running*, C-Gate keeps holding the port it opened, so the network stays
at `InterfaceState=closed` even after you plug the interface back in. The add-on
now recovers from this by itself too: when a network's interface goes down and
the device it was using has vanished (or a `/dev/serial/by-id/...` path now
points at a different port), it re-finds the device by the identity recorded on
the last good boot, repoints your project database at the new port, and restarts
only the internal C-Gate. Expect a short outage while C-Gate restarts; the log
explains what moved where.

This never runs for CNI (ethernet) installs, which have no
`cgate_serial_device`, and it never restarts C-Gate for an interface that is
simply unplugged — there is nothing to reopen until you plug it back in. It
keeps looking while the network stays closed, so however long the interface was
out, recovery happens on the next check (roughly 30 seconds) after you plug it
back in. Within one outage, repeated restarts are spaced out by a growing delay
and capped (three by default), so a faulty cable cannot put C-Gate into a
restart loop; if the cap is reached, recovery stops and says so, and you should
reconnect the interface and restart the add-on. The cap is only refreshed once
the interface has come back up and stayed up for a while, so a long outage
cannot quietly earn itself more restarts.

**Known limitations**

- **Projects saved on Windows reference `COMx` ports** — which cannot exist on
  Linux, leaving the network with `InterfaceState=closed` and an empty tree.
  The add-on handles this for you: when `cgate_serial_device` is set, the
  project sync rewrites any `COMx` interface address in the synced project
  `.db` to your serial device (stored as the bare port name C-Gate lists in
  `PORT LIST`, e.g. `ttyUSB0`). Interfaces already pointing at a Linux-usable
  address are left untouched. If your project's interface is a **CNI (ethernet)
  type** rather than serial, that is a different fix — the startup diagnostics
  (`NET LIST_ALL`) show the project's `interfaceType`/`interfaceAddress` so you
  can tell them apart.
- **Untested on ARM** (aarch64/armhf/armv7) and only lightly tested on
  amd64 — which is why this ships as an opt-in beta.
- Whether a given dongle/USB chipset works depends on C-Gate's bundled serial
  support; not every combination may function.

If this does not work for your setup, the remote-mode arrangement
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
| `getall_on_start` | boolean | _(unset)_ | Request all device states on startup. Not set by default — add it to your add-on options to turn it on. |
| `getall_period` | integer | _(unset)_ | How often to request all states (seconds). Not set by default — no periodic refresh happens until you add it. |
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
| `ha_discovery_cover_app_id` | integer | (unset) | C-Bus app ID whose groups become `cover` entities (blinds/shutters). **Off unless you set it.** `203` is the usual choice, but note C-Bus calls 203 **Enable Control** — a general-purpose application, not a covers-only one. If your 203 groups are something else (disabling keypad buttons is a common use), do not set this, or point it at whichever app your blinds actually use. Motorised covers on the Lighting application are auto-detected by name regardless of this setting. |
| `ha_discovery_switch_app_id` | integer | (null) | C-Bus app ID for switches (optional). Leave empty to disable switch discovery. |
| `ha_discovery_trigger_app_id` | integer | (null) | C-Bus app ID for trigger groups (keypads, scene buttons). Typically `202`. Each group is exposed as an HA `event` entity, a companion `button` entity, and (when `ha_discovery_scene_enabled` is `true`) a `scene` entity. Leave empty to disable. |
| `ha_discovery_scene_enabled` | boolean | `true` | Publish an HA `scene` entity for each C-Bus trigger group in addition to the `event` and `button` entities. Set to `false` to suppress scene entities. |
| `ha_discovery_auto_type` | boolean | `true` | Auto-detect device types for Lighting-application (56) groups. Detects motorised covers (blinds/shutters) from the group label. A manual `type_overrides` entry and a label prefix always take precedence; auto-detection only upgrades the default `light`. Setting this to `false` also disables `ha_discovery_type_from_unit`. Groups on the other `ha_discovery_*_app_id` applications are typed by their application-id mapping and are not classified here at all. |
| `ha_discovery_type_from_label_prefix` | boolean | `false` | Treat a group label starting with an entity-domain prefix as that device type for discovery (e.g. `cover.bedroom_shutter` → cover, `switch.porch_light` → switch). Supported prefixes: `light.`, `cover.`, `switch.`, `relay.`, `pir.` A manual `type_overrides` entry always wins. |
| `ha_discovery_type_from_unit` | boolean | `false` | Decide each Lighting-application group's entity type from the **C-Bus unit hardware** driving it instead of from its name: a dimmer channel stays a dimmable `light`, a relay channel becomes a `light` with **no brightness control**, and a group driven only by an input unit (sensor/key input, e.g. a bus coupler) becomes a `binary_sensor`. Unit types the add-on does not recognise are left alone and logged so they can be reported. **Off by default because enabling it can change the type of entities you already have.** A manual `type_overrides` entry, a label prefix, and a cover-identifying name all still win. See "Entity type from C-Bus unit type" below. |
| `ha_discovery_auto_type_name_heuristics` | boolean | `true` | When `ha_discovery_auto_type` is on, classify covers by matching the group label against the cover keyword list. Set to `false` to turn keyword matching off. |
| `ha_discovery_auto_type_cover_keywords` | list | `[blind, shutter, shade, awning, curtain, roller, garage door]` | Keywords that mark a Lighting group as a cover. Matching is case-insensitive and catches plurals. |
| `ha_discovery_hvac_app_id` | integer | (null) | C-Bus app ID for a **lighting-compatible** HVAC group (PAC/touchscreen-exposed). This is NOT the native Air Conditioning application (172) — use it only for groups mirrored onto a lighting-style app by a PAC or touchscreen. Each group is exposed as an HA `climate` entity. Leave empty to disable. |
| `ha_hvac_temperature_unit` | list | `C` | Temperature unit for HVAC climate entities: `C` for Celsius, `F` for Fahrenheit. |
| `cbus_aircon_app_id` | integer | (null) | C-Bus Air Conditioning application id (e.g. `172`) for native thermostat data. Decodes `zone_temperature` (incl. sensor status), `set_zone_hvac_mode` (mode, setpoint, fan speed/mode, flags), `set_ward_on/off`, `zone_hvac_plant_status` (running action + plant error), and — spec-derived, no live captures yet — the humidity verbs (`zone_humidity`, `set_zone_humidity_mode`, `zone_humidity_plant_status`). Topics are keyed by the thermostat's **source unit** (not zone group) to support multiple thermostats: `cbus/read/{network}/172/{sourceUnit}/current_temperature`, `/setpoint`, `/mode` (`off`/`heat`/`cool`/`auto`/`fan_only`), `/state`, `/action`, `/fan_mode`, `/fan_speed`, `/fan_speed_pct`, `/comfort_level`, `/error`, `/error_description`, `/problem`, `/sensor_status`, `/sensor_problem`, `/current_humidity`, `/humidity_mode`, `/humidity_setpoint`, `/humidity_action`. An HA `climate` entity (with fan mode, humidity state) and `problem` binary_sensors for plant/sensor faults are auto-created per thermostat. Off by default. |
| `cbus_aircon_control_enabled` | boolean | `false` | Opt-in to **control** of native Air Conditioning thermostats (writes to live heating/cooling): enables `cbus/write/{network}/172/{sourceUnit}/setpoint` (°C), `/hvacmode` (`off`/`heat`/`cool`/`auto`/`fan_only`), and `/fanmode` (`automatic`/`continuous`), and adds command topics to the discovered climate entity. Setpoint writes are debounced (3s) per the protocol's echo guidance; flags, per-mode setpoints, and fan state learned from the thermostat are echoed on writes. Also sends `AIRCON REFRESH` when a zone group is first seen. |
| `cbus_security_app_id` | string | `208` | C-Bus Security application id for alarm zone sensors (read-only). Publishes one `binary_sensor` per zone: `cbus/read/{network}/208/{zone}/state` is `ON` for unsealed/open/short and `OFF` for sealed, with the raw zone state (`sealed`/`unsealed`/`open`/`short`) on `cbus/read/{network}/208/{zone}/attributes`. Zone names come from the zone labels under application 1 in your Toolkit project (import them via C-Bus Labels); a device class (`motion`, `door`, `window`, `garage_door`, `smoke`) is inferred from the name. Zone state is synced on connect via `security status_request` (security panels do not answer getall). Set to `0` to disable. |
| `cbus_security_control_enabled` | boolean | `false` | Opt-in to **arming** the security panel: adds the `cbus/write/{network}/208/panel/arm` command topic to the `alarm_control_panel` entity (`ARM_AWAY`, `ARM_NIGHT`, `ARM_HOME`, `ARM_VACATION`). Off by default — the arm command carries **no PIN** on the C-Bus network, so anything that can publish to the command topic can arm your panel. The entity is read-only without it. Disarming needs `cbus_security_disarm_enabled` as well. Requires `cbus_security_app_id` to be set. |
| `cbus_security_disarm_enabled` | boolean | `false` | Opt-in to **disarming** as well, on top of `cbus_security_control_enabled`. C-Bus has no disarm command, so the PIN is typed at the panel via keypad emulation: Home Assistant shows its own numeric keypad and sends what you type in the command payload. **The PIN is not stored anywhere** — not in the add-on options, not in Home Assistant — but it does cross your MQTT broker on every disarm. Only enable on a broker you trust, ideally with TLS. See "Alarm panel" below. |
| `cbus_security_bypass_enabled` | boolean | `false` | Opt-in to **forcing an arm past an open zone**, on top of `cbus_security_control_enabled`. Adds the `arm custom bypass` action to the alarm card and the "Bypass open zones" button, both of which send the panel's `#` key. Off by default and separate from arming, because an alarm armed past an open door reports **armed** while that door is not covered. Never automatic — cgateweb will not bypass a zone on your behalf. |
| `cbus_measurement_app_id` | integer | (null) | C-Bus Measurement application id (`228`) for analogue/numeric sensor readings (temperature, power, light level, energy, etc). Decodes `measurement data ...` events and publishes `cbus/read/{network}/228/{device}/{channel}/value` (the decoded number) and `/unit` (e.g. `W`, `°C`, `lx`; empty if unitless/custom), with a `sensor` entity auto-created per device/channel. Also gates the write path: publish `value,multiplier,units` to `cbus/write/{network}/228/{device}/{channel}/data` to inject a reading onto C-Bus (e.g. from a scripted/virtual sensor) — cgateweb sends the native `MEASUREMENT DATA` command. One setting gates both directions, since — unlike Air Conditioning/Security — this isn't a hardware-control write; it's how a measurement source (physical or scripted) gets its own data onto the bus. Off by default. |
| `ha_bridge_diagnostics_enabled` | boolean | `true` | Publish bridge health/diagnostic entities to Home Assistant via MQTT Discovery |
| `ha_bridge_diagnostics_interval_sec` | integer | `60` | How often to refresh bridge diagnostic states (seconds) |

### How a group's entity type is decided

For groups on the **Lighting application (56)**, the entity type is decided by the first rule below that produces an answer:

1. **A manual `type_overrides` entry** in your labels file, or set from the label editor UI. Always wins.
2. **An entity-id-style label prefix** (e.g. a group named `cover.bedroom_shutter`), when `ha_discovery_type_from_label_prefix` is on.
3. **The cover name heuristics** — a label containing a cover keyword such as `blind` or `shutter` — when `ha_discovery_auto_type` is on.
4. **The C-Bus unit type driving the group**, when `ha_discovery_type_from_unit` is on.
5. **The default**: a dimmable `light`.

Cover *names* deliberately outrank the unit type (rule 3 before rule 4). A relay channel can equally drive a light, a motorised blind or an irrigation valve, so the hardware alone cannot tell them apart, while a name that positively identifies a cover is good evidence. A group named "Patio Blind" driven by a relay therefore stays a `cover`.

Groups on the other `ha_discovery_*_app_id` applications (cover, switch, relay, PIR, trigger, HVAC) are typed by their **application-id mapping** and do not enter this chain at all — none of the four rules above applies to them.

Accepted `type_overrides` values are `cover`, `switch`, `relay`, `pir` and `hvac`, plus `light` (or `light-dimmable`) to pin a group to the default dimmable light and so exempt it from all automatic classification. When `ha_discovery_type_from_unit` is enabled, `light-onoff` and `binary_sensor` are also accepted. With that setting **off** those two are unrecognised: the group falls back to a dimmable light and a warning is logged — deliberately, so a mistyped override cannot silently strip a load of its command topic.

### Entity type from C-Bus unit type

`ha_discovery_type_from_unit` (default `false`) decides a Lighting-application group's entity type from the **C-Bus unit hardware** driving it, rather than from its name:

- A group driven by a **dimmer** channel (unit types beginning `DIM`, e.g. `DIMDN8`) stays a dimmable `light`.
- A group driven by a **relay** channel (unit types beginning `REL`, e.g. `RELDN12`) becomes a `light` **with no brightness control**. It stays in the `light` domain, and its `unique_id` and entity id are unchanged, so existing automations, scripts and dashboards keep working — but the brightness slider disappears, because ramping a relay channel was never real.
- A group driven **only by an input unit** (unit types beginning `SEN`, e.g. a key-input or sensor unit such as a bus coupler) becomes a `binary_sensor`. There is no load on the group to control, so the entity is read-only and any `light` config previously published for it is retracted. This is the one case that changes domain, so its entity id changes from `light.*` to `binary_sensor.*`.
- A group driven by **both** a dimmer and a relay keeps its brightness slider — the dimmer wins.

**This is off by default because enabling it can change the type of entities you already have.** Before turning it on, check whether any automation sends a brightness or ramp command to a group that is actually relay-driven.

Unit types the add-on does not recognise are **left alone**: the group keeps whatever type the rest of the chain gave it, normally the default dimmable light. Each unrecognised type that drives a discovered group is logged once per network per discovery run, at info level, asking you to report it on [GitHub issue #37](https://github.com/dougrathbone/cgateweb/issues/37) so it can be classified. An unrecognised type sharing a group with an input unit also suppresses the `binary_sensor` conclusion, since that unknown unit might itself be an output — the add-on will not make a group read-only on a guess.

Setting `ha_discovery_auto_type: false` disables this along with the cover name heuristics. The setting works in both `managed` and `remote` mode.

**Known limitation — a leftover binary sensor after turning the setting back off.** If you enable this, a group becomes a `binary_sensor`, and you then disable it again *and* restart the add-on, the read-only entity can persist alongside the restored light. Turning the setting off republishes the light config, but the record of which sensor configs were published lives only in memory, so a restart loses track of the one to retract. Delete the retained discovery topic to clear it:

```
homeassistant/binary_sensor/cgateweb_<network>_<app>_<group>/config
```

Publishing an empty payload to that topic removes the entity. Disabling the setting without restarting in between is unaffected.

### Letting external clients reach managed C-Gate

In managed mode C-Gate runs inside the add-on container, reachable only from the add-on itself. C-Gate is a multi-client server, so tools such as **C-Bus Toolkit** can connect to that same instance over your LAN — which is what you need when the PC Interface is physically attached to the Home Assistant host. Use `cgate_external_clients` to list the addresses allowed in, each with an access level:

```yaml
cgate_external_clients:
  - address: "192.168.1.50"
    level: program
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `cgate_external_clients` | list of objects | `[]` (empty — add-on only) | Addresses allowed to connect to the managed C-Gate. Each entry has an `address` (IP address or hostname) and a `level` of `monitor`, `operate` or `program`. Each becomes a `remote <address> <level>` rule in C-Gate's access control file. Managed mode only. |

The levels are:

- **`monitor`** — read-only: watch C-Bus events, no control.
- **`operate`** — control loads (switch and ramp groups).
- **`program`** — reprogram C-Bus units. This is the level C-Bus Toolkit needs to program a network.

Read all of the following before enabling this:

- **C-Gate has no authentication on these ports.** Any client whose address matches a rule gets that level, with no username and no password. Only expose C-Gate if you actually need to.
- **`program` also grants the ability to shut C-Gate down.** C-Gate's access levels, increasing, are `none`, `connect`, `monitor`, `operate`, `admin`, `program`, `debug` — so `program` sits *above* `admin`. Granting Toolkit the level it needs necessarily grants the administrative commands, including shutdown. There is no way to separate them.
- **Subnets use an octet of `255`, not CIDR notation.** `192.168.1.255` means every address on `192.168.1.x`. Prefer listing a single, specific address: a subnet grant is far wider than it looks. The add-on logs a warning for any wildcard octet, and rejects `255.255.255.255` (every address on the internet) outright.
- **You must also map C-Gate's ports in Home Assistant's Network panel.** The add-on declares `20023/tcp` (command), `20024/tcp` (event) and `20025/tcp` (status change), plus their SSL equivalents `20123`, `20124` and `20125` — all **unmapped by default**. Home Assistant can only map ports an add-on declares, so exposing C-Gate requires leaving `cgate_port` at its default **20023** — a custom `cgate_port` cannot be mapped here.

- **It is a no-op in remote mode.** With `cgate_mode: remote`, C-Gate runs on another machine and this add-on does not own its access control file. Grant access in that C-Gate's own `access.txt` instead.

The add-on rewrites only its own clearly marked block in `/data/cgate/config/access.txt` on every start; any rules you added by hand outside that block are preserved. The add-on writes `remote` rules only, never `interface` rules — an `interface` rule matches *every* connection arriving on the network interface it names, which silently turns an intended per-client grant into a blanket grant.

**If a client is refused even though it is listed:** when C-Gate refuses a connection it logs the peer address it actually saw. Compare that with the address you configured — they can differ. This add-on runs with `host_network: false`, so incoming connections traverse Docker's bridge network. A LAN client's source address is expected to be preserved through the port mapping, but this has not been confirmed on real Home Assistant OS hardware. If C-Gate reports some other address (a Docker gateway address, say), that is the address your rule has to match — and please report it on [GitHub issue #37](https://github.com/dougrathbone/cgateweb/issues/37).

### Connecting C-Bus Toolkit to managed C-Gate

Current C-Bus Toolkit versions reach a remote C-Gate over **SSL only**, and the old `cgatesites.xml` trick for forcing the plain port is gone — v19 does not ship those files. That blocked Toolkit against managed C-Gate for a while, and the suggested workaround was stunnel on the Home Assistant host, which is not something you should have to do.

You don't. C-Gate already listens on its SSL ports inside the container; the add-on just never declared them, so Home Assistant had no way to publish them. Since 1.24.2 it does, and this is **confirmed working** by two users on real hardware.

1. Add your PC's address to `cgate_external_clients` with level `program` — Toolkit needs `program` to write to a network.
2. In the add-on's **Network** panel, reveal the disabled ports and map **`20123/tcp`** (the SSL command port). Map `20124` and `20125` too if you want the event streams.
3. Restart the add-on so the access rules are written.
4. In Toolkit: **Disconnect C-Gate**, then **Connect to Remote C-Gate**, and give it your Home Assistant host's address with port `20123`.

You do **not** need to edit any XML, and you do **not** need to put anything extra in `/share/cgate/tag/` beyond the project `.db` you already have there. Both are dead ends that cost earlier reporters time.

**If Toolkit connects but shows only "topology" and reports "No Catalog Available":** Toolkit is talking to C-Gate but your project has no synchronised units for it to show. Check that the project's network connection method matches how it is really connected in managed mode (for a USB interface, the serial/COM interface rather than a CNI), then sync the network. The add-on's own log is a quick way to tell which side the problem is on: if its TreeXML fetch reports units, C-Gate knows your hardware and the issue is Toolkit-side; if the tree comes back empty, the project never synced.

> **Remember what mapping this port means.** C-Gate has no authentication beyond the address list, and `program` sits above `admin` in its access levels, so it also permits shutting C-Gate down. Map to a single specific address, never a subnet, and never expose it to the internet.

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
| 208 | Security | `binary_sensor` per alarm zone (labels from application 1) + `alarm_control_panel` per network | On by default; `cbus_security_app_id: 0` disables; `cbus_security_control_enabled: true` for arming, plus `cbus_security_disarm_enabled: true` for disarming and `cbus_security_bypass_enabled: true` for force-arm |
| 228 | Measurement | `sensor` per device/channel (unit/device_class from the reading) | Opt-in via `cbus_measurement_app_id: 228` — also enables the write path |
| 202 | Trigger groups | `event` + `button` | Opt-in via `ha_discovery_trigger_app_id` |
| 203 | Enable Control (often covers) | `cover` | Opt-in via `ha_discovery_cover_app_id: 203` |
| Custom | Enable Control (switches) | `switch` | Opt-in via `ha_discovery_switch_app_id` |
| Custom | Lighting-compatible HVAC group (PAC/touchscreen-exposed) | `climate` | Opt-in via `ha_discovery_hvac_app_id` |

The app ID values above are the C-Bus standard defaults. Some installations use non-standard IDs — check your C-Bus Toolkit project if a device type is not being discovered.

**Application 203 is "Enable Control", not "covers".** Pointing `ha_discovery_cover_app_id` at 203 is the common choice because blinds usually live there in homes, but the application itself is general purpose — installers also use it for things like disabling keypad buttons. If your 203 groups are not blinds, leave the setting unset rather than having them appear as cover entities.

**Phantom groups do not report state.** A C-Bus group that is not assigned to any output unit channel — a "phantom" group, common for logic-only groups such as an Enable Control flag — does not exist on the network as far as `GET` and `GETALL` are concerned, so its state cannot be read. cgateweb can send to it, but it will never receive a level back, and if it is the only group on an application you will see the "application has no groups on network" message at startup. Assigning the group to a spare relay or dimmer channel in Toolkit makes it queryable, if you need its state in Home Assistant.

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

### Security zones (application 208)

With `cbus_security_app_id` set (default `208`), cgateweb exposes every alarm panel zone as a Home Assistant `binary_sensor` (read-only), plus one `alarm_control_panel` entity per network (see "Alarm panel" below).

- `cbus/read/{network}/208/{zone}/state` — `ON` when the zone is unsealed, open or short; `OFF` when sealed
- `cbus/read/{network}/208/{zone}/attributes` — JSON with the raw zone state (`sealed`, `unsealed`, `open`, `short`) so automations can distinguish loop faults

Zone names come from the zone labels under **application 1** in your Toolkit project — import the project via C-Bus Labels and each sensor is named accordingly (zones are announced at startup from these labels; unlabelled zones appear on their first event with a fallback name). A device class is inferred from the name: `pir`/`motion` → motion, `garage` → garage door, `door` → door, `window` → window, `smoke` → smoke.

Security panels do not answer lighting-style getall requests, so on connect (and on first security traffic) cgateweb sends `security status_request` reports 1 and 2 to sync the state of zones 1–80. Set `cbus_security_app_id: 0` to disable the feature.

### Alarm panel (arming)

Alongside the zone sensors, cgateweb publishes one `alarm_control_panel` entity per network on the **C-Bus Security Panel** device (the same device that carries the panel trouble sensors):

- `cbus/read/{network}/208/panel/state` — the HA alarm state: `disarmed`, `armed_away`, `armed_home`, `armed_night`, `armed_vacation`, `arming`, `pending`, `triggered`
- `cbus/read/{network}/208/panel/attributes` — JSON attributes; while the panel refuses to arm, the blocking zone appears as `blocking_zone`

The state machine follows the panel's broadcasts: `system_arm` sets the armed mode (C-Bus day/stay mode 3 maps to `armed_home`), `exit_delay_started` shows `arming`, `arm_not_ready` shows `pending` with the blocking zone, `arm_ready` returns to `disarmed`, `alarm_on` shows `triggered` and `alarm_off` reverts to the pre-alarm state.

With `cbus_security_control_enabled: true` (off by default) the entity gains a command topic, `cbus/write/{network}/208/panel/arm`, and Home Assistant's **arm** buttons work: `ARM_AWAY` → `away`, `ARM_NIGHT` → `night`, `ARM_HOME` → `day` (day/stay), `ARM_VACATION` → `vacation`. These are C-Gate's own arm-mode keywords (C-Gate manual §4.5.177); the numeric mode values in the C-Bus application spec are not accepted by the command interface and are rejected with `405 Parameter out of range`. The panel confirms with a `system_arm` broadcast, so the displayed state always comes from the panel itself.

> **Security warning:** the C-Bus `security arm` command carries **no PIN** — anything that can publish to the command topic can arm your panel. Only enable control on a broker you trust.

#### Bypassing open zones

When arming stalls at `pending` because a zone is open (`arm_not_ready` names it in the attributes), the physical keypad's `#` key bypasses the open zones and lets the arm continue.

This is a **third** opt-in, `cbus_security_bypass_enabled: true`, on top of `cbus_security_control_enabled`. It is separate from arming because it makes a different promise: an alarm armed past an open door reports **armed** to you and to Home Assistant, while that door is not actually covered. Turning on arming should not quietly hand out "arm anyway" as well.

With both enabled there are two ways to send the `#` keypress from Home Assistant, so the arm flow (arm → bypass → armed) completes without walking to the keypad:

- **On the alarm card itself** — the panel offers Home Assistant's **arm custom bypass** action, which is the tidier option if you already drive the panel from a dashboard card.
- **A separate "Bypass open zones" button** on the panel device, which is easier to call from a script or put on its own dashboard.

Both send exactly the same `SECURITY EMULATE_KEYPAD` command; use whichever suits your setup. Neither appears at all while `cbus_security_bypass_enabled` is off, so you never get a control that silently does nothing.

> This is deliberately never automatic. Bypassing an open zone is a security decision, and only the person who can see the open window should make it — the add-on will not force an arm on your behalf just because a zone is unsealed.

#### Disarming

Disarming is a **second** opt-in, `cbus_security_disarm_enabled: true`, on top of `cbus_security_control_enabled`. The two are separate because they are not equally risky: arming cannot let anyone in.

C-Bus has no disarm command — the specification reserves the arm value that would mean "disarm", and C-Gate offers no disarm arm-mode. The only route is `SECURITY EMULATE_KEYPAD` (C-Gate manual §4.5.179), which presses one key on the panel's keypad per command. So a disarm is simply your PIN typed at the panel, one digit at a time, exactly as if you had entered it yourself.

With disarm enabled, the discovered entity uses **Home Assistant's own keypad**. Pressing Disarm opens the numeric pad, and what you type is sent to cgateweb, which replays it to the panel. The panel decides whether the PIN is right; cgateweb does not check it and cannot know, so the entity's state changes only when the panel broadcasts that it has disarmed.

What this means for your PIN:

- **It is not stored anywhere.** Not in the add-on configuration, not in Home Assistant. The discovery config uses Home Assistant's `REMOTE_CODE` mode, which shows the keypad but skips local validation, so there is no second PIN to keep in sync and nothing on disk to leak.
- **It does cross MQTT on every disarm**, in the command payload. Anyone able to subscribe to your broker can read it. Use an authenticated broker, and TLS if you can.
- **It is not written to the log.** cgateweb logs the number of keypresses sent, never the digits, and refuses to echo a malformed payload in case it contained a PIN. Keypad commands are also redacted out of the raw protocol logging, which C-Gate echoes back.

  > **If you captured a debug log while disarming on 1.24.0, 1.24.1 or 1.24.2, treat it as containing your PIN.** Those versions redacted the PIN from cgateweb's own messages but not from the raw C-Gate protocol lines logged at debug level, where each keypress appeared individually. Fixed in 1.24.3. Debug logging is off by default, so this only affects you if you turned it on and kept the output — delete any such log, or change your PIN if you shared one.
- Only digits are accepted. Keypad emulation can send any character, so a non-numeric payload is rejected rather than typed at the panel.
- **Attempts are rate limited** to 10 per 10 minutes per network, which is far more than normal use and slow enough to make guessing the PIN over MQTT impractical. cgateweb cannot tell a correct PIN from an incorrect one — only the panel can — so every well-formed attempt counts. Rejected payloads (wrong shape, no code) don't, so a broken automation can't lock you out. When the limit trips it is logged as a warning; if you see one you didn't cause, someone with access to your broker is guessing your code. Tunable in a standalone `settings.js` via `securityDisarmMaxAttempts` and `securityDisarmAttemptWindowMs`; deliberately not an add-on option.

The code is followed by a `#` keypress, which is what submits it — the panel otherwise just holds the digits and waits. This was confirmed on real hardware; Enter (`$0D`) had no effect. If your panel expects something else, please report it on [issue #51](https://github.com/dougrathbone/cgateweb/issues/51) with a log.

### Measurement application (228)

The C-Bus Measurement application (`$E4`) carries analogue/numeric readings — temperature, power, light level, energy, and more — keyed by **device + channel** rather than a group address, since a single measurement device can report several independent channels. See the official Clipsal spec (`CBUS-APP/28`) for the full 42-entry unit table — 40 SI unit codes, plus "no units" and "custom".

With `cbus_measurement_app_id` set (default off; typically `228`), cgateweb decodes `measurement data ...` broadcasts and publishes, per device/channel:

- `cbus/read/{network}/228/{device}/{channel}/value` — the decoded reading (`raw × 10^multiplier`)
- `cbus/read/{network}/228/{device}/{channel}/unit` — the unit string (e.g. `W`, `°C`, `lx`, `%`); empty if unitless or custom

A Home Assistant `sensor` entity is auto-created per device/channel the first time it's seen, with `unit_of_measurement` and `device_class` (where the unit maps unambiguously to one — e.g. °C → temperature, W → power, Wh → energy, lx → illuminance, V → voltage, A → current, Pa → pressure, Hz → frequency) taken from the reading itself. Units the spec shares between quantities get no `device_class`: `%` covers humidity, tank levels, valve positions and any other ratio, so the entity is left as a plain percentage sensor rather than being announced as something it may not be. You can always set a device class yourself on the entity in Home Assistant.

Energy readings (Wh) are published with `state_class: total_increasing` rather than `measurement`, which is what lets them be used in Home Assistant's Energy dashboard; every other unit uses `measurement`.

Unlike Air Conditioning/Security, Measurement is not primarily about controlling hardware — a "measurement device" can just as easily be a script or virtual sensor as physical equipment (the specification itself defines devices as either "input units, which measure the quantities" or "output units, which display" them). So the same setting also enables the **write** path: publish a CSV payload of `value,multiplier,units` (e.g. `5042,0,38` for 5042 W) to `cbus/write/{network}/228/{device}/{channel}/data`, and cgateweb sends the native `MEASUREMENT DATA` command onto C-Bus — this is how a scripted or virtual sensor (e.g. reading a solar inverter's power output) gets its data onto the bus. Invalid values, multipliers, or unit codes are rejected with a warning rather than sent to C-Gate.

Because injecting a reading isn't a hardware-actuation risk the way arming a panel or driving a thermostat is, there's no separate `*_control_enabled` flag here — `cbus_measurement_app_id` gates both directions.

## Networking

This add-on runs with `host_network: false`.

- Ingress is enabled and routes the label editor UI through Home Assistant. Requests arriving via Ingress are already authenticated by Home Assistant (the Supervisor injects an `X-Ingress-Path` header), so label edits and `.cbz`/XML imports work out of the box with no `web_api_key`. At startup the add-on discovers its ingress entry path from the Supervisor API (`/addons/self/info`) and trusts requests carrying it; if that lookup fails, ingress API access stays denied (401) and a warning is logged — set `web_api_key` as a fallback.
- Port `8080/tcp` is exposed by the add-on for direct access if needed.
- Ports `20023/tcp`, `20024/tcp` and `20025/tcp` are declared so managed C-Gate can be reached by external tools such as C-Bus Toolkit. They are **unmapped by default** — map them in the Network panel only if you need external access, and list the permitted clients in `cgate_external_clients` first. C-Gate has **no authentication** on these ports. See "Letting external clients reach managed C-Gate" above.
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
3. If the download fails verification or the URL no longer works: Clipsal/Schneider occasionally change the download URL or repackage the zip, which breaks the URL/checksum pinned in the add-on (this happened in July 2026). Check the add-on's [GitHub releases](https://github.com/dougrathbone/cgateweb/releases) for an update re-pinning the new file, or install manually — see "Uploading C-Gate manually" above: download the C-Gate 3 Linux package from the Clipsal downloads page yourself, set `cgate_install_source` to `upload`, place the zip in `/share/cgate/`, and restart
4. Note that newer C-Gate versions may require a Schneider login on the download portal, so a direct `cgate_download_url` pointing at the portal can serve a login page instead of the zip — download in a browser and use `upload` mode instead
5. Ensure the C-Gate zip file is a valid Linux package

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
