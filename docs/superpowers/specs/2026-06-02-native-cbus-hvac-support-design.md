# Native C-Bus HVAC Support — Design

**Date:** 2026-06-02
**Status:** Approved (brainstorming complete)
**Approach:** A — Verification-first, phased, pluggable per-application decoders

## Background

A user (Karl) reported that cgateweb's HVAC support "wasn't working." Investigation of his
C-Gate 3 project backup (`THEGAFF.db`), cross-referenced against our code, the C-Gate manual,
and open C-Bus protocol references, confirmed the report and a forum poster's diagnosis: our
current HVAC support is built on a wrong assumption.

### What the investigation found

Karl's actual C-Bus applications (network 1):

| App addr | Name | Nature |
|---|---|---|
| 56 | Lighting | standard lighting |
| 113 | Irrigation | |
| **115** | **HVAC Actuator 1** | **lighting-style** relay groups: `Y (heat/cool)`, `B (cool activation)`, `G (fan)`, `B (heat activation)`, `W (heat)`, `G (cool/heat fan)`, `Damper Zone 1-4` |
| 116 | HVAC Actuator 2 | lighting-style |
| 136 | Heating (Legacy) | legacy heating app |
| **172** | **Air Conditioning** | the real C-Bus HVAC app — thermostat (unit 250) lives here; only a "Communication Group 1" |
| 202 | Trigger Control | |
| 203 | Enable Control | |
| 224 | Telephony | |

He also has a **Pascal Logic Controller (unit 10)** — exactly the device that can bridge app 172
to lighting-compatible groups.

Three concrete defects / gaps:

1. **Bogus default.** `src/constants.js` hard-codes `DEFAULT_CBUS_APP_HVAC = '201'`. App 201 does
   not exist in standard C-Bus. The docs cite it as the default.
2. **Faked HVAC via lighting ramps.** `mqttCommandRouter._handleHvacSetpoint` sends `RAMP` with
   `level = round(temp × 2)`; `_handleHvacMode` maps every active mode to a plain `ON`. Both carry
   code comments admitting "Hardware validation required." This only works if a touchscreen/PAC has
   been programmed to expose lighting-compatible groups — which is precisely what Karl's app 115 is.
3. **C-Gate exposes no native verb for the Air Conditioning ($AC/172) application.** The manual
   lists dedicated commands for Lighting, Measurement ($E4), Temperature Broadcast ($19), Enable,
   Trigger, Security, Clock, MediaTransport — but nothing for $AC. So a real C-Bus HVAC thermostat
   cannot be driven the way lighting is. (The `mminehanNZ/cgateweb` fork confirms C-Gate *does*
   surface app-172 messages on the event interface for reading, but punts all encoding onto the user
   and points at Clipsal's proprietary "C-Gate Air-Conditioning Application User Guide.pdf".)

Karl's project has **no Temperature Broadcast (25) app, no Measurement (228) app, no network
variables, and no control points** — his temperature/setpoint/mode data lives entirely on app 172.
Measurement/Temp-Broadcast support is therefore valuable for the general user base but does not, by
itself, read Karl's thermostat.

### The unifying lesson

The original bug was **guessing a wire format**. This design is verification-first: no decoder for a
specialised application is written from a guess — only against real captured C-Gate event lines.

## Goals

- Remove the broken `201` default and the misleading temp×2/ON mapping; document the working pattern.
- Add native read support for Temperature Broadcast ($19) → HA temperature.
- Add native read support for Measurement ($E4).
- Add **read-only** support for the Air Conditioning application (172): zone temp/setpoint/mode.

## Non-goals (this scope)

- **No writes to app 172** (no live-HVAC setpoint/mode writes). Read-only first; writes are a
  separate, hardware-validated effort.
- No composite multi-group climate entity (explicitly deferred by the user).
- No changes to lighting/cover/PIR/trigger behaviour.

## Architecture — pluggable application-decoder registry

Today every event line runs through one regex
(`EVENT_REGEX = /^(\w+)\s+(\w+)\s+(\d+\/\d+\/\d+)(?:\s+(\d+))?/`) that assumes
`<type> <action> <net>/<app>/<group> [one-int]`. Lighting fits; temperature/measurement/air-con
carry extra fields that get silently truncated.

```
line ──► CBusEvent
            │  fast path (lighting/trigger/PIR/cover): unchanged regex   ← hot path, untouched
            │
            └─ if application ∈ registered specialised decoders {25, 228, 172}:
                   ApplicationDecoderRegistry.decode(app, rawLine) → reading | null
                                                        │
                          ┌─────────────────────────────┼─────────────────────────────┐
                  TemperatureDecoder($19)      MeasurementDecoder($E4)      AirConDecoder($172)
                          │                             │                             │
                          └────────► reading {kind, value, unit, zone, ...} ───────────┘
                                                        │
                                       EventPublisher.publishReading() → MQTT
```

- **`src/applicationDecoders/`** — one module per application, each exporting
  `{ appId, decode(rawLine) → reading | null }`. One clear purpose; independently testable; mirrors
  libcbus's one-module-per-application layout.
- **`CBusEvent`** keeps the lighting fast path. It gains a single branch: if the parsed application
  has a registered specialised decoder, delegate; otherwise behave exactly as today. **Zero
  behavioural change** for existing users.
- **`EventPublisher`** gains a `publishReading()` path for structured readings, separate from the
  existing on/off/level publish.

Property: adding an application = one decoder file + tests, no hot-path edits.

## Phasing & deliverables

Each phase ships independently. **Phases 1–3 proceed now.** Phases 4–5 are written but **blocked
until real captured samples** for apps 228/172 exist (Phase 2 produces them).

| Phase | Deliverable | Status | Risk |
|---|---|---|---|
| **1. Foundation fix** | Remove `DEFAULT_CBUS_APP_HVAC='201'`; keep `ha_discovery_hvac_app_id` defaulting `null`; fence/rewrite the temp×2 + mode→ON code as explicitly legacy "HVAC-via-lighting"; document the working pattern (expose HVAC on a lighting-style app like 115 + PAC bridge) | **Now** | Low |
| **2. Raw-event capture mode** | `cbusRawEventLogApps: []` — when an app ID is listed, log the verbatim C-Gate event line (info level), optionally publish to `cbus/read/{net}/{app}/{group}/raw`. Lets users capture ground-truth for 25/228/172 | **Now** | Low |
| **3. Temperature ($19)** | `TemperatureDecoder` (`°C = byte ÷ 4`, 0–63.75) → `current_temperature` topic; optional HA temperature-sensor discovery | **Now** (confirm C-Gate string via Phase 2) | Low |
| **4. Measurement ($E4)** | `MeasurementDecoder` → sensor topic(s) with unit/value | **Blocked on capture** | Medium |
| **5. Air Conditioning (172) read-only** | `AirConDecoder` → zone temp/setpoint/mode to MQTT + climate `current_temperature`; **no writes** | **Blocked on capture** | Medium-High |

## Configuration (additive; defaults preserve current behaviour)

Per the CLAUDE.md rule that new tunables must be additive (default = current behaviour):

- `cbusRawEventLogApps: []` — app IDs to dump verbatim (Phase 2)
- `ha_discovery_temperature_app_id: null` — Temp Broadcast app (conventionally 25 when enabled)
- `ha_discovery_measurement_app_id: null`
- `ha_discovery_aircon_app_id: null` — read-only Air Conditioning app (conventionally 172)

`homeassistant-addon/config.yaml` and `package.json` version stay in sync; any new scalar options
added to the add-on schema use the optional (`?`) suffix or ship with defaults in `options`, per the
config.yaml rules.

## Encoding — known vs. must-verify

- **Temperature $19:** `°C = rawByte ÷ 4`, range 0–63.75 (libcbus). *Known.* The C-Gate event-port
  string wrapping it must be confirmed from a Phase-2 capture before the decoder is finalised.
- **Measurement $E4:** multi-field (device/channel/value/units/exponent). **Must capture.**
- **Air-Con 172:** complex multi-param SAL (the mminehanNZ fork shows payloads like
  `5 0 1 0 0 0 1 8 4352 0`); zone temp/setpoint/mode layout per Clipsal's "C-Gate Air-Conditioning
  Application User Guide." **Must capture and, where possible, cross-check against that guide.**

**Verification rule:** decoders for 228/172 are built TDD against real captured fixtures. If a
sample for an app cannot be obtained, that phase stays unshipped rather than shipping a guess.

## Error handling

- A decoder returns `null` on malformed/partial input (never throws) → pipeline falls through to
  today's behaviour or drops cleanly; the event loop never wedges (the "parse failure must have a
  recovery route" pattern).
- Out-of-range decoded values (e.g. temperature > 63.75) are logged and dropped, not published.

## Testing

- **TDD per decoder**: pure-parser unit tests using real captured lines as fixtures
  (Arrange-Act-Assert; mock nothing).
- **Regression guard**: existing lighting/cover/PIR/trigger event tests stay green — proves the hot
  path is untouched.
- **HA discovery tests** for any new sensor/climate entity.
- **No live-HVAC writes** anywhere in this scope.

## Open dependency

Phases 4–5 require a real capture from a system that uses apps 228/172 (e.g. Karl's). Phase 2 is the
mechanism; until samples exist, 4–5 remain specified-but-unshipped.

## References

- libcbus temperature application (encoding `°C = byte/4`):
  https://github.com/micolous/cbus/blob/master/cbus/protocol/application/temperature.py
- libcbus temperature docs:
  https://cbus.readthedocs.io/en/latest/cbus.protocol.application.temperature.html
- mminehanNZ/cgateweb (reads app-172 HVAC messages; defers encoding to the user):
  https://github.com/mminehanNZ/cgateweb
- C-Gate manual (condensed): `docs/cgate-manual.md` (Measurement $E4 / Temperature Broadcast $19;
  no $AC verb)
- Clipsal "C-Gate Air-Conditioning Application User Guide.pdf" — proprietary; required for full 172
  field layout
