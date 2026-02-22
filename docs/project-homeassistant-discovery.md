# PRD: Home Assistant MQTT Discovery for cgateweb

**1. Introduction**

This document outlines the requirements for adding Home Assistant MQTT Discovery support to the `cgateweb` project. This feature will allow `cgateweb` to automatically announce configured C-Bus devices (initially lighting groups) to Home Assistant, enabling them to be automatically detected and added without manual configuration in Home Assistant's `configuration.yaml`.

**2. Goals**

*   Automatically discover C-Bus lighting groups managed by C-Gate as Home Assistant `light` entities via MQTT.
*   Provide basic control (On/Off, Brightness) for discovered lights through Home Assistant.
*   Populate Home Assistant entities with relevant information obtained from C-Gate (names/labels, addresses).
*   Allow users to enable/disable and configure the discovery process.

**3. Mechanism**

*   `cgateweb` will implement the [Home Assistant MQTT Discovery protocol](https://www.home-assistant.io/integrations/mqtt/#mqtt-discovery).
*   For each C-Bus lighting group identified, `cgateweb` will publish a configuration payload (JSON) to a specific MQTT topic.
*   Home Assistant, when configured for MQTT discovery on the same broker, will listen for these messages and automatically create corresponding `light` entities.

**4. Triggering Discovery**

Discovery messages will be published under the following conditions:

*   **On Startup:** After `cgateweb` successfully connects to both C-Gate and the MQTT broker, it will query the C-Gate network structure and publish discovery messages for all identified lighting groups.
*   **Manual Trigger:** Via a specific MQTT message published to a `cgateweb` control topic (e.g., `cbus/write/bridge/announce`). This allows for re-discovery if needed.
*   **(Future Consideration):** Periodically re-publishing discovery messages to ensure HA stays in sync, although retained messages should handle most cases.

**5. Information Source**

*   `cgateweb` will primarily use the C-Gate `TREEXML <network>` command to retrieve the network object structure, including Application addresses and Group addresses/labels (names).
*   The target C-Bus network(s) for discovery should ideally be configurable or derived from activity/settings (e.g., the network specified in `getallnetapp`). For simplicity initially, we may rely on the network(s) configured for `getall*` or require explicit configuration.

**6. Mapping C-Bus Lighting to Home Assistant Entities**

*   **HA Component:** C-Bus Lighting Application groups (typically Application ID 56) will be mapped to the Home Assistant `light` component.
*   C-Bus Enable Control Application groups (typically Application ID 203, used for relays/blinds) will be mapped to the Home Assistant `cover` component (initial support for basic open/close).
*   Optionally, groups under a user-configured Application ID (`ha_discovery_switch_app_id`, default `null`) can be mapped to the Home Assistant `switch` component.
*   **Discovery Topic Format (Light):** `<discovery_prefix>/light/cgateweb_<network>_56_<group>/config`
*   **Discovery Topic Format (Cover):** `<discovery_prefix>/cover/cgateweb_<network>_<cover_app_id>_<group>/config`
*   **Discovery Topic Format (Switch):** `<discovery_prefix>/switch/cgateweb_<network>_<switch_app_id>_<group>/config`
    *   `<discovery_prefix>`: Configurable via `settings.js`, defaults to `homeassistant`.
    *   `<network>`, `<app>`, `<group>`: C-Bus addressing identifiers obtained from C-Gate.
    *   The `cgateweb_` prefix helps namespace entities created by this bridge.
*   **Entity Naming:** The Home Assistant entity's friendly name will be derived from the C-Bus Group Label obtained via `TREEXML`. A fallback name (e.g., "CBus Light <network>/<app>/<group>") will be used if no label is available.
*   **Unique ID:** `cgateweb_<network>_<app>_<group>` (ensures stability across restarts).

**7. Configuration Payload (JSON)**

For each C-Bus lighting group (`<network>/56/<group>`):
```json
{
  "name": "<Group Label or Fallback Name>",
  "unique_id": "cgateweb_<network>_56_<group>",
  "state_topic": "cbus/read/<network>/56/<group>/state",
  "command_topic": "cbus/write/<network>/56/<group>/switch",
  "payload_on": "ON",
  "payload_off": "OFF",
  "brightness_state_topic": "cbus/read/<network>/56/<group>/level",
  "brightness_command_topic": "cbus/write/<network>/56/<group>/ramp",
  "brightness_scale": 100, // Matches the 0-100 scale used by cgateweb's /level topic
  "qos": 0, // Default QoS
  "retain": true, // Discovery messages MUST be retained
  "device": {
    "identifiers": ["cgateweb_<network>_56_<group>"], // Could potentially group by C-Bus Unit later
    "name": "<Group Label or Fallback Name>",
    "manufacturer": "Clipsal C-Bus via cgateweb",
    "model": "Lighting Group", // Or potentially identify specific unit types later
    "via_device": "cgateweb_bridge" // Link to the bridge device
  },
  "origin": { // Optional: Helps HA diagnostics
      "name": "cgateweb",
      "sw_version": "<cgateweb_version>", // Requires adding version info
      "support_url": "https://github.com/dougrathbone/cgateweb"
  }
  // Future: Add availability_topic if needed/reliable
}
```
*   **Note on Brightness:** `cgateweb` currently publishes level state as `0-100`. Therefore, `brightness_scale: 100` is required in the HA payload for the `brightness_state_topic` to be interpreted correctly. `cgateweb` accepts `0-100` on the `ramp` command topic and translates internally, so this matches.

For each C-Bus Enable Control group (`<network>/203/<group>`) identified as a cover:
```json
{
  "name": "<Group Label or Fallback Name>",
  "unique_id": "cgateweb_<network>_203_<group>",
  "state_topic": "cbus/read/<network>/203/<group>/state",
  "command_topic": "cbus/write/<network>/203/<group>/switch",
  "payload_open": "ON",
  "payload_close": "OFF",
  "state_open": "ON",
  "state_closed": "OFF",
  "position_topic": "cbus/read/<network>/203/<group>/position",
  "set_position_topic": "cbus/write/<network>/203/<group>/position",
  "stop_topic": "cbus/write/<network>/203/<group>/stop",
  "payload_stop": "STOP",
  "position_open": 100,
  "position_closed": 0,
  "qos": 0, 
  "retain": true,
  "device_class": "shutter",
  "device": {
    "identifiers": ["cgateweb_<network>_203_<group>"],
    "name": "<Group Label or Fallback Name>",
    "manufacturer": "Clipsal C-Bus via cgateweb",
    "model": "Enable Control Group (Cover)",
    "via_device": "cgateweb_bridge"
  },
  "origin": { 
      "name": "cgateweb",
      "sw_version": "<cgateweb_version>",
      "support_url": "https://github.com/dougrathbone/cgateweb"
  }
}
```
*   **Note on Covers:** Covers now support full position control:
    - **Position**: 0-100% where 0=closed, 100=fully open
    - **Stop**: Stops the cover at its current position using TERMINATERAMP
    - **Open/Close**: Basic ON/OFF commands for full open/close
    - State is reported as ON (open/opening) or OFF (closed)

For each C-Bus group (`<network>/<switch_app_id>/<group>`) identified as a switch:
```json
{
  "name": "<Group Label or Fallback Name>",
  "unique_id": "cgateweb_<network>_<switch_app_id>_<group>",
  "state_topic": "cbus/read/<network>/<switch_app_id>/<group>/state",
  "command_topic": "cbus/write/<network>/<switch_app_id>/<group>/switch",
  "payload_on": "ON",
  "payload_off": "OFF",
  "state_on": "ON", 
  "state_off": "OFF",
  "qos": 0,
  "retain": true,
  "device": {
    "identifiers": ["cgateweb_<network>_<switch_app_id>_<group>"],
    "name": "<Group Label or Fallback Name>",
    "manufacturer": "Clipsal C-Bus via cgateweb",
    "model": "Generic Group (Switch)", // Model might be unknown/Enable Control
    "via_device": "cgateweb_bridge"
  },
  "origin": { 
      "name": "cgateweb",
      "sw_version": "<cgateweb_version>",
      "support_url": "https://github.com/dougrathbone/cgateweb"
  }
}
```

**8. `cgateweb` Configuration (`settings.js`)**

New settings will be added:

*   `ha_discovery_enabled` (boolean, default: `false`): Master switch to enable/disable the feature.
*   `ha_discovery_prefix` (string, default: `"homeassistant"`): The MQTT topic prefix HA listens on.
*   `ha_discovery_networks` (array of strings/numbers, default: `null` or `[]`): Specifies which C-Bus network IDs (e.g., `[254, 255]`) to run discovery on. If null/empty, discovery might be disabled or attempt based on `getallnetapp`.
*   `ha_discovery_cover_app_id` (string/number, default: `203`): The C-Bus Application ID to treat as covers.
*   `ha_discovery_switch_app_id` (string/number, default: `null`): The C-Bus Application ID to treat as switches. If set (e.g., to '203' or '1'), groups under this application will be discovered as switches.

**9. Limitations (Initial Scope)**

*   Only C-Bus Lighting (App 56), Enable Control configured as Covers (App 203 default), and groups under the optionally configured Switch App ID are discovered.
*   Cover support is basic open/close (mapping to C-Bus ON/OFF). Stop commands and position reporting are not supported.
*   Assumes the standard `cgateweb` topic structure for state and commands.
*   Does not initially handle device removal cleanly (i.e., publishing an empty payload to the config topic when a C-Bus device disappears from C-Gate requires extra logic). HA handles stale entities relatively well if the device becomes unavailable.
*   Availability (`availability_topic`) is not included initially, as C-Gate's online/offline reporting for individual groups might require `TREEXMLDETAIL` or specific event monitoring.

**10. Future Enhancements**

*   Discover other C-Bus application types (e.g., explicit Relay app if identified).
*   Add support for `STOP` commands for covers if feasible via C-Bus scenes or specific hardware.
*   Add support for cover position if using specific C-Bus blind controllers.
*   Implement availability topics based on C-Gate status or unit online status (if feasible).
*   Add logic to remove HA entities when C-Bus devices are removed from C-Gate config (publish empty payload).
*   More sophisticated device grouping in HA based on C-Bus Unit addresses from `TREEXMLDETAIL`.
*   Allow customization of entity names via `settings.js`.
