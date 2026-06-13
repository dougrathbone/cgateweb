# C-Bus HVAC / Air Conditioning (172) — Investigation Notes

Working knowledge of the C-Bus **Air Conditioning** application (app id `172`, `$AC`)
as reverse-engineered from real thermostat captures, with pointers to the code that
implements each piece. The goal is that future experimentation or iteration can pick
up where we left off without re-deriving the wire format.

> **Status legend:** ✅ verified against real hardware · ⚠️ inferred (not yet observed
> asserting) · ❓ unknown / not captured.

---

## 1. Two different "HVAC" mechanisms (read this first)

cgateweb has **two unrelated HVAC paths**. Confusing them wastes time.

| | **Native Air Conditioning (172)** | **HVAC-via-lighting** |
|---|---|---|
| Enabled by | `cbus_aircon_app_id` | `ha_discovery_hvac_app_id` |
| Source | Real C-Bus AC app `aircon …` event verbs | A lighting-style app where a PAC/touchscreen mirrors HVAC onto lighting groups |
| Temp encoding | `°C = raw / 256` (decoded from `zone_temperature`) | level 0–255 mapped to a temperature via template |
| Keyed by | **source unit** (the thermostat unit addr, e.g. 201/202) | **group** address |
| HA climate entity | **not yet auto-created** (publishes raw topics only) | auto-created by `_createHvacDiscovery` |
| Code | `src/applicationDecoders/airconDecoder.js` | `src/haDiscovery.js` `_createHvacDiscovery` |

**Known gap:** the native path publishes to `cbus/read/{net}/172/{sourceUnit}/…`, but
`_createHvacDiscovery` (`src/haDiscovery.js:812`) builds its climate entity keyed by
**group** (`cbus/read/{net}/{app}/{group}/…`) for the via-lighting pattern. So enabling
`ha_discovery_hvac_app_id=172` does **not** produce a working entity for native
thermostats — the topics don't line up. Closing this (a native climate entity keyed by
source unit) is the main outstanding work — see §7.

---

## 2. Data sources & how to capture more

The decode was derived from **PICED logs** supplied by an end user (Karl, project
`THEGAFF`, thermostat units **201** = Clipsal `5070THP`, **202** = `5070THB`).

PICED is the key trick: it logs the **raw C-Gate `Rx` line** *and* its own
**human-decoded line** at the same timestamp. Pairing them gives ground truth without a
protocol spec. Example (same event, two log lines):

```
C-Gate : Rx "aircon set_zone_hvac_mode //THEGAFF/254/172 1 0,1,2,3,4 2 0 0 0 1 3 3840 0 #sourceunit=201 OID=…"
C-Bus Rx : HVAC Application : Zone Group 1, Zone 0,1,2,3,4 Mode = Cool, … (unit 201)
```
→ `f0 = 2` ⇔ "Mode = Cool".

**To capture more:**
- Best source so far has been **PICED → "Log C-Gate" + "Log C-Touch/PAC"** on the PAC,
  then have the user cycle modes/setpoints/fan and annotate (Karl inserted `~~~ BASELINE`
  markers between units).
- In-repo capture tool: `tools/capture-cbus-events.js` (C-Gate + CNI modes, with
  labelling). It captures the raw stream but does **not** decode semantics the way PICED
  does — prefer PICED logs when reverse-engineering a new field.

**To analyse a capture quickly:** pair raw verbs with PICED text, e.g.
```
grep 'set_zone_hvac_mode' log.txt | sed -E 's#.*/172 ##; s/OID=[^ ]*//'   # raw params
grep 'Mode = ' log.txt | sed -E 's#.*HVAC Application : ##'                # PICED labels
```
The two lists come out in the same chronological order.

---

## 3. Native 172 wire format

### Event line shape
```
[# ]aircon <verb> //<PROJECT>/<net>/172 <zoneGroup> <zoneList> <params…> #sourceunit=<NNN> OID=<…>
```
- C-Gate emits many of these **`#`-comment-prefixed** — the standard event parser drops
  comments, so aircon lines are intercepted *before* that (see §6).
- `#sourceunit=<NNN>` identifies the thermostat unit and is the topic key. Extracted in
  `airconDecoder.js` (`extractSourceUnit`).
- `<zoneList>` is a comma list (e.g. `0,1,2,3,4`) — informational; not used for keying.

### Verbs

Decoder: `src/applicationDecoders/airconDecoder.js` — `decodeLine` (line ~49) dispatches
by verb. Each returns a reading `{ kind, network, application, zoneGroup, zones,
sourceUnit, … , verb }` or `null`.

| Verb | `kind` | Params after `<net>/172` | Decode |
|------|--------|--------------------------|--------|
| `zone_temperature` | `temperature` | `zoneGroup zones rawTemp flag` | ✅ `°C = rawTemp / 256` (`decodeZoneTemperature`) |
| `set_zone_hvac_mode` | `mode` | `zoneGroup zones f0 f1 f2 f3 f4 f5 f6 f7` | ✅ `f0` = mode code; `f6` = setpoint raw (`decodeZoneHvacMode`) |
| `set_ward_on` / `set_ward_off` | `state` | `zoneGroup` | ✅ on/off (`decodeWardState`) |
| `zone_hvac_plant_status` | `action` | `zoneGroup zones statusValid bitmask reserved` | ✅ running state → `hvac_action` (`decodeZonePlantStatus`) |
| `set_plant_hvac_level` | — | `zoneGroup zones f0 … level …` | ❓ plant demand level (~0–255); **not decoded** (not needed for a climate entity) |

### Mode codes (`f0`) — all ✅ verified (capture 2026-06-11)

| `f0` | PICED label | cgateweb mode | Notes |
|------|-------------|---------------|-------|
| 0 | Off | `off` | |
| 1 | Heat | `heat` | |
| 2 | Cool | `cool` | |
| 3 | Heat/Cool (Auto) | `auto` | PICED says "Heat/Cool (Auto)"; HA `heat_cool` may be a better fit when a climate entity is built |
| 4 | Fan Only | `fan_only` | see setpoint sentinel below |

Map: `HVAC_MODE_BY_CODE` (`airconDecoder.js:29`). Unknown codes → `mode: null` and a
warning is logged in `cgateWebBridge._handleAirconLine`.

### Setpoint (`f6`)
- `°C = f6 / 256` (e.g. `5632 → 22.0`, `3840 → 15.0`).
- ⚠️ **Sentinel:** in **Fan Only** mode the thermostat sends `f6 = 32512` (`0x7F00`) =
  "no setpoint". Decoding it naively yields a bogus **127 °C**. Guarded in
  `decodeZoneHvacMode`: setpoint is only emitted when `0 < f6 ≤ 12800` (≤ 50 °C),
  otherwise `null`. (Off mode sends `f6 = 0` → also `null`.)

### Plant status bitmask (`zone_hvac_plant_status`)
Param layout: `zoneGroup zones statusValid bitmask reserved`. The **bitmask** (4th param):

| Bit (value) | Meaning | Status |
|-------------|---------|--------|
| 0 (1) | Cooling | ⚠️ inferred — never asserted in capture (heat-only plant) |
| 1 (2) | Heating | ✅ |
| 2 (4) | Fan | ✅ |
| 3 (8) | Damper | ✅ |
| 4 (16) | (Error?) | ❓ never observed set; position unconfirmed |
| 5 (32) | Busy | ✅ |

Derived `action` (for HA `hvac_action`): `cooling → 'cooling'`, else `heating →
'heating'`, else `fan → 'fan'`, else `'idle'`. See `decodeZonePlantStatus`
(`airconDecoder.js:183`). Example: bitmask `46` = `32+8+4+2` = Busy+Damper+Fan+Heating
→ action `heating`, busy `true`.

---

## 4. MQTT topics published (native path)

All keyed by **source unit** (so two thermostats sharing a zone group don't collide):

```
cbus/read/{network}/172/{sourceUnit}/current_temperature
cbus/read/{network}/172/{sourceUnit}/setpoint
cbus/read/{network}/172/{sourceUnit}/mode
cbus/read/{network}/172/{sourceUnit}/state          # ON/OFF (ward)
cbus/read/{network}/172/{sourceUnit}/action         # heating/cooling/fan/idle
```

Suffix constants: `src/constants.js` (`MQTT_TOPIC_SUFFIX_HVAC_*`, incl.
`MQTT_TOPIC_SUFFIX_HVAC_ACTION = 'action'`).

---

## 5. Settings

`src/defaultSettings.js`:
- `cbus_aircon_app_id` (default `null`) — set to `172` to enable native decode + topic
  publishing. **Off by default.**
- `ha_discovery_hvac_app_id` (default `null`) — the *via-lighting* discovery path (see §1);
  **not** the native path.
- `ha_hvac_temperature_unit` (default `'C'`).

Validation: `src/settingsValidator.js` (`cbus_aircon_app_id`). Add-on wiring:
`src/config/ConfigLoader.js` (maps add-on options → settings), exposed in
`homeassistant-addon/config.yaml`.

---

## 6. Code map (data flow)

```
C-Gate event line
  └─ cgateWebBridge._processEventLine            src/cgateWebBridge.js:421
       └─ _handleAirconLine  (gated on cbus_aircon_app_id)   :395
            ├─ airconDecoder.decodeLine          src/applicationDecoders/airconDecoder.js:49
            │     → { kind: temperature|mode|state|action, … }
            └─ eventPublisher.publishReading      src/eventPublisher.js:226
                  → MQTT cbus/read/{net}/172/{sourceUnit}/…
```
- Writes (HA → C-Bus): `src/mqttCommandRouter.js` handles `setpoint` /
  `hvacmode` write commands (`MQTT_CMD_TYPE_HVAC_*`). ⚠️ The native-172 *write command
  format* to C-Gate is **not yet verified against hardware** — see §7.
- Discovery (via-lighting only): `src/haDiscovery.js` `_createHvacDiscovery` (line 812).
- Tests: `tests/applicationDecoders/airconDecoder.test.js` (decoder, with real-capture
  fixtures), `tests/cgateWebBridge.test.js` ("Aircon (172) event routing"),
  `tests/hvac.test.js` (publisher / discovery / command router).

---

## 7. Known gaps / future work

1. **Native HVAC auto-discovery (biggest item).** Emit one HA `climate` entity per
   thermostat (keyed by `sourceUnit`), pointing at the §4 topics incl. `action`, with the
   verified mode list. This is what makes thermostats appear in HA — the via-lighting
   `_createHvacDiscovery` does not serve the native path (§1).
   **Decision (2026-06-13): event-driven auto-create** (publish the climate config the
   first time a thermostat's source unit is seen in the aircon stream), **with read+write
   control**; Karl to beta-test.
2. **Write/control command format — UNRESOLVED (blocker for the write half).** The existing
   handlers `_handleHvacSetpoint` / `_handleHvacMode` (`src/mqttCommandRouter.js:539/575`)
   emit a lighting **`RAMP`** command (`level = temp × 2`). That is the *via-lighting*
   format and is **not** valid for native app 172 — sending it to a real 172 thermostat
   will not control it. The correct native control command is unknown. **Resolve before
   shipping writes:** capture the C-Gate **Tx** line while controlling a thermostat from
   PICED/Toolkit (PICED logs Tx as well as Rx), to learn the exact command (likely a
   symmetric `aircon set_zone_hvac_mode …` / setpoint command on the command port, but
   confirm). Writing to a live HVAC warrants getting this right rather than guessing.
3. **Fan speed (Auto vs 1).** ❓ Not captured — in the 2026-06-11 log the fan-speed change
   did not surface as a distinct field/verb (`f5` stayed `3` across on-modes). Needs a
   targeted capture or the protocol spec before a `fan_mode` can be decoded.
4. **`cool`/`error` bits** of `zone_hvac_plant_status` are inferred by position (the plant
   never cooled or errored in the capture). Confirm with a capture that does.
5. **`auto` vs `heat_cool`.** PICED labels code 3 "Heat/Cool (Auto)"; we publish `auto`.
   Revisit when the climate entity is built (HA `heat_cool` is the dual-setpoint mode).

---

## 8. How to add a new verb / field (recipe)

1. Capture with PICED; pair the raw `aircon <verb> …` line with PICED's decoded text (§2).
2. Add a `decode<Verb>` function + dispatch in `airconDecoder.js`; return a reading with a
   `kind`. Mark each field ✅/⚠️/❓ in comments per how well the capture confirms it.
3. Route the new `kind` in `cgateWebBridge._handleAirconLine`.
4. Publish it in `eventPublisher.publishReading`; add any new topic suffix to
   `src/constants.js`.
5. Add tests with **verbatim capture fixtures** (see existing `airconDecoder.test.js`).
6. `npm test` **and** `npm run lint -- --max-warnings=0` (the distribution gate) before
   committing.

---

## Related
- Protocol overview: [`docs/CBUS_PROTOCOL.md`](./CBUS_PROTOCOL.md)
- Original design / plan: `docs/superpowers/specs/2026-06-02-native-cbus-hvac-support-design.md`,
  `docs/superpowers/plans/2026-06-02-native-cbus-hvac-support.md`
