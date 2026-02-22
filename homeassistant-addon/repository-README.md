# C-Gate Web Bridge - Home Assistant Add-on Repository

![C-Gate Web Bridge](cgateweb/logo.png)

A Home Assistant add-on that bridges [Clipsal C-Bus](https://www.clipsal.com/products/c-bus) lighting and automation systems to Home Assistant via MQTT.

[![GitHub Release](https://img.shields.io/github/v/release/dougrathbone/cgateweb-homeassistant?style=flat-square)](https://github.com/dougrathbone/cgateweb-homeassistant/releases)
[![GitHub Stars](https://img.shields.io/github/stars/dougrathbone/cgateweb?style=flat-square)](https://github.com/dougrathbone/cgateweb)

## Features

- **Automatic MQTT Discovery** -- C-Bus devices appear in Home Assistant with no manual YAML configuration
- **Lights, Covers, Switches** -- Supports dimmable lighting (App 56), blinds/shutters, relays, and PIR sensors
- **MQTT Auto-Detection** -- Automatically finds your Mosquitto broker credentials
- **Remote or Managed C-Gate** -- Connect to an existing C-Gate server, or let the add-on run C-Gate for you
- **Connection Pooling** -- High-performance command handling with pooled C-Gate connections

## Installation

### Step 1: Add the repository

1. Open Home Assistant
2. Navigate to **Settings** > **Add-ons** > **Add-on Store**
3. Click the **overflow menu** (three dots, top-right) > **Repositories**
4. Paste the following URL and click **Add**:

```
https://github.com/dougrathbone/cgateweb-homeassistant
```

### Step 2: Install the add-on

1. The **C-Gate Web Bridge** add-on should now appear in the Add-on Store (you may need to refresh the page)
2. Click on it and press **Install**

### Step 3: Configure

1. Go to the **Configuration** tab
2. Set your **C-Gate host** IP address (the machine running C-Gate)
3. Set your **C-Gate project** name (e.g., `HOME` or `CLIPSAL`)
4. MQTT settings are auto-detected from the Mosquitto add-on -- no configuration needed
5. Click **Save**

### Step 4: Start

1. Go to the **Info** tab and click **Start**
2. Check the **Log** tab to verify the add-on connects to C-Gate and MQTT
3. Your C-Bus devices should appear automatically in Home Assistant under **Settings** > **Devices & Services** > **MQTT**

## Quick Start Configuration

For most installations with a remote C-Gate server, only three settings are needed:

| Setting | Value |
|---------|-------|
| C-Gate Mode | `remote` |
| C-Gate Host | IP address of your C-Gate server |
| C-Gate Project | Your C-Gate project name |

Everything else has sensible defaults, including network `254` (the C-Bus factory default) and automatic MQTT broker detection.

## What is C-Gate?

[C-Gate](https://updates.clipsal.com/ClipsalSoftwareDownload/mainsite/cis/technical/downloads/index.html) is Clipsal's server software that communicates with C-Bus hardware over a serial or network interface. This add-on acts as a bridge between C-Gate and Home Assistant via MQTT.

If you don't already have C-Gate running, you can use this add-on's **managed mode** to run it locally.

## Documentation

- **[Full Configuration Reference](https://github.com/dougrathbone/cgateweb/blob/master/homeassistant-addon/DOCS.md)** -- All options, MQTT topics, troubleshooting
- **[Main Project README](https://github.com/dougrathbone/cgateweb#readme)** -- Architecture, development, standalone usage

## Support & Development

All development, issues, and contributions happen in the main repository:

**[dougrathbone/cgateweb](https://github.com/dougrathbone/cgateweb)**

- [Report a Bug](https://github.com/dougrathbone/cgateweb/issues/new)
- [Request a Feature](https://github.com/dougrathbone/cgateweb/issues/new)
- [View Source Code](https://github.com/dougrathbone/cgateweb)

## License

This project is open source. See the [main repository](https://github.com/dougrathbone/cgateweb) for license details.
