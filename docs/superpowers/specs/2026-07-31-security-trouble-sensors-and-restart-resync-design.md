# Security panel trouble sensors, Live Events enrichment, and restart state resync

Date: 2026-07-31
Issues: [#42](https://github.com/dougrathbone/cgateweb/issues/42) (security application, phase 1 follow-up), [#44](https://github.com/dougrathbone/cgateweb/issues/44) (level sync after HA or MQTT restart)
Target release: v1.21.0

## Background

Phase 1 of the security application shipped across v1.20.0 to v1.20.2 and the alpha tester
(@djagerif, running a 64-zone Cytech Comfort II panel on network 254, app 208) confirmed zone
binary_sensors, the log-level split and label renames all work. Two items from their last two
comments on #42 remain, and #44 arrived on 2026-07-31 as a separate report.

Three pieces of work, ordered smallest-risk first:

1. **Live Events enrichment** — security rows in the web UI render as raw levels.
2. **Panel trouble sensors** — seven captured panel-wide verbs are decoded nowhere and
   surface only as `Security line not decoded (verb pending support)` at DEBUG.
3. **Restart state resync** — HA or broker restarts leave entities with no state.

## 1. Live Events enrichment (#42)

### Problem

`SecurityEventHandler._emitEventLog` (`src/securityEventHandler.js:308`) emits the
lighting-shaped SSE entry `{ts, network, app, group, level, type, label?}`. The UI therefore
renders an arm sequence as level percentages:

```
12:21:11   254/208/13   Group 13   0 (0%)
12:21:29   254/208/0    —          255 (100%)
```

`_describeSystemEvent` (`securityEventHandler.js:235`) already builds the correct sentence for
the INFO log; it is simply never sent to the UI.

### Design

Add an optional `description` field to the SSE entry. Populate it for all three security event
shapes:

| Event shape | description |
| --- | --- |
| zone | `Zone sealed` / `Zone unsealed` / `Zone open` / `Zone short` |
| system verb | `_describeSystemEvent` output, e.g. `System armed (Day mode)` |
| panel trouble | `Mains power failure`, `Battery low`, … (see section 2) |

In `public/index.html`:

- the entry normaliser (~line 2001) carries `description` through alongside `label`;
- `renderEventLog()` (~line 1934) renders `description` in the value column **instead of**
  `N (P%)` when present, and suppresses the level bar for that row;
- the filter input matches `description` in addition to address and label.

Lighting rows are untouched — they have no `description` and keep their level text and bar.

Target rendering:

```
12:21:11   254/208/13   Group 13   Zone unsealed
12:21:15   254/208/13   Group 13   Zone bypassed
12:21:29   254/208      —          Ready to arm
12:21:45   254/208      —          System armed (Day mode)
12:23:53   254/208      —          System disarmed
```

## 2. Panel trouble sensors (#42)

### Captured verbs

From @djagerif's panic, mains-failure and disarm captures, none of which reach the dispatch
chain in `src/applicationDecoders/securityDecoder.js` (falls through to `return null` at line
261):

```
# security panic_activated //MIDSTRM/254/208
# security mains_failure //MIDSTRM/254/208
# security mains_restored //MIDSTRM/254/208
# security low_battery_corrected //MIDSTRM/254/208
# security line_cut_alarm //MIDSTRM/254/208 line_cut_alarm_cleared
# security tamper_off //MIDSTRM/254/208
```

`arm_failed` and `fire_alarm` are already decoded (`securityDecoder.js:248`) but published
nowhere.

### Condition map

Seven conditions. The `<verb>_raised` / `<verb>_cleared` detail-suffix convention already used
by `arm_failed` generalises to `line_cut_alarm` and `fire_alarm`.

| Condition | device_class | ON | OFF |
| --- | --- | --- | --- |
| `mains` | `problem` | `mains_failure` | `mains_restored` |
| `battery` | `battery` | `low_battery` | `low_battery_corrected` |
| `tamper` | `tamper` | `tamper_on` | `tamper_off` |
| `panic` | `safety` | `panic_activated` | `panic_off`, `panic_cleared`, or disarm |
| `line` | `problem` | `line_cut_alarm` (`_raised`) | `line_cut_alarm_cleared` |
| `arm_failed` | `problem` | `arm_failed` (`_raised`) | `arm_failed_cleared`, or a successful arm |
| `fire` | `smoke` | `fire_alarm` (`_raised`) | `fire_alarm_cleared`, or disarm |

**Inferred verb names.** The captures contain only one half of three pairs: `low_battery_corrected`
without a raise, `tamper_off` without a raise, and `panic_activated` without a clear. `low_battery`,
`tamper_on` and `panic_off` / `panic_cleared` are therefore inferred from the naming convention of
the confirmed pairs. All three are handled defensively — an inferred verb that never arrives costs
nothing, and the derived clears below mean `panic` still recovers without `panic_off` existing. Ask
the tester to confirm the raise verbs if they can produce a mains-independent low battery or a
tamper.

**Derived clears.** The panel never explicitly clears `panic`, `arm_failed` or `fire` in the
captures, so those three clear on `system_arm` with mode 0. This follows the tester's note that
"disarm clears all possible trouble conditions" and is corroborated by both captured sequences:
`arm_failed_raised` → `alarm_on` → `alarm_off` → `system_arm 0`, and `fire_alarm_raised` →
`alarm_on` → `alarm_off` → `system_arm 0`. `arm_failed` additionally clears on a successful arm
(`system_arm` with a non-zero mode).

### Components

**`src/applicationDecoders/securityDecoder.js`** stays a pure translator holding no state. New
verbs return `{kind: 'panel_trouble', network, application, condition, active, verb, detail}`.
An unrecognised verb still returns `null` so it falls through to raw event capture.

**`src/securityPanelState.js`** (new, ~80 lines). Owns the verb-to-condition map, the current
state per network, and dedupe — a repeated `mains_failure` publishes nothing. Kept out of
`securityEventHandler.js` because that file is already 314 lines and a standalone unit is
testable without mocking the whole handler.

Interface:

- `applyReading(reading) -> [{condition, active, changed}]` — also handles derived clears, so a
  `system_arm` mode 0 reading can return several cleared conditions at once.
- `seedFromStatusReport(reading) -> [{condition, active, changed}]`
- `getState(network) -> {condition: boolean}`

**`src/haDiscoveryPublishers.js`** gains `ensureSecurityPanelDiscovery(network, appId)`,
mirroring `ensureSecurityZoneDiscovery`'s contract (`haDiscoveryPublishers.js:590`): idempotent
Seen set, `exclude` honoured with retraction of the retained config, topics registered in both
`_publishedTopics` and `_eventDrivenDiscoveryTopics` so tree-run stale cleanup skips them.
Triggered by the first security traffic for that network, as zones are.

All seven entities share one device block:

```js
device: {
  identifiers: ['cgateweb_254_208_panel'],
  name: 'C-Bus Security Panel 254/208',
  model: 'C-Bus Security Panel'
}
entity_category: 'diagnostic'
```

`entity_category: 'diagnostic'` groups them under Diagnostics on the device page rather than
cluttering dashboards. The 64 zone devices are unchanged.

### Topics

```
cbus/read/254/208/panel/mains/state       -> ON | OFF
cbus/read/254/208/panel/battery/state     -> ON | OFF
cbus/read/254/208/panel/tamper/state      -> ON | OFF
cbus/read/254/208/panel/panic/state       -> ON | OFF
cbus/read/254/208/panel/line/state        -> ON | OFF
cbus/read/254/208/panel/arm_failed/state  -> ON | OFF
cbus/read/254/208/panel/fire/state        -> ON | OFF
```

unique_id: `cgateweb_254_208_panel_<condition>`.

A non-numeric `panel` segment cannot be confused with a zone number. Read topics are
publish-only from cgateweb and nothing in the bridge parses them numerically; HA takes the exact
topic from the discovery config.

### Initial state

The panel emits trouble verbs only on transition and there is no query for mains, battery, line,
arm-fail or fire state. `status_report_1` does carry authoritative tamper and panic bytes, which
the decoder already unpacks (`securityDecoder.js:140`).

At discovery time, seed all seven:

- `tamper`, `panic` — from the `status_report_1` bytes when a report has already been seen for
  that network.
- `mains`, `battery`, `line`, `arm_failed`, `fire` — `OFF` (assumed healthy).
- `tamper`, `panic` when no `status_report_1` has arrived yet — `OFF`, then corrected by
  `seedFromStatusReport` when the first report lands. Discovery is triggered by the first
  security traffic for a network, which may precede the status reports the bridge requests, so
  this ordering must not be assumed either way.

**Accepted risk:** a trouble condition raised before cgateweb started reads OK until the next
transition or a disarm re-emits its cleared verb. The alternative leaves entities `Unknown`
indefinitely on a healthy panel, which is the complaint behind #44.

### Logging

New verbs join `_describeSystemEvent` and log at INFO, preserving the level split the tester
asked for (panel events INFO, routine zone changes DEBUG): `Mains power failure`, `Mains power
restored`, `Battery low`, `Battery restored`, `Tamper detected`, `Tamper cleared`, `Phone line
cut`, `Phone line restored`, `Panic activated`, `Fire alarm`.

### Configuration

**No new config option.** Publishing is gated on the existing security app id setting plus
`ha_discovery_enabled`. `homeassistant-addon/config.yaml` and the 17 translation files are
untouched, so `validate:translations` and `validate:addon-config` cannot drift.

## 3. Restart state resync (#44)

### Problem

`retainreads` defaults to `false` (`src/defaultSettings.js:14`) and `getallonstart` only fires at
bridge startup. Nothing subscribes to the HA birth topic. Two failure modes:

- **HA restarts.** The add-on keeps running, so it publishes nothing. HA has no retained state to
  read and entities sit unknown until the next physical C-Bus event — the reporter's "two
  lightning icons" that snap to a real icon on first use.
- **The broker restarts.** Without retained-message persistence the entities disappear entirely,
  because the retained discovery configs are gone too.

### Components

**`src/stateResyncCoordinator.js`** (new, ~90 lines).

- `requestResync(trigger, {republishDiscovery})`, debounced by `stateResyncDebounceMs`, reusing
  the dedupe shape shipped for security sync in v1.20.1. A broker bounce that also restarts HA
  resyncs once, not twice.
- On fire: republish discovery configs if asked, then queue
  `GET //PROJ/{netapp}/* level` for each entry from `_resolveGetallNetApps()`, then request a
  security status sync per network. One INFO summary line naming the trigger and the count.

**Two consequences of reusing the getall path**, both handled explicitly:

- The security application is deliberately excluded from getall
  (`bridgeInitializationService.js:127` — panels do not answer lighting-style getall, spec
  §5.9). The coordinator therefore also calls
  `securityEventHandler.requestStatusSync(network, 'resync')`. Without this, zone sensors would
  stay stale across an HA restart, reintroducing #44 inside the feature just shipped for #42.
- An install with no getall or discovery networks configured has nothing to resync. That logs at
  DEBUG rather than silently doing nothing.

**Triggers.**

- *MQTT reconnect.* `mqttManager` already tracks `_hasConnectedOnce`
  (`src/mqttManager.js:62`). `_handleConnect` emits a distinct `reconnect` event when that flag
  was already true, so a first connect is unchanged and startup's own getall still covers it.
  Wired to `requestResync('mqtt-reconnect', {republishDiscovery: true})`.
- *HA birth message.* `mqttManager` subscribes to the birth topic next to `cbus/write/#`
  (`src/mqttManager.js:311`). Payload `online` triggers `requestResync('ha-birth')`; `offline`
  (HA's shutdown message) is ignored. The topic defaults to `${ha_discovery_prefix}/status`,
  which is `homeassistant/status` for the default prefix and follows the prefix when a user has
  changed it, overridable via `haStatusTopic`.

**Discovery payload cache.** `haDiscovery._publishedTopics` (`src/haDiscovery.js:50`) is a Set of
topics with no payloads, so republishing needs a parallel `Map<topic, payload>` written wherever
`_publishedTopics.add` happens and deleted on retraction, plus `republishDiscoveryConfigs()` to
replay it retained. Bounded by entity count: a few hundred payloads of roughly 500 bytes. The
alternative — re-running the TREEXML sweep — would drag in the retry, epoch and resync machinery
(`haDiscovery.js:58`-`80`) for no benefit.

### Settings

New in `src/defaultSettings.js`, all additive:

| Setting | Default | Purpose |
| --- | --- | --- |
| `stateResyncOnHaRestart` | `true` | Resync on HA birth message |
| `stateResyncOnMqttReconnect` | `true` | Resync after a mid-session broker reconnect |
| `stateResyncDebounceMs` | `5000` | Collapse near-simultaneous triggers |
| `haStatusTopic` | `null` | Override; falls back to `${ha_discovery_prefix}/status` |

Not exposed in `config.yaml`, so no translation churn; standalone users override in
`settings.js`. The two booleans default on because that is the fix — the only behaviour change is
the intended one.

### Not doing

The reporter suggested `GETSTATE //PROJECT/{net} levels`, which covers all applications on a
network in one command. Rejected for now: its reply lines carry an OID token where `-` appears in
the form the parser handles today, so it needs new parsing for no functional gain over the
existing, already-exercised getall path. Worth revisiting only if per-app getall proves too slow
on large projects.

## Error handling

- A decoded reading for a different application id is ignored, as today
  (`securityEventHandler.js:142`).
- Undecodable security lines keep falling through to raw event capture rather than being
  consumed, preserving the existing diagnostic path for verbs still unknown.
- `republishDiscoveryConfigs()` publishes through `mqttManager`, which already queues retained
  publishes when disconnected and replays them on reconnect
  (`src/mqttManager.js:65`-`70`), so a resync racing a flapping broker cannot lose configs.
- A resync with an empty net/app list logs at DEBUG and does nothing.
- HA flapping is bounded by the debounce; `offline` payloads never trigger work.

## Testing

Extend:

- `tests/applicationDecoders/securityDecoder.test.js` — seven new verbs, `_raised`/`_cleared`
  detail suffixes, unknown verbs still return `null`.
- `tests/securityDiscovery.test.js` — seven configs, shared device block, `entity_category`,
  exclusion with retraction.
- `tests/securityEventHandler.test.js` — INFO text per verb, `description` present on zone,
  system and panel SSE entries.
- `tests/mqttManager.test.js` — `reconnect` fires only after a prior connect, birth topic
  subscribed, birth payload routing.

New:

- `tests/securityPanelState.test.js` — transitions, dedupe of repeated raises, derived clears on
  disarm and on successful arm, seeding from `status_report_1`.
- `tests/stateResyncCoordinator.test.js` — debounce collapses two triggers into one, `online` vs
  `offline`, reconnect vs first connect, empty net/app list, security status sync included,
  discovery republish only on the reconnect path.

No DOM test harness exists for `public/index.html` (`tests/webServer.test.js` only asserts it is
served), so the render change is covered by the SSE payload assertions plus a manual check
against the running add-on.

## Delivery

Three commits, smallest risk first, per the repo's batch process:

1. Live Events enrichment for security rows (#42).
2. Panel trouble binary_sensors (#42).
3. HA and broker restart state resync (#44).

Then `chore: release v1.21.0` with the CHANGELOG entry, version bumped in both `package.json`
and `homeassistant-addon/config.yaml`, tag `v1.21.0` pushed to trigger HACS distribution, and a
backfilled GitHub Release on the source repo.

`npm test`, `npm run lint` and `npm run typecheck` must pass before each commit.
