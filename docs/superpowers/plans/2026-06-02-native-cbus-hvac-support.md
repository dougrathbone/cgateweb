# Native C-Bus HVAC Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace cgateweb's broken "HVAC-as-lighting-ramp" guess with a verification-first, pluggable per-application decoder layer that natively reads C-Bus Temperature Broadcast ($19), Measurement ($E4), and (read-only) Air Conditioning (172) data.

**Architecture:** Keep the existing single-regex lighting fast path in `CBusEvent` untouched. Add a small `src/applicationDecoders/` registry — one module per C-Bus application — that `CBusEvent` delegates to only when the parsed application matches a registered specialised decoder. Decoders return a structured reading or `null`; `EventPublisher` gains a `publishReading()` path that maps readings to MQTT topics. New applications = new decoder file + tests, no hot-path edits.

**Tech Stack:** Node.js, Jest (Arrange-Act-Assert, mock external deps only), existing `src/constants.js` / `src/defaultSettings.js` / `src/settingsValidator.js` conventions.

**Spec:** `docs/superpowers/specs/2026-06-02-native-cbus-hvac-support-design.md`

**Branch:** `feat/native-cbus-hvac` (already created; spec already committed there)

---

## Phasing summary

- **Phase 1 — Foundation fix** (Tasks 1–3): remove the bogus `201` default, fence the legacy temp×2/mode→ON code, fix docs. Proceeds now.
- **Phase 2 — Raw-event capture mode** (Tasks 4–5): a settings-gated verbatim event logger that produces ground-truth samples. Proceeds now.
- **Phase 3 — Temperature ($19) decoder** (Tasks 6–10): pluggable decoder registry + temperature decoder + publish path + HA sensor discovery. Proceeds now; the **exact C-Gate line format is confirmed via Task 9** before the decoder ships.
- **Phases 4–5 — Measurement ($E4) and Air-Con (172)** (Task 11, blocked): specified but NOT implemented until real captured samples exist. See the "Blocked phases" section — do not write decoders from guesses.

Run the full suite with `npm test` after every phase. No commit may have failing tests (CLAUDE.md rule).

---

## File Structure

**Create:**
- `src/applicationDecoders/index.js` — the `ApplicationDecoderRegistry`: maps appId → decoder, exposes `getDecoder(appId)`.
- `src/applicationDecoders/temperatureDecoder.js` — Temperature Broadcast ($19) decoder.
- `tests/applicationDecoders/registry.test.js`
- `tests/applicationDecoders/temperatureDecoder.test.js`
- `tests/rawEventCapture.test.js`

**Modify:**
- `src/constants.js` — remove dead `DEFAULT_CBUS_APP_HVAC`; add temperature topic/app constants.
- `src/defaultSettings.js` — add additive settings.
- `src/settingsValidator.js` — validate new settings (follow existing app-id patterns).
- `src/mqttCommandRouter.js` — relabel the legacy HVAC handlers as "HVAC-via-lighting" (no behaviour change).
- `src/cbusEvent.js` — delegate to a specialised decoder when one is registered for the application; expose decoded reading.
- `src/eventPublisher.js` — add `publishReading()`; route temperature readings to a `current_temperature` topic.
- `src/cgateWebBridge.js` — raw-capture hook in `_processEventLine`; pass decoder registry / settings through.
- `src/haDiscovery.js` (+ `src/haDiscoveryConfigs.js`) — optional temperature sensor discovery.
- `README.md` — fix the wrong `201` references; document the working HVAC-via-lighting + PAC pattern and the new read settings.

---

## Phase 1 — Foundation fix

### Task 1: Remove the bogus `DEFAULT_CBUS_APP_HVAC` constant

**Files:**
- Modify: `src/constants.js:6` and its export at `src/constants.js:136`
- Test: `tests/constants.test.js` (create if absent)

- [ ] **Step 1: Write the failing test**

Create or append to `tests/constants.test.js`:

```javascript
const constants = require('../src/constants');

describe('constants HVAC cleanup', () => {
    it('does not export the bogus app-201 HVAC default', () => {
        expect(constants.DEFAULT_CBUS_APP_HVAC).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/constants.test.js -t "bogus app-201" --silent`
Expected: FAIL — `DEFAULT_CBUS_APP_HVAC` is currently `'201'`, not `undefined`.

- [ ] **Step 3: Make the change**

In `src/constants.js`, delete line 6:
```javascript
const DEFAULT_CBUS_APP_HVAC = '201';    // C-Bus application ID for HVAC/Air Conditioning
```
and delete the `DEFAULT_CBUS_APP_HVAC,` line from the `module.exports` block (around line 136).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/constants.test.js --silent`
Expected: PASS.

- [ ] **Step 5: Confirm no remaining references**

Run: `grep -rn "DEFAULT_CBUS_APP_HVAC" src/ index.js tests/ | grep -v "constants.test.js"`
Expected: no output (the only remaining hit, if any, is the assertion test above).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/constants.js tests/constants.test.js
git commit -m "fix: remove non-existent C-Bus app-201 HVAC default constant"
```

---

### Task 2: Relabel the legacy HVAC command handlers as "HVAC-via-lighting"

The temp×2 / mode→ON handlers in `mqttCommandRouter.js` are NOT removed — they are the working path for installs (like Karl's) that expose HVAC on a lighting-compatible app via a PAC/touchscreen. This task only corrects the misleading comments so the behaviour is honestly documented as a lighting-level mapping, not a real-thermostat protocol. **No logic change.**

**Files:**
- Modify: `src/mqttCommandRouter.js` (the `_handleHvacSetpoint` and `_handleHvacMode` JSDoc blocks, ~lines 521–605)
- Test: none (comment-only change; existing router tests must stay green)

- [ ] **Step 1: Replace the `_handleHvacSetpoint` JSDoc**

Replace the doc comment above `_handleHvacSetpoint` with:

```javascript
    /**
     * Handles HVAC setpoint commands for the "HVAC-via-lighting" pattern.
     *
     * This is NOT the native C-Bus Air Conditioning ($AC/172) protocol — C-Gate
     * exposes no command verb for that application. Instead this maps a target
     * temperature onto a lighting-style group level, which works when a PAC or
     * touchscreen has been programmed to expose HVAC control as a lighting-
     * compatible group (the common real-world setup; see the project README).
     *
     * Mapping: level = round(clamp(temp, 0, 50) * 2)  →  0.5°C resolution.
     * The receiving logic block in the PAC interprets the level. Adjust the PAC
     * logic, not this code, if your resolution differs.
     *
     * @param {CBusCommand} command - The setpoint command
     * @param {string} payload - Temperature value as a string (e.g., "22.5")
     * @param {string} topic - Original topic for error logging
     * @private
     */
```

- [ ] **Step 2: Replace the `_handleHvacMode` JSDoc**

Replace the doc comment above `_handleHvacMode` with:

```javascript
    /**
     * Handles HVAC mode commands for the "HVAC-via-lighting" pattern.
     *
     * As with the setpoint handler, this drives a lighting-compatible group, not
     * the native Air Conditioning application. 'off' → C-Gate OFF; any active
     * mode ('auto'/'cool'/'heat'/'fan_only') → C-Gate ON, leaving mode selection
     * to the PAC/touchscreen logic that the group feeds.
     *
     * @param {CBusCommand} command - The mode command
     * @param {string} payload - Mode string (e.g., "off", "auto", "cool")
     * @param {string} topic - Original topic for error logging
     * @private
     */
```

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all pass (no logic changed).

- [ ] **Step 4: Commit**

```bash
git add src/mqttCommandRouter.js
git commit -m "docs: clarify legacy HVAC handlers drive lighting groups, not native AC app"
```

---

### Task 3: Fix the wrong `201` references in the README

**Files:**
- Modify: `README.md:129` and `README.md:149`
- Test: none (docs)

- [ ] **Step 1: Fix line 129**

Replace:
```
*   **HVAC / Climate:** Devices using the configured `ha_discovery_hvac_app_id` (default: `null` — disabled; commonly Air Conditioning App `201`) are discovered as `climate` entities.
```
with:
```
*   **HVAC / Climate (via lighting):** Devices using the configured `ha_discovery_hvac_app_id` (default: `null` — disabled) are discovered as `climate` entities. This drives a **lighting-compatible group**, not the native C-Bus Air Conditioning application — use the app ID of a PAC/touchscreen-exposed HVAC group (e.g. an "HVAC Actuator" lighting-style app), NOT the Air Conditioning app 172. See "HVAC notes" below.
```

- [ ] **Step 2: Fix line 149**

Replace:
```
    ha_discovery_hvac_app_id: null     // App ID for HVAC/climate zones (e.g., Air Conditioning 201) - null to disable
```
with:
```
    ha_discovery_hvac_app_id: null     // App ID of a lighting-compatible HVAC group (PAC/touchscreen-exposed); NOT the Air Conditioning app 172 - null to disable
```

- [ ] **Step 3: Add an "HVAC notes" subsection**

Immediately after the line-129 bullet's surrounding list, add:

```markdown
> **HVAC notes:** The real C-Bus *Air Conditioning* application (172) and *Heating* (136) are not driven by C-Gate's lighting verbs, so cgateweb cannot control a native thermostat directly through `ha_discovery_hvac_app_id`. The supported pattern is to program a Pascal Logic Controller (PAC) or touchscreen to mirror HVAC control onto a lighting-compatible group/application, then point `ha_discovery_hvac_app_id` at that app. Native *reading* of Temperature Broadcast (25) and Measurement (228) sensors is available via `ha_discovery_temperature_app_id` / `ha_discovery_measurement_app_id` (see below).
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: correct HVAC app guidance (172 not 201; lighting-bridge pattern)"
```

---

## Phase 2 — Raw-event capture mode

### Task 4: Add the `cbusRawEventLogApps` setting + validation

**Files:**
- Modify: `src/defaultSettings.js` (add the setting)
- Modify: `src/settingsValidator.js` (validate it as an array of app IDs)
- Test: `tests/defaultSettings.test.js`, `tests/settingsValidator.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/defaultSettings.test.js`:

```javascript
const { defaultSettings } = require('../src/defaultSettings');

describe('raw event capture defaults', () => {
    it('defaults cbusRawEventLogApps to an empty array (capture off)', () => {
        expect(defaultSettings.cbusRawEventLogApps).toEqual([]);
    });
});
```

Append to `tests/settingsValidator.test.js` (match the file's existing import/use of the validator — inspect the top of the file and mirror it):

```javascript
describe('cbusRawEventLogApps validation', () => {
    it('accepts an array of numeric-string app IDs', () => {
        const result = validateSettings({ ...validBase, cbusRawEventLogApps: ['172', '228'] });
        expect(result.valid).toBe(true);
    });
    it('rejects a non-array cbusRawEventLogApps', () => {
        const result = validateSettings({ ...validBase, cbusRawEventLogApps: '172' });
        expect(result.valid).toBe(false);
    });
});
```

> Note: `validateSettings` / `validBase` names above must match this test file's existing helpers. Read `tests/settingsValidator.test.js` first and reuse whatever it already imports and the valid-settings fixture it already defines.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/defaultSettings.test.js tests/settingsValidator.test.js -t "cbusRawEventLogApps" --silent` and `... -t "raw event capture"`
Expected: FAIL — setting undefined / no validation.

- [ ] **Step 3: Add the default**

In `src/defaultSettings.js`, add inside the object (near the other capture/debug settings):

```javascript
    // Apps whose raw C-Gate event lines should be logged verbatim (and published
    // to cbus/read/{net}/{app}/{group}/raw) for protocol capture. Empty = off.
    // Used to capture ground-truth samples for specialised applications
    // (e.g. 25 Temperature, 228 Measurement, 172 Air Conditioning) before
    // writing decoders. See docs/superpowers/specs/2026-06-02-native-cbus-hvac-support-design.md
    cbusRawEventLogApps: [],
```

- [ ] **Step 4: Add validation**

In `src/settingsValidator.js`, following the pattern used for other array/app-id settings, add a check that `cbusRawEventLogApps`, when present, is an array whose entries are strings or numbers. Push a validation error otherwise. (Mirror the exact error-collection style already in the file.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest tests/defaultSettings.test.js tests/settingsValidator.test.js --silent`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/defaultSettings.js src/settingsValidator.js tests/defaultSettings.test.js tests/settingsValidator.test.js
git commit -m "feat: add cbusRawEventLogApps setting for protocol capture"
```

---

### Task 5: Log/publish raw event lines for configured apps

**Files:**
- Modify: `src/cgateWebBridge.js` (`_processEventLine`, ~line 386)
- Test: `tests/rawEventCapture.test.js`

The capture must run **before** the existing `new CBusEvent(line)` parse so it records lines even when the standard parser can't understand them. Extract the application from the address token cheaply without depending on `CBusEvent` validity.

- [ ] **Step 1: Write the failing test**

Create `tests/rawEventCapture.test.js`:

```javascript
const CgateWebBridge = require('../src/cgateWebBridge');

// Helper: build a bridge with capture enabled for app 172, capturing log + publish calls.
function buildBridgeForCapture(apps) {
    const published = [];
    const logged = [];
    const bridge = Object.create(CgateWebBridge.prototype);
    bridge.settings = { cbusRawEventLogApps: apps };
    bridge.logger = {
        debug: () => {}, warn: () => {}, info: (msg) => logged.push(msg),
        isLevelEnabled: () => false
    };
    bridge.warn = () => {};
    bridge.error = () => {};
    bridge.eventPublisher = { publishEvent: () => {} };
    bridge.deviceStateManager = { updateLevelFromEvent: () => {} };
    bridge.publishRawEventCapture = CgateWebBridge.prototype.publishRawEventCapture;
    bridge._rawPublish = (topic, payload) => published.push({ topic, payload });
    return { bridge, published, logged };
}

describe('raw event capture', () => {
    it('logs a verbatim line when its app is in cbusRawEventLogApps', () => {
        const { bridge, logged } = buildBridgeForCapture(['172']);
        bridge.publishRawEventCapture('someappevent 254/172/1 1 2 3');
        expect(logged.some(l => l.includes('254/172/1 1 2 3'))).toBe(true);
    });

    it('ignores lines whose app is not configured for capture', () => {
        const { bridge, logged } = buildBridgeForCapture(['172']);
        bridge.publishRawEventCapture('lighting on 254/56/4');
        expect(logged.length).toBe(0);
    });

    it('does nothing when capture list is empty', () => {
        const { bridge, logged } = buildBridgeForCapture([]);
        bridge.publishRawEventCapture('someappevent 254/172/1 9');
        expect(logged.length).toBe(0);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/rawEventCapture.test.js --silent`
Expected: FAIL — `publishRawEventCapture` is not defined.

- [ ] **Step 3: Implement `publishRawEventCapture` and call it**

Add this method to `CgateWebBridge` (near `_processEventLine`):

```javascript
    /**
     * If the event's application is listed in settings.cbusRawEventLogApps, log
     * the verbatim line (and publish it to a /raw topic) for protocol capture.
     * Cheap, allocation-light app extraction so it can run on every event line.
     */
    publishRawEventCapture(line) {
        const apps = this.settings.cbusRawEventLogApps;
        if (!apps || apps.length === 0) return;

        // Find the first net/app/group token; extract the application (2nd field).
        const match = line.match(/(\d+)\/(\d+)\/(\d+)/);
        if (!match) return;
        const application = match[2];
        if (!apps.map(String).includes(String(application))) return;

        this.logger.info(`C-Gate raw capture [app ${application}]: ${line}`);
        if (typeof this._rawPublish === 'function') {
            this._rawPublish(`cbus/read/${match[1]}/${match[2]}/${match[3]}/raw`, line);
        }
    }
```

In `_processEventLine`, add a call right after the `clock ` guard and before the debug log:

```javascript
        this.publishRawEventCapture(line);
```

Wire `_rawPublish` to the real MQTT publish in the bridge constructor where the MQTT publish function is available (mirror how `eventPublisher`'s `publishFn` is provided — use the same underlying publish). If a clean publish function isn't readily in scope, logging alone satisfies the capture goal; the `/raw` publish is best-effort.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/rawEventCapture.test.js --silent`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/cgateWebBridge.js tests/rawEventCapture.test.js
git commit -m "feat: raw C-Gate event capture for configured applications"
```

---

## Phase 3 — Temperature ($19) decoder

### Task 6: Add temperature constants

**Files:**
- Modify: `src/constants.js` (add app + topic constants and exports)
- Test: `tests/constants.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/constants.test.js`:

```javascript
describe('temperature constants', () => {
    it('exports the Temperature Broadcast app id and current_temperature suffix', () => {
        const c = require('../src/constants');
        expect(c.DEFAULT_CBUS_APP_TEMPERATURE).toBe('25');
        expect(c.MQTT_TOPIC_SUFFIX_HVAC_CURRENT_TEMP).toBe('current_temperature');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/constants.test.js -t "temperature constants" --silent`
Expected: FAIL — `DEFAULT_CBUS_APP_TEMPERATURE` undefined.

- [ ] **Step 3: Add the constant + export**

In `src/constants.js`, near `DEFAULT_CBUS_APP_TRIGGER`:
```javascript
const DEFAULT_CBUS_APP_TEMPERATURE = '25';   // C-Bus Temperature Broadcast application ($19)
const DEFAULT_CBUS_APP_MEASUREMENT = '228';  // C-Bus Measurement application ($E4)
```
Add both to `module.exports`. (`MQTT_TOPIC_SUFFIX_HVAC_CURRENT_TEMP` already exists and is exported.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/constants.test.js --silent`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/constants.js tests/constants.test.js
git commit -m "feat: add Temperature/Measurement C-Bus application constants"
```

---

### Task 7: Temperature decoder (pure value conversion)

The conversion is the certain part (`°C = byte ÷ 4`, range 0–63.75, per libcbus). The decoder accepts the already-extracted raw integer and returns a structured reading; line-format extraction is layered on in Task 8 and confirmed against a real capture in Task 9.

**Files:**
- Create: `src/applicationDecoders/temperatureDecoder.js`
- Test: `tests/applicationDecoders/temperatureDecoder.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/applicationDecoders/temperatureDecoder.test.js`:

```javascript
const decoder = require('../../src/applicationDecoders/temperatureDecoder');

describe('temperatureDecoder', () => {
    it('declares the Temperature Broadcast app id', () => {
        expect(decoder.appId).toBe('25');
    });

    it('converts a raw byte to °C (byte / 4)', () => {
        // 86 / 4 = 21.5°C
        const reading = decoder.decodeValue({ group: '3', rawByte: 86 });
        expect(reading).toEqual({ kind: 'temperature', group: '3', celsius: 21.5, unit: 'C' });
    });

    it('handles the 0 and max (255 → 63.75) bounds', () => {
        expect(decoder.decodeValue({ group: '1', rawByte: 0 }).celsius).toBe(0);
        expect(decoder.decodeValue({ group: '1', rawByte: 255 }).celsius).toBe(63.75);
    });

    it('returns null for out-of-range / invalid raw bytes', () => {
        expect(decoder.decodeValue({ group: '1', rawByte: -1 })).toBeNull();
        expect(decoder.decodeValue({ group: '1', rawByte: 256 })).toBeNull();
        expect(decoder.decodeValue({ group: '1', rawByte: NaN })).toBeNull();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/applicationDecoders/temperatureDecoder.test.js --silent`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the decoder**

Create `src/applicationDecoders/temperatureDecoder.js`:

```javascript
const { DEFAULT_CBUS_APP_TEMPERATURE } = require('../constants');

/**
 * C-Bus Temperature Broadcast ($19 / app 25) decoder.
 * Encoding (per the C-Bus Temperature Broadcast Application): °C = rawByte / 4,
 * valid 0.0–63.75°C. Group address identifies the reporting sensor/zone.
 */
const appId = DEFAULT_CBUS_APP_TEMPERATURE;

function decodeValue({ group, rawByte }) {
    if (!Number.isInteger(rawByte) || rawByte < 0 || rawByte > 255) {
        return null;
    }
    return { kind: 'temperature', group: String(group), celsius: rawByte / 4, unit: 'C' };
}

module.exports = { appId, decodeValue };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/applicationDecoders/temperatureDecoder.test.js --silent`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/applicationDecoders/temperatureDecoder.js tests/applicationDecoders/temperatureDecoder.test.js
git commit -m "feat: temperature broadcast value decoder (degC = byte/4)"
```

---

### Task 8: Decoder registry + `CBusEvent` delegation

**Files:**
- Create: `src/applicationDecoders/index.js`
- Modify: `src/cbusEvent.js`
- Test: `tests/applicationDecoders/registry.test.js`, additions to `tests/cbusEvent.test.js`

- [ ] **Step 1: Write the failing registry test**

Create `tests/applicationDecoders/registry.test.js`:

```javascript
const registry = require('../../src/applicationDecoders');

describe('ApplicationDecoderRegistry', () => {
    it('returns the temperature decoder for app 25', () => {
        expect(registry.getDecoder('25')).toBeDefined();
        expect(registry.getDecoder('25').appId).toBe('25');
    });

    it('returns undefined for lighting (56) — handled by the fast path', () => {
        expect(registry.getDecoder('56')).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/applicationDecoders/registry.test.js --silent`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the registry**

Create `src/applicationDecoders/index.js`:

```javascript
const temperatureDecoder = require('./temperatureDecoder');

// appId → decoder. Only specialised applications appear here; lighting/cover/
// PIR/trigger remain on CBusEvent's regex fast path.
const DECODERS = new Map([
    [temperatureDecoder.appId, temperatureDecoder]
]);

function getDecoder(appId) {
    return DECODERS.get(String(appId));
}

module.exports = { getDecoder };
```

- [ ] **Step 4: Run registry test to verify it passes**

Run: `npx jest tests/applicationDecoders/registry.test.js --silent`
Expected: PASS.

- [ ] **Step 5: Write the failing `CBusEvent` delegation test**

Append to `tests/cbusEvent.test.js`:

```javascript
describe('specialised application delegation', () => {
    it('decodes a temperature broadcast event into a reading', () => {
        // Format CONFIRMED in Task 9. Provisional shape: "temperature 254/25/3 86"
        const event = new CBusEvent('temperature 254/25/3 86');
        expect(event.isValid()).toBe(true);
        expect(event.getApplication()).toBe('25');
        const reading = event.getReading();
        expect(reading).toEqual({ kind: 'temperature', group: '3', celsius: 21.5, unit: 'C' });
    });

    it('leaves lighting events with no reading (fast path unchanged)', () => {
        const event = new CBusEvent('lighting on 254/56/4');
        expect(event.getReading()).toBeNull();
    });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx jest tests/cbusEvent.test.js -t "specialised application" --silent`
Expected: FAIL — `getReading` undefined / no decoding.

- [ ] **Step 7: Implement delegation in `CBusEvent`**

In `src/cbusEvent.js`:
- Add `const applicationDecoders = require('./applicationDecoders');` at the top.
- Initialise `this._reading = null;` in the constructor alongside the other fields.
- After a successful standard parse (i.e. once `this._network/_application/_group` are set and `this._isValid` is true), add:

```javascript
        // Specialised applications (temperature, measurement, air-con) carry
        // extra fields the lighting regex truncates. Delegate to a decoder.
        const decoder = applicationDecoders.getDecoder(this._application);
        if (decoder) {
            // _level holds the trailing integer extracted by the fast path.
            this._reading = decoder.decodeValue({ group: this._group, rawByte: this._level });
        }
```

- Add the getter:

```javascript
    /**
     * Structured reading for specialised applications (temperature, etc.),
     * or null for lighting/cover/PIR/trigger events.
     * @returns {object|null}
     */
    getReading() {
        return this._reading;
    }
```

> **Implementation note:** the provisional line format assumes C-Gate renders a temperature broadcast as `temperature 254/25/3 <rawByte>` — i.e. the existing regex captures app=25 and the trailing integer as `_level`. **Task 9 confirms this against a real capture.** If the real format differs (e.g. the value is pre-converted to °C, or there are extra fields), adjust the extraction here and the Task-8 fixtures accordingly before shipping.

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx jest tests/cbusEvent.test.js tests/applicationDecoders --silent`
Expected: PASS.

- [ ] **Step 9: Run the full suite (regression guard)**

Run: `npm test`
Expected: all pass — existing lighting/cover/PIR/trigger event tests unchanged.

- [ ] **Step 10: Commit**

```bash
git add src/applicationDecoders/index.js src/cbusEvent.js tests/applicationDecoders/registry.test.js tests/cbusEvent.test.js
git commit -m "feat: application decoder registry + CBusEvent temperature delegation"
```

---

### Task 9: Confirm the real C-Gate temperature event format

**This is a verification gate, not code. Do not ship Task 8's line format on a guess.**

**Files:** none (may produce a fixture update to Tasks 7–8)

- [ ] **Step 1: Capture a real temperature event**

On a system with a Temperature Broadcast sensor (or ask the user/Karl to), set `cbusRawEventLogApps: ['25']` (from Task 4) and observe the verbatim line logged when a temperature changes. Alternatively telnet the C-Gate event port and watch app-25 traffic.

- [ ] **Step 2: Compare against the provisional format**

Confirm whether the line matches `temperature 254/25/<group> <rawByte>` and whether `<rawByte>` is the raw 0–255 value (×0.25°C) or a pre-converted decimal.

- [ ] **Step 3: Reconcile**

- If it matches: mark this task done; no code change.
- If the value is pre-converted (e.g. `... 21.5`): change `temperatureDecoder.decodeValue` to accept a `celsius` directly (add a `decodeCelsius` path), update `CBusEvent` extraction to parse the decimal, and update the Task-7/8 fixtures to the real line. Re-run `npx jest tests/applicationDecoders tests/cbusEvent.test.js`.
- If the address/field layout differs: update the extraction in `CBusEvent` and the fixtures to the captured reality.

- [ ] **Step 4: Commit any reconciliation**

```bash
git add -A
git commit -m "fix: align temperature decoder with captured C-Gate event format"
```

> If no capture can be obtained, STOP here: do not enable temperature discovery (Task 10) on an unverified format. The decoder is safe (returns null on non-matching lines) but should not be advertised until confirmed.

---

### Task 10: Publish temperature readings + optional HA sensor discovery

**Files:**
- Modify: `src/eventPublisher.js` (add `publishReading`, call it from `publishEvent` when `event.getReading()` is set)
- Modify: `src/defaultSettings.js` (add `ha_discovery_temperature_app_id: null`)
- Modify: `src/settingsValidator.js` (validate it like other app-id settings)
- Modify: `src/haDiscovery.js` / `src/haDiscoveryConfigs.js` (temperature sensor discovery when the app id is set)
- Test: `tests/eventPublisher.test.js`, `tests/defaultSettings.test.js`

- [ ] **Step 1: Write the failing publisher test**

Append to `tests/eventPublisher.test.js` (mirror the file's existing publisher construction/mocks):

```javascript
describe('temperature reading publish', () => {
    it('publishes a current_temperature reading to the read topic', () => {
        const calls = [];
        const publisher = new EventPublisher({
            settings: {},
            publishFn: (topic, payload) => calls.push({ topic, payload }),
            mqttOptions: {}
        });
        const fakeEvent = {
            isValid: () => true,
            getNetwork: () => '254', getApplication: () => '25', getGroup: () => '3',
            getAction: () => null, getLevel: () => 86,
            getReading: () => ({ kind: 'temperature', group: '3', celsius: 21.5, unit: 'C' })
        };
        publisher.publishEvent(fakeEvent, '(Evt)');
        expect(calls).toContainEqual({
            topic: 'cbus/read/254/25/3/current_temperature',
            payload: '21.5'
        });
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest tests/eventPublisher.test.js -t "temperature reading" --silent`
Expected: FAIL — no current_temperature publish.

- [ ] **Step 3: Implement `publishReading` + early branch**

In `src/eventPublisher.js`, at the top of `publishEvent`, after the `if (!event || !event.isValid()) return;` guard, add:

```javascript
        if (typeof event.getReading === 'function') {
            const reading = event.getReading();
            if (reading) {
                this.publishReading(event.getNetwork(), event.getApplication(), event.getGroup(), reading);
                return;
            }
        }
```

Add the method (near `_publishHvacEvent`):

```javascript
    /**
     * Publishes a structured reading from a specialised application decoder.
     * Temperature → cbus/read/{net}/{app}/{group}/current_temperature.
     */
    publishReading(network, application, group, reading) {
        if (reading.kind === 'temperature') {
            const topic = `${MQTT_TOPIC_PREFIX_READ}/${network}/${application}/${group}/${MQTT_TOPIC_SUFFIX_HVAC_CURRENT_TEMP}`;
            this._publishIfNeeded(topic, String(reading.celsius), this.mqttOptions);
        }
    }
```

(`MQTT_TOPIC_PREFIX_READ` and `MQTT_TOPIC_SUFFIX_HVAC_CURRENT_TEMP` are already imported at the top of the file.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest tests/eventPublisher.test.js -t "temperature reading" --silent`
Expected: PASS.

- [ ] **Step 5: Add the discovery setting + validation**

In `src/defaultSettings.js` add `ha_discovery_temperature_app_id: null,` (near the other `ha_discovery_*_app_id`). In `src/settingsValidator.js` validate it exactly like `ha_discovery_pir_app_id` (optional scalar app id). Add a `tests/defaultSettings.test.js` assertion that it defaults to `null`.

- [ ] **Step 6: Add HA temperature sensor discovery**

In `src/haDiscoveryConfigs.js`, add a branch in the app→type mapping (mirroring the existing `ha_discovery_hvac_app_id` branch at line ~38) that maps `settings.ha_discovery_temperature_app_id` to a `sensor` component with `device_class: temperature`, `unit_of_measurement: °C`, and `state_topic` = `.../current_temperature`. Add a corresponding entry to the config table (mirror the `hvac:` entry shape) and a discovery test in the haDiscovery test file following the existing per-type test pattern.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/eventPublisher.js src/defaultSettings.js src/settingsValidator.js src/haDiscovery.js src/haDiscoveryConfigs.js tests/
git commit -m "feat: publish C-Bus temperature readings and HA temperature sensor discovery"
```

---

### Task: Phase 3 add-on config sync + version bump

**Files:** `homeassistant-addon/config.yaml`, `package.json`, `CHANGELOG.md`

- [ ] **Step 1:** Add the new options (`cbusRawEventLogApps`, `ha_discovery_temperature_app_id`) to `homeassistant-addon/config.yaml` `options` + `schema`, honouring the config.yaml rules (array fields need defaults in `options`; scalar optionals use the `?` suffix). Add matching translation keys to `homeassistant-addon/translations/en.yaml` (other languages can copy English per CLAUDE.md).
- [ ] **Step 2:** Bump version in BOTH `package.json` and `homeassistant-addon/config.yaml` (keep in sync — CI enforces).
- [ ] **Step 3:** Add a CHANGELOG entry summarising Phases 1–3.
- [ ] **Step 4:** Run `npm test`; commit `chore: release vX.Y.Z`. Tag + push happens at integration time per CLAUDE.md release process (not in this plan's scope to push).

---

## Blocked phases — do NOT implement until samples exist

### Task 11 (BLOCKED): Measurement ($E4) and Air Conditioning (172) decoders

These are intentionally left without concrete TDD steps because writing fixtures from a guessed wire format is exactly the defect this whole effort exists to fix. Implement only after Phase 2 capture yields real lines.

**Unblock protocol:**
1. On a system using the app (Karl's, for 172), set `cbusRawEventLogApps: ['172']` (and/or `['228']`) and capture verbatim event lines across temperature/setpoint/mode changes.
2. For 172, obtain Clipsal's "C-Gate Air-Conditioning Application User Guide.pdf" to map the multi-field SAL payload (the `mminehanNZ/cgateweb` fork shows payloads like `5 0 1 0 0 0 1 8 4352 0`) to zone temperature / setpoint / mode fields.
3. Add `src/applicationDecoders/measurementDecoder.js` and/or `airConDecoder.js` returning structured readings (`{kind:'temperature'|'setpoint'|'mode', ...}`), built TDD against the captured lines.
4. Register them in `src/applicationDecoders/index.js`.
5. Extend `EventPublisher.publishReading()` to map setpoint/mode readings to topics (`setpoint`, `mode`) and the air-con reading to climate `current_temperature`.
6. Add `ha_discovery_measurement_app_id` / `ha_discovery_aircon_app_id` settings + validation + discovery, read-only.
7. **No writes to app 172** in this scope.

Each decoder follows the same task shape as Tasks 7–8 (pure decode test → registry registration → CBusEvent delegation already exists → publish path → discovery). Write those concrete tasks once the captured fixtures are in hand.

---

## Self-review notes

- **Spec coverage:** Foundation fix (Tasks 1–3), raw capture (4–5), temperature read incl. discovery (6–10), measurement/172 gated (11) — all spec sections mapped. The "read-only, no writes" non-goal is enforced in Tasks 2, 11. The additive-settings rule and config.yaml rules are covered in Tasks 4/10/release task.
- **Type consistency:** reading shape `{ kind, group, celsius, unit }` is consistent across temperatureDecoder (Task 7), CBusEvent delegation (Task 8), and publishReading (Task 10). Registry method `getDecoder` used consistently. Decoder property `appId` and method `decodeValue` consistent across Tasks 7/8.
- **Verification-first:** Task 9 is an explicit gate preventing temperature shipping on an unconfirmed format; Task 11 is blocked by design.
