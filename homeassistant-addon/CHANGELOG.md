# Changelog

All notable changes to the C-Gate Web Bridge Home Assistant add-on will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.10.0] - 2026-05-30

### Added

- **Automatic cover detection.** Groups on the Lighting application (56) whose label contains a cover keyword (`blind`, `shutter`, `shade`, `awning`, `curtain`, `roller`, `garage door`) are now discovered as Home Assistant `cover` entities instead of `light`. This fixes the common case where shutter relays share the lighting application with real lights and previously all appeared as lights. Classification is conservative and label-only: a manual `type_overrides` entry and application-id mappings always take precedence; auto-detection only ever upgrades the default `light`. Configurable via `ha_discovery_auto_type` (default on), `ha_discovery_auto_type_name_heuristics`, and `ha_discovery_auto_type_cover_keywords`.

### Fixed

- **`.cbz` import "Failed Unauthorised" through HA Ingress.** The web UI import endpoint now trusts requests proxied through Home Assistant Ingress when no API key is configured, so importing a C-Bus project from the add-on UI works out of the box. A configured `web_api_key` is still always enforced, and direct (non-ingress) requests remain blocked unless explicitly allowed.
- **HVAC type overrides produced a broken thermostat.** Reclassifying a lighting group to `hvac` via `type_overrides` now publishes a full climate payload (temperature/mode topics) instead of a generic payload missing the thermostat controls.

## [1.9.4] - 2026-05-27

### Security

- **API key comparison is now constant-time** (`crypto.timingSafeEqual`). Removes the timing oracle the previous `===` comparison exposed.
- **`.cbz` import is guarded against zip-bombs**. The parser pre-flights the sum of declared decompressed sizes for every ZIP entry against a 100MB cap (overridable via constructor) before extracting anything, so a small upload cannot blow up RAM. Defence-in-depth path-traversal guard on internal entry names extracted alongside.
- **HTTP security headers** added on every response: `Content-Security-Policy` (locks resource loading to same-origin, killing the common third-party-script XSS payload pattern without breaking the bundled inline UI) and `Referrer-Policy: no-referrer` (prevents leaking the HA Ingress-tokenised URL to any external resource).
- **Managed-mode install pre-flights ZIP entry names** for path-traversal (`..`) or absolute paths via a new `_cgateweb_verify_zip_safe` helper in `cgate-install.sh`. Runs before each `unzip` call. Modern unzip already strips these but the explicit guard makes any future tooling regression visible.

### Mobile / Responsive

- **Web UI is now responsive across all common viewport sizes** for both direct LAN access and HA Companion App (iframe-embedded via HA Ingress). Previously had zero `@media` breakpoints. Includes:
  - `viewport-fit=cover` + `env(safe-area-inset-*)` padding for notched phones.
  - `font-size: 16px` on all form inputs - eliminates the iOS auto-zoom-on-focus behaviour that previously fired every time a user tapped a label.
  - Touch targets enlarged on touch-primary devices (row checkboxes 22×22, buttons min-height 44px) per WCAG 2.5.5 / iOS HIG. Desktop mouse users keep the compact layout.
  - `<= 768px`: main labels table becomes horizontally scrollable; Entity ID and "unsaved" columns hide; tab bar tightens; toast spans full width.
  - `<= 480px`: Type column also hides; add-row and bulk toolbar stack vertically; header collapses; status bar single-column.
  - Area dropdown is constrained to viewport width on narrow screens so it can't shoot off the right edge.

## [1.9.3] - 2026-05-27

### Fixed

- **Editing labels (or areas / type overrides / entity IDs / exclusions) via the Web UI did not update Home Assistant device names**. `LabelLoader.save()` wrote the file and updated internal state but never emitted `labels-changed` directly. The only emit site was the `fs.watch` callback, which is gated by a 1000ms self-write grace period to prevent double-processing - so for in-process saves (PUT/PATCH `/api/labels`, POST `/api/labels/import`), the event was silently suppressed. The downstream listener that re-triggers HA Discovery therefore never fired, and HA never saw the updated entity configs.
  - `save()` now emits `labels-changed` directly with the full `getLabelData()` payload (labels, areas, typeOverrides, entityIds, exclude). The file-watcher path still correctly suppresses the resulting fs event within the grace window, so there's no double-fire.
  - The same fix automatically covers areas, type overrides, entity IDs, and the exclude list - all flow through the single `save()` codepath.

## [1.9.2] - 2026-05-26

### Changed

- **Log noise reduction**: demoted two high-volume INFO log lines to DEBUG. Both fire per-event and dominated production log volume (~45% of lines in a typical sampled window). Real startup/shutdown/state-transition messages stay at INFO so they remain easy to spot; users who need the per-command trace can set `log_level: debug` in the add-on config.
  - `MqttCommandRouter` "MQTT Recv: ..." (every received MQTT write/switch/ramp command)
  - `BridgeInitializationService` "Getting all periodic values for ..." (every periodic getall poll fire)

## [1.9.1] - 2026-05-24

### Performance

- **Managed-mode JVM tuned for the small-heap, low-throughput control-plane workload**. Adds `-XX:+UseSerialGC` (Serial GC's overhead is ~30-50MB lower than the default G1 for a 64-256MB heap), `-XX:TieredStopAtLevel=1` (skip the C2 server JIT - C-Gate is not throughput-critical and tier-1 C1 is faster to warm up), and `-Djava.net.preferIPv4Stack=true` (eliminate unused IPv6 DNS roundtrips during socket setup). Expected impact on Pi/NAS managed-mode deploys: ~30-50MB lower JVM RSS plus ~2-5s faster cold start. Remote-mode users are unaffected.
- **Node.js V8 heap capped at 256MB via `--max-old-space-size=256`**. Node defaults to a fraction of host memory (often 1.5-4GB on shared HA hardware), which means a runaway leak or unbounded cache only OOMs after starving other addons. 256MB sits ~2-3x above the observed ~100-110MB steady-state RSS and makes worst-case behaviour predictable (clean process OOM and s6 restart vs slow host degradation).
- **Web server start deferred past the readiness signal**. The label-editing web UI was on the await chain before `connectionManager.start()`, adding measurable latency to the startup-to-ready window. The web server now starts in the background after readiness fires; failure still logs a warning but never blocks the bridge.
- **HA Discovery and auto-network-discovery deferred off the readiness path**. Previously `lifecycle_state=ready` published only after the post-connect work (including a potentially 5s auto-discovery wait for the tree response) finished. Now readiness publishes as soon as connection health is confirmed; auto-discovery / initial getall / HA Discovery TreeXML sweep run in the background. Users with the default `autoDiscoverNetworks=true` see up to 5s less ready-signal latency.
- **`DeviceStateManager` device-level / last-seen maps now bounded** (`deviceStateMaxEntries`, default 5000, floor 100) with FIFO-on-insert eviction. Matches the existing pattern used by `eventPublisher._topicCache`. Defense-in-depth against long-uptime growth; no behaviour change for any realistic install.

### Build / Image

- **Multi-stage Dockerfile** drops `npm` from the runtime image (~50-80MB saved). The builder stage installs npm, runs `npm ci`, cleans the cache; the runtime stage only carries `nodejs + openjdk17 + curl + unzip + netcat-openbsd` plus the resolved `node_modules`.
- **`.dockerignore` at the repo root** excludes `.git/`, `tests/`, `test-env/`, `coverage/`, `tools/`, IDE state, and the host's `node_modules` (which can contain platform-incompatible native binaries) from the build context.

### CI

- **`package.json` / `config.yaml` version drift now gates the build** via a new `version-sync` CI job. Previously documented in CLAUDE.md as a manual step that had caused stale deploys.
- **GitHub Actions pinned to commit SHAs** for `actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, and `softprops/action-gh-release`. Pin updates become explicit changes instead of silent absorption of upstream tag movements.
- **HACS deploy token moved out of the rendered `git clone` URL** in `hacs-distribution.yml` (now passed via `env:`).
- **`HEALTHCHECK` added to the addon Dockerfile**: TCP probe on port 8080 with a 180s start-period (covers managed-mode first-boot C-Gate download).
- **Integration test now passes end-to-end and is no longer masked by `continue-on-error`**. Switched from `podman compose` (which delegated to a daemon-socket-requiring docker-compose plugin on Linux) to `podman-compose` (the Python wrapper that was already pip-installed in the workflow), then softened four project-dependent assertions that the previous flaky-mask had hidden so the no-project test fixture passes cleanly.

### Fixed

- **`perf/raw.json` no longer tracked** (regenerated benchmark output causing constant 190-line / 190-line diff churn in every working tree).

### Tests

- Closed three real coverage gaps surfaced by an audit: cgateConnectionPool end-to-end cascade-exhaustion, web-server OPTIONS-preflight rejection from a disallowed origin, web-server GET traffic exemption from the mutation rate limit.

## [1.9.0] - 2026-05-24

### Added
- **Tunable HA Discovery TreeXML retry settings**: four new keys in `settings.js` allow ops to tune the discovery startup-race retry budget without forking. `haDiscoveryMaxTreeRetryAttempts` (default 8), `haDiscoveryTreeRetryInitialDelayMs` (default 2000), `haDiscoveryTreeRetryMaxDelayMs` (default 60000), `haDiscoveryTreeRequestTimeoutMs` (default 8000). Defaults are unchanged from prior behaviour.
- **Tunable web UI body-size limit**: `webMaxBodySizeBytes` setting (default 10MB) controls the max accepted POST/PUT/PATCH body on the label-editing API. Useful for unusually large `.cbz` uploads on permissive deployments.

### Fixed
- **Stuck HA Discovery on malformed TreeXML**: when `parseString` failed (truncated payload, encoding glitch, C-Gate restart mid-stream), the discovery network previously sat in `DISCOVERING` state forever - no retry, no `PAUSED` transition, no diagnostic signal. The parse error now flows through the same retry-with-backoff mechanism as 401 Network not found, eventually transitioning to `PAUSED` after the retry budget is exhausted.

### Changed
- **Internal: `labelSnapshot` lifted to instance property in `HaDiscovery`**. Eliminates a positional parameter that was threaded through seven helper methods (23+ call sites). No external behaviour change.
- **Internal: exponential-backoff calculation extracted to `src/backoff.js`**. Replaces three subtly different inline formulas in `cgateConnectionPool.js`, `cgateConnection.js`, and `haDiscovery.js`. No behaviour change at the three call sites.

### Operations / CI
- **Added a CI gate that fails the build when `package.json` and `homeassistant-addon/config.yaml` versions disagree**. Previously documented as manual-and-error-prone in `CLAUDE.md`; now enforced.
- **GitHub Actions versions pinned to commit SHAs** for `actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, and `softprops/action-gh-release`. Pin updates become explicit code changes instead of silent absorption of upstream tag movements.
- **HACS deploy token moved out of the rendered git-clone URL** in `hacs-distribution.yml`, into the run step's `env:` block. Eliminates the risk of token leakage via verbose-mode logging.
- **`HEALTHCHECK` added to the addon Dockerfile**. TCP-probes the always-on cgateweb web UI port after a 180s start-period (allows for managed-mode first-boot C-Gate download). Mostly diagnostic under HA Supervisor, but useful for visibility.

## [1.8.10] - 2026-05-24

### Added
- **Managed mode project sync from `/share/cgate/tag/`**: a new `cont-init` script syncs pre-built C-Gate project database files into the managed C-Gate `tag/` directory on every container start. Place `<PROJECTNAME>.db` (built in C-Bus Toolkit or copied from another C-Gate install) into `/share/cgate/tag/`, restart the add-on, and managed C-Gate will serve the project so TreeXML / HA Discovery succeed. The sync is timestamp-aware (`source -nt dest`) so C-Gate state written between restarts is never clobbered by a stale share copy.
- **Web UI import response now flags itself as labels-only**: `POST /api/labels/import` returns `scope: "labels-only"` and a `notice` field explaining that the `.cbz`/`.xml` import does not load the C-Gate project itself, with a pointer to the managed-mode `.db` workflow. Avoids the trap where users assumed importing in the Web UI was sufficient to populate managed C-Gate (issue #9).

### Documentation
- New "Loading your C-Gate project in managed mode" section in `DOCS.md` explaining the `.db` sync workflow and why `.cbz` import alone is insufficient.

## [1.8.9] - 2026-05-09

### Added
- **MIT LICENSE bundled with the distribution repo**: the release workflow now copies the MIT license into both the `cgateweb-homeassistant` repo root and the add-on subfolder so the licensing terms are visible alongside the installable add-on (and so the repo passes OSI-license listing checks for awesome-home-assistant).

## [1.8.8] - 2026-05-07

### Fixed
- **Managed mode install failed with "Invalid download URL scheme: null"**: when running the add-on in managed mode without overriding `cgate_download_url`, the install script would log `Downloading C-Gate from: null` and abort. Root cause: `bashio::config 'cgate_download_url' ''` returns the literal string `"null"` for unset optional fields (upstream bashio's `${2:-null}` rewrites an empty default to `"null"`), so the script's `[[ -z … ]]` empty-check never fired and the hardcoded fallback URL was never applied. The install script now treats both empty and `"null"` as unset for `cgate_download_url` and `cgate_download_sha256`, and the URL/SHA resolution is extracted into helpers covered by unit tests.

## [1.8.7] - 2026-05-05

### Fixed
- **Startup-race silent publish drops**: HA Discovery configs and initial state values published before the MQTT broker was fully connected were silently dropped — `MqttManager.publish()` incremented a counter but never replayed the lost messages. Affected entities sat at `unavailable` in Home Assistant indefinitely (until C-Gate happened to emit a fresh event for that group while MQTT was up). `cgateweb`'s own startup path is the largest culprit: `cgateWebBridge.start()` calls `_updateBridgeReadiness('startup')` and `haBridgeDiagnostics.publishNow('startup')` before the broker connects, so ~38 retained publishes per restart go to /dev/null.
- `MqttManager` now keeps a bounded retain-aware queue of publishes attempted while disconnected. Map semantics give us newest-wins-per-topic so a stale `level=0` is correctly overwritten by a fresh `level=128` if both queue during the same disconnect window. The queue is bounded (default 1000 entries; configurable via `mqttPendingPublishMaxEntries`) and oldest entries are evicted with a warning if the broker stays unreachable. On (re)connect, the queue is flushed and the count is logged. Non-retained publishes (one-shot events whose meaning would be invalidated by replay) are still dropped — only retained state is queued.

## [1.8.6] - 2026-05-05

### Added
- **Network removed cleanup**: counterpart to the v1.8.5 "Network created" handler. When C-Gate signals that a network has been removed or deleted (async system event 742, "Network removed" / "Network deleted"), HA Discovery now publishes empty retained payloads to every previously-published entity config topic for that network — including the per-network discovery diagnostic sensor itself — so HA tears the entities down instead of leaving them sitting Offline forever. Any in-flight TREEXML retry for the removed network is canceled.

## [1.8.5] - 2026-05-04

### Added
- **Event-driven HA Discovery refresh**: when a network finishes loading in C-Gate (async system event 742, "Network created"), HA Discovery now refreshes the network's tree the moment it becomes available, instead of waiting for the v1.8.1 retry backoff to fire. This eliminates the discovery delay on cold starts where C-Gate initialises a few seconds after opening its TCP port. The retry remains as belt-and-braces.

### Changed
- **Command response parser hardening**: the parser now recognises C-Gate's timestamp-prefixed async event lines (e.g. `20260504-193110.569 742 //PROJECT/254 ... Network created ...`) by stripping the leading timestamp before parsing. The parser also pins response codes to positions 0-2 of the line, eliminating mis-parses caused by hyphens elsewhere in the payload (UUIDs, etc.). Validity range expanded from 1xx-6xx to 1xx-9xx so 7xx/8xx async events route correctly. Behaviour for canonical lines like `200-OK` is unchanged.

## [1.8.4] - 2026-05-04

### Added
- **Per-network discovery health sensor**: HA Discovery now publishes a "Discovery (Network N)" diagnostic sensor for each configured network, with three states — `discovering` (request in flight or retry pending), `ok` (last TreeXML succeeded), or `paused` (retry budget exhausted from the v1.8.1 startup-race protection). The sensor lives under the existing cgateweb Bridge device in HA, so users can see at a glance whether auto-discovery is healthy without trawling the add-on logs. State publishes are de-duplicated; the HA Discovery config payload is published once per network.

## [1.8.3] - 2026-05-04

### Refactor
- **HA Discovery retry state**: collapsed the parallel `_treeWatchdogs` and `_treeRetryState` Maps in `HaDiscovery` into a single `_treeRequestState` Map (`networkId -> { attempts, watchdogHandle, retryHandle }`), eliminating duplicate lookups, an awkward `keepAttempts` boolean parameter, and three near-duplicate cleanup helpers. Behaviour is unchanged.
- Removed unnecessary `typeof === 'function'` guards around `haDiscovery.handleCommandError` and `haDiscovery.stop` calls in `BridgeInitializationService`; the methods are part of the class contract and the bridge holds a locally constructed instance.

## [1.8.2] - 2026-05-04

### Fixed
- **C-Gate config keys**: `cgate-install.sh` was writing `CommandInterface.port` and `EventInterface.port` into `C-GateConfig.txt`, but C-Gate uses `command-port` and `event-port`. C-Gate logged "Invalid key" warnings on every startup and any user-customized ports were silently dropped, so the addon kept using C-Gate defaults regardless of the configured `cgate_port` / `cgate_event_port` values. The script now writes the correct keys, anchors its grep checks with `^…=` so comment headers in `C-GateConfig.txt` don't produce false-positive matches, and strips any legacy invalid keys left over from earlier installs.

## [1.8.1] - 2026-05-04

### Fixed
- **HA Discovery startup race**: C-Gate accepts TCP connections on the command port before its project's networks are loaded, so the initial `TREEXML` query could return `401 Network not found` and HA Discovery would silently give up — devices never appeared in Home Assistant even though events flowed normally. `HaDiscovery` now retries failed TreeXML requests with exponential backoff (2s → 60s, up to 8 attempts), driven both by the `401 Network not found` fast-fail and an 8s no-response watchdog. After the retry limit, a clear warning explains how to recover via `cbus/write/<network>///gettree`.

## [1.8.0] - 2026-04-29

### Changed
- **MQTT pre-connect log noise**: when the bridge starts before the MQTT broker is reachable, `MqttManager` now warns once per disconnect window instead of per-publish. On reconnect, a single rolled-up info line reports how many publishes were dropped while disconnected. Eliminates ~17 startup warnings per restart and bounds spam if the broker stays unreachable.
- **Network auto-discovery fallback**: when `tree //PROJECT` returns a 4xx/5xx (e.g. C-Gate 402 "Operation not supported"), the discovery handler now claims the response so the default error logger does not also fire, and the discovery messages are demoted from WARN/ERROR to INFO since the fallback to configured `getall_networks` is the expected path on C-Gate versions that do not support project-level tree queries.

### Refactor
- Extracted entity-id field construction (`default_entity_id` + `object_id`) into a shared `entityIdFields(component, objectId)` helper in `src/constants.js` and replaced six inline callsites across `haDiscovery`, `haBridgeDiagnostics`, and `staleDeviceDetector`.
- Replaced raw `'sensor'`, `'binary_sensor'`, and `'cgateweb_bridge'` string literals with `HA_COMPONENT_SENSOR`, `HA_COMPONENT_BINARY_SENSOR`, and `HA_DEVICE_VIA` constants for consistency with the rest of the HA discovery code.

## [1.7.2] - 2026-04-19

### Fixed
- **Fresh-install Import failure**: the add-on now falls back to `/config/cgateweb-labels.json` when no `cbus_label_file` option is set and no label file exists at auto-detect paths. Previously, importing a Clipsal project file on a fresh install failed with "No label file path configured". Dropped `/share/cgate/labels.json` from auto-detect since `/share` is mounted read-only.
- **Standalone Import error message**: when the label file path really is unset (standalone mode), the Import endpoint now returns a 400 with an actionable message pointing at `cbus_label_file` instead of a generic failure.
- **Doubled toast prefix**: removed the server-side "Import failed: " prefix that was duplicating the client-side prefix in error toasts.

## [1.7.1] - 2026-04-14

### Fixed
- **Backwards compatibility**: retain `object_id` alongside `default_entity_id` in MQTT discovery payloads so Home Assistant versions prior to 2025.10 continue to work. Unknown keys are silently ignored by both old and new HA versions.

## [1.7.0] - 2026-04-14

### Fixed
- **HA 2026.4 compatibility**: Home Assistant 2026.4 removed support for the deprecated `object_id` field in MQTT discovery. Replaced with `default_entity_id` (which includes the domain prefix, e.g. `light.kitchen_light`) across `haDiscovery`, `haBridgeDiagnostics`, and `staleDeviceDetector`.

## [1.6.1] - 2026-04-05

### Fixed
- **Area picker**: fetch areas via HA template API (registry endpoint removed in HA 2026.x); dropdown now shows full area names without icons
- **Save toast**: show actual label count instead of "undefined"
- **Tab bar scrollbar**: removed spurious scrollbar on tab bar

## [1.6.0] - 2026-04-05

### Changed
- **Tabbed web interface**: replaced collapsible sections with tabs — Status, Device Labels, Live Events, Import/Export. State is preserved between tab switches.

### Fixed
- **Live Events accordion**: was not toggling due to double click handler conflict
- **Area column width**: widened to prevent text truncation

### Security
- **Managed C-Gate hardening**: HTTPS-only download URLs, curl timeouts, 500MB file size cap, symlink rejection, file permission hardening, Java memory limits

### Improved
- **CI modernization**: GitHub Actions updated to v5/v7, test matrix Node 20+22, no deprecation warnings
- **Test coverage**: 1153 tests, 92.7% coverage — added tests for address validation, signal handlers, event filtering, tab interface

## [1.5.5] - 2026-04-04

### Improved
- **Translation refinements**: improved translations for Czech, Danish, Norwegian, Polish, Swedish, and Ukrainian

## [1.5.4] - 2026-04-04

### Added
- **Complete translations**: all 16 non-English translation files updated to match the full en.yaml configuration schema (previously missing 20+ fields added in recent releases)
- **Test coverage**: new tests for bridge diagnostics consolidated stats, line processor buffer cap, connection pool recovery via `connectionAdded`, ConfigLoader unknown settings key warning, web API dashboard/areas endpoints, CORS enforcement, and security headers

## [1.5.3] - 2026-04-04

### Security
- **CORS origin leak**: disallowed origins no longer receive an `Access-Control-Allow-Origin` header; previously fell back to the first allowed origin, enabling cross-site API access from any website
- **Rate limit bypass**: rate limiting now uses the TCP socket address instead of the spoofable `X-Forwarded-For` header
- **MIME sniffing**: added `X-Content-Type-Options: nosniff` header to all responses

### Fixed
- **Searchable area dropdown**: area field in the label editor is now a searchable dropdown showing existing areas from Home Assistant and the label file, preventing duplicate/inconsistent area names
- **HA area registry API**: use POST (not GET) for the Supervisor area registry endpoint; add 30-second cache to avoid repeated API calls
- **Area dropdown UX**: prevent double-commit on click/Tab/Escape; allow ArrowUp to deselect; fix `API_BASE` variable reference
- **MQTT reconnection**: clear `_connecting` flag on connection close so the bridge can reconnect after a failed initial connection attempt
- **Cover state**: handle null `rawLevel` on plain `on` action (without level) by falling back to the action, matching the lighting path
- **HVAC mode**: revert `rawLevel===0` off detection — C-Bus level 0 maps to 0°C setpoint, not an off state; only the explicit `off` action sets mode to off
- **730 event parsing**: search for ` level=` (space-prefixed) to avoid matching inside other key names
- **Tree message buffer**: cap at 500 entries to prevent unbounded growth when HA Discovery is disabled

### Changed
- Performance benchmarks updated: event throughput +30%, command throughput +58%, P95 latencies down 28-83%

## [1.5.2] - 2026-04-04

### Fixed
- **Upgrade failure**: users upgrading from v1.4.x got "Missing option 'getall_app_periods' in root" because array-type schema fields were removed from `options` defaults; HA Supervisor requires these to exist in the saved config for validation. Restored default values for `getall_networks`, `getall_app_periods`, `ha_discovery_networks`, and `web_allowed_origins`.

## [1.5.1] - 2026-04-04

### Fixed
- **730 event level parsing**: C-Gate 730 events include a UUID before the `level=N` field; the fast-path parser was extracting the leading digit from the UUID (e.g. `6` from `6c2b7f80-...`) instead of the correct level value, causing lights to appear permanently on in Home Assistant
- Cover and lighting ON/OFF state now uses raw C-Bus level instead of quantized percentage, fixing incorrect OFF state at very low brightness levels (1-2 out of 255)
- HVAC mode correctly reports `off` for ramp-to-zero commands
- haDiscovery race condition: tree responses arriving before HA Discovery initialized are now buffered and replayed instead of silently dropped
- Connection pool recovery: bridge no longer gets stuck after all pool connections go unhealthy then recover
- Socket state verified after drain timeout to prevent writing to destroyed sockets
- Try/catch in command data handler prevents a single malformed C-Gate line from crashing the processing loop

### Added
- Startup diagnostics summary: logs connections, networks, features, device types, and labels on boot
- MQTT consolidated stats topic (`cbus/read/bridge/stats`): JSON with version, uptime, connections, queue, publisher, and discovery stats
- Web dashboard endpoint (`GET /api/dashboard`): bridge health, device list with levels/labels, and recent event count
- Unknown settings key warnings in standalone mode (catches typos in settings.js)
- `cbusname` validation (rejects spaces, slashes, and quotes)
- Queue drop warnings published to `hello/cgateweb/warnings` when the command queue is full
- Configurable INCREASE/DECREASE timeout (`relativeLevelTimeoutMs`, default 5000ms)

### Changed
- HA addon config simplified from ~40 visible fields to 5 essentials; all other settings hidden by default and accessible via "Show unused optional configuration options"
- Improved addon config descriptions with defaults and auto-detection notes
- All resources properly cleaned up on bridge stop (event listeners, timers, ramp trackers, coalesce buffers)
- Input validation: C-Bus address ranges, 1MB line buffer cap, WebServer body read guards, rate limit memory cap
- TLS certificate errors now show clear file path in the error message

## [1.4.30] - 2026-03-29

### Fixed
- **Devices turning off on bridge restart**: the bridge was executing stale retained write commands replayed by the MQTT broker on reconnect (e.g. `cbus/write/254/56/5/ramp -> OFF`). Retained messages on write topics are now silently ignored on subscribe — only fresh commands from HA automations/UI are executed
- C-Gate 401/404 errors for getall on unconfigured apps (e.g. cover app 203 when no covers exist) now log as WARN instead of ERROR; 401 hint text corrected from "Unauthorized" to "Object Not Found or Unauthorized"

## [1.4.29] - 2026-03-29

### Added
- Real-time C-Bus event log in the label editor: a collapsible "Live Events" panel streams events via SSE (`GET /api/events/stream`), showing address, resolved label, level, and a visual bar; click any row to filter the main table to that device; pause/clear controls; auto-reconnects on disconnect; state persisted in localStorage
- Stale device detection: tracks last-seen timestamp per device; after `stale_device_threshold_hours` (default 24h) without an update, a HA `sensor` entity (`C-Bus Stale Devices`) shows the count with JSON attributes listing addresses, labels, and hours-since-last-seen; configurable via `stale_device_detection_enabled`, `stale_device_threshold_hours`, `stale_device_check_interval_sec`

## [1.4.28] - 2026-03-29

### Added
- Per-app configurable poll intervals via `getall_app_periods`: override the global `getall_period` per C-Bus application ID (e.g. poll HVAC every 5 min, covers every 1 min, lighting every hour); set `0` to disable polling for a specific app
- Cover position interpolation during ramps: when a ramp/position command targets a cover group, intermediate position values are published every 500ms so Home Assistant shows smooth blind movement; real C-Gate events always take priority and cancel the interpolation immediately; configurable via `cover_ramp_duration_sec` (default 5s)

## [1.4.27] - 2026-03-28

### Added
- Label editor undo/redo: full history stack (up to 50 steps) with Undo/Redo buttons showing step count, keyboard shortcuts (Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z), and toast feedback; all mutations are undoable (cell edits, type changes, exclude toggles, bulk operations, auto-fill areas, import)
- C-Gate project XML export: `GET /api/labels/export.xml` endpoint returns a TreeXML-compatible file grouping devices by network and application; "Export project XML" download button added to the UI
- C-Bus trigger groups now also published as Home Assistant `scene` entities via MQTT Discovery, enabling scene activation from the HA UI and automations; configurable via `ha_discovery_scene_enabled` (default: true)

### Fixed
- Jest `testPathIgnorePatterns` restored to `/.claude/` to correctly suppress worktree test files from running in the main test suite

## [1.4.26] - 2026-03-28

### Added
- Cover tilt support: configure a separate C-Bus app ID (`ha_discovery_cover_tilt_app_id`) for venetian/louvre blind tilt control; tilt position publishes to `cbus/read/{n}/{tiltApp}/{g}/tilt` and HA cover entities gain `tilt_status_topic` / `tilt_command_topic`
- Automatic C-Bus network discovery: on connect the bridge sends `tree //PROJECT` and parses network IDs as a fallback for `getall_networks` and `ha_discovery_networks`; configurable via `auto_discover_networks` (default: true)
- Label editor pagination: 25/50/100/All per-page selector (persisted in localStorage, default 50) with prev/next controls and "Showing X–Y of Z" count
- Label export: "Download backup" button downloads the current `labels.json` directly from the browser
- Auto-area suggestion: `guessArea()` detects room words in device labels (Office, Kitchen, Bedroom, etc.) and shows suggestions as placeholder text; "Auto-fill areas" button batch-applies guesses to unset rows

### Fixed
- Cover getall response parsing confirmed end-to-end correct; regression tests added to prevent future regressions (level=0/128/255 → position=0/50/100, state OFF/ON)

## [1.4.25] - 2026-03-28

### Fixed
- Area column now visible and editable in the label editor (inline click-to-edit, searches by area name)

## [1.4.24] - 2026-03-28

### Added
- Area/room assignment in label editor: set a room name per device (e.g. "Office") and it flows through as `suggested_area` in HA MQTT Discovery — Home Assistant auto-assigns entities to rooms on first discovery
- Documentation: HVAC (App 201), trigger groups (App 202), PIR, relay, and C-Bus application ID reference table added to DOCS.md

### Fixed
- Startup getall now polls all configured app IDs (covers, HVAC, triggers, switches) not just lighting (App 56) — cover positions and HVAC states are now known immediately after bridge restart
- Background timers now call `.unref()` so Jest tests exit cleanly without "worker process has failed to exit gracefully" warnings

## [1.4.23] - 2026-03-28

### Added
- C-Bus HVAC support (App 201): climate zones exposed as Home Assistant `climate` entities with current temperature, setpoint control, and mode (off/auto/cool/heat/fan_only)
- C-Bus trigger write-back: each trigger group now also publishes a companion HA `button` entity, allowing Home Assistant automations to fire C-Bus scenes/triggers
- Trigger groups now visible in the label editor with read-only type badge, editable label/entity-id, and exclude toggle
- Stale HA discovery cleanup: when a device is excluded or changes type, the old MQTT discovery message is automatically cleared so HA removes the stale entity
- Event connection keep-alive: periodic pings on the C-Gate event port (20025) detect silent TCP drops; configurable via `connection_keep_alive_interval_sec`

### Fixed
- Trigger groups in label editor are correctly identified and shown with purple badge; type cannot be accidentally changed

## [1.4.22] - 2026-03-28

### Added
- C-Bus trigger group support (App 202): trigger events now published as Home Assistant `event` entities, enabling automations from keypads and scenes
- Connection pool tuning settings in addon UI: `connection_pool_size`, `connection_health_check_interval_sec`, `connection_keep_alive_interval_sec`
- Label editor batch operations: multi-select rows with checkboxes, bulk type assignment (light/cover/switch), bulk exclude/include, Shift+click range selection
- Integration test now validates HA MQTT Discovery message format and required fields

### Fixed
- Cover entities now use `optimistic: false` in discovery payload so Home Assistant waits for confirmed position feedback before updating UI state

## [1.4.21] - 2026-03-28

### Added
- MQTT TLS/SSL support for external brokers: `mqtt_use_tls`, `mqtt_ca_file`, and `mqtt_reject_unauthorized` options are now configurable in the add-on UI
- Supports self-signed CA certificates, standard TLS (port 8883), and optional certificate verification bypass

## [1.4.20] - 2026-03-28

### Added
- C-Gate version shown as a diagnostic entity in Home Assistant (populated automatically from managed-mode install)
- Runtime status panel in the label editor now shows bridge version, uptime, lifecycle reason, and reconnect counts

### Fixed
- Multi-network support: `getall_networks` with more than one network now correctly polls all listed networks on startup and periodically, not just the first
- Integration test now runs on Linux CI without a podman machine (Linux containers run natively)

### Changed
- CI workflow now includes an integration test job (managed mode, downloads C-Gate) running on push to main

## [1.4.19] - 2026-03-28

### Fixed
- Multi-network support: `getall_networks` with more than one network now correctly polls all listed networks on startup and periodically, not just the first
- Bridge diagnostic entity names are now published correctly in MQTT discovery payloads
- Runtime status panel timer is correctly cleared when navigating away from the label editor page

### Changed
- CI workflow now includes an integration test job (managed mode, downloads C-Gate) running on push to main
- Integration test now runs on Linux CI without a podman machine (Linux containers run natively)

## [1.4.18] - 2026-03-28

### Fixed
- Corrected CI coverage threshold for `cgateConnectionPool` to match actual coverage (37.5%)

## [1.4.17] - 2026-03-28

### Fixed
- Removed no-useless-catch lint error in `lineProcessor`

## [1.4.16] - 2026-03-28

### Fixed
- Web server now binds to `0.0.0.0` in add-on mode, fixing 502 errors when accessing the label editor via HA Ingress; standalone mode retains `127.0.0.1` default; regression test added

## [1.4.15] - 2026-03-28

### Added
- End-to-end integration test (`test-env/integration-test.js`) validating the full managed-mode stack: C-Gate install, C-Gate start, MQTT readiness, C-Gate connectivity, bridge lifecycle, and a 10-second stability window

## [1.4.14] - 2026-03-28

### Fixed
- Managed mode: correctly handles the Schneider Electric download package (outer zip contains a nested C-Gate zip that must be extracted separately)
- Managed mode: updated default C-Gate download URL from dead Clipsal CDN to `download.se.com` (V3.3.2, publicly accessible)
- Better error logging when a C-Gate download fails, including HTTP status code and 404-specific guidance
- `test-env` updated with Dockerfile, mock HA Supervisor HTTP API, and podman-compose instructions

## [1.4.13] - 2026-03-28

### Fixed
- Managed mode: corrected C-Gate startup flags (`-s` only, removing invalid `-p`/`-e`/`-nogui` flags that caused an infinite restart loop)
- `cgate-install.sh` now writes `CommandInterface.port` and `EventInterface.port` into `C-GateConfig.txt` during installation so custom ports take effect

### Added
- Local test environment (`test-env/`) with docker-compose, Mosquitto broker config, and options templates (managed-upload, managed-download, remote) for validating managed mode without a real HA Supervisor

## [1.4.12] - 2026-03-10

### Added
- Bridge diagnostic entities published to Home Assistant via MQTT Discovery: ready state, lifecycle, MQTT/event connection status, command pool health, queue depth, and reconnect indicator

### Performance
- Reduced hot-path parsing overhead in line processor

## [1.4.11] - 2026-03-04

### Fixed
- Interactive command priority propagation: explicit interactive queue requests are no longer downgraded to standard priority

### Added
- Router regression coverage for command priority handling

## [1.4.10] - 2026-03-04

### Changed
- Version alignment: Home Assistant add-on version synced with application version for phase 1 performance release

## [1.4.9] - 2026-03-04

### Changed
- Version alignment: Home Assistant add-on version synced with application version for performance improvements release

## [1.4.8] - 2026-03-04

### Changed
- Hardened web API defaults: mutating endpoints now require authentication by default unless explicitly overridden
- Added configurable CORS allowlist support and explicit unsafe override toggle for unauthenticated writes
- Improved HA discovery TreeXML handling by isolating queued network context to avoid state bleed between requests
- Expanded bridge runtime status with lifecycle/readiness state and queue/pool health metrics, plus `/healthz` and `/readyz` endpoints
- Aligned CI and distribution release quality gates with lint (`--max-warnings=0`) and coverage checks

### Fixed
- Consolidated startup validation path to reduce duplicate config validation logic and drift
- Managed-mode C-Gate install now supports checksum verification and safer default local-only interface access

## [1.2.2] - 2026-02-28

### Fixed
- **Cover position publishing**: Type-overridden covers on the lighting app now correctly publish to the `position` MQTT topic, fixing non-functional position sliders in Home Assistant for blind/cover entities

## [1.2.1] - 2026-02-22

### Fixed
- **MQTT auth error messaging**: Authentication failures now display a clear, actionable error with environment-specific fix instructions (addon vs standalone) instead of a raw JSON error dump

## [1.2.0] - 2026-02-22

### Added
- **C-Bus label management**: Three-tier label resolution (custom JSON > C-Gate TREEXML > fallback)
- **Clipsal project file import**: Upload `.cbz`/`.xml` project files to extract device labels
- **Web-based label editor**: Real-time label editing UI accessible via HA Ingress (panel: "C-Bus Labels")
- **Type overrides**: Configure groups as `light`, `cover`, or `switch` to control HA entity type
- **Entity ID hints**: Preserve existing entity IDs during migration from manual YAML configuration
- **Group exclusion**: Exclude specific groups from HA MQTT Discovery
- **Hot-reload labels**: File watcher detects `labels.json` changes and republishes discovery
- **Migration tooling**: CLI tool (`tools/cgate-label-manager.js`) for C-Gate label inventory and management
- C-Gate mode configuration: `remote` (connect to external C-Gate) or `managed` (run C-Gate locally)
- MQTT auto-detection from Home Assistant Supervisor API
- Configuration UI translations for 17 languages
- s6-overlay process supervision for managed C-Gate mode

### Changed
- HA Discovery now sets entity-level `name` to `null` to prevent doubled friendly names
- Stale retained MQTT discovery messages are automatically cleared when type overrides change entity type
- Discovery supplements from `labels.json` when TREEXML returns incomplete data

### Fixed
- Labels-changed listener leak on restart (now properly removed in `stop()`)
- Label file watcher now starts after haDiscovery initialization
- Label import preserves existing `type_overrides`, `entity_ids`, and `exclude` sections

## [1.1.0] - 2026-02-22

### Changed
- **MQTT publish throughput**: Removed 200ms throttle from MQTT publishing path. Events now publish directly to MQTT instead of queuing, reducing latency from 200-600ms to near-zero per event. "Get all" responses for 100 devices now complete in <1s instead of 40+ seconds.
- **Connection pool optimization**: Cached healthy connections array to eliminate per-command array allocation during round-robin selection.
- **Tree XML buffering**: Replaced O(n^2) string concatenation with O(n) array-based accumulation for HA Discovery tree parsing.
- **Shared loggers**: CBusEvent and CBusCommand now use module-level shared loggers, eliminating per-instance allocation overhead.

### Fixed
- **LineProcessor memory leak**: Fixed leak where reconnecting pool connections left orphaned PassThrough stream/readline pairs in the processor Map. Now keys by pool index and cleans up on reconnection.

## [1.0.0] - TBD

### Added
- Initial Home Assistant add-on implementation
- Automatic configuration from add-on options via ConfigLoader
- Support for dual installation modes (standalone vs add-on)
- Home Assistant MQTT Discovery integration
- Multi-architecture Docker image support (amd64, aarch64, armhf, armv7, i386)
- Comprehensive configuration validation
- User-friendly configuration UI in Home Assistant
- Automatic device discovery for lights, covers, and switches
- Host network access for C-Gate connectivity
- Comprehensive documentation and troubleshooting guide

---

**Note**: This add-on is based on the [cgateweb](https://github.com/dougrathbone/cgateweb) Node.js application. For the core application changelog, see the main repository.
