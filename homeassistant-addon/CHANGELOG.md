# Changelog

All notable changes to the C-Gate Web Bridge Home Assistant add-on will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.17.6] - 2026-07-22

### Changed

- **The changelog now reads like it was written for you.** Every release note back to the first one has been rewritten in plain language — what changed and what it means for your setup, without code formatting or internal jargon. A short style guide now lives in the contributor docs so future entries follow the same format.

## [1.17.5] - 2026-07-22

### Changed

- **USB-serial PC Interfaces are now supported in beta.** The managed-mode USB PCI feature has been validated with both the native USB 5500PCU and a 5500PC over a USB-to-serial adapter, including projects saved on Windows. Documentation and the option text in every language now describe the tested setups and how to get started.

## [1.17.4] - 2026-07-22

### Added

- **C-Gate downloads retry when the network corrupts them.** A fresh managed-mode install downloads C-Gate from Schneider; on flaky or proxied connections that file sometimes arrives truncated or as an error page and failed the integrity check. The download now retries a few times, logs how big the file actually is, and — if it still fails — tells you how to install from a manually downloaded copy instead.

## [1.17.3] - 2026-07-21

### Added

- **Projects saved on Windows now work with a USB PC Interface.** A Toolkit project saved on Windows points its network interface at a Windows COM port, which cannot exist on Linux, so the network never opened. When a serial device is configured, the project sync now rewrites that Windows port to your device automatically on every start.
- The startup serial diagnostics now also list each network's interface type, address, and state, so a misconfigured project is visible directly in the log.

## [1.17.2] - 2026-07-21

### Added

- **Brute-force protection for the web UI.** Repeated failed attempts with the wrong web API key are now rate-limited; after 20 failures in a minute from one client, further attempts get a "too many requests" response instead of a clean 401. Valid keys are unaffected, and the limit is configurable.

### Fixed

- **A failing event stream can no longer crash the add-on.** If a web request failed after its response had already started, the error handler tried to write a second response and took the whole process down. It now simply ends the response.

### Changed

- The add-on's base images moved to a supported Alpine release, restoring security updates for the packages inside the image.

## [1.17.1] - 2026-07-21

### Fixed

- **Target humidity now shows on climate entities.** It was published under a setting name Home Assistant doesn't recognize, so it silently never appeared.
- **Changing the temperature or fan of an off thermostat no longer turns it on.** Adjusting the target on an off climate card used to start the plant in heat mode; the command is now ignored with a warning. Selecting a mode remains the way to switch a unit on.
- **Fan speed is remembered across automatic fan mode.** Switching the fan to automatic used to forget the learned fan speed, so switching back to continuous reverted to default speed.

## [1.17.0] - 2026-07-20

### Added

- **Name groups with their Home Assistant entity id to set their type.** With the new "type from label prefix" option (off by default), a group named cover.bedroom_shutter is discovered as a cover, switch.porch_light as a switch, and so on. Supported prefixes are light, cover, switch, relay, and pir; a manual type override still wins.
- **Each group now reports which unit changed it.** A new source_unit topic per group carries the C-Bus unit that last changed the group, so automations can react to a physical switch press or ignore changes that came from the bridge itself.

## [1.16.3] - 2026-07-20

### Added

- **A clear warning when managed C-Gate has no project.** If you start managed mode without installing a Toolkit project database, the log now says exactly that — including the "Network not found" symptom it causes and how to fix it — instead of a confusing retry loop. Importing labels in the web UI does not install the project; the database still goes in the share folder.

### Fixed

- The startup serial diagnostics now query C-Gate's interface list with the correct command, instead of one the server rejected.

## [1.16.2] - 2026-07-20

### Added

- **Discovery now refreshes the moment a network finishes syncing.** The bridge asks C-Gate for sync-complete events, so after a startup or resync the group tree is re-fetched immediately instead of after the polling fallback cycle. On systems where the event never arrives, the bounded polling still applies.

### Fixed

- Some C-Gate event lines were silently dropped because of their prefix format, which would also have hidden network-created notifications.

## [1.16.1] - 2026-07-19

### Added

- **The startup sync log now names the units it is waiting for.** When discovery gives up waiting for units that never report group bindings, it lists them by address and type, so it's obvious which devices caused the wait.

## [1.16.0] - 2026-07-19

### Added

- **Temperature sensors now appear in Home Assistant automatically.** Any Temperature Broadcast group shows up as a temperature sensor the first time it reports, with no extra configuration.
- **Thermostat fault alerts.** Each air-conditioning thermostat gains "plant problem" and "temperature sensor problem" indicators, driven by the unit's own error reports.
- **Humidity support for air conditioning.** Installations with humidity plant get current and target humidity on their climate entities, plus humidity mode and plant state topics. This follows the protocol documentation but hasn't been tested against real humidity hardware yet, and is read-only.
- **Fan mode control.** Thermostats can now be switched between automatic and continuous fan from Home Assistant (when control is enabled), and the climate card shows the current fan mode and speed.
- **Faster, quieter startup.** The bridge asks each air-conditioning zone group for its full state the first time it appears, instead of waiting for broadcasts to trickle in.

### Fixed

- Sub-zero zone temperatures now read correctly instead of being dropped.
- Fan-only broadcasts are no longer misread as a 127 °C setpoint.
- Changes made from Home Assistant no longer reset a thermostat's own settings: setback and guard options, fan configuration, and per-mode setpoints are now learned from the thermostat and echoed back. Rapid temperature adjustments are also collapsed into a single command, as the protocol recommends.
- Fixed a regular-expression performance issue in web request handling.

### Changed

- Internal: type-checking enabled across the source, CI dependencies updated.

## [1.15.15] - 2026-07-19

### Fixed

- **Startup no longer re-scans the network tree in a loop when some units have no groups (#25).** Units that legitimately control no groups (some sensors, for example) used to trigger a full tree re-fetch on every startup — after 30, 60, then 120 seconds — republishing the same entities each time. A re-fetch that returns an identical tree now stops early, and the log notes those units are treated as unassigned.

### Changed

- Internal: integration-test failures now dump the container logs to make CI failures diagnosable.

## [1.15.14] - 2026-07-19

### Added

- **Air-conditioning plant errors are now reported.** Each thermostat publishes its error state as an error code and a plain-language description (heater, cooler or fan failure, sensor failure, service or filter required), decoded from the official protocol documentation. A non-zero error also logs a warning once per unit until it clears.
- **Fan speed and fan mode readings for air conditioning.** Zone events now expose the fan speed and whether the fan is running automatically or continuously, and climate entities show the current fan mode. Fan mode is read-only in this release.

### Fixed

- Errors while handling C-Gate traffic now log both the error and the offending line, instead of dropping both.

## [1.15.13] - 2026-07-19

### Added

- **Serial device dropdown for the USB-serial PC Interface alpha (#28).** The serial device option now offers a dropdown of devices actually detected on the host instead of a free-text field. Custom paths — such as the by-id path, which survives replugging — are still possible via the YAML configuration editor. Startup also logs an inventory of detected devices, so a wrong pick shows what actually exists.
- **Startup diagnostics for the serial alpha (#28).** With a serial device configured in managed mode, startup logs the device's resolved target and C-Gate's own port and interface lists in a paste-ready block for issue reports. The diagnostics never block or break startup.

### Fixed

- **The built-in C-Gate download is now integrity-checked.** The default managed-mode download is verified against a pinned checksum instead of proceeding warn-only. Your own checksum still overrides it, and custom download addresses without one already failed hard.

### Changed

- Internal: type-checking extended across the core modules and a test-only web-server shutdown hang fixed; no runtime behaviour change.

## [1.15.12] - 2026-07-18

### Added

- **Alpha support for USB PC Interfaces in managed mode (#28).** A new opt-in serial device option (hidden by default, so upgrades change nothing for existing users) passes a USB PCI — a 5500PC or 5500PCU attached to the Home Assistant host — through to the C-Gate instance inside the add-on. Startup validates the configured device and fails fast with a readable error. Experimental: known limitations (Windows-saved port names in the Toolkit project, untested on ARM) are documented — please report results on issue #28.
- Documented that USB PC Interfaces also work today via remote mode, running your own C-Gate on any machine with the dongle attached.

## [1.15.11] - 2026-07-18

### Fixed

- **Label save and import no longer fail with "Unauthorized" from the side panel (#33).** The add-on relied on an environment variable the Supervisor never sets, so with no web API key configured, every label save, import, and the status tab failed authorization through the side panel. The bridge now discovers its side-panel path from the Supervisor at startup, and the label editor surfaces a failed save instead of silently dropping it.
- **Groups missing at startup are now discovered automatically (#25).** While C-Gate is still syncing with the C-Bus network, it reports units without their groups, and those groups previously stayed missing until a manual tree refresh. The bridge now re-fetches the tree when C-Gate reports the network has finished syncing, and schedules a bounded retry (30, 60, then 120 seconds) whenever a tree still contains unsynced units.
- **Malformed addresses in command topics are rejected.** Network, application, and group numbers must be one to three digits; values with stray characters were previously accepted and silently truncated.

### Changed

- **Custom C-Gate downloads now require a checksum.** A custom download address without its checksum fails the install with a clear error instead of only warning. If you use a custom address, set its checksum before upgrading.
- Internal: web server split into modules; local linting now matches CI.

## [1.15.10] - 2026-07-12

### Fixed

- **A manual tree refresh no longer creates duplicate "unknown" entities (#25).** Refreshing the tree over MQTT asked C-Gate twice, and the second response was misattributed to a phantom unknown network, duplicating every entity in Home Assistant. Exactly one request is now sent, and any tree response that can't be attributed to a network is dropped instead of published.
- Documentation typo: corrected the name of the tree refresh topic.

## [1.15.9] - 2026-07-11

### Fixed

- Internal: the release pipeline no longer skips publishing the add-on when an optional integration job is skipped.

## [1.15.8] - 2026-07-11

### Fixed

- **The 64-bit ARM add-on image builds again.** It crashed while installing dependencies under emulation; dependencies are now installed on the build machine's architecture and copied into the image. A lint issue that blocked the distribution pipeline was fixed too.

### Changed

- Internal: add-on image builds now use Docker Buildx with explicit target platforms.

## [1.15.7] - 2026-07-11

### Fixed

- **32-bit ARM images build again.** The base image has no current Java package on armv7, so the build now falls back to the older Java on the platforms that need it — unblocking the failed 1.15.6 release.
- **Sensitive web pages now require the same authorization as changes.** The labels, status, dashboard, areas, export, and live event pages previously allowed unauthenticated reads; the health endpoints stay public. The add-on's side-panel address is also no longer written to the log at startup.
- Uploaded C-Gate packages without a checksum now log the same integrity warning as downloads do.

### Changed

- Add-on publishing is restricted to real release tags, and overlapping deploys are prevented.
- Reconnect backoff now honours the configured initial and maximum delays, and several previously hard-coded limits (event log size, event-stream keepalive, MQTT queue size, startup debounce) are now tunable.
- The bridge warns at startup when MQTT broker certificate verification is disabled, and the operator docs now cover broker access-control requirements.
- Internal: discovery and option handling refactored, with added test coverage; no behaviour change intended.

## [1.15.6] - 2026-07-11

### Fixed

- **Requests pretending to come through the Home Assistant side panel are rejected, and the web port is no longer exposed by default.** Web changes now verify the request really came from the ingress proxy. Host port 8080 is no longer mapped; if you re-expose the port, set a web API key.
- **Label updates are hardened against malicious keys**, matching the protection partial updates already had.
- **Network auto-discovery no longer probes in a way typical installs can't answer** when your networks are already configured, removing a recurring error from the log; any remaining occurrences log quietly.
- **Startup no longer warns about MQTT messages queueing before the first connection.** Mid-session disconnects still warn, and queued retained messages still replay on reconnect.
- **An MQTT login failure no longer restart-loops the add-on.** Add-on mode stays alive, throttles the warning, and retries; standalone mode still exits.
- **Project names and login credentials are validated** so embedded newlines or spaces can't inject extra commands to C-Gate.
- **Failed C-Gate commands now publish a warning** on the bridge warnings topic instead of failing silently.
- **Overlapping tree requests are de-duplicated**, and stale responses are ignored once a newer request for the same network is in flight.

### Changed

- Concurrent live event-stream connections are capped (32 by default) to limit denial-of-service on an exposed web port.
- Releases now require multi-architecture builds and the C-Gate integration tests to pass before publishing.

## [1.15.5] - 2026-07-10

### Added

- **The automatic device-type options can now be set from the add-on UI.** Automatic type detection, label-name heuristics, and the cover keyword list were previously only reachable from a standalone settings file.
- **Multi-architecture images.** The add-on is now built for 64-bit Intel/AMD, 64-bit ARM, and 32-bit ARM.
- Reconnect and timeout intervals that were hard-coded (MQTT reconnect and connect timeouts, C-Gate reconnect attempts, cover ramp updates) are now configurable.

### Fixed

- **Temperature sensor readings are now published.** Decoded temperature events were parsed but never reached MQTT; they now appear on their reading topic.
- **Network auto-discovery now works out of the box for standalone installs.** A settings-name mismatch left it silently disabled for settings-file deployments; it now defaults to on, matching the add-on and the documentation.
- Discovery no longer leaks internal label state when a pass fails partway through, which could leave stale data on the next run.
- The web server reports a proper error when a page asset fails to stream, instead of a broken response.
- Corrected the add-on installation instructions in the README.

### Changed

- Removed a never-implemented MQTT command from the accepted command set.
- The release workflow now requires version checks, add-on validation, static checks, and tests to pass before an image is published.
- Internal: refactoring and added CI guards (schema and translation parity, type checking); no runtime behaviour change.

## [1.15.4] - 2026-06-29

### Fixed

- **Discovery no longer accepts a partially-synced tree as complete.** A tree entry carrying a group but no application address was wrongly counted as a real device, so discovery could finish "successfully" with zero entities. The check now requires a resolvable application address. (#16 follow-up)

## [1.15.3] - 2026-06-29

### Fixed

- **Light statuses now update in managed mode (#21).** The managed-mode installer set C-Gate's event port to the same port as the real-time status stream cgateweb reads, so C-Gate served the wrong stream and every entity stayed Unknown in Home Assistant. The installer no longer sets that port — and removes the bad setting from existing installs, which self-heal on the next start.
- **Discovery waits for C-Bus groups to finish syncing (#16).** On networks that sync progressively, C-Gate briefly reports units that have no group bindings yet; discovery treated that as complete, published zero entities, and stopped retrying. A unit now only counts as a real device once it carries group addresses, and an all-empty tree is retried until the groups appear.

## [1.15.2] - 2026-06-28

### Fixed

- **Discovery now explains a zero-entity result instead of looking successful (#16).** When the network tree carries no group addresses and no labels file supplies them, the log now warns with the cause and the remedy — import your Toolkit project labels via the web UI — instead of a quiet line that looked like success.

## [1.15.1] - 2026-06-28

### Fixed

- **Discovery now works on C-Gate 3.7.1 (#23).** The device-tree request used a form of network addressing that C-Gate 3.3.2 tolerated but 3.7.1 rejects, so no entities ever appeared. The request now uses the same project-qualified addressing as every other command, which works on both versions.

## [1.15.0] - 2026-06-28

### Added

- **You can now upgrade the managed C-Gate version without losing your project (#16).** Once installed, C-Gate previously stayed at the bundled version forever — there was no way to move off 3.3.2, which can't read newer project databases and left affected installs with an empty tree. Two upgrade paths are now available in managed mode: turn on the new Force C-Gate Reinstall option to reinstall on the next start, or — in upload mode — drop a newer C-Gate zip into the share folder and it is detected and installed automatically. Your project databases and C-Gate configuration are preserved across the reinstall.

## [1.14.9] - 2026-06-21

### Fixed

- **Thermostats and network connectivity sensors no longer vanish after a tree refresh.** Those entities are published when their events arrive rather than as part of a tree scan, but the stale-entity cleanup that runs after each scan treated them as leftovers and removed them — so on networks that re-scan at startup, thermostats disappeared on reboot. Event-driven entities are now tracked separately and left alone by the tree cleanup.

### Changed

- **The Air Conditioning Control option description is clearer.** It now states that thermostats appear as read-only climate entities without it; enabling it only adds mode and temperature control, which writes to live heating and cooling. It is not required for thermostats to be visible.

## [1.14.8] - 2026-06-21

### Fixed

- **Discovery no longer finishes with zero entities while the network is still syncing (#17).** At startup C-Gate briefly returns a tree containing only its own interface unit before the real units finish syncing; that was accepted as a zero-device success, and the devices that arrived moments later never appeared until a manual refresh. A management-only tree is now treated as still syncing and retried until the real units arrive.

## [1.14.7] - 2026-06-17

### Fixed

- **A clear error for unsupported label-import files.** Picking a non-project file — a real Comic Book archive, say, which the Android-friendly file picker can offer — used to produce a baffling XML parse error. The importer now detects the format by content and rejects anything that isn't a Toolkit project export with an actionable message. A misnamed archive still imports, since detection looks at content, not the file extension.

## [1.14.6] - 2026-06-17

### Fixed

- **Label import now works in the Home Assistant Android app.** The file picker restricted selection to extensions Android can't reliably map, so the project file was greyed out and couldn't be selected. The picker now accepts the project file on mobile; the server still validates the actual content.

## [1.14.5] - 2026-06-17

### Fixed

- **Project import now works with C-Bus Toolkit 1.17.x.** Newer Toolkit exports contain a project database rather than XML, so the importer kept reporting that no XML file was found. It now reads the database directly — inside an archive or on its own — and reconstructs the network, application, and group names from it. Older XML exports continue to work unchanged.

## [1.14.4] - 2026-06-17

### Fixed

- **Discovery now finds your devices on startup, not only after a manual refresh (#16).** When the network hadn't finished syncing, C-Gate returned an empty tree that was accepted as a zero-device success, so nothing appeared until you refreshed the tree manually. An empty tree is now treated as still syncing and retried with backoff until the populated tree arrives.
- **No more phantom "unknown" network.** Duplicate tree requests for the same network caused the second response to be misattributed, publishing a stray tree topic and discovery sensor. Duplicate in-flight requests are now suppressed.

## [1.14.3] - 2026-06-16

### Fixed

- **Managed mode now actually loads your C-Gate project (#16).** Project databases were placed where C-Gate 3.x never looks, so managed C-Gate started with no project loaded, every command failed, and discovery found nothing. The database now goes into C-Gate's project folder and the project is set to load and start automatically on boot.
- **Project configuration is reapplied on every start.** The project name and port settings were previously only written on a fresh C-Gate install, so existing and upgrading installs never received them.

### Changed

- Internal: the integration test now verifies the project actually loads in managed mode, so this regression fails CI instead of passing silently.

## [1.14.2] - 2026-06-16

### Fixed

- **The thermostat card's temperature range now matches the hardware** — 10 to 32 °C instead of 0 to 50 — so Home Assistant no longer offers values the thermostat silently rejects.
- **Thermostat cards update instantly.** Changing mode or temperature from Home Assistant is now reflected immediately instead of waiting for the thermostat's next broadcast.
- **A mirrored controller can be hidden.** A controller that re-broadcasts a zone, showing up as a duplicate climate card, can now be removed by adding its unit to the label exclude list.
- **Lights named like covers stay lights.** A group such as Garage Door Lamps is no longer auto-classified as a cover when its label also names a light.
- **Project import works with more Toolkit exports**, including archives whose internal files use different letter casing.
- **No more spurious air-conditioning parse warnings** for unrecognised broadcast lines.

## [1.14.1] - 2026-06-15

### Fixed

- **Clearer message when cgateweb can't reach C-Gate.** A connection that never establishes now logs what to check — host and port reachability, the C-Gate machine's firewall, and C-Gate's access list — instead of a bare timeout.
- **The setpoint is no longer lost when a thermostat turns off.** Native thermostats report a zero setpoint when off; the last active target is now kept instead of reporting 0 °C.
- **The Air Conditioning control option reads correctly in standalone mode**, where a hand-edited settings file could supply it in a form that was previously misread.
- **The status page escapes labels and addresses**, so label text can't be interpreted as markup.
- **Secrets are kept out of logs** — any password- or token-like value passed to the logger is redacted before output.
- **Faster failover signalling.** When the last command connection drops, the problem is reported immediately instead of up to 30 seconds later.

### Changed

- Internal: error handling and shutdown tidied; CI hardened (add-on image built on every pull request, translation parity validated, minimum Node version 20).

## [1.14.0] - 2026-06-14

### Added

- **Control your C-Bus thermostats from Home Assistant.** You can now set the mode and target temperature of native C-Bus air-conditioning thermostats directly from the climate card. It's opt-in via the new Air Conditioning Control option (off by default) because it writes to live heating and cooling. Each thermostat is targeted correctly even when several share a zone group — no touchscreen, Wiser, or extra hardware required.

### Changed

- Internal: startup scripts hardened; no functional change.

## [1.13.1] - 2026-06-13

### Added

- **Network connectivity sensors.** Each monitored C-Bus network now exposes a connectivity sensor in Home Assistant reflecting its CNI or PCI link, so you can alert or automate on a network going offline, not just read it on the status page.
- **Optional offline notification.** A new setting (off by default) raises a Home Assistant persistent notification when a network's link goes offline and dismisses it when the link recovers.

## [1.13.0] - 2026-06-13

### Added

- **C-Bus network link status on the status page.** cgateweb now detects when the link between C-Gate and the C-Bus network drops — an outage that was previously invisible because C-Gate keeps its own connection up the whole time. It polls each network's interface state (read-only), shows an indicator on the status page that's highlighted when a link is down, and logs a warning on dropout and a message on recovery. The poll interval is configurable (30 seconds by default; set it to 0 to disable).

## [1.12.1] - 2026-06-13

### Fixed

- **The Air Conditioning option is now translated in every language.** It was only present in English, so non-English users saw an untranslated label.
- The label-edit API now skips potentially malicious keys in requests, as defence in depth.

### Changed

- **Web UI timeouts are now tunable.** Three previously hard-coded values — the diagnostics active-device window, the areas cache lifetime, and the Supervisor API timeout — are now settings with unchanged defaults.

## [1.12.0] - 2026-06-13

### Added

- **Air-conditioning thermostats now appear automatically in Home Assistant.** With the Air Conditioning option enabled and discovery on, each thermostat gets a climate entity the first time it's seen on the bus, showing current temperature, target setpoint, operating mode, and the live running action. Custom names from the label file are used.
- This first release is read-only: the thermostat card displays state but does not yet send control commands, pending verification of the command format against hardware.

## [1.11.4] - 2026-06-13

### Added

- **Live running action for air conditioning.** The plant's current activity — heating, cooling, fan, or idle — is now published per thermostat, ready to show on the climate card.
- **Verified air-conditioning mode codes.** The cool, auto, and fan-only operating modes — previously best-effort — are now confirmed against real thermostat captures.

### Fixed

- **No bogus setpoint in fan-only mode.** In fan-only mode the thermostat reports a special "no setpoint" value that was being decoded as a 127 °C target; the setpoint is now omitted whenever it falls outside the plausible range.

## [1.11.3] - 2026-06-10

### Added

- **Air conditioning: mode, setpoint, and multiple thermostats.** Building on the temperature reading, the bridge now also decodes the operating mode (off and heat verified; cool, auto, and fan-only best-effort pending hardware confirmation), the target setpoint, and the zone on/off state. Multiple thermostats on one network are now supported: readings are keyed by the thermostat's own unit address, so two units sharing a zone group no longer collide.

### Changed

- **Air-conditioning topics are now keyed by thermostat unit, not zone group.** This corrects collisions between thermostats sharing a zone group and only affects the opt-in Air Conditioning feature introduced in 1.11.0.

## [1.11.1] - 2026-06-06

### Fixed

- **The 1.11.0 release now actually ships.** A lint failure blocked its distribution build, so the add-on never updated; the air-conditioning temperature feature arrives with this release.

## [1.11.0] - 2026-06-06

### Added

- **Native C-Bus air-conditioning room temperature.** The bridge now decodes temperature broadcasts from the C-Bus Air Conditioning application and publishes them per zone. Enable it with the Air Conditioning application option (off by default). Read-only for now — mode and setpoint come later. This is the real Air Conditioning application, distinct from the older HVAC-via-lighting approach.

### Fixed

- Documentation no longer cites a non-existent application number for air conditioning; the real one is 172.

## [1.10.1] - 2026-05-31

### Fixed

- **The cover stop button now works.** Home Assistant sends stop as a payload on the cover's command topic, which the bridge treated as invalid and silently dropped — so blinds would open and close but never stop mid-travel. Stop now halts the blind and cancels any in-progress position animation.

## [1.10.0] - 2026-05-30

### Added

- **Automatic cover detection.** Lighting groups whose label mentions a blind, shutter, shade, awning, curtain, roller, or garage door are now discovered as covers instead of lights — fixing the common case where shutter relays share the lighting application with real lights and everything appeared as a light. Detection is conservative and label-only: a manual type override always wins, and auto-detection only ever upgrades the default light type. On by default, with adjustable keywords.

### Fixed

- **Project import no longer fails with "Unauthorised" through the side panel.** Importing from the add-on UI now works out of the box when no web API key is configured; a configured key is still always enforced, and direct requests remain blocked unless explicitly allowed.
- **HVAC type overrides produce a working thermostat.** Reclassifying a lighting group as HVAC now publishes the full climate payload instead of one missing the thermostat controls.

## [1.9.4] - 2026-05-27

### Changed

- **The web UI is now usable on phones and tablets.** Previously desktop-only, it now adapts to small screens: no iOS zoom-on-tap, larger touch targets, a scrollable label table on narrow screens, and a sensible layout down to phone widths — while desktop keeps the compact layout.

### Security

- **API key comparison is now constant-time**, removing a timing side channel that could have helped an attacker guess the key.
- **Project imports are guarded against zip bombs.** The total decompressed size is checked against a cap before anything is extracted, so a small upload can't exhaust memory; archived file names are also checked for path tricks.
- **Security headers on every web response**, blocking scripts loaded from other sites and preventing the side-panel address from leaking to external resources.
- **Managed-mode installs verify archive contents** for path tricks before extracting.

## [1.9.3] - 2026-05-27

### Fixed

- **Label edits from the web UI update Home Assistant again.** Saves through the editor wrote the file but, due to a guard meant to prevent double-processing, never triggered re-discovery — so changed names, areas, type overrides, and exclusions never reached Home Assistant until something else reloaded the file.

## [1.9.2] - 2026-05-26

### Changed

- **Quieter logs.** Two high-volume lines — one for every received command and one for every periodic poll — moved from info to debug level; together they were about 45% of typical log volume. Startup, shutdown, and state messages stay at info; set the log level option to debug if you need the full trace.

## [1.9.1] - 2026-05-24

### Changed

- **Lower memory footprint and faster startup in managed mode.** The bundled Java runtime is tuned for a small control-plane workload — roughly 30–50 MB less memory and a few seconds faster cold start on Pi- and NAS-class hardware — and the bridge's own memory is capped so a fault can't starve other add-ons. Remote-mode users are unaffected.
- **Faster readiness at startup.** The web UI and initial discovery no longer delay the bridge's ready signal; they start in the background once the connection is healthy.
- Internal: smaller Docker image, version-drift and dependency-pinning CI gates, a container health check, and bounded internal caches.

## [1.9.0] - 2026-05-24

### Added

- **Discovery retry tuning.** New settings control how long and how often discovery retries fetching the network tree at startup; defaults are unchanged.
- **The web upload size limit is now configurable**, useful for unusually large project files.

### Fixed

- **Discovery no longer gets stuck on a malformed tree response.** A truncated or interrupted reply previously left discovery waiting forever with no retry or diagnostic; it now retries with backoff and eventually pauses with a clear state.

### Changed

- Internal: discovery internals simplified and CI hardened (version-drift gate, pinned action versions, token-leak fix, health check); no behaviour change.

## [1.8.10] - 2026-05-24

### Added

- **Install your Toolkit project into managed C-Gate via the share folder.** Drop the project database built in C-Bus Toolkit (or copied from another C-Gate install) into the share folder and restart; managed C-Gate will serve the project so discovery succeeds. The sync is timestamp-aware, so changes C-Gate saves between restarts are never overwritten by a stale copy.
- **The web import now warns that it's labels-only (#9).** Importing a project file into the web UI imports names and groups but does not install the project into C-Gate — the import now says so and points at the managed-mode workflow, avoiding a common setup trap.

### Changed

- Documentation: new section on loading your C-Gate project in managed mode.

## [1.8.9] - 2026-05-09

### Added

- The MIT license now ships alongside the installable add-on in the distribution repository.

## [1.8.8] - 2026-05-07

### Fixed

- **Managed mode no longer fails with an invalid download address.** An unset download option was being read as the literal word "null", so the built-in fallback address was never used and the install aborted. Empty and unset values are now handled correctly for both the download address and its checksum.

## [1.8.7] - 2026-05-05

### Fixed

- **Entities no longer get stuck unavailable after a restart.** State and discovery messages published before the MQTT broker finished connecting were silently dropped, so affected entities sat unavailable until the device happened to change. Messages published while disconnected are now queued — newest wins per topic, bounded, with a warning if the broker stays down — and replayed on reconnect. One-shot events are still dropped rather than replayed.

## [1.8.6] - 2026-05-05

### Added

- **Removed networks are cleaned up in Home Assistant.** When C-Gate reports a network was removed or deleted, all of that network's discovered entities are now torn down instead of sitting offline forever, and any pending tree retry is cancelled.

## [1.8.5] - 2026-05-04

### Added

- **Discovery refreshes the moment a network comes up.** When C-Gate finishes loading a network, discovery re-fetches the tree immediately instead of waiting for the retry timer — eliminating the discovery delay on cold starts. The retry remains as a fallback.

### Changed

- Internal: more robust parsing of C-Gate event lines; timestamps, unusual event codes, and hyphens in payloads no longer cause mis-parses.

## [1.8.4] - 2026-05-04

### Added

- **A per-network discovery health sensor.** Each network gets a diagnostic sensor in Home Assistant — discovering, ok, or paused — so you can see at a glance whether auto-discovery is healthy without trawling the add-on logs.

## [1.8.3] - 2026-05-04

### Changed

- Internal: discovery retry bookkeeping simplified; no behaviour change.

## [1.8.2] - 2026-05-04

### Fixed

- **Custom C-Gate ports now actually take effect in managed mode.** The installer wrote the port settings under names C-Gate doesn't recognise, so C-Gate warned on every start and silently kept its defaults. The correct names are now written, and leftovers from earlier installs are cleaned up.

## [1.8.1] - 2026-05-04

### Fixed

- **Discovery no longer gives up when C-Gate is still starting.** C-Gate accepts connections before its networks are loaded, so the first tree request could fail and devices never appeared even though events flowed normally. The request is now retried with backoff — up to 8 attempts over about a minute — and after the limit a clear warning explains how to trigger a manual refresh.

## [1.8.0] - 2026-04-29

### Changed

- **Less log noise when the MQTT broker isn't up yet.** The bridge warns once per disconnect instead of once per message, and reports a single rolled-up count of dropped messages on reconnect.
- **Quieter network auto-discovery fallback.** On C-Gate versions that don't support the project-level query, falling back to your configured networks is now logged as routine information instead of warnings and errors.
- Internal: discovery payload construction deduplicated; no behaviour change.

## [1.7.2] - 2026-04-19

### Fixed

- **Importing a project file works on a fresh install.** With no label file configured, the add-on now falls back to a default location instead of failing with "No label file path configured".
- **A clearer error in standalone mode** when no label file path is set, pointing at the relevant setting.
- Removed a duplicated prefix in import error messages.

## [1.7.1] - 2026-04-14

### Fixed

- **Compatibility with older Home Assistant versions.** Discovery payloads again include the old entity-id field alongside the new one, so Home Assistant versions before 2025.10 keep working.

## [1.7.0] - 2026-04-14

### Fixed

- **Home Assistant 2026.4 compatibility.** That release dropped the old entity-id field in MQTT discovery; the bridge now uses the replacement field everywhere.

## [1.6.1] - 2026-04-05

### Fixed

- The area picker works again after Home Assistant removed the endpoint it used, and now shows full area names.
- The save confirmation shows the real label count instead of "undefined".
- Removed a spurious scrollbar on the tab bar.

## [1.6.0] - 2026-04-05

### Fixed

- The Live Events panel toggles correctly again, and the area column no longer truncates text.

### Changed

- **Tabbed web interface.** The collapsible sections are now tabs — Status, Device Labels, Live Events, Import/Export — with state preserved between switches.
- Internal: CI modernised and test coverage expanded.

### Security

- Managed-mode C-Gate downloads are hardened: secure download addresses only, timeouts, a download size cap, symlink rejection, stricter file permissions, and Java memory limits.

## [1.5.5] - 2026-04-04

### Changed

- Translation refinements for Czech, Danish, Norwegian, Polish, Swedish, and Ukrainian.

## [1.5.4] - 2026-04-04

### Added

- **Complete option translations.** All 16 non-English languages now cover the full configuration schema, including fields added in recent releases.

### Changed

- Internal: test coverage expanded.

## [1.5.3] - 2026-04-04

### Fixed

- **A searchable area dropdown** in the label editor, showing existing areas from Home Assistant and your labels, preventing duplicate or inconsistent room names.
- The area list is fetched correctly and cached briefly to avoid repeated API calls.
- Area dropdown polish: no double-commit on click, Tab, or Escape; arrow-up deselects.
- **MQTT reconnection fixed** — the bridge can now reconnect after a failed first connection attempt.
- **Cover state fixed** for plain on commands without a level, matching the lighting behaviour.
- **HVAC mode fixed** — a level of zero is a 0 °C setpoint, not off; only an explicit off turns the unit off.
- More reliable parsing of level-change events, and a cap on an internal buffer that could grow unbounded when discovery is disabled.

### Changed

- Performance improved: higher event and command throughput and lower latencies, per the project's benchmarks.

### Security

- **Cross-origin protection fixed.** Disallowed websites no longer receive a permission header that previously let any site call the API from a visitor's browser.
- **Rate limiting can no longer be spoofed** through forwarded-address headers; it now uses the real connection address.
- All responses now tell browsers not to second-guess content types.

## [1.5.2] - 2026-04-04

### Fixed

- **Upgrading from 1.4.x no longer fails** with a missing-option error. Defaults for the list-type options were restored, which the Supervisor requires to validate your saved configuration.

## [1.5.1] - 2026-04-04

### Added

- **Startup diagnostics summary** logging connections, networks, features, and labels on boot.
- **A bridge statistics topic** with version, uptime, connection, queue, and discovery stats.
- **A web dashboard** with bridge health, the device list with levels and labels, and recent event counts.
- Warnings for unrecognised settings in standalone mode, catching typos in your settings file.
- Validation of the C-Bus name setting, and warnings published when the command queue is full.
- The dim up/down timeout is now configurable.

### Fixed

- **Lights no longer appear stuck on.** Level-change events carry an identifier the fast parser misread as the level, so lights could appear permanently on in Home Assistant; the correct value is now read.
- **Very dim lights no longer report as off.** On/off state now uses the raw C-Bus level, fixing false offs at the lowest brightness steps.
- HVAC mode now correctly reports off after a ramp-to-zero command.
- Tree responses arriving before discovery is ready are buffered and replayed instead of silently dropped.
- The bridge no longer gets stuck after all connections drop and recover.
- Hardened connection handling: writes to a dead socket after a timeout, and a single malformed C-Gate line, can no longer crash processing.

### Changed

- **The add-on configuration page is much simpler** — about five essential options instead of forty; everything else sits behind "Show unused optional configuration options", with better descriptions.
- Improved cleanup on shutdown, stricter input validation, and clearer certificate error messages.

## [1.4.30] - 2026-03-29

### Fixed

- **Devices no longer turn off when the bridge restarts.** Stale commands retained by the MQTT broker were being replayed and executed on reconnect; retained messages on command topics are now ignored — only fresh commands from Home Assistant run.
- Polling applications you don't use (the cover application when you have no covers, for example) now logs a warning instead of an error, with corrected hint text.

## [1.4.29] - 2026-03-29

### Added

- **A live event log in the label editor.** A collapsible panel streams C-Bus events as they happen — address, label, level, and a visual bar — with click-to-filter, pause and clear controls, and automatic reconnect.
- **Stale device detection.** Devices that stop reporting are counted on a new Home Assistant sensor — with their addresses, labels, and last-seen times in its attributes — after a configurable threshold, 24 hours by default.

## [1.4.28] - 2026-03-29

### Added

- **Per-application poll intervals.** You can now poll different C-Bus applications at different rates — HVAC every five minutes, lighting every hour, say — or disable polling for a specific application.
- **Smooth cover movement.** During a position command, intermediate positions are published so Home Assistant shows blinds moving smoothly; real events always take priority, and the animation duration is configurable.

## [1.4.27] - 2026-03-28

### Added

- **Undo and redo in the label editor** — up to 50 steps, with buttons, keyboard shortcuts, and confirmation toasts. Every edit is undoable, including bulk operations and imports.
- **Project XML export.** Download your labels as a C-Gate-compatible project file from the web UI.
- **Trigger groups appear as scenes.** C-Bus trigger groups are now also published as Home Assistant scenes, so they can be fired from the UI and automations (configurable, on by default).

### Changed

- Internal: test configuration fix.

## [1.4.26] - 2026-03-28

### Added

- **Cover tilt support.** Venetian and louvre blinds on a separate tilt application now get tilt position and control on their cover entities.
- **Automatic network discovery.** On connect, the bridge asks C-Gate for its networks as a fallback when none are configured (on by default).
- **Label editor pagination** — 25, 50, 100, or all rows per page, with your choice remembered.
- **Label backup download** straight from the browser.
- **Automatic room suggestions.** The editor detects room words in device names and can fill empty room fields in one click.

### Fixed

- Cover polling responses verified end-to-end, with regression tests to keep positions and states correct.

## [1.4.25] - 2026-03-28

### Fixed

- The area column is now visible and editable in the label editor, with click-to-edit and name search.

## [1.4.24] - 2026-03-28

### Added

- **Room assignment in the label editor.** Set a room per device and Home Assistant auto-assigns the entity to that area on first discovery.
- Documentation for HVAC, trigger groups, PIR and relay applications, plus a C-Bus application reference table.

### Fixed

- **Cover positions and HVAC states are known immediately after a restart** — the startup poll now covers all configured applications, not just lighting.
- Internal: test processes now exit cleanly.

## [1.4.23] - 2026-03-28

### Added

- **HVAC climate zones in Home Assistant**, with current temperature, setpoint control, and mode.
- **Fire C-Bus scenes from Home Assistant.** Each trigger group gets a companion button entity for use in automations.
- Trigger groups now appear in the label editor with a read-only type badge, an editable label and entity id, and an exclude toggle.
- **Automatic cleanup of stale entities.** When a device is excluded or changes type, its old discovery entry is cleared so Home Assistant removes it.
- **Connection keep-alive.** Periodic pings on the event connection detect silent drops; the interval is configurable.

### Fixed

- Trigger groups are correctly identified in the label editor, and their type can't be changed accidentally.

## [1.4.22] - 2026-03-28

### Added

- **Trigger events in Home Assistant.** Trigger group presses now appear as event entities, enabling automations from keypads and scenes.
- Connection pool tuning options in the add-on UI.
- **Bulk editing in the label editor** — multi-select with checkboxes, bulk type assignment and exclusion, and shift-click range selection.

### Fixed

- Cover entities now wait for confirmed position feedback before updating, instead of assuming success.

### Changed

- Internal: the integration test now validates discovery message format.

## [1.4.21] - 2026-03-28

### Added

- **Encrypted MQTT connections.** TLS options for external brokers are now configurable in the add-on UI, including self-signed CA certificates and optional verification bypass.

## [1.4.20] - 2026-03-28

### Added

- **The C-Gate version appears as a diagnostic entity** in Home Assistant, populated automatically in managed mode.
- The label editor's status panel now shows bridge version, uptime, and reconnect counts.

### Fixed

- **Multiple networks are all polled.** With more than one network configured, only the first was polled; all are now polled at startup and periodically.

### Changed

- Internal: the CI pipeline now runs the managed-mode integration test on every push, natively on Linux.

## [1.4.19] - 2026-03-28

### Fixed

- **Multiple networks are all polled.** With more than one network configured, only the first was polled; all are now polled at startup and periodically.
- Bridge diagnostic entity names now publish correctly.
- The status panel's refresh timer is properly cleaned up when you leave the page.

### Changed

- Internal: the CI pipeline now runs the managed-mode integration test on every push, natively on Linux.

## [1.4.18] - 2026-03-28

### Fixed

- Internal: corrected a CI coverage threshold.

## [1.4.17] - 2026-03-28

### Fixed

- Internal: fixed a lint error blocking the build.

## [1.4.16] - 2026-03-28

### Fixed

- **The label editor works through the Home Assistant side panel again.** The web server only listened on localhost, which broke side-panel access with a 502 error; it now listens on all interfaces in add-on mode, while standalone mode keeps the localhost default.

## [1.4.15] - 2026-03-28

### Added

- Internal: end-to-end integration test covering the full managed-mode stack, from C-Gate install through to a stability check.

## [1.4.14] - 2026-03-28

### Fixed

- **Managed mode handles Schneider's download package correctly** — the download contains a nested archive that must be extracted separately.
- **The default C-Gate download address works again**, updated from a dead link to Schneider's current server.
- Clearer errors when a C-Gate download fails, including specific guidance when the file isn't found.
- Internal: local test environment expanded.

## [1.4.13] - 2026-03-28

### Added

- Internal: a local test environment for validating managed mode without a real Home Assistant Supervisor.

### Fixed

- **Managed mode no longer restart-loops C-Gate** — invalid startup flags were removed.
- Custom C-Gate ports are now written to C-Gate's configuration during install so they take effect.

## [1.4.12] - 2026-03-10

### Added

- **Bridge health entities in Home Assistant** — ready state, lifecycle, connection status, command queue depth, and a reconnect indicator, all discovered automatically.

### Changed

- Internal: faster event-line parsing.

## [1.4.11] - 2026-03-04

### Fixed

- Interactive commands keep their priority instead of being downgraded behind routine traffic.

### Changed

- Internal: test coverage for command priority handling.

## [1.4.10] - 2026-03-04

### Changed

- Internal: version alignment only — the add-on version was synced with the application release.

## [1.4.9] - 2026-03-04

### Changed

- Internal: version alignment only — the add-on version was synced with the application release.

## [1.4.8] - 2026-03-04

### Fixed

- Startup validation consolidated, removing duplicated checks that could drift apart.
- Managed-mode installs now verify download checksums and default to local-only interface access.

### Changed

- **Web API hardened by default.** Endpoints that change things now require authentication unless explicitly overridden, cross-origin requests are restricted to a configurable allowlist, and unauthenticated writes require an explicit unsafe toggle.
- **New health endpoints and richer runtime status**, including readiness state and queue and connection health.
- More reliable discovery when several tree requests are queued at once.

## [1.2.2] - 2026-02-28

### Fixed

- **Cover position sliders now work for type-overridden covers.** Covers on the lighting application published position to the wrong topic, so the slider in Home Assistant did nothing.

## [1.2.1] - 2026-02-22

### Fixed

- **Clearer MQTT login errors.** Authentication failures now show an actionable message with fix steps for your setup — add-on or standalone — instead of a raw error dump.

## [1.2.0] - 2026-02-22

### Added

- **Label management.** Give your C-Bus groups custom names, resolved from your labels file first, then C-Gate's project data, then a fallback.
- **Toolkit project import.** Upload a Toolkit project export to pull in device labels.
- **A web-based label editor**, available in the Home Assistant side panel.
- **Type overrides** — mark a group as a light, cover, or switch to control its Home Assistant entity type.
- **Entity id hints** to keep your existing ids when migrating from manual YAML configuration.
- **Group exclusion** from discovery.
- **Live label reloads** — edits to the labels file are picked up and republished automatically.
- A command-line tool for label inventory and migration.
- Managed or remote C-Gate modes, automatic MQTT setup from the Supervisor, a 17-language configuration UI, and process supervision for the bundled C-Gate.

### Fixed

- A listener leak on restart, label watching starting at the wrong time, and imports now preserve your existing type overrides, entity ids, and exclusions.

### Changed

- Friendlier entity names in Home Assistant, with no more doubled names.
- Stale discovery entries are cleared automatically when a type override changes an entity's type.
- Discovery is supplemented from your labels file when C-Gate's data is incomplete.

## [1.1.0] - 2026-02-22

### Fixed

- A memory leak where reconnecting connections left orphaned stream handlers behind.

### Changed

- **Much faster publishing.** The artificial delay on MQTT publishing is gone: events now reach Home Assistant almost instantly instead of 200–600 ms late, and a full status poll of 100 devices completes in under a second instead of 40-plus seconds.
- Internal: connection pooling, tree parsing, and logging efficiency improvements.

## [1.0.0] - TBD

### Added

- Initial Home Assistant add-on release.
- Automatic configuration from add-on options, with validation and a user-friendly configuration UI.
- Standalone and add-on installation modes.
- Home Assistant MQTT discovery for lights, covers, and switches.
- Multi-architecture image support.
- Network access for C-Gate connectivity.
- Documentation and troubleshooting guide.

---

**Note**: This add-on is based on the [cgateweb](https://github.com/dougrathbone/cgateweb) Node.js application. For the core application changelog, see the main repository.
