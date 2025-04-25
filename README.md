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

This project supports automatic discovery of C-Bus lighting groups (as `light` entities), basic relay/cover groups (as `cover` entities using `ha_discovery_cover_app_id`), and basic switch groups (as `switch` entities using `ha_discovery_switch_app_id`) in Home Assistant.

*   Enable by setting `ha_discovery_enabled: true` in `settings.js`.
*   Configure the MQTT discovery prefix (usually `homeassistant`) via `ha_discovery_prefix`.
*   Specify which C-Bus networks to scan for devices using `ha_discovery_networks`.
*   Configure the C-Bus Application IDs for covers and switches using `ha_discovery_cover_app_id` (default 203) and `ha_discovery_switch_app_id` (default null).
*   See `docs/project-homeassistant-discovery.md` for more details.

### Testing

This project uses Jest for unit testing.

1.  Install development dependencies: `npm install`
2.  Run tests: `npx jest`
3.  Run tests with coverage report: `npx jest --coverage`

### Other notes:

This project is actively developed against Home Assistant, but should work with any MQTT-compatible system.
It assumes the default cgate ports
