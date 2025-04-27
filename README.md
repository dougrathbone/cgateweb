cgateweb
========

MQTT interface for C-Bus lighting written in Node.js.

This script acts as a middleware broker that connects to C-Gate over telnet and publishes the events to an MQTT broker.

(If you're looking for HVAC, I haven't/can't try it but have a look at this fork: https://github.com/mminehanNZ/cgateweb)

### Install:

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
2)  Run `node index.js` (useful for testing or foreground operation).


### Updates get published on these topics:

 - cbus/read/#1/#2/#3/state  -  ON/OFF gets published to these topics if the light is turned on/off

 - cbus/read/#!/#2/#3/level  -  The level of the light gets published to these topics

### Publish to these topics to control the lights:

 - cbus/write/#1/#2/#3/switch  -  Publish ON/OFF to these topics to turn lights on/off

 - cbus/write/#1/#2/#3/ramp  -  Publish a % to ramp to that %. Optionally add a comma then a time (e.g. 50,4s or 100,2m). Also, INCREASE/DECREASE ramp by 5% up or down and ON/OFF turns on/off.

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
*   **Covers:** Devices using the configured `ha_discovery_cover_app_id` (default: `203`) are discovered as `cover` entities (device class `shutter`), supporting open/close.
*   **Switches:** Devices using the configured `ha_discovery_switch_app_id` (default: `null`) are discovered as `switch` entities.
*   **Relays:** Devices using the configured `ha_discovery_relay_app_id` (default: `null`) are discovered as `switch` entities with device class `outlet`.
*   **PIR Motion Sensors:** Devices using the configured `ha_discovery_pir_app_id` (default: `null`) are discovered as `binary_sensor` entities with device class `motion`.

**Configuration (`settings.js`):**

```javascript
module.exports = {
    // ... other settings ...

    // --- HA Discovery Settings ---
    ha_discovery_enabled: true,         // Set to true to enable discovery
    ha_discovery_prefix: 'homeassistant', // Default HA discovery topic prefix
    ha_discovery_networks: ['254'],     // List C-Bus network IDs to scan (e.g., ['254', '200'])
    
    // Application IDs for specific device types (MUST match your C-Bus project configuration)
    ha_discovery_cover_app_id: '203',   // App ID for Covers (e.g., Enable Control)
    ha_discovery_switch_app_id: null,   // App ID for Switches (e.g., Enable Control, Trigger Control) - null to disable
    ha_discovery_relay_app_id: null,    // App ID for Relays (e.g., Enable Control) - null to disable
    ha_discovery_pir_app_id: null      // App ID for PIR Motion Sensors (e.g., Trigger Control) - null to disable
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

*   Discovery for Switches, Relays, and PIRs is **disabled by default** (`null`). You *must* set the corresponding `ha_discovery_*_app_id` in `settings.js` to the correct C-Bus Application ID to enable discovery for these types.
*   If multiple discovery types (e.g., Cover and Switch) are configured with the *same* Application ID, `cgateweb` prioritizes discovery in this order: Cover > Switch > Relay > PIR. Only the first matching type will be discovered for a given C-Bus group using that Application ID.
*   For more technical details, see `docs/project-homeassistant-discovery.md`.

### Testing

This project uses Jest for unit testing.

1.  Install development dependencies: `npm install`
2.  Run tests: `npx jest`
3.  Run tests with coverage report: `npx jest --coverage`

### Other notes:

This project is actively developed against Home Assistant, but should work with any MQTT-compatible system.
It assumes the default cgate ports
