cgateweb
========

[![Node.js CI](https://github.com/dougrathbone/cgateweb/actions/workflows/ci.yml/badge.svg)](https://github.com/dougrathbone/cgateweb/actions/workflows/ci.yml)
[![Home Assistant Addon](https://img.shields.io/github/actions/workflow/status/dougrathbone/cgateweb/hacs-distribution.yml?label=Home%20Assistant%20Addon)](https://github.com/dougrathbone/cgateweb/actions/workflows/hacs-distribution.yml)

MQTT bridge for Clipsal C-Bus lighting systems, written in Node.js. Available as a **Home Assistant Add-on** or as a standalone service.

Connects to C-Gate over TCP, publishes C-Bus events to an MQTT broker, and supports Home Assistant MQTT Discovery for automatic device configuration. Control your C-Bus lights, covers, switches, and sensors from Home Assistant or any MQTT-compatible platform.

> **Looking for HVAC support?** See this fork: https://github.com/mminehanNZ/cgateweb

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

 - cbus/write/#1///tree - result gets published as JSON on cbus/read/#1///tree

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

> **HVAC notes:** The real C-Bus *Air Conditioning* application (172) and *Heating* (136) are not driven by C-Gate's lighting verbs, so cgateweb cannot control a native thermostat directly through `ha_discovery_hvac_app_id`. The supported pattern is to program a Pascal Logic Controller (PAC) or touchscreen to mirror HVAC control onto a lighting-compatible group/application, then point `ha_discovery_hvac_app_id` at that app.
>
> **Native read-only Air Conditioning (172) data** is available via `cbus_aircon_app_id`. Set it to your AC application id (typically `172`) and cgateweb will decode broadcasts from the C-Bus Air Conditioning application and publish to the following topics — keyed by the thermostat's **source unit** (e.g. `201`, `202`), not the zone group, so multiple thermostats on the same network never collide:
>
> | Topic | Value |
> |-------|-------|
> | `cbus/read/{net}/172/{sourceUnit}/current_temperature` | Room temperature in °C (raw / 256) |
> | `cbus/read/{net}/172/{sourceUnit}/setpoint` | Target setpoint in °C (raw / 256) |
> | `cbus/read/{net}/172/{sourceUnit}/mode` | `off` or `heat` (verified); `cool`, `auto`, `fan_only` (best-effort, not yet confirmed on hardware) |
> | `cbus/read/{net}/172/{sourceUnit}/state` | `ON` / `OFF` (zone-group master on/off) |
>
> This is **read-only** — no HVAC control commands are sent. To help capture raw event samples for other specialised applications (e.g. Temperature Broadcast app 25, Measurement app 228), set `cbusRawEventLogApps` to a list of app IDs (e.g. `['25', '228']`) — cgateweb will then log each matching C-Gate event line verbatim and publish it to `cbus/read/{net}/{app}/{group}/raw`. Defaults to `[]` (off).

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
*   **Devices that live on the Lighting application (56) but are not lights** — e.g. shutter-relay units (blinds use lighting group addresses) or a thermostat exposed on app 56 — are classified by Application ID and so default to `light`. Motorised covers whose label contains a cover keyword are now auto-detected (see *Automatic cover detection* below). For anything auto-detection can't infer, add a per-group `type_overrides` entry in your labels file (`"<net>/<app>/<group>": "cover" | "switch" | "relay" | "pir" | "hvac"`) or via the web UI; an override always wins.
*   If multiple discovery types (e.g., Cover and Switch) are configured with the *same* Application ID, `cgateweb` prioritizes discovery in this order: Cover > Switch > Relay > PIR. Only the first matching type will be discovered for a given C-Bus group using that Application ID.
*   For more technical details, see `docs/project-homeassistant-discovery.md`.

#### Automatic cover detection

Groups on the Lighting application (56) whose label contains a cover keyword (`blind`, `shutter`, `shade`, `awning`, `curtain`, `roller`, `garage door`) are published as Home Assistant `cover` entities instead of `light`. This is on by default (`ha_discovery_auto_type: true`).

Precedence: a manual `type_overrides` entry always wins, then application-id mappings, then this automatic detection, then the default `light`. To disable auto-detection set `ha_discovery_auto_type: false`; to keep it on but turn off keyword matching set `ha_discovery_auto_type_name_heuristics: false`. Customise the keyword list with `ha_discovery_auto_type_cover_keywords` (matching is case-insensitive and catches plurals).

Note: a shutter relay with a non-descriptive name still appears as a light — add a `type_overrides` entry (e.g. `"254/56/15": "cover"`) for those.

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
