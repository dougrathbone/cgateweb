# Security Panel Trouble Sensors, Live Events Enrichment and Restart Resync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two remaining #42 alpha-feedback items (Live Events enrichment, panel-trouble binary_sensors) and fix #44 (entity state lost across Home Assistant or MQTT broker restarts).

**Architecture:** Three independent slices. (1) An optional `description` field on Live Events SSE entries, rendered by the web UI in place of the level percentage. (2) Seven new panel-wide verbs decoded in `securityDecoder`, tracked by a new stateless-per-network `securityPanelState` module, published as diagnostic `binary_sensor`s on one shared "C-Bus Security Panel" device. (3) A new `stateResyncCoordinator` that re-issues the existing getall plus a security status sync when Home Assistant sends its birth message or the MQTT broker reconnects mid-session.

**Tech Stack:** Node.js (CommonJS), Jest, ESLint, `tsc --noEmit` with `// @ts-check` per file, vanilla JS in `public/index.html`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-31-security-trouble-sensors-and-restart-resync-design.md`
- Target release: **v1.21.0**. Version must be bumped in **both** `package.json` and `homeassistant-addon/config.yaml` (CI `version-sync` job fails otherwise).
- **No new `config.yaml` options.** All new settings live only in `src/defaultSettings.js`, so `homeassistant-addon/translations/*.yaml` (17 files) stay untouched.
- `npm test`, `npm run lint` (`--max-warnings 0`) and `npm run typecheck` must all pass before every commit.
- New files start with `// @ts-check` and `'use strict';`, matching `src/securityEventHandler.js:1-2`.
- Never include Claude/AI attribution in commit messages.
- Security app id comes from `settings.cbus_security_app_id`; a falsy value or `'0'` disables all security behaviour.
- Reuse `src/backoff.js` for any backoff; do not reinvent the formula.

---

### Task 1: Live Events `description` field

**Files:**
- Modify: `src/securityEventHandler.js` (`_emitEventLog` ~line 308, `_emitSystemEventLog` ~line 270, zone branch ~line 150)
- Modify: `public/index.html` (`eventMatchesFilter` ~line 1925, `renderEventLog` ~line 1934, `appendEventRow` ~line 1993)
- Test: `tests/securityEventHandler.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `_emitEventLog(network, application, group, level, type, label = null, description = null)` — trailing optional param, so existing call sites keep working. SSE entry gains `description?: string`. Panel-wide entries now pass `group = null`, and the UI renders such rows as `net/app` with no trailing slash.

- [ ] **Step 1: Write the failing tests**

In `tests/securityEventHandler.test.js`, add to the existing event-log describe block:

```js
it('includes a description on zone event log entries', () => {
    const entries = [];
    const handler = createHandler({ onEventLog: (e) => entries.push(e) });
    handler.handleLine('# security zone_unsealed //PROJ/254/208/13 #sourceunit=18 OID=');
    expect(entries[0]).toMatchObject({ group: '13', description: 'Zone unsealed' });
});

it('includes a description and a null group on panel-wide system entries', () => {
    const entries = [];
    const handler = createHandler({ onEventLog: (e) => entries.push(e) });
    handler.handleLine('# security system_arm //PROJ/254/208 3 #sourceunit=18 OID=');
    expect(entries[0]).toMatchObject({ group: null, description: 'System armed (Day mode)' });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest tests/securityEventHandler.test.js -t description`
Expected: FAIL — `description` undefined, `group` is `'0'`.

- [ ] **Step 3: Thread `description` through the handler**

Add the trailing param and pass `_describeSystemEvent(reading)` for system verbs, and a zone-state sentence for zone events:

```js
_emitEventLog(network, application, group, level, type, label = null, description = null) {
    if (!this.onEventLog) return;
    this.onEventLog({
        ts: Date.now(), network, app: application, group, level, type,
        ...(label && { label }),
        ...(description && { description })
    });
}
```

Zone branch: pass `` `Zone ${reading.zoneState}` `` with the state capitalised (`Zone unsealed`). `_emitSystemEventLog`: pass `reading.zone || null` as group and `this._describeSystemEvent(reading)` as description.

- [ ] **Step 4: Run to verify pass**

Run: `npx jest tests/securityEventHandler.test.js`
Expected: PASS.

- [ ] **Step 5: Render it in the UI**

`appendEventRow`: build the address without a trailing slash when there is no group, and carry the description:

```js
addr: event.group === null || event.group === undefined || event.group === ''
    ? event.network + '/' + event.app
    : event.network + '/' + event.app + '/' + event.group,
description: event.description || '',
```

`renderEventLog`: replace the value and bar cells with a description-aware pair:

```js
var valueCell = row.description
    ? '<td colspan="2">' + esc(row.description) + '</td>'
    : '<td>' + esc(row.level) + ' (' + pct + '%)</td>' +
      '<td class="event-bar-cell"><div class="event-bar-bg"><div class="event-bar-fill" style="width:' + pct + '%"></div></div></td>';
```

`eventMatchesFilter`: add `if (row.description && row.description.toLowerCase().indexOf(f) !== -1) return true;`

- [ ] **Step 6: Full gates**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/securityEventHandler.js public/index.html tests/securityEventHandler.test.js
git commit -m "fix: describe security events in the Live Events window (#42)"
```

---

### Task 2: Decode the seven panel-trouble verbs

**Files:**
- Modify: `src/applicationDecoders/securityDecoder.js` (header docblock, new map above `parseAddress` ~line 66, dispatch before the final `return null` ~line 261)
- Test: `tests/applicationDecoders/securityDecoder.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `decodeLine` returns `{ kind: 'panel_trouble', network, application, condition, active, verb, detail }` where `condition` is one of `'mains' | 'battery' | 'tamper' | 'panic' | 'line' | 'arm_failed' | 'fire'` and `active` is a boolean. Also exports `PANEL_TROUBLE_CONDITIONS` (array of the seven condition keys, in display order) and `PANEL_TROUBLE_VERBS` (Map of verb → `{condition, active}`).

Note: `arm_failed` and `fire_alarm` currently return `kind: 'arm_failed'` / `'fire_alarm'` with a `detail` (`securityDecoder.js:248`). They now return `kind: 'panel_trouble'` instead, with `active` derived from the `_raised`/`_cleared` detail suffix (bare verb with no detail means raised). `_describeSystemEvent` handling for those two kinds moves accordingly in Task 4.

- [ ] **Step 1: Write the failing tests**

```js
describe('panel trouble verbs', () => {
    const cases = [
        ['mains_failure', 'mains', true],
        ['mains_restored', 'mains', false],
        ['low_battery', 'battery', true],
        ['low_battery_corrected', 'battery', false],
        ['tamper_on', 'tamper', true],
        ['tamper_off', 'tamper', false],
        ['panic_activated', 'panic', true],
        ['panic_cleared', 'panic', false]
    ];
    it.each(cases)('decodes %s', (verb, condition, active) => {
        const r = decodeLine(`# security ${verb} //MIDSTRM/254/208  #sourceunit=18 OID=`);
        expect(r).toMatchObject({ kind: 'panel_trouble', network: '254', application: '208', condition, active });
    });

    it('derives active from the _raised/_cleared detail suffix', () => {
        expect(decodeLine('# security line_cut_alarm //MIDSTRM/254/208 line_cut_alarm_cleared #sourceunit=18 OID='))
            .toMatchObject({ condition: 'line', active: false });
        expect(decodeLine('# security line_cut_alarm //MIDSTRM/254/208 line_cut_alarm_raised #sourceunit=18 OID='))
            .toMatchObject({ condition: 'line', active: true });
    });

    it('treats a bare suffix-style verb as raised', () => {
        expect(decodeLine('# security fire_alarm //MIDSTRM/254/208  #sourceunit=18 OID='))
            .toMatchObject({ condition: 'fire', active: true });
    });

    it('still returns null for genuinely unknown verbs', () => {
        expect(decodeLine('# security some_future_verb //MIDSTRM/254/208 #sourceunit=18 OID=')).toBeNull();
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest tests/applicationDecoders/securityDecoder.test.js -t "panel trouble"`
Expected: FAIL — `decodeLine` returns `null`.

- [ ] **Step 3: Implement**

Add above `parseAddress`:

```js
/**
 * Panel-wide trouble conditions. Verb pairs confirmed by the #42 captures
 * except low_battery, tamper_on and panic_off/panic_cleared, whose raise (or
 * clear) halves were never captured and are inferred from the naming
 * convention of the confirmed pairs.
 */
const PANEL_TROUBLE_CONDITIONS = ['mains', 'battery', 'tamper', 'panic', 'line', 'arm_failed', 'fire'];

const PANEL_TROUBLE_VERBS = new Map([
    ['mains_failure', { condition: 'mains', active: true }],
    ['mains_restored', { condition: 'mains', active: false }],
    ['low_battery', { condition: 'battery', active: true }],
    ['low_battery_corrected', { condition: 'battery', active: false }],
    ['tamper_on', { condition: 'tamper', active: true }],
    ['tamper_off', { condition: 'tamper', active: false }],
    ['panic_activated', { condition: 'panic', active: true }],
    ['panic_off', { condition: 'panic', active: false }],
    ['panic_cleared', { condition: 'panic', active: false }]
]);

// Verbs whose active/cleared sense rides a "<verb>_raised" / "<verb>_cleared"
// detail argument instead of the verb name. A bare verb means raised.
const PANEL_TROUBLE_DETAIL_VERBS = new Map([
    ['line_cut_alarm', 'line'],
    ['arm_failed', 'arm_failed'],
    ['fire_alarm', 'fire']
]);
```

Replace the `arm_failed || fire_alarm` branch (line ~248) with a single dispatch placed before the final `return null`:

```js
const simple = PANEL_TROUBLE_VERBS.get(verb);
if (simple) {
    return { kind: 'panel_trouble', network, application, condition: simple.condition, active: simple.active, verb, detail: null };
}

const detailCondition = PANEL_TROUBLE_DETAIL_VERBS.get(verb);
if (detailCondition) {
    const detail = params.length > 0 ? params.join(' ') : null;
    const active = !(detail && detail.endsWith('_cleared'));
    return { kind: 'panel_trouble', network, application, condition: detailCondition, active, verb, detail };
}
```

Update the header docblock verb list and export both new constants.

- [ ] **Step 4: Run to verify pass**

Run: `npx jest tests/applicationDecoders/securityDecoder.test.js`
Expected: PASS. Existing `arm_failed`/`fire_alarm` assertions will fail on `kind` — update them to expect `kind: 'panel_trouble'` with the right `condition`.

- [ ] **Step 5: Full gates and commit**

```bash
npm test && npm run lint && npm run typecheck
git add src/applicationDecoders/securityDecoder.js tests/applicationDecoders/securityDecoder.test.js
git commit -m "feat: decode C-Bus security panel trouble verbs (#42)"
```

---

### Task 3: `securityPanelState` module

**Files:**
- Create: `src/securityPanelState.js`
- Test: `tests/securityPanelState.test.js`

**Interfaces:**
- Consumes: `PANEL_TROUBLE_CONDITIONS` from Task 2.
- Produces: class `SecurityPanelState` with
  - `applyReading(reading) -> Array<{condition: string, active: boolean}>` — returns only *changed* conditions; handles derived clears.
  - `seedFromStatusReport(reading) -> Array<{condition: string, active: boolean}>`
  - `initialStates(network) -> Array<{condition: string, active: boolean}>` — all seven, for discovery-time seeding.
  - `getState(network) -> Object<string, boolean>`

- [ ] **Step 1: Write the failing tests**

```js
const SecurityPanelState = require('../src/securityPanelState');

describe('SecurityPanelState', () => {
    let state;
    beforeEach(() => { state = new SecurityPanelState(); });

    it('reports a newly raised condition as changed', () => {
        expect(state.applyReading({ kind: 'panel_trouble', network: '254', condition: 'mains', active: true }))
            .toEqual([{ condition: 'mains', active: true }]);
    });

    it('dedupes a repeated raise', () => {
        state.applyReading({ kind: 'panel_trouble', network: '254', condition: 'mains', active: true });
        expect(state.applyReading({ kind: 'panel_trouble', network: '254', condition: 'mains', active: true })).toEqual([]);
    });

    it('tracks networks independently', () => {
        state.applyReading({ kind: 'panel_trouble', network: '254', condition: 'mains', active: true });
        expect(state.applyReading({ kind: 'panel_trouble', network: '200', condition: 'mains', active: true }))
            .toEqual([{ condition: 'mains', active: true }]);
    });

    it('clears panic, arm_failed and fire on disarm', () => {
        for (const condition of ['panic', 'arm_failed', 'fire']) {
            state.applyReading({ kind: 'panel_trouble', network: '254', condition, active: true });
        }
        const cleared = state.applyReading({ kind: 'system_arm', network: '254', mode: 0 });
        expect(cleared.map((c) => c.condition).sort()).toEqual(['arm_failed', 'fire', 'panic']);
        expect(cleared.every((c) => c.active === false)).toBe(true);
    });

    it('clears arm_failed on a successful arm but leaves panic alone', () => {
        state.applyReading({ kind: 'panel_trouble', network: '254', condition: 'arm_failed', active: true });
        state.applyReading({ kind: 'panel_trouble', network: '254', condition: 'panic', active: true });
        expect(state.applyReading({ kind: 'system_arm', network: '254', mode: 1 }))
            .toEqual([{ condition: 'arm_failed', active: false }]);
    });

    it('does not report unchanged conditions on disarm', () => {
        expect(state.applyReading({ kind: 'system_arm', network: '254', mode: 0 })).toEqual([]);
    });

    it('seeds tamper and panic from a status report', () => {
        const seeded = state.seedFromStatusReport({
            kind: 'status_report_1', network: '254', tamperActive: true, panicActive: false
        });
        expect(seeded).toEqual([{ condition: 'tamper', active: true }]);
        expect(state.getState('254').tamper).toBe(true);
    });

    it('initialStates returns all seven conditions defaulting to inactive', () => {
        const initial = state.initialStates('254');
        expect(initial).toHaveLength(7);
        expect(initial.every((c) => c.active === false)).toBe(true);
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest tests/securityPanelState.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/securityPanelState.js`**

Key points: `Map<network, Object<condition, boolean>>`; conditions default `false`; `applyReading` returns `[]` when the value is unchanged; `system_arm` mode 0 clears `panic`, `arm_failed`, `fire`; non-zero mode clears only `arm_failed`; `seedFromStatusReport` applies `tamperActive`/`panicActive`; `initialStates` lazily creates the network entry and returns all seven current values.

- [ ] **Step 4: Run to verify pass**

Run: `npx jest tests/securityPanelState.test.js`
Expected: PASS.

- [ ] **Step 5: Full gates and commit**

```bash
npm test && npm run lint && npm run typecheck
git add src/securityPanelState.js tests/securityPanelState.test.js
git commit -m "feat: track C-Bus security panel trouble state per network (#42)"
```

---

### Task 4: Publish trouble sensors and log them

**Files:**
- Modify: `src/haDiscoveryPublishers.js` (add `ensureSecurityPanelDiscovery` + `_createSecurityPanelDiscovery` after `_createSecurityZoneDiscovery` ~line 667; add `_securityPanelSeen` field near `_securityZoneSeen` ~line 100)
- Modify: `src/securityEventHandler.js` (wire `SecurityPanelState`, handle `kind: 'panel_trouble'`, extend `_describeSystemEvent`, publish panel topics)
- Modify: `src/eventPublisher.js` (accept `kind: 'security_panel'` readings, near the `security_zone` branch ~line 425)
- Test: `tests/securityDiscovery.test.js`, `tests/securityEventHandler.test.js`

**Interfaces:**
- Consumes: `SecurityPanelState` (Task 3), `PANEL_TROUBLE_CONDITIONS` (Task 2), `_emitEventLog(..., description)` (Task 1).
- Produces: `ensureSecurityPanelDiscovery(network, appId) -> boolean`; retained state on `cbus/read/{net}/{app}/panel/{condition}/state` as `ON`/`OFF`.

- [ ] **Step 1: Write the failing discovery tests**

```js
describe('security panel trouble discovery', () => {
    it('publishes seven diagnostic binary_sensors on one shared panel device', () => {
        haDiscovery.ensureSecurityPanelDiscovery('254', '208');
        const configs = publishedConfigsMatching('/panel_');
        expect(configs).toHaveLength(7);
        for (const payload of configs) {
            expect(payload.entity_category).toBe('diagnostic');
            expect(payload.device.identifiers).toEqual(['cgateweb_254_208_panel']);
            expect(payload.device.model).toBe('C-Bus Security Panel');
        }
    });

    it('assigns the agreed device classes', () => {
        haDiscovery.ensureSecurityPanelDiscovery('254', '208');
        expect(deviceClassFor('mains')).toBe('problem');
        expect(deviceClassFor('battery')).toBe('battery');
        expect(deviceClassFor('tamper')).toBe('tamper');
        expect(deviceClassFor('panic')).toBe('safety');
        expect(deviceClassFor('line')).toBe('problem');
        expect(deviceClassFor('arm_failed')).toBe('problem');
        expect(deviceClassFor('fire')).toBe('smoke');
    });

    it('is idempotent', () => {
        expect(haDiscovery.ensureSecurityPanelDiscovery('254', '208')).toBe(true);
        expect(haDiscovery.ensureSecurityPanelDiscovery('254', '208')).toBe(false);
    });

    it('retracts and skips an excluded panel', () => {
        haDiscovery.exclude.add('254/208/panel');
        expect(haDiscovery.ensureSecurityPanelDiscovery('254', '208')).toBe(false);
        expect(retractedTopics()).toHaveLength(7);
    });

    it('publishes nothing when ha_discovery_enabled is false', () => {
        settings.ha_discovery_enabled = false;
        expect(haDiscovery.ensureSecurityPanelDiscovery('254', '208')).toBe(false);
    });
});
```

And in `tests/securityEventHandler.test.js`:

```js
it('publishes ON for a mains failure and OFF when restored', () => {
    const handler = createHandler();
    handler.handleLine('# security mains_failure //PROJ/254/208 #sourceunit=18 OID=');
    expect(eventPublisher.publishReading).toHaveBeenCalledWith('254', '208', 'panel/mains',
        { kind: 'security_panel', active: true });
    handler.handleLine('# security mains_restored //PROJ/254/208 #sourceunit=18 OID=');
    expect(eventPublisher.publishReading).toHaveBeenLastCalledWith('254', '208', 'panel/mains',
        { kind: 'security_panel', active: false });
});

it('logs panel trouble at INFO', () => {
    const handler = createHandler();
    handler.handleLine('# security mains_failure //PROJ/254/208 #sourceunit=18 OID=');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Mains power failure'));
});

it('clears panic on disarm without a panic_off verb', () => {
    const handler = createHandler();
    handler.handleLine('# security panic_activated //PROJ/254/208 #sourceunit=18 OID=');
    handler.handleLine('# security system_arm //PROJ/254/208 0 #sourceunit=18 OID=');
    expect(eventPublisher.publishReading).toHaveBeenCalledWith('254', '208', 'panel/panic',
        { kind: 'security_panel', active: false });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest tests/securityDiscovery.test.js tests/securityEventHandler.test.js`
Expected: FAIL — `ensureSecurityPanelDiscovery` is not a function.

- [ ] **Step 3: Implement discovery**

`_createSecurityPanelDiscovery(networkId, appId)` loops the seven conditions, building for each:

```js
const uniqueId = `cgateweb_${networkId}_${appId}_panel_${condition}`;
const readBase = `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/panel/${condition}`;
const payload = {
    name: PANEL_CONDITION_LABELS[condition],   // 'Mains power', 'Battery', 'Tamper', 'Panic', 'Phone line', 'Arm failed', 'Fire alarm'
    unique_id: uniqueId,
    state_topic: `${readBase}/${MQTT_TOPIC_SUFFIX_STATE}`,
    payload_on: MQTT_STATE_ON,
    payload_off: MQTT_STATE_OFF,
    device_class: PANEL_CONDITION_DEVICE_CLASSES[condition],
    entity_category: 'diagnostic',
    qos: 0,
    device: buildDeviceBlock({
        identifiers: [`cgateweb_${networkId}_${appId}_panel`],
        name: `C-Bus Security Panel ${networkId}/${appId}`,
        model: 'C-Bus Security Panel'
    }),
    origin: buildOriginBlock()
};
```

`name` is a real string here, not `null` as zones use — these are seven entities on a shared device, so each needs its own name. Register every topic in `_publishedTopics` and `_eventDrivenDiscoveryTopics`; on exclusion, retract all seven. Exclusion key is `{net}/{app}/panel`.

- [ ] **Step 4: Implement publishing and logging**

In `src/eventPublisher.js`, next to the `security_zone` branch:

```js
} else if (reading.kind === 'security_panel') {
    this._publishState(network, application, group, reading.active ? MQTT_STATE_ON : MQTT_STATE_OFF);
}
```

(Match the exact helper the `security_zone` branch uses; `group` is already the `panel/{condition}` path segment.)

In `src/securityEventHandler.js`: construct `this.panelState = new SecurityPanelState()`; add a `panel_trouble` branch that calls `applyReading`, publishes each changed condition, logs at INFO via `_describeSystemEvent`, and emits an event-log entry with the description. Feed `system_arm` readings through `applyReading` as well (for the derived clears) *in addition to* their existing handling. Seed at discovery time from `initialStates`, and call `seedFromStatusReport` in the status-report branch.

Extend `_describeSystemEvent` with the seven conditions in both senses: `Mains power failure` / `Mains power restored`, `Battery low` / `Battery restored`, `Tamper detected` / `Tamper cleared`, `Panic activated` / `Panic cleared`, `Phone line cut` / `Phone line restored`, `Arm failed` / `Arm failure cleared`, `Fire alarm` / `Fire alarm cleared`.

- [ ] **Step 5: Run to verify pass**

Run: `npx jest tests/securityDiscovery.test.js tests/securityEventHandler.test.js`
Expected: PASS.

- [ ] **Step 6: Full gates and commit**

```bash
npm test && npm run lint && npm run typecheck
git add src/haDiscoveryPublishers.js src/securityEventHandler.js src/eventPublisher.js tests/
git commit -m "feat: security panel trouble sensors as diagnostic binary_sensors (#42)"
```

---

### Task 5: Discovery config payload cache and republish

**Files:**
- Modify: `src/haDiscovery.js` (add `_publishedConfigPayloads` next to `_publishedTopics` ~line 50; add `republishDiscoveryConfigs()`)
- Modify: `src/haDiscoveryPublishers.js` (record payloads wherever `_publishedTopics.add` runs; delete on retraction)
- Test: `tests/haDiscovery.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `haDiscovery.republishDiscoveryConfigs() -> number` (count republished).

- [ ] **Step 1: Write the failing test**

```js
it('replays every published discovery config payload', () => {
    haDiscovery.ensureSecurityZoneDiscovery('254', '208', '13');
    mqttManager.publish.mockClear();
    const count = haDiscovery.republishDiscoveryConfigs();
    expect(count).toBe(1);
    expect(mqttManager.publish).toHaveBeenCalledWith(
        expect.stringContaining('/config'), expect.stringContaining('cgateweb_254_208_13'),
        expect.objectContaining({ retain: true })
    );
});

it('does not replay a retracted config', () => {
    haDiscovery.ensureSecurityZoneDiscovery('254', '208', '13');
    haDiscovery.exclude.add('254/208/14');
    haDiscovery.ensureSecurityZoneDiscovery('254', '208', '14');
    expect(haDiscovery.republishDiscoveryConfigs()).toBe(1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest tests/haDiscovery.test.js -t republish`
Expected: FAIL — not a function.

- [ ] **Step 3: Implement**

Add `this._publishedConfigPayloads = new Map();` beside `_publishedTopics`. Introduce one helper used by every config publish site so the two collections cannot drift:

```js
_recordDiscoveryConfig(topic, payload) {
    this._publishedTopics.add(topic);
    this._publishedConfigPayloads.set(topic, payload);
}

_forgetDiscoveryConfig(topic) {
    this._publishedTopics.delete(topic);
    this._publishedConfigPayloads.delete(topic);
}

republishDiscoveryConfigs() {
    let count = 0;
    for (const [topic, payload] of this._publishedConfigPayloads) {
        this._publish(topic, payload, MQTT_RETAINED_STATE_OPTIONS);
        count++;
    }
    if (count > 0) this.logger.info(`Republished ${count} HA Discovery config(s)`);
    return count;
}
```

Replace the existing `_publishedTopics.add(...)` / `.delete(...)` calls in `haDiscovery.js` and `haDiscoveryPublishers.js` with these helpers. Keep `_eventDrivenDiscoveryTopics` handling exactly as it is.

- [ ] **Step 4: Run to verify pass, then full gates and commit**

```bash
npx jest tests/haDiscovery.test.js tests/securityDiscovery.test.js tests/haDiscoveryTree.test.js
npm test && npm run lint && npm run typecheck
git add src/haDiscovery.js src/haDiscoveryPublishers.js tests/haDiscovery.test.js
git commit -m "refactor: cache HA Discovery config payloads for replay"
```

---

### Task 6: State resync on HA restart and broker reconnect

**Files:**
- Create: `src/stateResyncCoordinator.js`
- Modify: `src/defaultSettings.js` (four new settings)
- Modify: `src/mqttManager.js` (`_handleConnect` ~line 290-320: emit `reconnect`, subscribe to the birth topic)
- Modify: `src/cgateWebBridge.js` (~line 407: intercept the birth topic before routing to `mqttCommandRouter`; construct and wire the coordinator)
- Test: `tests/stateResyncCoordinator.test.js` (new), `tests/mqttManager.test.js`

**Interfaces:**
- Consumes: `haDiscovery.republishDiscoveryConfigs()` (Task 5), `securityEventHandler.requestStatusSync(network, trigger)`, `bridgeInitializationService._resolveGetallNetApps()`.
- Produces: `StateResyncCoordinator` with `requestResync(trigger, {republishDiscovery = false} = {})` and `dispose()`.

- [ ] **Step 1: Write the failing tests**

```js
describe('StateResyncCoordinator', () => {
    it('queues a getall per configured net/app', () => {
        coordinator.requestResync('ha-birth');
        jest.advanceTimersByTime(5000);
        expect(commandQueue.add).toHaveBeenCalledWith('GET //TEST/254/56/* level\n');
    });

    it('collapses two triggers inside the debounce window into one resync', () => {
        coordinator.requestResync('ha-birth');
        coordinator.requestResync('mqtt-reconnect');
        jest.advanceTimersByTime(5000);
        expect(commandQueue.add).toHaveBeenCalledTimes(1);
    });

    it('republishes discovery configs only when asked', () => {
        coordinator.requestResync('ha-birth');
        jest.advanceTimersByTime(5000);
        expect(haDiscovery.republishDiscoveryConfigs).not.toHaveBeenCalled();
        coordinator.requestResync('mqtt-reconnect', { republishDiscovery: true });
        jest.advanceTimersByTime(5000);
        expect(haDiscovery.republishDiscoveryConfigs).toHaveBeenCalledTimes(1);
    });

    it('requests a security status sync, which getall cannot cover', () => {
        coordinator.requestResync('ha-birth');
        jest.advanceTimersByTime(5000);
        expect(securityEventHandler.requestStatusSync).toHaveBeenCalledWith('254', 'resync');
    });

    it('logs at debug and sends nothing when no networks are configured', () => {
        initializationService._resolveGetallNetApps.mockReturnValue([]);
        coordinator.requestResync('ha-birth');
        jest.advanceTimersByTime(5000);
        expect(commandQueue.add).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('no getall'));
    });

    it('honours the disable flags', () => {
        settings.stateResyncOnHaRestart = false;
        coordinator.requestResync('ha-birth');
        jest.advanceTimersByTime(5000);
        expect(commandQueue.add).not.toHaveBeenCalled();
    });
});
```

And in `tests/mqttManager.test.js`:

```js
it('emits reconnect only after a prior successful connect', () => {
    const onReconnect = jest.fn();
    manager.on('reconnect', onReconnect);
    manager._handleConnect();
    expect(onReconnect).not.toHaveBeenCalled();
    manager._handleConnect();
    expect(onReconnect).toHaveBeenCalledTimes(1);
});

it('subscribes to the HA birth topic on connect', () => {
    manager._handleConnect();
    expect(mockClient.subscribe).toHaveBeenCalledWith('homeassistant/status', expect.any(Function));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest tests/stateResyncCoordinator.test.js tests/mqttManager.test.js`
Expected: FAIL — module not found; `reconnect` never emitted.

- [ ] **Step 3: Add the settings**

In `src/defaultSettings.js`:

```js
// State resync after a Home Assistant or MQTT broker restart (issue #44).
// HA keeps running the add-on across its own restart, so nothing would
// otherwise republish state and entities sit unknown until the next C-Bus
// event. Both default on: this is a fix, not an opt-in feature.
stateResyncOnHaRestart: true,
stateResyncOnMqttReconnect: true,
stateResyncDebounceMs: 5000,
// Falls back to `${ha_discovery_prefix}/status` when null.
haStatusTopic: null,
```

- [ ] **Step 4: Implement the coordinator**

`requestResync(trigger, opts)` returns early when the matching disable flag is set, records `republishDiscovery` as sticky-OR across collapsed triggers, and (re)arms a single `setTimeout` for `stateResyncDebounceMs`. On fire: republish configs if requested; for each `_resolveGetallNetApps()` entry queue `GET //${cbusname}/${netapp}/* level\n`; for each distinct network call `securityEventHandler.requestStatusSync(network, 'resync')`; log one INFO summary naming the trigger and counts, or DEBUG when there is nothing to do. `dispose()` clears the pending timer.

`requestStatusSync` currently dedupes per session on the `early`/`postSync` slots (`securityEventHandler.js:103-133`), so add a `'resync'` trigger that bypasses the dedupe — otherwise the second and later resyncs would silently do nothing. Add a test asserting a second resync still sends.

- [ ] **Step 5: Wire the triggers**

`src/mqttManager.js` `_handleConnect`: capture `const isReconnect = this._hasConnectedOnce;` before the flag is set, subscribe to `this._haStatusTopic()` alongside `cbus/write/#`, and `this.emit('reconnect')` after `this.emit('connect')` when `isReconnect`.

`src/cgateWebBridge.js` (~line 407):

```js
this.mqttManager.on('message', (topic, payload) => {
    if (topic === this.mqttManager.haStatusTopic) {
        if (String(payload).trim().toLowerCase() === 'online') {
            this.stateResyncCoordinator.requestResync('ha-birth');
        }
        return;
    }
    this.mqttCommandRouter.routeMessage(topic, payload);
});
this.mqttManager.on('reconnect', () => {
    this.stateResyncCoordinator.requestResync('mqtt-reconnect', { republishDiscovery: true });
});
```

- [ ] **Step 6: Run to verify pass, then full gates and commit**

```bash
npx jest tests/stateResyncCoordinator.test.js tests/mqttManager.test.js tests/cgateWebBridge.test.js
npm test && npm run lint && npm run typecheck
git add src/stateResyncCoordinator.js src/defaultSettings.js src/mqttManager.js src/cgateWebBridge.js tests/
git commit -m "fix: resync entity state after Home Assistant or broker restart (#44)"
```

---

### Task 7: Release v1.21.0

**Files:**
- Modify: `package.json`, `homeassistant-addon/config.yaml`, `CHANGELOG.md`

- [ ] **Step 1: Bump both versions to 1.21.0**

Both files must agree or CI's `version-sync` job fails.

- [ ] **Step 2: Write the CHANGELOG entry**

Cover: Live Events descriptions for security rows; seven panel-trouble diagnostic sensors on a shared panel device; state resync after HA or broker restart. Plain language, no emdashes in issue-facing copy.

- [ ] **Step 3: Full gates plus the add-on validators**

```bash
npm test && npm run lint && npm run typecheck
npm run validate:translations && npm run validate:addon-config
```

- [ ] **Step 4: Commit, push, tag**

```bash
git add package.json homeassistant-addon/config.yaml CHANGELOG.md
git commit -m "chore: release v1.21.0"
git push origin master
git tag v1.21.0 && git push origin v1.21.0
```

- [ ] **Step 5: Watch CI, then backfill the GitHub Release**

```bash
gh run watch
gh release create v1.21.0 --notes "<CHANGELOG section>"
```

- [ ] **Step 6: Reply on #42 and #44**

Plain text, concise, no emdashes. On #42, list what shipped and ask @djagerif to confirm the three inferred verbs (`low_battery`, `tamper_on`, a panic clear) if they can produce a low battery or tamper. On #44, describe both triggers and note that `GETSTATE ... levels` was deferred in favour of the existing getall path.

---

## Self-Review

**Spec coverage:** Live Events enrichment → Task 1. Verb decoding incl. inferred verbs and detail suffixes → Task 2. Panel state, dedupe, derived clears, status-report seeding → Task 3. Discovery (shared device, diagnostic category, device classes, exclusion), topics, initial seeding, INFO logging, no new config option → Task 4. Discovery payload cache → Task 5. Coordinator, both triggers, debounce, security status sync, empty-network case, four new settings → Task 6. Release and issue replies → Task 7. "Not doing" (`GETSTATE`) is recorded in Task 7 step 6.

**Two spec gaps found and fixed while planning:**
1. `requestStatusSync` dedupes per session, so the coordinator's security sync would fire once and never again. Task 6 step 4 adds a `'resync'` trigger that bypasses the dedupe, with a test.
2. `arm_failed` and `fire_alarm` already return their own `kind`s, so folding them into `panel_trouble` is a behaviour change to existing decoder output. Task 2 step 4 calls out updating the existing assertions.

**Type consistency:** `condition` keys are identical across Tasks 2, 3 and 4 (`mains`, `battery`, `tamper`, `panic`, `line`, `arm_failed`, `fire`). `applyReading`/`seedFromStatusReport`/`initialStates` all return `Array<{condition, active}>`. `_emitEventLog`'s new trailing `description` param is used consistently in Tasks 1 and 4.
