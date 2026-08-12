cgateweb
========

[![Node.js CI](https://github.com/dougrathbone/cgateweb/actions/workflows/ci.yml/badge.svg)](https://github.com/dougrathbone/cgateweb/actions/workflows/ci.yml)
[![Home Assistant Addon](https://img.shields.io/github/actions/workflow/status/dougrathbone/cgateweb/hacs-distribution.yml?label=Home%20Assistant%20Addon)](https://github.com/dougrathbone/cgateweb/actions/workflows/hacs-distribution.yml)
[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-dougrathbone-FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/dougrathbone)

An MQTT bridge for Clipsal C-Bus. It connects to C-Gate over TCP, publishes C-Bus state to MQTT, and accepts commands back — so your lights, blinds, switches, sensors, air conditioning and security panel appear in Home Assistant automatically.

Run it as a **Home Assistant add-on** (recommended) or as a **standalone Node.js service**.

## Install

### Home Assistant add-on

1. Settings → Add-ons → Add-on Store → ⋮ → **Repositories**
2. Add `https://github.com/dougrathbone/cgateweb-homeassistant`
3. Refresh the store, install **C-Gate Web Bridge**, set `cgate_host` and `cgate_project` in the Configuration tab, and start it.

MQTT is detected automatically if you run the Mosquitto add-on. Everything else is optional.

👉 **[Full configuration reference and walkthroughs →](homeassistant-addon/DOCS.md)**

### Standalone

Needs Node.js 20+ and a C-Gate you can reach over the network.

```bash
git clone https://github.com/dougrathbone/cgateweb.git
cd cgateweb
npm install
cp settings.js.example settings.js   # then edit: C-Gate host, project name, MQTT broker
npm start
```

To run it as a systemd service instead of in the foreground:

```bash
sudo node install-service.js         # installs, enables and starts cgateweb.service
sudo node uninstall-service.js       # to remove
```

## Do I need C-Gate?

Yes — cgateweb talks to C-Gate, it does not talk to C-Bus directly. You have two options:

- **Remote mode** (simplest, and what most people should use): run C-Gate on any Windows or Linux machine that has your C-Bus interface attached, and point cgateweb at its IP.
- **Managed mode** (Home Assistant add-on only): the add-on downloads and runs C-Gate for you, including support for a USB PC Interface plugged into the Home Assistant host. See [Managed mode](homeassistant-addon/DOCS.md#c-gate-managed-mode-settings).

## MQTT topics

Replace `{net}`, `{app}` and `{group}` with your C-Bus network, application and group numbers (commonly `254`, `56`, and the group).

**State, published by cgateweb:**

| Topic | Value |
|---|---|
| `cbus/read/{net}/{app}/{group}/state` | `ON` / `OFF` |
| `cbus/read/{net}/{app}/{group}/level` | Level as a percentage |
| `cbus/read/{net}/{app}/{group}/source_unit` | The C-Bus unit that caused the change, so automations can ignore their own writes |
| `hello/cgateweb` | `Online` / `Offline` (the latter via MQTT last-will if the bridge dies) |

**Commands, published by you:**

| Topic | Payload |
|---|---|
| `cbus/write/{net}/{app}/{group}/switch` | `ON` / `OFF` |
| `cbus/write/{net}/{app}/{group}/ramp` | `0`–`100`, optionally `50,4s` or `100,2m` to ramp over time; also `INCREASE`, `DECREASE`, `ON`, `OFF` |
| `cbus/write/{net}/{app}/{group}/position` | `0`–`100` for covers (`0` closed) |
| `cbus/write/{net}/{app}/{group}/stop` | `STOP` to halt a cover or ramp |
| `cbus/write/{net}/{app}//getall` | Any payload — republishes current state for that application |
| `cbus/write/{net}///gettree` | Any payload — publishes the network structure as JSON to `cbus/read/{net}///tree` |

Air conditioning and security have their own topics — see [Applications](homeassistant-addon/DOCS.md#c-bus-application-ids).

**Broker ACLs:** the bridge needs to *subscribe* to `cbus/write/#` and *publish* to `cbus/read/#`, `cbus/bridge/#`, `hello/cgateweb`, and `homeassistant/#` if discovery is on. [Mosquitto example](homeassistant-addon/DOCS.md).

## Home Assistant discovery

With `ha_discovery_enabled`, cgateweb reads your C-Gate network structure and publishes MQTT Discovery configs, so entities appear without you defining any YAML.

Discovered with no extra configuration:

- **Lights** — every Lighting (56) group. Motorised covers are auto-detected from the group name (`blind`, `shutter`, `curtain`, …) and become `cover` entities instead.
- **Temperature sensors** — Temperature Broadcast (25) groups, the first time each one reports.
- **Security** — one `binary_sensor` per alarm zone, plus an alarm panel entity, from application 208.

Opt in by pointing a setting at the application id your project uses:

| Setting | Becomes |
|---|---|
| `ha_discovery_cover_app_id` | `cover` entities (often `203`) |
| `ha_discovery_switch_app_id` | `switch` entities |
| `ha_discovery_relay_app_id` | `switch` entities, device class outlet |
| `ha_discovery_pir_app_id` | `binary_sensor` entities, device class motion |
| `ha_discovery_trigger_app_id` | `event`, `button` and `scene` entities |
| `cbus_aircon_app_id` | `climate` entities from native C-Bus air conditioning (`172`) |

Application ids vary between installations — check your project in C-Bus Toolkit, or publish to `cbus/write/{net}///gettree` and read the JSON that comes back.

Writes are **opt-in** for anything that controls real plant or security: air conditioning needs `cbus_aircon_control_enabled`, and arming the alarm needs `cbus_security_control_enabled` (with disarming behind `cbus_security_disarm_enabled` on top).

If a group gets the wrong entity type, override it per group in your labels file or through the built-in web UI. The full precedence rules, per-group overrides, and the opt-in unit-type classification are all in [DOCS.md](homeassistant-addon/DOCS.md#home-assistant-discovery).

## Development

```bash
npm test              # Jest unit tests
npm test -- --coverage
npm run lint
npm run typecheck
```

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE.txt). Originally created by Steven Lazidis, currently maintained by Doug Rathbone.
