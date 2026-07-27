cgateweb
========

[![Node.js CI](https://github.com/dougrathbone/cgateweb/actions/workflows/ci.yml/badge.svg)](https://github.com/dougrathbone/cgateweb/actions/workflows/ci.yml)
[![Home Assistant Addon](https://img.shields.io/github/actions/workflow/status/dougrathbone/cgateweb/hacs-distribution.yml?label=Home%20Assistant%20Addon)](https://github.com/dougrathbone/cgateweb/actions/workflows/hacs-distribution.yml)
[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-dougrathbone-FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/dougrathbone)

MQTT bridge for Clipsal C-Bus lighting systems, written in Node.js. Available as a **Home Assistant Add-on** or as a standalone service.

Connects to C-Gate over TCP, publishes C-Bus events to an MQTT broker, and supports Home Assistant MQTT Discovery for automatic device configuration. Control your C-Bus lights, covers, switches, and sensors from Home Assistant or any MQTT-compatible platform.

**USB-serial PC Interface (5500PC/5500PCU)?** Run C-Gate yourself on any Windows/Linux machine with the dongle attached and connect in remote mode — or try the Home Assistant add-on's beta managed-mode serial passthrough. See [DOCS.md](homeassistant-addon/DOCS.md#usb-serial-pci-support).

### Home Assistant Add-on Repositories

- **Source repository (this repo):** https://github.com/dougrathbone/cgateweb
- **Home Assistant add-on repository (for Home Assistant):** https://github.com/dougrathbone/cgateweb-homeassistant
- Add the add-on repository URL above in Home Assistant Add-on Store to install/update the add-on.

### Install:

**Option 1: Home Assistant Add-on (Recommended for HA users)**

The add-on is distributed through the Home Assistant **Supervisor Add-on Store**, not HACS.

1. **Add the Add-on Repository:**
   - In Home Assistant, go to Settings → Add-ons → Add-on Store
   - Click the 3-dot menu (top right) → Repositories
   - Add repository: `https://github.com/dougrathbone/cgateweb-homeassistant`

2. **Install the Add-on:**
   - Refresh the Add-on Store and find "cgateweb" under the newly added repository
   - Click it and select Install
   - Configure your C-Gate and MQTT settings in the Configuration tab
   - Start the add-on

**Option 2: Standalone Installation**

These instructions assume a Linux system with Node.js, npm, and systemd.

1.  **Clone the repository:**
    ```bash
    # Navigate to your desired installation directory, e.g., /usr/local/src
    cd /usr/local/src 
    sudo git clone https://github.com/dougrathbone/cgateweb.git
    cd cgateweb
    ```
2.  **Install dependencies:**
    ```bash
    sudo npm install # Install required node modules
    ```
3.  **Configure Settings:**
    ```bash
    sudo nano settings.js
    ```
    Edit the file to match your C-Gate server IP address, project name, MQTT broker address, and any necessary credentials.

4.  **Install and Start the Service:**
    Run the installer script using sudo:
    ```bash
    sudo node install-service.js
    ```
    This script will:
    *   Check for root privileges.
    *   Copy `cgateweb.service` to `/etc/systemd/system/`.
    *   Reload the systemd daemon.
    *   Enable the service to start on boot (`systemctl enable`).
    *   Start the service immediately (`systemctl start`).

    Follow the output of the script for status and any potential errors.

### Usage if not using as service:

1)  Put your settings in `settings.js`.
2)  Run `npm start` or `node index.js` (useful for testing or foreground operation).

### Status Topic

`cgateweb` publishes its status to the `hello/cgateweb` topic:

*   `Online`: Published when `cgateweb` successfully connects to MQTT and C-Gate.
*   `Offline`: Published automatically by the MQTT broker (using Last Will and Testament - LWT) if `cgateweb` disconnects uncleanly.

### Updates get published on these topics:

 - cbus/read/#1/#2/#3/state  -  ON/OFF gets published to these topics if the light is turned on/off

 - cbus/read/#!/#2/#3/level  -  The level of the light gets published to these topics

### Publish to these topics to control the lights:

 - cbus/write/#1/#2/#3/switch  -  Publish ON/OFF to these topics to turn lights on/off

 - cbus/write/#1/#2/#3/ramp  -  Publish a % to ramp to that %. Optionally add a comma then a time (e.g. 50,4s or 100,2m). Also, INCREASE/DECREASE ramp by 5% up or down and ON/OFF turns on/off.

### Control covers/blinds:

 - cbus/write/#1/#2/#3/position  -  Publish a position 0-100 (0=closed, 100=fully open)

 - cbus/write/#1/#2/#3/stop  -  Publish STOP to stop the cover at its current position

### This requests an update from all lights:

 - cbus/write/#1/#2//getall - current values get published on the cbus/read topics

 #1,#2 and #3 should be replaced by your c-bus network number, application number, and the group number.

Requesting an update on start or periodic updates can be set in the settings file.

### This requests the network tree:

 - cbus/write/#1///gettree - result gets published as JSON on cbus/read/#1///tree

### MQTT broker ACL

When using broker ACLs, the bridge user must **subscribe** to `cbus/write/#` and **publish** to `cbus/read/#`, `cbus/bridge/#`, `hello/cgateweb`, and (if HA Discovery is enabled) `{ha_discovery_prefix}/#`. See `homeassistant-addon/DOCS.md` for a Mosquitto example.

### Home Assistant MQTT Discovery

`cgateweb` supports automatic discovery of C-Bus devices in Home Assistant using the MQTT Discovery protocol.

When enabled, `cgateweb` queries the C-Gate network structure (`TREEXML`) and publishes configuration messages to the specified MQTT discovery prefix (default: `homeassistant`). Home Assistant listens to this prefix and automatically adds discovered devices.

Supported Device Types:

*   **Lights:** C-Bus Lighting Application groups (typically App ID 56) are discovered as Home Assistant `light` entities, supporting on/off and brightness control.
*   **Covers:** Devices using the configured `ha_discovery_cover_app_id` (default: `null` — disabled; commonly set to `203` for Enable Control) are discovered as `cover` entities (device class `shutter`), supporting:
    - **Position control:** Set position 0-100% (0=closed, 100=fully open)
    - **Stop:** Stop the cover at its current position
    - **Open/Close:** Basic open/close commands
*   **Switches:** Devices using the configured `ha_discovery_switch_app_id` (default: `null`) are discovered as `switch` entities.
*   **Relays:** Devices using the configured `ha_discovery_relay_app_id` (default: `null`) are discovered as `switch` entities with device class `outlet`.
*   **PIR Motion Sensors:** Devices using the configured `ha_discovery_pir_app_id` (default: `null`) are discovered as `binary_sensor` entities with device class `motion`.
*   **HVAC / Climate (via lighting):** Devices using the configured `ha_discovery_hvac_app_id` (default: `null` — disabled) are discovered as `climate` entities. This drives a **lighting-compatible group**, not the native C-Bus Air Conditioning application — use the app ID of a PAC/touchscreen-exposed HVAC group (e.g. an "HVAC Actuator" lighting-style app), NOT the Air Conditioning app 172. See "HVAC notes" below.
*   **Temperature sensors:** C-Bus Temperature Broadcast groups (App ID 25) are discovered event-driven as `sensor` entities (device class `temperature`) the first time each sensor broadcasts — no configuration needed beyond `ha_discovery_enabled`.

> **HVAC notes:** `ha_discovery_hvac_app_id` is for the *lighting-compatible* HVAC pattern only: program a Pascal Logic Controller (PAC) or touchscreen to mirror HVAC control onto a lighting-style group/application, then point this setting at that app. Native C-Bus *Air Conditioning* (172) thermostats are supported directly — set `cbus_aircon_app_id` (typically `172`) for state decoding and climate entities, and opt in to control (set mode/temperature) with `cbus_aircon_control_enabled`. See below.
>
> **Native Air Conditioning (172) data** is available via `cbus_aircon_app_id`. Set it to your AC application id (typically `172`) and cgateweb will decode broadcasts from the C-Bus Air Conditioning application and publish to the following topics — keyed by the thermostat's **source unit** (e.g. `201`, `202`), not the zone group, so multiple thermostats on the same network never collide:
>
> | Topic | Value |
> |-------|-------|
> | `cbus/read/{net}/172/{sourceUnit}/current_temperature` | Room temperature in °C (raw / 256) |
> | `cbus/read/{net}/172/{sourceUnit}/setpoint` | Target setpoint in °C (raw / 256) |
> | `cbus/read/{net}/172/{sourceUnit}/mode` | `off`, `heat`, `cool`, `auto`, `fan_only` (all verified against real hardware) |
> | `cbus/read/{net}/172/{sourceUnit}/state` | `ON` / `OFF` (zone-group master on/off) |
> | `cbus/read/{net}/172/{sourceUnit}/action` | `heating` / `cooling` / `fan` / `idle` (live plant running state) |
> | `cbus/read/{net}/172/{sourceUnit}/fan_mode` | `automatic` / `continuous` (Aux Level bit 6) |
> | `cbus/read/{net}/172/{sourceUnit}/fan_speed` | Raw fan speed setting 0–63 (Aux Level bits 0–5) |
> | `cbus/read/{net}/172/{sourceUnit}/fan_speed_pct` | Fan speed % when it lives in the raw level (vent/fan, evaporative manual) |
> | `cbus/read/{net}/172/{sourceUnit}/error` + `…/error_description` | Plant error code (0 = no error) and human-readable text |
> | `cbus/read/{net}/172/{sourceUnit}/problem` + `…/sensor_problem` | `ON`/`OFF` problem states backing the HA `binary_sensor` entities (plant fault / temperature-sensor fault) |
> | `cbus/read/{net}/172/{sourceUnit}/sensor_status` | Temperature sensor status (0 = ok; temperature is suppressed at total failure) |
> | `cbus/read/{net}/172/{sourceUnit}/current_humidity`, `…/humidity_mode`, `…/humidity_setpoint`, `…/humidity_action` | Humidity application state (spec-derived; only present with humidity plant) |
> | `cbus/read/{net}/172/{sourceUnit}/comfort_level` | Evaporative comfort level (evaporative plant cooling only) |
>
> Control is **opt-in** via `cbus_aircon_control_enabled` (off by default — it writes to live heating/cooling). When enabled, publish a mode (`off`/`heat`/`cool`/`auto`/`fan_only`) to `cbus/write/{net}/172/{sourceUnit}/hvacmode`, a target in °C to `cbus/write/{net}/172/{sourceUnit}/setpoint`, or a fan mode (`automatic`/`continuous`) to `cbus/write/{net}/172/{sourceUnit}/fanmode` and cgateweb sends the native `AIRCON` commands; the discovered climate entity also gains command topics. Setpoint writes are debounced to one command per 3s per the protocol's anti-echo guidance, and the thermostat's flags, per-mode setpoints, and fan state are learned and echoed on writes. To help capture raw event samples for other specialised applications (e.g. Temperature Broadcast app 25, Measurement app 228), set `cbusRawEventLogApps` to a list of app IDs (e.g. `['25', '228']`) — cgateweb will then log each matching C-Gate event line verbatim and publish it to `cbus/read/{net}/{app}/{group}/raw`. Defaults to `[]` (off).

**Configuration (`settings.js`):**

```javascript
module.exports = {
    // ... other settings ...

    // --- HA Discovery Settings ---
    ha_discovery_enabled: true,         // Set to true to enable discovery
    ha_discovery_prefix: 'homeassistant', // Default HA discovery topic prefix
    ha_discovery_networks: ['254'],     // List C-Bus network IDs to scan (e.g., ['254', '200'])
    
    // Application IDs for specific device types (MUST match your C-Bus project configuration).
    // All of these default to `null` (disabled). Only the Lighting application (56) is
    // discovered out of the box, and every Lighting group is published as a `light`.
    ha_discovery_cover_app_id: '203',   // App ID for Covers (e.g., Enable Control) - null to disable (default)
    ha_discovery_switch_app_id: null,   // App ID for Switches (e.g., Enable Control, Trigger Control) - null to disable
    ha_discovery_relay_app_id: null,    // App ID for Relays (e.g., Enable Control) - null to disable
    ha_discovery_pir_app_id: null,     // App ID for PIR Motion Sensors (e.g., Trigger Control) - null to disable
    ha_discovery_hvac_app_id: null     // App ID of a lighting-compatible HVAC group (PAC/touchscreen-exposed); NOT the Air Conditioning app 172 - null to disable
};
```

**Finding C-Bus Application IDs:**

The crucial step is setting the correct `ha_discovery_*_app_id` values to match **your specific C-Bus project configuration**. Here are common ways to find these IDs:

1.  **C-Bus Toolkit Software:** This is the most reliable method. Open your C-Bus project file (`.cbz`) in Toolkit, navigate to the relevant Units (dimmers, relays, sensors) and check the Application ID assigned to them (often Lighting=56, Enable Control=203, Trigger Control=28, Measurement=60, etc., but can be customized).
2.  **Project Documentation:** If you have documentation from the original C-Bus installer/programmer, it might list the Application assignments.
3.  **Examine `TREE` Output (Advanced):** You can temporarily trigger a `gettree` command via MQTT:
    *   Publish an empty message to `cbus/write/<network>///gettree` (e.g., `cbus/write/254///gettree`).
    *   Listen to the `cbus/read/<network>///tree` topic.
    *   The JSON payload published here contains the raw network structure. You can inspect the `Unit` -> `Application` sections to find `ApplicationAddress` values associated with known device labels.

**Important Notes:**

*   Discovery for Covers, Switches, Relays, PIRs, and HVAC is **disabled by default** (`null`). Only the Lighting application (56) is discovered automatically, and **every** Lighting group is published as a `light`. You *must* set the corresponding `ha_discovery_*_app_id` in `settings.js` to the correct C-Bus Application ID to enable the other types.
*   **Devices that live on the Lighting application (56) but are not lights** — e.g. shutter-relay units (blinds use lighting group addresses) or a thermostat exposed on app 56 — are classified by Application ID and so default to `light`. Motorised covers whose label contains a cover keyword are now auto-detected (see *Automatic cover detection* below). For anything auto-detection can't infer, add a per-group `type_overrides` entry in your labels file (`"<net>/<app>/<group>": "cover" | "switch" | "relay" | "pir" | "hvac"`) or via the web UI; an override always wins. Two further override values, `light-onoff` (a light with no brightness control) and `binary_sensor` (a read-only sensor with no command topic), are accepted **only when `ha_discovery_type_from_unit` is enabled** — with that setting off they are unrecognised and the group falls back to a dimmable light with a warning. See *Type from C-Bus unit type (opt-in)* below.
*   If multiple discovery types (e.g., Cover and Switch) are configured with the *same* Application ID, `cgateweb` prioritizes discovery in this order: Cover > Switch > Relay > PIR. Only the first matching type will be discovered for a given C-Bus group using that Application ID.
*   For more technical details, see `docs/project-homeassistant-discovery.md`.

#### Automatic cover detection

Groups on the Lighting application (56) whose label contains a cover keyword (`blind`, `shutter`, `shade`, `awning`, `curtain`, `roller`, `garage door`) are published as Home Assistant `cover` entities instead of `light`. This is on by default (`ha_discovery_auto_type: true`).

To disable auto-detection set `ha_discovery_auto_type: false`; to keep it on but turn off keyword matching set `ha_discovery_auto_type_name_heuristics: false`. Customise the keyword list with `ha_discovery_auto_type_cover_keywords` (matching is case-insensitive and catches plurals).

#### Classification precedence

For groups on the Lighting application (56), the entity type is decided by the first rule below that produces an answer. Groups on the other `ha_discovery_*_app_id` applications are typed by their application-id mapping instead and never enter this chain.

1. **A manual `type_overrides` entry** in your labels file (or set via the web UI). Always wins.
2. **An entity-id-style label prefix** (e.g. `cover.bedroom_shutter`), when `ha_discovery_type_from_label_prefix` is enabled.
3. **The cover name heuristics** — a label containing a cover keyword such as `blind` or `shutter`, when `ha_discovery_auto_type` is on.
4. **The C-Bus unit type driving the group**, when `ha_discovery_type_from_unit` is enabled.
5. **The default**: a dimmable `light`.

Cover *names* deliberately outrank the unit type (rule 3 before rule 4). A relay channel can equally drive a light, a motorised blind or an irrigation valve, so the hardware alone cannot tell them apart — whereas a name that positively identifies a cover is good evidence. A group named "Patio Blind" on a relay unit therefore stays a `cover`. Groups whose names say nothing about being a cover still fall through to unit-type classification, which is where most of that feature's value is.

Note: a shutter relay with a non-descriptive name still appears as a light — add a `type_overrides` entry (e.g. `"254/56/15": "cover"`) for those.

#### Type from label prefix (opt-in)

If you name your C-Bus groups with their intended Home Assistant entity id (e.g. `cover.bedroom_shutter`, `switch.porch_light`, `light.bedroom_downlights`), set `ha_discovery_type_from_label_prefix: true` and the domain prefix becomes the group's discovery type. Supported prefixes: `light.`, `cover.`, `switch.`, `relay.`, `pir.` (anything else, e.g. `lock.`, is ignored). See *Classification precedence* above — only a manual `type_overrides` entry outranks the prefix. A `light.` prefix pins the group to the light domain without pinning its dim capability, so with `ha_discovery_type_from_unit` also enabled a relay-driven `light.porch` becomes an on/off light rather than getting a brightness slider that ramps a relay channel.

#### Type from C-Bus unit type (opt-in)

Set `ha_discovery_type_from_unit: true` and each Lighting-application group's entity type comes from the C-Bus **unit hardware** driving it, rather than from its name:

*   A group driven by a **dimmer** channel stays a dimmable `light`.
*   A group driven by a **relay** channel becomes a `light` **with no brightness control**. It stays in the `light` domain — the entity id and `unique_id` are unchanged, so existing automations, scripts and dashboards keep working — but the brightness slider goes away, because ramping a relay channel was never real.
*   A group driven **only by an input unit** (a sensor or key-input unit, such as a bus coupler) becomes a `binary_sensor`. There is no load on the group to control, so the entity is read-only, and any previously published `light` config for it is retracted. This one *does* move domain, so the entity id changes from `light.*` to `binary_sensor.*` — the only case here that does.
*   If a group is driven by both a dimmer and a relay, the dimmer wins and the group keeps its brightness slider.

**This is off by default because turning it on can change the type of entities you already have.** A group you currently see as a dimmable light may become an on/off light or a binary sensor. Review your automations for brightness commands against relay-driven groups before enabling it.

Unit types cgateweb does not recognise are **left alone** — the group keeps whatever type the rest of the chain gave it (normally the default dimmable light) — and each unrecognised type that drives a discovered group is logged once per network at info level, asking you to report it on [GitHub issue #37](https://github.com/dougrathbone/cgateweb/issues/37) so it can be classified. An unrecognised type sharing a group with an input unit also suppresses the `binary_sensor` conclusion, since that unknown unit might itself be an output.

Precedence is covered under *Classification precedence* above: manual overrides, label prefixes and cover names all outrank the unit type. Setting `ha_discovery_auto_type: false` disables unit-type classification along with the name heuristics.

One known wrinkle: if you enable this, a group becomes a `binary_sensor`, and you then turn the setting off *and* restart the add-on, the read-only entity can linger next to the restored light. The record of which sensor configs were published is held in memory only, so a restart loses track of the one to clear. Publish an empty payload to `homeassistant/binary_sensor/cgateweb_<network>_<app>_<group>/config` to remove it. Turning the setting off without a restart in between is unaffected.

With this setting enabled, `light-onoff` and `binary_sensor` also become valid `type_overrides` values, for forcing those shapes on a group whose hardware cgateweb cannot see or classify. (An override of `light` or `light-dimmable` is always valid and pins a group to the default dimmable light, which is how you exempt one group from all of the automatic rules.)

#### Source unit per group

Every C-Bus event carries the unit that originated it (`#sourceunit`). cgateweb publishes it to `cbus/read/{net}/{app}/{group}/source_unit`, so automations can react to a physical switch press specifically, or ignore bridge/CNI-originated writes to avoid loops. (Not published for events without a source unit, e.g. sync updates.)

### USB-serial PC Interface support (beta)

Two ways to use a C-Bus USB PC Interface (5500PC native USB, or 5500PC via a USB-to-serial adapter):

- **Remote mode (recommended for most):** run C-Gate on any Windows or Linux machine with the interface attached, and point cgateweb at it (`cbusip` / `cgate_host`).
- **Managed mode (Home Assistant add-on):** the add-on can run C-Gate with the interface plugged into the HA host itself. Set `cgate_serial_device` (a dropdown of detected serial devices — prefer a stable `/dev/serial/by-id/...` path), keep `cgate_mode: managed`, and install your Toolkit project `.db` into `/share/cgate/tag/`. Projects saved on Windows reference a `COMx` port that cannot exist on Linux — the add-on rewrites those interface addresses to your serial device automatically on each startup. Field-tested with both interface types; report problems on [GitHub issue #28](https://github.com/dougrathbone/cgateweb/issues/28).

**If the interface renumbers across a replug:** a USB PC Interface unplugged and plugged back in — into another port, or after a host reboot — can come back on a different `/dev/ttyUSB*` name, which used to leave the network stuck at `InterfaceState=closed` (or fail startup outright). The add-on now recovers in both cases. It records the device's identity on each good boot, so **at startup** it re-resolves the configured path to the interface it actually remembers and repoints your project at it; and **while running**, if a network's interface goes down and its device has vanished or a `/dev/serial/by-id/...` path now points somewhere else, it re-resolves the device, repoints the project database and restarts only the internal C-Gate (a short outage, explained in the log). Restarts are spaced out and capped so a faulty cable cannot cause a restart loop.

The reliable fix is to **configure a `/dev/serial/by-id/...` path** rather than a bare `/dev/ttyUSB0`: that alias is derived from the device's own identity, so it survives replugging into a different USB port and the problem does not arise in the first place.

### Exposing managed C-Gate to external clients (Home Assistant add-on)

In the add-on's managed mode, C-Gate runs inside the add-on container and is reachable only from the add-on itself. C-Gate is a multi-client server, so tools such as **C-Bus Toolkit** can connect to that same instance over the LAN — useful when the PC Interface is physically attached to the Home Assistant host. Set `cgate_external_clients` to the list of addresses allowed in, each with an access level:

```yaml
cgate_external_clients:
  - address: "192.168.1.50"
    level: program
```

`level` is one of `monitor` (read-only), `operate` (control loads) or `program` (reprogram C-Bus units — what Toolkit needs). Each entry becomes a `remote <address> <level>` rule in C-Gate's access control file.

Read these before enabling it:

*   **C-Gate has no authentication on these ports.** Any client whose address matches a rule gets that level, with no username or password. Only expose C-Gate if you actually need to.
*   **`program` also grants the ability to shut C-Gate down.** In C-Gate's level hierarchy (`none`, `connect`, `monitor`, `operate`, `admin`, `program`, `debug`) `program` sits *above* `admin`, so granting Toolkit the level it needs necessarily grants the administrative commands too. There is no way to separate them.
*   **Subnets are written as an octet of `255`, not CIDR.** `192.168.1.255` means every address on `192.168.1.x`. Prefer listing a single address; a subnet grant is much wider than it looks, and `255.255.255.255` (every address on the internet) is rejected outright.
*   **You must also map C-Gate's ports in Home Assistant's Network panel** (20023 command, 20024 event, 20025 status change). They are declared by the add-on but unmapped by default. Because Home Assistant can only map ports the add-on declares, exposing C-Gate requires leaving `cgate_port` at its default **20023** — a custom `cgate_port` cannot be mapped.
*   **It is a no-op in remote mode.** With `cgate_mode: remote` C-Gate runs on another machine, so this add-on does not own its access control file; grant access in that C-Gate's own `access.txt`.

**If a client is refused despite being listed:** when C-Gate refuses a connection it logs the peer address it actually saw. Compare that with the address you configured — they can differ. The add-on runs with `host_network: false`, so incoming connections traverse Docker's bridge network; a LAN client's source address is expected to be preserved through the port mapping, but this has not been confirmed on real Home Assistant OS hardware. If C-Gate reports a different address (for example a Docker gateway address), that is what the rule needs to match, and it is worth reporting on [GitHub issue #37](https://github.com/dougrathbone/cgateweb/issues/37).

See [DOCS.md](homeassistant-addon/DOCS.md) for the add-on walkthrough.

### Testing

This project uses Jest for unit testing.

1.  Install development dependencies: `npm install`
2.  Run tests: `npm test`
3.  Run tests with coverage report: `npm test -- --coverage`

### Other notes:

This project is actively developed against Home Assistant, but should work with any MQTT-compatible system.
It assumes the default cgate ports

### License

Released under the [MIT License](LICENSE.txt). Originally created by Steven Lazidis; currently maintained by Doug Rathbone.
