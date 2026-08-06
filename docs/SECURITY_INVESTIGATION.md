# C-Bus Security Application (208) — Design & Assessment

Design for supporting the C-Bus **Security** application (app id `208`, `$D0`) as a
first-class feature alongside the native HVAC (172) support, requested in
[GitHub issue #42](https://github.com/dougrathbone/cgateweb/issues/42).

> **Official spec available:** *C-Bus Security Application* (CBUS-APP/05 issue 4.3) —
> [`docs/Security Application.md`](./Security%20Application.md). Sections below cite
> it as "spec §5.x". Wire examples confirmed against live captures posted in #42 by
> @djagerif (status reports and zone events from a Ness/Comfort-style panel on
> network 254).

> **Status:** phase 1 (zone sensors) in progress. Live-panel captures received
> 2026-07-27 (#42) — the event surface in §1 is confirmed; remaining unknowns
> are listed in §7.

---

## 1. Protocol summary (what C-Gate puts on the wire)

Zone labels live under **application 1** in the Toolkit project; zone state events
arrive on **application 208**. One security system per network max (spec §5.10).

### Zone events (spec §5.5.1.11–5.5.1.14)

```
security zone_unsealed //PROJECT/254/208/35    # zone opened ("detected")
security zone_sealed   //PROJECT/254/208/35    # zone closed ("normal")
```

Zone numbers are `$01`–`$7F` (1–127). The spec also defines `zone_open` and
`zone_short` (loop fault states); see "zone states" below — whether real panels
emit them as discrete events is unconfirmed.

### Bulk state sync (spec §5.5.1.20–21, §5.5.2.1–2)

Security panels **do not answer lighting-style MMI/getall requests** (spec §5.9),
so initial sync uses dedicated requests (send both after network sync):

```
security status_request //PROJECT/254/208 1
security status_request //PROJECT/254/208 2
```

Replies (space-separated bytes on the event port, `#`-prefixed):

```
security status_report_1 //PROJECT/254/208 <state> <tamper> <panic> <z1..z32 packed>
security status_report_2 //PROJECT/254/208 <z33..z80 packed>
```

- Report 1 covers zones 1–32, prefixed by system arm state, tamper and panic bytes
  (this is the "first three positions" offset observed in #42).
- Report 2 covers zones 33–80, no prefix. **The spec caps at zone 80**, and the
  only accessible panel is 64-zone, so anything higher is event-driven only
  (see §7).
- Zone states are **2 bits each, 4 zones per byte**: `%00` sealed, `%01` unsealed,
  `%10` open, `%11` short. Absent zones always report sealed.

### System state events (confirmed by live captures, #42)

Captured from a real 64-zone Cytech panel (event port, `#`-prefixed comment lines,
so the handler hooks the **comment path**, same as aircon lines):

```
security arm_ready           //MIDSTRM/254/208
security arm_not_ready       //MIDSTRM/254/208/44      # names the blocking zone
security exit_delay_started  //MIDSTRM/254/208
security system_arm          //MIDSTRM/254/208 <mode>  # see table below
security arm_failed          //MIDSTRM/254/208 arm_failed_raised
security alarm_on            //MIDSTRM/254/208
security alarm_off           //MIDSTRM/254/208
security zone_isolated       //MIDSTRM/254/208/44      # zone bypassed on arming
security fire_alarm          //MIDSTRM/254/208 fire_alarm_raised
```

Arm modes (spec §5.5.1.1, confirmed by capture): `0` disarmed, `1` away, `2` night,
`3` day/stay, `4` vacation. `system_arm 0` is the disarm announcement; the spec's
separate `system_disarmed` verb was not observed. Note the panel uses `system_arm`
(spec calls the event "System Armed / Disarmed"), not `system_armed`.

The `alarm_control_panel` entity (phase 2) builds on these; zone sensors (phase 1)
only need `zone_sealed`/`zone_unsealed` and the status reports.

### Control messages

**Read the C-Gate manual for command syntax, not the application spec.** The
application spec describes what travels on the bus; C-Gate's command interface
has its own syntax, and the two do not match. Two separate bugs came from
conflating them — see the post-mortem below before writing another command.

C-Gate manual §4.5.177:

```
SECURITY ARM app arm-mode
arm-mode = "away" | "night" (home) | "day" | "vacation" | "highest"
```

So `security arm //PROJECT/254/208 day`. The spec's numeric mode values
(`$01`..`$04`, `$FF`) are **not** accepted here; C-Gate answers
`405 Parameter out of range (bad arm mode)`.

Other C-Gate security commands (manual §4.5.176-182), none used yet:
`SECURITY DISPLAY_MESSAGE`, `SECURITY EMULATE_KEYPAD`, `SECURITY RAISE_ALARM`,
`SECURITY REQUEST_ZONE_NAME`, `SECURITY TAMPER [raise|drop]`. There is also a
queryable `ArmState` object parameter, which could seed panel state without a
`status_request`.

**There is no disarm command.** No arm-mode keyword disarms, and the spec
reserves `$00` rather than defining it as disarm. Disarming needs
`SECURITY EMULATE_KEYPAD`, replaying the PIN keypress by keypress — marked
OPTIONAL in the spec, so a given panel need not implement it. Tracked in #51.

#### Post-mortem: two bugs, one root cause

Both shipped, both found by the reporter on #42 rather than by us, and both came
from reading the application spec where the C-Gate manual was the authority:

1. **1.23.0's disarm** sent `security arm ... 0`. An earlier revision of this
   section claimed "disarm is arm code `$00` via the matching command", which
   borrowed the `$00 = disarmed` encoding from the §5.5.1.1 System
   Armed/Disarmed *broadcast* — a different message travelling the other
   direction. Inert on a live panel; removed in 1.23.1.
2. **1.23.0/1.23.1's arming** sent the spec's numeric modes. Every arm was
   rejected with `405`, so the feature never worked at all. Fixed in 1.23.2 by
   sending C-Gate's keywords.

The numbers were never wrong *for the bus*; they were never right for the
interface we actually write to. When adding a security command, quote the
C-Gate manual section in the code comment, as `securityCommand.js` now does.

## 2. What happens today (pre-change behaviour)

Verified against current master:

- `security zone_sealed //…/208/35` **parses as a generic event** and publishes a
  misleading `OFF` to `cbus/read/254/208/35/state` for *both* sealed and unsealed
  (`actionIsOn` knows neither verb).
- `security status_report_1 …` **fails parsing entirely** → "Could not parse C-Bus
  event" warning spam.
- No discovery, no sync, no config — zero security handling exists in `src/`.

## 3. Architecture: the native-HVAC template

The native aircon feature is the exact template — security lines have the same
shape (`<app> <verb> //…` with no group-style payload CBusEvent can parse). Every
seam has a 1:1 counterpart:

| Piece | HVAC (existing) | Security (proposed) |
|---|---|---|
| Line decoder | `src/applicationDecoders/airconDecoder.js` (standalone) | `src/applicationDecoders/securityDecoder.js` — `zone_sealed/unsealed`, `status_report_1/2`, `system_armed/disarmed`, `alarm_on/off` |
| Event handler | `src/airconEventHandler.js` (`isAirconLine`/`handleLine`) | `src/securityEventHandler.js`, gated on `settings.cbus_security_app_id` |
| Hook point | `cgateWebBridge._processEventLine` first check (`src/cgateWebBridge.js:573`) | Insert `_handleSecurityLine` first (before the generic parser so zone events stop publishing bogus OFF and reports stop warn-spamming) |
| Publish | `eventPublisher.publishReading` (`src/eventPublisher.js:104`) | Same: zone → `cbus/read/{net}/208/{zone}/state` `ON` (unsealed/open) / `OFF` (sealed), retained |
| Discovery | `haDiscovery.ensureNativeAirconDiscovery` (event-driven) | `ensureSecurityZoneDiscovery` + a label-driven branch in tree discovery (§4) |
| Initial sync | `AIRCON REFRESH` per ward on first sight | `SECURITY STATUS_REQUEST 1/2` after `762` sync-ok (`bridgeInitializationService.handleAllConnected` / `haDiscovery.handleNetworkSyncComplete`) and on first security traffic (mirror `_maybeRefreshWard`) |
| Config | `cbus_aircon_app_id` | `cbus_security_app_id` (default `208`; `0`/empty disables) through config.yaml → addonOptionMap → defaultSettings → settingsValidator, plus translations |
| Write path | `mqttCommandRouter` native-aircon handlers | Phase 2 only (arm/disarm) |

## 4. Discovery: zones as `binary_sensor`

Two complementary seams (mirroring how lighting combines tree + label discovery):

1. **Label-driven (primary):** Toolkit zone labels live under app 1, and the label
   importer already stores them app-agnostically as `net/1/<zone>` keys
   (`src/cbusProjectParser.js` — no change needed). Add a security branch to
   `_runDiscoveryFromTree` (or extend `_supplementFromLabels`, currently
   lighting-only at `src/haDiscovery.js:453`) that enumerates `{net}/1/*` labels
   and publishes one `binary_sensor` per zone, keyed `net/208/<zone>`. Zones get
   announced at startup even before the first zone event — important because zone
   events can be rare.
2. **Event-driven (fallback):** `ensureSecurityZoneDiscovery(network, appId, zone)`
   on first zone event/status report for an unlabelled zone, following the
   `ensureTemperatureDiscovery` contract (idempotent Seen set, `exclude` honored,
   topics registered in `_eventDrivenDiscoveryTopics` so tree-run stale cleanup
   skips them).

**Device-class inference** (requested in #42): new mapping in
`src/deviceTypeClassifier.js` (home of the existing cover-keyword classifier):
`PIR|motion` → `motion`, `garage` → `garage_door`, `door` → `door`,
`window` → `window`; default `device_class: door`-less generic binary_sensor when
nothing matches. Keyword list overridable via a
`ha_discovery_security_device_class_keywords`-style setting, mirroring
`ha_discovery_auto_type_cover_keywords`. Smoke detectors (`smoke` → `smoke`) and
`tamper` are cheap additions to the same map.

**2-bit zone states:** HA `binary_sensor` is on/off. Map `%01 unsealed` and
`%10 open` → `ON`, `%00 sealed` → `OFF`, and publish `%11 short` as `ON` with the
raw state in a JSON attributes topic (same pattern as djagerif's Comfort example:
`state_topic` + `json_attributes_topic`), so automations can distinguish faults.

## 5. Phasing & effort assessment

### Phase 1 — Zone sensors (the "Part A" from #42)

| Work item | Effort |
|---|---|
| `securityDecoder` (zone events + status_report_1/2 bit unpacking + arm/tamper/panic prefix) | M — bit packing is the only real logic; well specified |
| `securityEventHandler` + `_processEventLine` hook + stop bogus OFF/warn spam | S |
| `ensureSecurityZoneDiscovery` + label-driven app-1 branch + cross-app label lookup | M |
| Device-class inference + setting | S |
| Initial sync: `status_request 1|2` on connect + after 762 sync-ok | S |
| `cbus_security_app_id` end-to-end config (+ schema, translations, DOCS.md) | S |
| Tests: `securityDecoder.test.js`, `securityEventHandler.test.js`, `securityDiscovery.test.js` (template: `temperatureDiscovery.test.js`), cbusEvent no-bogus-OFF regression | M |

Phase 1 is self-contained, read-only on the bus, and delivers all the value
djagerif asked for first. No new dependencies; every mechanism already exists.

### Phase 2 — Alarm control ("Part B", later)

`alarm_control_panel` MQTT entity (arm away/home/night/vacation, disarm),
built on the Phase 1 decoder's `system_arm`/`alarm_on`/`alarm_off` events and
the §5.5.2 control messages sent via the command port. Needs a control-enabled
flag like `cbus_aircon_control_enabled` (`security arm` is a write — same
careful opt-in posture as aircon writes). Disarm-under-duress semantics
(spec §5.12) still need real-panel captures before we touch them. Sized M–L,
mostly because of capture-driven validation, not code volume.

## 6. Reporter captures — received

djagerif delivered DEBUG-level captures (#42, 2026-07-27) covering arm away /
day-stay / vacation (local and remote), exit-delay expiry (`arm_failed`), zone
bypass on arming (`zone_isolated`), fire alarm, and final-exit-door arming.
Every verb in §1's table comes from those lines. Two practical notes:

- The raw-capture setting (`cbusRawEventLogApps`, `src/defaultSettings.js:200`)
  is **not exposed in the add-on config** — DEBUG level already logs the full
  line text via "Ignoring comment from event port", which proved sufficient.
- His Toolkit project uses default `Group1`, `Group2` zone names, so
  device-class inference gets no keywords from his install — the generic
  default matters as much as the mapping.
- His panel is 64-zone (Cytech now owns the C-Bus interface), so zones 81–96
  are untestable for the foreseeable future (see §7).

## 7. Open questions

- **Zones 81–96:** spec §5.5.1.21 fixes report 2 at zones 33–80, and no
  accessible panel reports higher. Settled until Cytech ships something newer:
  sync zones 1–80 via reports, and let event-driven discovery pick up any
  higher zone that emits an event.
- Do real panels emit `zone_open`/`zone_short` as discrete events, or only via
  the 2-bit report fields? Decoder accepts both regardless.
- ~~C-Gate's exact rendering of `system_armed`/`alarm_on` lines~~ — resolved by
  capture: the verb is `system_arm <mode>`, and alarm-style verbs may carry a
  free-text argument (`arm_failed_raised`, `fire_alarm_raised`).
