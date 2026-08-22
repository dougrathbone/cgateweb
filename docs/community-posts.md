# Community posts (copy-paste)

These are ready to post. Do not paste the same text into five places on the same day. One Home Assistant Community thread, replies on existing C-Bus threads, then the lists and local groups.

File issues on https://github.com/dougrathbone/cgateweb — not on the add-on distribution repo.

This is a Supervisor add-on, not a HACS integration.

---

## Home Assistant Community (Share your Projects)

Title: C-Gate Web Bridge — Clipsal C-Bus as a Home Assistant add-on

Body:

C-Gate Web Bridge is a Home Assistant add-on that talks to Clipsal C-Gate and publishes C-Bus lights, covers, switches, sensors, air conditioning and a security panel onto MQTT Discovery, so they appear in Home Assistant without YAML.

It is an add-on repository, not HACS. Add this URL in Settings → Add-ons → Add-on Store → Repositories:

https://github.com/dougrathbone/cgateweb-homeassistant

Typical setup is four fields: add the repo, install, set C-Gate host and project, start. MQTT is auto-detected if you run Mosquitto. If you do not already run C-Gate, managed mode can download and run it inside the add-on, including a USB PC Interface on the HA host.

Source, issues and the full option list: https://github.com/dougrathbone/cgateweb

I maintain it. If something mis-discovers a group or a panel, open an issue on the source repo with add-on version and a redacted log.

---

## Reply on an existing C-Bus / C-Gate thread

If you are still wiring C-Bus into Home Assistant with a hand-rolled MQTT script, there is now an add-on that does discovery for you: C-Gate Web Bridge. Add https://github.com/dougrathbone/cgateweb-homeassistant in the Add-on Store (not HACS). Point it at your C-Gate host and project name. Bugs and requests go to https://github.com/dougrathbone/cgateweb/issues

---

## awesome-home-assistant (or similar lists)

- [C-Gate Web Bridge](https://github.com/dougrathbone/cgateweb) - Home Assistant add-on that bridges Clipsal C-Bus (via C-Gate) to MQTT Discovery.

Add-on repository: `https://github.com/dougrathbone/cgateweb-homeassistant`

---

## Aussie / NZ home automation groups (short)

Clipsal C-Bus users on Home Assistant: there is a Supervisor add-on that maps C-Gate through to HA as lights, blinds, sensors, HVAC and alarm. Not HACS — add https://github.com/dougrathbone/cgateweb-homeassistant in the Add-on Store. Source: https://github.com/dougrathbone/cgateweb
