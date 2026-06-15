# CgateWebBridge Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink `src/cgateWebBridge.js` (761 lines, 184-line constructor) from a kitchen-sink orchestrator into a thin coordinator by extracting four cohesive collaborators, and stop `BridgeInitializationService` from mutating bridge internals — all behaviour-preserving.

**Architecture:** Each extraction moves a cohesive group of methods + the state they own into a focused class that the bridge instantiates and delegates to. The bridge keeps wiring/ownership; collaborators own their slice of state. Every task is behaviour-preserving: the existing `tests/cgateWebBridge.test.js` suite must stay green throughout, and each new collaborator gets its own unit tests. No public MQTT/topic behaviour changes.

**Tech Stack:** Node.js, EventEmitter, Jest. No new dependencies.

**Why this is safe to do incrementally:** the bridge is constructed once and runs single-threaded; moving a method to a collaborator and delegating is a mechanical, testable transform. Tasks are ordered lowest-risk-first; the riskiest (Task 5, init-service decoupling) is last so the earlier extractions build confidence in the test suite.

**Baseline before starting:** `npm test` green (1445 tests), `npm run lint -- --max-warnings=0` clean.

---

## File Structure

- `src/airconEventHandler.js` (new) — decode an aircon C-Bus line, update `AirconControlRegistry`, publish. Owns: nothing persistent beyond the injected registry.
- `src/cniNotificationManager.js` (new) — CNI offline/online notification state machine. Owns: the per-network "notified" set and notification IDs.
- `src/bridgeReadiness.js` (new) — lifecycle state + readiness reason + status snapshot. Owns: `lifecycleState`, `readinessReason`, last-status fields.
- `src/cgateWebBridge.js` (modify) — delegate to the above; split the constructor into focused private builders; consume init-service results instead of being mutated.
- `src/bridgeInitializationService.js` (modify, Task 5) — return an init-result object instead of writing 19+ `bridge.*` fields.
- Tests: `tests/airconEventHandler.test.js`, `tests/cniNotificationManager.test.js`, `tests/bridgeReadiness.test.js` (new); existing `tests/cgateWebBridge.test.js` and `tests/bridgeInitializationService.test.js` stay green.

**Current method groups in `cgateWebBridge.js` (for reference):**
- Construction/wiring: constructor `:60-244`
- Event handler setup: `_setupEventHandlers :246`
- Connection lifecycle: `_handleAllConnected :369`, `_connectMqtt :747`, `_connectCommandSocket :751`, `_connectEventSocket :755`
- Data path: `_handleCommandData :377`, `_handleEventData :395`, `_processEventLine :446`, `_publishRawEventCapture :486`
- Aircon: `_handleAirconLine :409` → **Task 1**
- Queue control: `_canProcessCommandQueue :521`, `_getAdaptiveQueueIntervalMs :526` (leave in bridge — tightly coupled to the pool it owns)
- CNI: `_handleNetworkInterfaceReading :578`, `_notifyCniOffline :603`, `_dismissCniNotification :624` → **Task 2**
- Readiness/lifecycle/status: `_getBridgeStatus :633`, `_updateBridgeReadiness :676`, `_setLifecycleState :694` → **Task 3**
- Settings reload: `reloadSettings :706`, `_applyLogLevel :732`
- Logging facade: `log/warn/error :548-577`

---

## Task 1: Extract AirconEventHandler

The simplest, most self-contained extraction. `_handleAirconLine` (`cgateWebBridge.js:409-444`) decodes a native-aircon line, records it in `airconControlRegistry`, and publishes via `eventPublisher`. It has no bridge-only state.

**Files:**
- Create: `src/airconEventHandler.js`
- Create: `tests/airconEventHandler.test.js`
- Modify: `src/cgateWebBridge.js:409-444` (replace body with delegation), constructor wiring near `:60-244`

- [ ] **Step 1: Read the current implementation**

Read `src/cgateWebBridge.js:409-444` and note every collaborator it touches (`this.airconControlRegistry`, `this.eventPublisher`, `this.logger`, `this.settings`, any decoder import). Copy the exact logic — do not paraphrase it.

- [ ] **Step 2: Write the failing test**

```js
// tests/airconEventHandler.test.js
const AirconEventHandler = require('../src/airconEventHandler');

function makeDeps() {
    return {
        registry: { recordModeReading: jest.fn() },
        eventPublisher: { publishAirconReading: jest.fn() }, // match the real method name found in Step 1
        logger: { debug: jest.fn(), warn: jest.fn() },
        settings: {},
    };
}

describe('AirconEventHandler', () => {
    it('records a decoded mode reading in the registry and publishes it', () => {
        const deps = makeDeps();
        const handler = new AirconEventHandler(deps);
        // Use a real aircon line that the existing bridge test in tests/cgateWebBridge.test.js exercises.
        handler.handleLine('<REAL AIRCON LINE FROM EXISTING BRIDGE TEST>');
        expect(deps.registry.recordModeReading).toHaveBeenCalled();
        expect(deps.eventPublisher.publishAirconReading).toHaveBeenCalled();
    });

    it('ignores a non-aircon or undecodable line without throwing', () => {
        const deps = makeDeps();
        const handler = new AirconEventHandler(deps);
        expect(() => handler.handleLine('garbage')).not.toThrow();
        expect(deps.registry.recordModeReading).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest tests/airconEventHandler.test.js`
Expected: FAIL with "Cannot find module '../src/airconEventHandler'".

- [ ] **Step 4: Create the class by moving the logic verbatim**

```js
// src/airconEventHandler.js
'use strict';
// + any decoder imports the original _handleAirconLine used (copy from cgateWebBridge.js top imports)

class AirconEventHandler {
    constructor({ registry, eventPublisher, logger, settings }) {
        this.registry = registry;
        this.eventPublisher = eventPublisher;
        this.logger = logger;
        this.settings = settings;
    }

    // Body copied verbatim from cgateWebBridge._handleAirconLine, with
    // this.airconControlRegistry -> this.registry and this.eventPublisher kept.
    handleLine(line) {
        // <EXACT logic from cgateWebBridge.js:409-444>
    }
}

module.exports = AirconEventHandler;
```

- [ ] **Step 5: Delegate from the bridge**

In `src/cgateWebBridge.js` constructor (after `eventPublisher` and `airconControlRegistry` are built), add:
```js
this.airconEventHandler = new AirconEventHandler({
    registry: this.airconControlRegistry,
    eventPublisher: this.eventPublisher,
    logger: this.logger,
    settings: this.settings,
});
```
Replace the body of `_handleAirconLine(line)` (`:409-444`) with:
```js
    _handleAirconLine(line) {
        return this.airconEventHandler.handleLine(line);
    }
```
Add `const AirconEventHandler = require('./airconEventHandler');` to the top imports.

- [ ] **Step 6: Run the new test and the full bridge suite**

Run: `npx jest tests/airconEventHandler.test.js tests/cgateWebBridge.test.js`
Expected: PASS (both). If a bridge test asserted on internal aircon behaviour, it still passes because `_handleAirconLine` delegates identically.

- [ ] **Step 7: Lint and commit**

Run: `npm run lint -- --max-warnings=0`
```bash
git add src/airconEventHandler.js tests/airconEventHandler.test.js src/cgateWebBridge.js
git commit -m "refactor: extract AirconEventHandler from CgateWebBridge"
```

---

## Task 2: Extract CniNotificationManager

`_handleNetworkInterfaceReading` (`:578`), `_notifyCniOffline` (`:603`), `_dismissCniNotification` (`:624`) form a small state machine over CNI online/offline transitions and own the per-network notification bookkeeping. Move them and that state.

**Files:**
- Create: `src/cniNotificationManager.js`
- Create: `tests/cniNotificationManager.test.js`
- Modify: `src/cgateWebBridge.js` (`:578-632` delegate, constructor wiring, and the `networkInterfaceMonitor` event handler in `_setupEventHandlers`)

- [ ] **Step 1: Read the current implementation and identify owned state**

Read `:578-632`. Identify every `this.*` field these three methods read/write (e.g. a Set of notified network IDs, stored notification IDs, `this.haNotifier`, `this.settings.cni_offline_notification`). That state moves into the new class.

- [ ] **Step 2: Write the failing test**

```js
// tests/cniNotificationManager.test.js
const CniNotificationManager = require('../src/cniNotificationManager');

function makeDeps(overrides = {}) {
    return {
        haNotifier: { notify: jest.fn().mockResolvedValue('notif-id'), dismiss: jest.fn().mockResolvedValue() },
        logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
        settings: { cni_offline_notification: true },
        ...overrides,
    };
}

describe('CniNotificationManager', () => {
    it('notifies once when a network goes offline and not again while still offline', async () => {
        const deps = makeDeps();
        const mgr = new CniNotificationManager(deps);
        await mgr.handleReading(254, { online: false });
        await mgr.handleReading(254, { online: false });
        expect(deps.haNotifier.notify).toHaveBeenCalledTimes(1);
    });

    it('dismisses the notification when the network comes back online', async () => {
        const deps = makeDeps();
        const mgr = new CniNotificationManager(deps);
        await mgr.handleReading(254, { online: false });
        await mgr.handleReading(254, { online: true });
        expect(deps.haNotifier.dismiss).toHaveBeenCalledTimes(1);
    });

    it('does nothing when cni_offline_notification is disabled', async () => {
        const mgr = new CniNotificationManager(makeDeps({ settings: { cni_offline_notification: false } }));
        await mgr.handleReading(254, { online: false });
        expect(mgr).toBeDefined();
    });
});
```
> NOTE: align method names (`notify`/`dismiss`) and the reading shape with the real `haNotifier` and `networkInterfaceMonitor` API found in Step 1 before running.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest tests/cniNotificationManager.test.js`
Expected: FAIL with "Cannot find module".

- [ ] **Step 4: Create the class, moving the three methods + their state verbatim**

```js
// src/cniNotificationManager.js
'use strict';

class CniNotificationManager {
    constructor({ haNotifier, logger, settings }) {
        this.haNotifier = haNotifier;
        this.logger = logger;
        this.settings = settings;
        this._notifiedNetworks = new Map(); // <match the original state shape from Step 1>
    }

    handleReading(networkId, reading) { /* from _handleNetworkInterfaceReading */ }
    _notifyOffline(networkId, interfaceState) { /* from _notifyCniOffline */ }
    _dismiss(networkId) { /* from _dismissCniNotification */ }
}

module.exports = CniNotificationManager;
```

- [ ] **Step 5: Delegate from the bridge**

Construct `this.cniNotificationManager = new CniNotificationManager({ haNotifier: this.haNotifier, logger: this.logger, settings: this.settings });` in the constructor. In `_setupEventHandlers`, change the `networkInterfaceMonitor` reading handler to call `this.cniNotificationManager.handleReading(networkId, reading)`. Delete `_notifyCniOffline`/`_dismissCniNotification` from the bridge (or leave `_handleNetworkInterfaceReading` as a one-line delegator if other code calls it — grep first).

- [ ] **Step 6: Run tests**

Run: `npx jest tests/cniNotificationManager.test.js tests/cgateWebBridge.test.js tests/haNotifier.test.js`
Expected: PASS.

- [ ] **Step 7: Lint and commit**

```bash
git add src/cniNotificationManager.js tests/cniNotificationManager.test.js src/cgateWebBridge.js
git commit -m "refactor: extract CniNotificationManager from CgateWebBridge"
```

---

## Task 3: Extract BridgeReadiness (lifecycle + readiness + status)

`_getBridgeStatus` (`:633`), `_updateBridgeReadiness` (`:676`), `_setLifecycleState` (`:694`) own `lifecycleState`, the readiness reason, and assemble the status snapshot (consumed by the web server `/status` and MQTT readiness publishing). Move them and their state into a `BridgeReadiness` collaborator that emits `readinessChanged`.

**Files:**
- Create: `src/bridgeReadiness.js`
- Create: `tests/bridgeReadiness.test.js`
- Modify: `src/cgateWebBridge.js` (delegate `:633-705`, constructor wiring, callers of `_updateBridgeReadiness`)

- [ ] **Step 1: Map state and callers**

Grep `_updateBridgeReadiness`, `_setLifecycleState`, `_getBridgeStatus`, `lifecycleState`, and any readiness fields across `src/`. List every caller (connection events, mqtt manager, init service). The new class must expose the same transitions these callers trigger.

- [ ] **Step 2: Write the failing test**

```js
// tests/bridgeReadiness.test.js
const BridgeReadiness = require('../src/bridgeReadiness');

describe('BridgeReadiness', () => {
    it('reports Offline until set ready, then Online', () => {
        const r = new BridgeReadiness({ logger: { info: jest.fn() } });
        expect(r.isReady()).toBe(false);
        r.update({ mqtt: true, commandPool: true, event: true }, 'all-connected');
        expect(r.isReady()).toBe(true);
    });

    it('emits readinessChanged only on transitions, with the reason', () => {
        const r = new BridgeReadiness({ logger: { info: jest.fn() } });
        const spy = jest.fn();
        r.on('readinessChanged', spy);
        r.update({ mqtt: true, commandPool: true, event: true }, 'all-connected');
        r.update({ mqtt: true, commandPool: true, event: true }, 'noop'); // same state
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).toMatchObject({ ready: true, reason: 'all-connected' });
    });
});
```
> Align `update(...)` inputs and `readinessChanged` payload with the real `_updateBridgeReadiness` signature found in Step 1.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest tests/bridgeReadiness.test.js`
Expected: FAIL with "Cannot find module".

- [ ] **Step 4: Create the class (extends EventEmitter), moving logic verbatim**

```js
// src/bridgeReadiness.js
'use strict';
const { EventEmitter } = require('events');

class BridgeReadiness extends EventEmitter {
    constructor({ logger }) {
        super();
        this.logger = logger;
        this.lifecycleState = 'booting';
        this.readinessReason = 'startup';
        this._ready = false;
    }
    isReady() { return this._ready; }
    update(connectionState, reason) { /* from _updateBridgeReadiness, emit 'readinessChanged' on change */ }
    setLifecycleState(state, reason) { /* from _setLifecycleState */ }
    getStatusSnapshot(extra) { /* from _getBridgeStatus */ }
}

module.exports = BridgeReadiness;
```

- [ ] **Step 5: Delegate from the bridge**

Construct `this.bridgeReadiness = new BridgeReadiness({ logger: this.logger });` early in the constructor. Replace `_updateBridgeReadiness`/`_setLifecycleState`/`_getBridgeStatus` bodies with delegations. Subscribe the existing MQTT-readiness publisher to `this.bridgeReadiness.on('readinessChanged', ...)` so the `hello/cgateweb` Online/Offline publishing is driven by the collaborator. Keep the bridge methods as thin delegators if external callers (web server) use them.

- [ ] **Step 6: Run tests**

Run: `npx jest tests/bridgeReadiness.test.js tests/cgateWebBridge.test.js tests/mqttManager.test.js tests/webServer.test.js`
Expected: PASS.

- [ ] **Step 7: Lint and commit**

```bash
git add src/bridgeReadiness.js tests/bridgeReadiness.test.js src/cgateWebBridge.js
git commit -m "refactor: extract BridgeReadiness (lifecycle, readiness, status)"
```

---

## Task 4: Split the constructor into focused builders

After Tasks 1-3 the constructor is smaller but still does dependency construction, queue construction, and event-log buffer setup inline. Split it into private builders for readability — pure mechanical move, no logic change.

**Files:**
- Modify: `src/cgateWebBridge.js` constructor (`:60-244`)

- [ ] **Step 1: Identify the three blocks**

In the constructor, bracket: (a) subsystem construction (managers, pool, event connection, publisher, registries, the new collaborators), (b) queue construction (`cgateCommandQueue`, any other queues), (c) the event-log buffer setup (`_eventLogBuffer`, `_eventLogListeners`, `_onEventLog`).

- [ ] **Step 2: Extract `_buildEventLogBuffer()` first (smallest, self-contained)**

Move block (c) into `_buildEventLogBuffer()` and call it from the constructor. Run `npx jest tests/cgateWebBridge.test.js` — expected PASS. Commit:
```bash
git add src/cgateWebBridge.js && git commit -m "refactor: extract _buildEventLogBuffer from CgateWebBridge constructor"
```

- [ ] **Step 3: Extract `_buildQueues()`**

Move block (b) into `_buildQueues()`. Note ordering: queues depend on `_getAdaptiveQueueIntervalMs`/`_canProcessCommandQueue` being defined as methods (they are — methods are hoisted on the instance). Run `npx jest tests/cgateWebBridge.test.js` — expected PASS. Commit.

- [ ] **Step 4: Extract `_buildSubsystems()`**

Move block (a) into `_buildSubsystems()`, preserving exact construction order (factories before the things that use them). Run the full suite `npm test` — expected PASS (1445+). Commit.

- [ ] **Step 5: Lint**

Run: `npm run lint -- --max-warnings=0`. Expected: clean.

---

## Task 5: Make BridgeInitializationService return results instead of mutating the bridge

**Highest-risk task — do last.** Today the service writes `bridge.discoveredNetworks`, `bridge.haDiscovery`, `bridge.periodGetAllInterval`, `bridge._onLabelsChanged`, etc. (~19 mutations). Change it to return an `InitResult` object that the bridge applies itself, so initialization is composable and testable.

**Files:**
- Modify: `src/bridgeInitializationService.js`
- Modify: `src/cgateWebBridge.js` (`_handleAllConnected :369` applies the result)
- Test: `tests/bridgeInitializationService.test.js` (update to assert on the returned result, not bridge mutation)

- [ ] **Step 1: Inventory every `bridge.*` write in the service**

Run: `grep -nE "this\.bridge\.[a-zA-Z_]+ *=" src/bridgeInitializationService.js`
List each assigned field. These become keys of the returned `InitResult`. Also list `this.bridge.<method>()` calls (e.g. `cgateCommandQueue.add`, `_updateBridgeReadiness`) — these stay as calls but should go through a narrow injected interface, not `this.bridge`.

- [ ] **Step 2: Write the failing test for the new return contract**

```js
// add to tests/bridgeInitializationService.test.js
it('returns an InitResult describing discovered state instead of mutating the bridge', async () => {
    const service = makeService(/* existing harness */);
    const result = await service.initialize(); // new method name; was handleAllConnected
    expect(result).toMatchObject({
        discoveredNetworks: expect.anything(),
        haDiscovery: expect.anything(),
    });
    // The service must NOT have written directly to a bare bridge object:
    expect(service.bridge).toBeUndefined(); // service no longer holds a bridge ref for state writes
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest tests/bridgeInitializationService.test.js -t "InitResult"`
Expected: FAIL.

- [ ] **Step 4: Refactor the service**

Change the constructor to take explicit collaborators (`{ commandQueue, labelLoader, settings, logger, haDiscoveryFactory }`) instead of `bridge`. Convert the init entrypoint to build and **return** `{ discoveredNetworks, haDiscovery, periodicTimers, labelChangeHandler }`. Replace every `this.bridge.X = Y` with assembling that into the result; replace `this.bridge.cgateCommandQueue.add(...)` with `this.commandQueue.add(...)`.

- [ ] **Step 5: Apply the result in the bridge**

In `_handleAllConnected`, call `const init = await this.initializationService.initialize();` then apply: `this.discoveredNetworks = init.discoveredNetworks; this.haDiscovery = init.haDiscovery; ...`. Register `init.labelChangeHandler` and store `init.periodicTimers` for cleanup in `stop()`.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS (1445+). Pay attention to `tests/bridgeInitializationService.test.js` and `tests/cgateWebBridge.test.js` — update assertions that previously checked bridge mutation to check the applied result.

- [ ] **Step 7: Lint and commit**

```bash
npm run lint -- --max-warnings=0
git add src/bridgeInitializationService.js src/cgateWebBridge.js tests/bridgeInitializationService.test.js
git commit -m "refactor: BridgeInitializationService returns InitResult instead of mutating bridge"
```

---

## Final verification

- [ ] `npm test` — all suites green (≥1445 tests).
- [ ] `npm run lint -- --max-warnings=0` — clean.
- [ ] `wc -l src/cgateWebBridge.js` — expect well under 500 lines (from 761).
- [ ] Manual diff review: confirm no MQTT topic, discovery payload, or readiness-string changed (grep the diff for changed string literals; there should be none).
- [ ] Optional: run the integration test locally (`npm run test:integration`) to confirm the assembled add-on still boots and connects.

---

## Notes / risks

- **Behaviour preservation is the whole game.** If any task requires changing a string literal published to MQTT or HA discovery, STOP — that's out of scope for a refactor and means the extraction boundary is wrong.
- **Task 5 is the risky one.** It touches the init order that Task-3's readiness and the haDiscovery late-binding depend on. If the existing init-order tests get fragile, consider splitting Task 5 into "introduce InitResult alongside existing mutation (dual-write)" then "remove the mutation" as two commits.
- **Out of scope (deliberately):** `_canProcessCommandQueue`/`_getAdaptiveQueueIntervalMs` stay in the bridge — they're tightly coupled to the pool the bridge owns and extracting them adds indirection without reducing responsibility.
- The connection/command state machine was reviewed separately and found sound; this plan does not touch `cgateConnectionPool.js`, `connectionManager.js`, or `throttledQueue.js`.
