# Changelog

All notable changes to the C-Gate Web Bridge Home Assistant add-on will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-dougrathbone-FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/dougrathbone)

If this add-on saves you time, you can [buy me a coffee](https://buymeacoffee.com/dougrathbone).

## [1.22.2] - 2026-08-02

### Fixed

- **Patched a high-severity vulnerability in the development toolchain** (brace-expansion, denial of service via unbounded expansion length) flagged by npm audit. It only affects testing and linting, not the running add-on.
- Internal: integration tests now fetch C-Gate from a pinned copy hosted on this repository, so releases no longer stall when Schneider rate-limits CI runners. The daily check still verifies the live Schneider download.

## [1.22.1] - 2026-08-02

### Fixed

- **Security panel trouble state now survives a restart.** Mains power, battery, phone line, arm failure and fire conditions used to reset to healthy on every add-on restart because the panel offers no way to query them; the last known state is now kept on disk and restored on startup. (#42)

## [1.22.0] - 2026-08-02

### Fixed

- **Lights no longer sit at unknown after startup.** The add-on now refreshes every group's level when C-Gate finishes synchronising the network, so entities come up with real values even without "Get all on start" enabled. (#44)
- **Bridge diagnostics and stale-device entities now come back after an MQTT broker restart**, instead of going missing until the add-on restarted.
- **The air conditioning option now applies when Home Assistant discovery is off.** MQTT-only installs could not enable aircon readings at all.
- **Security zone labels now export with proper application names** in the XML label export.

### Changed

- Internal: performance and reliability cleanup across the event pipeline and discovery, faster Live Events rendering, and removal of dead code. No behavior change intended; report anything odd.

## [1.21.1] - 2026-08-01

### Fixed

- **Key-input switches and bus couplers are now recognised for unit-type classification.** With "Set entity type from C-Bus unit type" on, a group driven only by a key-input wall switch or bus coupler now becomes a binary sensor instead of staying a light and logging "unit types not recognised". (#37)

## [1.21.0] - 2026-07-31

### Added

- **Security Alpha: panel health sensors.** Seven new diagnostic binary sensors track the panel itself: mains power, battery, tamper, panic, phone line, arm failure and fire alarm. They group under Diagnostics on a single "C-Bus Security Panel" device. (#42)
- Mains, battery, phone line, arm-fail and fire sensors start as OK and correct themselves on the next change or disarm, because the panel cannot be queried for them. Low battery, tamper-on and panic-clear are inferred from one test panel, so report differences on #42.

### Fixed

- **Entity state is restored after Home Assistant or the MQTT broker restarts.** Entities no longer sit unknown (or vanish entirely after a broker restart) until something changes on the bus. (#44)
- **Security Alpha: the Live Events window now describes security events in words** ("Zone unsealed", "System armed (Day mode)") instead of raw 0/255 levels, and panel-wide events no longer show a bogus `/0` group. (#42)

## [1.20.2] - 2026-07-28

### Fixed

- **Security Alpha: `cbus_security_app_id: 0` now applies even when HA discovery is off.** Previously an MQTT-only user still got zone events on the default application.
- **Security Alpha: zone state changes now log at DEBUG instead of INFO** so a busy panel no longer fills the log. Arm and alarm events stay at INFO. (#42)
- **Security Alpha: the Live Events window now shows zone names** from your Toolkit labels, including on zone-bearing arm events like "not ready" and "bypassed".

## [1.20.1] - 2026-07-28

### Fixed

- **Security Alpha: zone status sync is now requested once at startup**, not up to three times. (#42)
- **Security Alpha: zone changes are now visible**, logged at INFO and shown in the web UI's Live Events window alongside lighting events.
- **Security Alpha: arm and alarm log lines are human-readable** (`System armed (Day mode)`, `Zone 44 bypassed`, ...) at INFO, instead of bare verb names at DEBUG.
- **Security Alpha: renaming a zone label now updates Home Assistant in place** after a Toolkit re-import or web UI label edit, instead of keeping the old name until restart.
- **Security Alpha: the bridge's own status request echoes no longer log "verb pending support".**

## [1.20.0] - 2026-07-27

### Added

- **Security Application zone sensors (Alpha).** Zones on the C-Bus Security application (208) now appear as binary sensors (#42), named from your Toolkit labels with device class guessed from the name (PIR/motion, garage, door, window, smoke). On by default via the new `cbus_security_app_id` option; set it to `0` to disable. Alpha: tested against the protocol spec plus one 64-zone panel; zones above 80 are discovered from events only; arm/disarm is not included yet. Report how your panel behaves on #42.
- **A CI watchdog now checks the C-Gate download daily**, so a Clipsal/Schneider portal change is caught before it breaks fresh installs.

### Fixed

- **Security events no longer publish a bogus `OFF` state**, and status reports no longer spam parse warnings.
- **Managed-mode installs now wait for the Supervisor API at boot**, so a slow Supervisor no longer stops the bridge from starting.
- **Failed C-Gate downloads now explain what to do**, including how to install a manually downloaded copy with `upload` mode (`/share/cgate/`).

## [1.19.0] - 2026-07-27

### Fixed

- **Group 255 placeholder labels are no longer imported from Toolkit projects.** Toolkit writes an "\<Unused\>" terminator group at 255 into every application; the importer now skips it and removes labels saved by earlier imports. (#41)

## [1.18.0] - 2026-07-26

### Added

- **Entity types can now come from your C-Bus hardware.** The new "Set entity type from C-Bus unit type" option (off by default) types each lighting group by the unit driving it: dimmer channels stay dimmable lights, relay channels become lights with no brightness control, and input-only groups become binary sensors. (#38, #37)
- A relay-driven group keeps its entity id, so automations keep working; it only loses the brightness slider. A group that becomes a binary sensor gets a new entity id, so update automations, scripts and dashboards that used the old light.
- Group names still win over hardware: a relay-driven group named "Patio Blind" stays a cover. Unrecognised unit types are left unchanged and logged. Bus couplers are treated as input units, but this is untested on real hardware.
- **C-Bus Toolkit can now reach the C-Gate running inside the add-on.** The new "External C-Gate clients" option lists allowed addresses and access levels (monitor, operate, program). (#37)
- C-Gate's ports can be mapped in Home Assistant's Network panel (unmapped by default). Read the docs first: these ports have no authentication, program level can shut C-Gate down, and an address ending in 255 means the whole subnet. Managed mode only.

### Fixed

- **A USB PC Interface renamed after a replug or reboot now recovers on its own.** The add-on finds the interface by identity and repoints the project at it. Choosing a by-id device path avoids the problem entirely. (#28)

### Changed

- **The add-on now writes its own C-Gate access rule** instead of relying on the one C-Gate ships with, and preserves any rules you added by hand.
- The documentation now correctly spells out the entity-type decision order: manual override, entity-id-style name, cover keywords, C-Bus unit type, then default dimmable light.

## [1.17.6] - 2026-07-22

### Changed

- **The changelog has been rewritten in plain language** back to the first release, and a style guide added to the contributor docs.

## [1.17.5] - 2026-07-22

### Changed

- **USB-serial PC Interfaces are now supported in beta.** Validated with the native USB 5500PCU and a 5500PC over a USB-to-serial adapter, including projects saved on Windows.

## [1.17.4] - 2026-07-22

### Added

- **C-Gate downloads now retry when the network corrupts them**, and tell you how to install a manually downloaded copy if retries fail.

## [1.17.3] - 2026-07-21

### Added

- **Projects saved on Windows now work with a USB PC Interface.** The Windows COM port in the project is rewritten to your configured serial device on every start.
- Startup serial diagnostics now list each network's interface type, address and state.

## [1.17.2] - 2026-07-21

### Added

- **Brute-force protection for the web UI.** After 20 failed web API key attempts in a minute from one client, further attempts are rejected. Configurable; valid keys unaffected.

### Fixed

- **A failing event stream can no longer crash the add-on.**

### Changed

- Base images moved to a supported Alpine release, restoring security updates.

## [1.17.1] - 2026-07-21

### Fixed

- **Target humidity now shows on climate entities.**
- **Changing the temperature or fan of an off thermostat no longer turns it on.**
- **Fan speed is now remembered across automatic fan mode.**

## [1.17.0] - 2026-07-20

### Added

- **Name a group with its Home Assistant entity id to set its type.** With the new "type from label prefix" option (off by default), `cover.bedroom_shutter` becomes a cover, `switch.porch_light` a switch, and so on. Prefixes: light, cover, switch, relay, pir. A manual type override still wins.
- **Each group now reports which unit changed it** on a new `source_unit` topic, so automations can react to a physical switch press or ignore bridge-originated changes.

## [1.16.3] - 2026-07-20

### Added

- **A clear warning when managed C-Gate has no project**, explaining the "Network not found" symptom and the fix. Importing labels in the web UI does not install the project; the database still goes in the share folder.

### Fixed

- Startup serial diagnostics now query C-Gate's interface list with the correct command.

## [1.16.2] - 2026-07-20

### Added

- **Discovery now refreshes the moment a network finishes syncing**, instead of waiting for the polling fallback.

### Fixed

- Some C-Gate event lines were silently dropped because of their prefix format.

## [1.16.1] - 2026-07-19

### Added

- **The startup sync log now names the units it is waiting for** by address and type.

## [1.16.0] - 2026-07-19

### Added

- **Temperature sensors now appear automatically** from any Temperature Broadcast group, no configuration needed.
- **Thermostat fault alerts:** each air-conditioning thermostat gains "plant problem" and "temperature sensor problem" indicators.
- **Humidity support for air conditioning:** current and target humidity on climate entities, plus humidity mode and plant state topics. Read-only, and not yet tested against real humidity hardware.
- **Fan mode control:** switch thermostats between automatic and continuous fan (when control is enabled), with current fan mode and speed on the climate card.
- **Faster, quieter startup:** each air-conditioning zone is asked for its full state the first time it appears.

### Fixed

- Sub-zero zone temperatures now read correctly.
- Fan-only broadcasts are no longer misread as a 127 °C setpoint.
- **Changes from Home Assistant no longer reset a thermostat's own settings** (setback, guard, fan configuration, per-mode setpoints), and rapid temperature adjustments are collapsed into one command.
- Fixed a regular-expression performance issue in web request handling.

### Changed

- Internal: type-checking enabled across the source, CI dependencies updated.

## [1.15.15] - 2026-07-19

### Fixed

- **Startup no longer re-scans the network tree in a loop when some units have no groups.** Units that control no groups (some sensors, for example) no longer trigger repeated full tree re-fetches. (#25)

### Changed

- Internal: integration-test failures now dump the container logs.

## [1.15.14] - 2026-07-19

### Added

- **Air-conditioning plant errors are now reported** as an error code and plain-language description (heater, cooler or fan failure, sensor failure, service or filter required), with a warning logged until the error clears.
- **Fan speed and fan mode readings for air conditioning**, shown on climate entities. Fan mode is read-only in this release.

### Fixed

- Errors while handling C-Gate traffic now log both the error and the offending line.

## [1.15.13] - 2026-07-19

### Added

- **Serial device dropdown for the USB-serial PC Interface alpha**, listing devices actually detected on the host. Custom paths (such as by-id, which survives replugging) are still possible via the YAML editor. (#28)
- **Startup diagnostics for the serial alpha**, logging the resolved device and C-Gate's port and interface lists in a paste-ready block. (#28)

### Fixed

- **The built-in C-Gate download is now verified against a pinned checksum.** Your own checksum still overrides it.

### Changed

- Internal: type-checking extended and a test-only shutdown hang fixed; no runtime behaviour change.

## [1.15.12] - 2026-07-18

### Added

- **Alpha support for USB PC Interfaces in managed mode (#28).** A new opt-in serial device option (hidden by default, so upgrades change nothing) passes a 5500PC or 5500PCU attached to the host through to C-Gate. Known limitations are documented; report results on #28.
- Documented that USB PC Interfaces also work today via remote mode.

## [1.15.11] - 2026-07-18

### Fixed

- **Label save and import no longer fail with "Unauthorized" from the side panel** when no web API key is configured, and a failed save is now surfaced instead of silently dropped. (#33)
- **Groups missing at startup are now discovered automatically** once C-Gate finishes syncing, with a bounded retry (30, 60, then 120 seconds) while units remain unsynced. (#25)
- **Malformed addresses in command topics are now rejected** instead of silently truncated.

### Changed

- **Custom C-Gate downloads now require a checksum.** If you use a custom download address, set its checksum before upgrading.
- Internal: web server split into modules; local linting now matches CI.

## [1.15.10] - 2026-07-12

### Fixed

- **A manual tree refresh no longer creates duplicate "unknown" entities** in Home Assistant. (#25)
- Documentation typo: corrected the name of the tree refresh topic.

## [1.15.9] - 2026-07-11

### Fixed

- Internal: the release pipeline no longer skips publishing the add-on when an optional integration job is skipped.

## [1.15.8] - 2026-07-11

### Fixed

- **The 64-bit ARM add-on image builds again.**

### Changed

- Internal: add-on image builds now use Docker Buildx with explicit target platforms.

## [1.15.7] - 2026-07-11

### Fixed

- **32-bit ARM images build again**, unblocking the failed 1.15.6 release.
- **Sensitive web pages (labels, status, dashboard, areas, export, live events) now require the same authorization as changes.** Health endpoints stay public.
- Uploaded C-Gate packages without a checksum now log the same integrity warning as downloads.

### Changed

- Reconnect backoff now honours the configured delays, and several hard-coded limits (event log size, event-stream keepalive, MQTT queue size, startup debounce) are now tunable.
- The bridge warns at startup when MQTT broker certificate verification is disabled, and the operator docs now cover broker access control.
- Internal: publishing restricted to real release tags; discovery and option handling refactored with added tests.

## [1.15.6] - 2026-07-11

### Fixed

- **Requests pretending to come through the Home Assistant side panel are rejected, and the web port is no longer exposed by default.** If you re-expose port 8080, set a web API key.
- **Label updates are hardened against malicious keys.**
- **Network auto-discovery no longer probes in a way typical installs can't answer**, removing a recurring log error.
- **Startup no longer warns about MQTT messages queueing before the first connection.**
- **An MQTT login failure no longer restart-loops the add-on** in add-on mode.
- **Project names and login credentials are validated** so embedded newlines or spaces can't inject extra C-Gate commands.
- **Failed C-Gate commands now publish a warning** on the bridge warnings topic instead of failing silently.
- **Overlapping tree requests are de-duplicated**, and stale responses ignored.

### Changed

- Concurrent live event-stream connections are capped (32 by default) to limit denial-of-service on an exposed web port.
- Internal: releases now require multi-architecture builds and the C-Gate integration tests to pass.

## [1.15.5] - 2026-07-10

### Added

- **The automatic device-type options can now be set from the add-on UI** instead of only from a standalone settings file.
- **Multi-architecture images:** 64-bit Intel/AMD, 64-bit ARM and 32-bit ARM.
- More previously hard-coded intervals (MQTT reconnect and connect timeouts, C-Gate reconnect attempts, cover ramp updates) are now configurable.

### Fixed

- **Temperature sensor readings are now published** to MQTT.
- **Network auto-discovery now works out of the box for standalone installs.**
- Discovery no longer leaks stale label state when a pass fails partway through.
- The web server reports a proper error when a page asset fails to stream.
- Corrected the add-on installation instructions in the README.

### Changed

- Removed a never-implemented MQTT command from the accepted command set.
- Internal: release workflow checks added; refactoring and CI guards with no runtime behaviour change.

## [1.15.4] - 2026-06-29

### Fixed

- **Discovery no longer accepts a partially-synced tree as complete**, which could finish "successfully" with zero entities. (#16 follow-up)

## [1.15.3] - 2026-06-29

### Fixed

- **Light statuses now update in managed mode.** A port clash made C-Gate serve the wrong stream, leaving every entity Unknown; existing installs self-heal on the next start. (#21)
- **Discovery waits for C-Bus groups to finish syncing** instead of treating an early, group-less tree as complete and publishing zero entities. (#16)

## [1.15.2] - 2026-06-28

### Fixed

- **Discovery now explains a zero-entity result** and tells you to import your Toolkit project labels via the web UI, instead of looking successful. (#16)

## [1.15.1] - 2026-06-28

### Fixed

- **Discovery now works on C-Gate 3.7.1**, which rejected the network addressing used by the device-tree request. (#23)

## [1.15.0] - 2026-06-28

### Added

- **You can now upgrade the managed C-Gate version without losing your project.** Turn on the new Force C-Gate Reinstall option, or in upload mode drop a newer C-Gate zip into the share folder. Project databases and C-Gate configuration are preserved. (#16)

## [1.14.9] - 2026-06-21

### Fixed

- **Thermostats and network connectivity sensors no longer vanish after a tree refresh.**

### Changed

- **Clearer Air Conditioning Control option description:** thermostats appear as read-only climate entities without it; enabling it only adds mode and temperature control.

## [1.14.8] - 2026-06-21

### Fixed

- **Discovery no longer finishes with zero entities while the network is still syncing**; it retries until the real units arrive. (#17)

## [1.14.7] - 2026-06-17

### Fixed

- **A clear error for unsupported label-import files**, instead of a baffling XML parse error. Detection looks at content, so a misnamed archive still imports.

## [1.14.6] - 2026-06-17

### Fixed

- **Label import now works in the Home Assistant Android app**, where the project file was previously greyed out.

## [1.14.5] - 2026-06-17

### Fixed

- **Project import now works with C-Bus Toolkit 1.17.x**, which exports a project database instead of XML. Older XML exports still work.

## [1.14.4] - 2026-06-17

### Fixed

- **Discovery now finds your devices at startup, not only after a manual refresh.** An empty tree is treated as still syncing and retried. (#16)
- **No more phantom "unknown" network** from duplicate tree requests.

## [1.14.3] - 2026-06-16

### Fixed

- **Managed mode now actually loads your C-Gate project.** Databases were placed where C-Gate never looks, so every command failed and discovery found nothing. (#16)
- **Project configuration is now reapplied on every start**, not only on a fresh install.

### Changed

- Internal: the integration test now verifies the project loads in managed mode.

## [1.14.2] - 2026-06-16

### Fixed

- **The thermostat card's temperature range now matches the hardware** (10 to 32 °C), so Home Assistant no longer offers values the thermostat rejects.
- **Thermostat cards update instantly** after a change from Home Assistant.
- **A mirrored controller can be hidden** by adding its unit to the label exclude list.
- **Lights named like covers stay lights** (for example Garage Door Lamps).
- **Project import works with more Toolkit exports**, including archives with different internal letter casing.
- **No more spurious air-conditioning parse warnings.**

## [1.14.1] - 2026-06-15

### Fixed

- **Clearer message when cgateweb can't reach C-Gate**, listing what to check instead of a bare timeout.
- **The setpoint is no longer lost when a thermostat turns off.**
- **The Air Conditioning control option reads correctly in standalone mode.**
- **The status page now escapes labels and addresses.**
- **Secrets are now redacted from logs.**
- **Faster failover signalling:** a dropped command connection is reported immediately instead of up to 30 seconds later.

### Changed

- Internal: error handling and shutdown tidied; CI hardened (add-on image built on every pull request, translation parity validated, minimum Node version 20).

## [1.14.0] - 2026-06-14

### Added

- **Control your C-Bus thermostats from Home Assistant.** Set mode and target temperature of native air-conditioning thermostats from the climate card. Opt-in via the new Air Conditioning Control option (off by default) because it writes to live heating and cooling.

### Changed

- Internal: startup scripts hardened; no functional change.

## [1.13.1] - 2026-06-13

### Added

- **Network connectivity sensors.** Each monitored network exposes a connectivity sensor, so you can alert or automate on a network going offline.
- **Optional offline notification** (off by default): a Home Assistant persistent notification while a network's link is down.

## [1.13.0] - 2026-06-13

### Added

- **C-Bus network link status on the status page.** Detects when the link between C-Gate and the network drops, highlights the indicator, and logs dropouts and recoveries. Poll interval configurable (30 seconds default; set to 0 to disable).

## [1.12.1] - 2026-06-13

### Fixed

- **The Air Conditioning option is now translated in every language.**
- The label-edit API now skips potentially malicious keys in requests, as defence in depth.

### Changed

- **Web UI timeouts are now tunable** (diagnostics active-device window, areas cache lifetime, Supervisor API timeout), with unchanged defaults.

## [1.12.0] - 2026-06-13

### Added

- **Air-conditioning thermostats now appear automatically in Home Assistant** as climate entities showing current temperature, setpoint, mode and running action. Requires the Air Conditioning option and discovery.
- This first release is read-only: no control commands yet.

## [1.11.4] - 2026-06-13

### Added

- **Live running action for air conditioning** (heating, cooling, fan, idle), published per thermostat.
- **Verified air-conditioning mode codes** for cool, auto and fan-only against real thermostat captures.

### Fixed

- **No bogus setpoint in fan-only mode** (previously decoded as 127 °C).

## [1.11.3] - 2026-06-10

### Added

- **Air conditioning: mode, setpoint, and multiple thermostats.** Off and heat verified; cool, auto and fan-only best-effort. Thermostats sharing a zone group no longer collide.

### Changed

- **Air-conditioning topics are now keyed by thermostat unit, not zone group.** Only affects the opt-in Air Conditioning feature from 1.11.0.

## [1.11.1] - 2026-06-06

### Fixed

- **The 1.11.0 release now actually ships**; a lint failure had blocked its build.

## [1.11.0] - 2026-06-06

### Added

- **Native C-Bus air-conditioning room temperature**, published per zone. Enable with the Air Conditioning application option (off by default). Read-only for now.

### Fixed

- Documentation now cites the real air-conditioning application number, 172.

## [1.10.1] - 2026-05-31

### Fixed

- **The cover stop button now works.** Stop commands were silently dropped, so blinds would open and close but never stop mid-travel.

## [1.10.0] - 2026-05-30

### Added

- **Automatic cover detection.** Groups whose label mentions a blind, shutter, shade, awning, curtain, roller or garage door are discovered as covers instead of lights. On by default with adjustable keywords; a manual type override always wins.

### Fixed

- **Project import no longer fails with "Unauthorised" through the side panel** when no web API key is configured.
- **HVAC type overrides now produce a working thermostat** with the full climate payload.

## [1.9.4] - 2026-05-27

### Changed

- **The web UI is now usable on phones and tablets.**

### Security

- **API key comparison is now constant-time**, removing a timing side channel.
- **Project imports are guarded against zip bombs** and archived-file path tricks.
- **Security headers on every web response.**
- **Managed-mode installs verify archive contents** before extracting.

## [1.9.3] - 2026-05-27

### Fixed

- **Label edits from the web UI update Home Assistant again** without waiting for something else to reload the file.

## [1.9.2] - 2026-05-26

### Changed

- **Quieter logs.** Two high-volume lines moved from info to debug, about 45% of typical log volume. Set the log level option to debug for the full trace.

## [1.9.1] - 2026-05-24

### Changed

- **Lower memory footprint and faster startup in managed mode** (roughly 30-50 MB less memory), and the bridge's memory is capped so a fault can't starve other add-ons. Remote mode unaffected.
- **Faster readiness at startup:** the web UI and initial discovery no longer delay the ready signal.
- Internal: smaller Docker image, CI gates, a container health check, and bounded internal caches.

## [1.9.0] - 2026-05-24

### Added

- **Discovery retry tuning:** new settings control how long and how often discovery retries the network tree at startup.
- **The web upload size limit is now configurable** for unusually large project files.

### Fixed

- **Discovery no longer gets stuck on a malformed tree response**; it retries with backoff and eventually pauses with a clear state.

### Changed

- Internal: discovery internals simplified and CI hardened; no behaviour change.

## [1.8.10] - 2026-05-24

### Added

- **Install your Toolkit project into managed C-Gate via the share folder.** Drop the project database into the share folder and restart. The sync is timestamp-aware, so changes C-Gate saves are never overwritten.
- **The web import now warns that it's labels-only** and points at the managed-mode workflow for installing the project itself. (#9)

### Changed

- Documentation: new section on loading your C-Gate project in managed mode.

## [1.8.9] - 2026-05-09

### Added

- The MIT license now ships alongside the installable add-on.

## [1.8.8] - 2026-05-07

### Fixed

- **Managed mode no longer fails with an invalid download address** when the download option is unset.

## [1.8.7] - 2026-05-05

### Fixed

- **Entities no longer get stuck unavailable after a restart.** Messages published while the broker is disconnected are now queued and replayed on reconnect.

## [1.8.6] - 2026-05-05

### Added

- **Removed networks are cleaned up in Home Assistant** instead of sitting offline forever.

## [1.8.5] - 2026-05-04

### Added

- **Discovery refreshes the moment a network comes up**, eliminating the discovery delay on cold starts.

### Changed

- Internal: more robust parsing of C-Gate event lines.

## [1.8.4] - 2026-05-04

### Added

- **A per-network discovery health sensor** (discovering, ok, or paused) so you can see whether auto-discovery is healthy without reading the logs.

## [1.8.3] - 2026-05-04

### Changed

- Internal: discovery retry bookkeeping simplified; no behaviour change.

## [1.8.2] - 2026-05-04

### Fixed

- **Custom C-Gate ports now actually take effect in managed mode**; they were previously written under names C-Gate ignores.

## [1.8.1] - 2026-05-04

### Fixed

- **Discovery no longer gives up when C-Gate is still starting.** The tree request is retried for about a minute, after which a warning explains how to refresh manually.

## [1.8.0] - 2026-04-29

### Changed

- **Less log noise when the MQTT broker isn't up yet:** one warning per disconnect and a rolled-up count of dropped messages on reconnect.
- **Quieter network auto-discovery fallback** on C-Gate versions without the project-level query.
- Internal: discovery payload construction deduplicated; no behaviour change.

## [1.7.2] - 2026-04-19

### Fixed

- **Importing a project file works on a fresh install** with no label file configured.
- **A clearer error in standalone mode** when no label file path is set.
- Removed a duplicated prefix in import error messages.

## [1.7.1] - 2026-04-14

### Fixed

- **Compatibility with Home Assistant versions before 2025.10** restored in discovery payloads.

## [1.7.0] - 2026-04-14

### Fixed

- **Home Assistant 2026.4 compatibility** for MQTT discovery.

## [1.6.1] - 2026-04-05

### Fixed

- The area picker works again after Home Assistant removed the endpoint it used, and now shows full area names.
- The save confirmation shows the real label count instead of "undefined".
- Removed a spurious scrollbar on the tab bar.

## [1.6.0] - 2026-04-05

### Fixed

- The Live Events panel toggles correctly again, and the area column no longer truncates text.

### Changed

- **Tabbed web interface:** Status, Device Labels, Live Events and Import/Export, with state preserved between switches.
- Internal: CI modernised and test coverage expanded.

### Security

- Managed-mode C-Gate downloads are hardened: secure download addresses only, timeouts, a size cap, symlink rejection, stricter file permissions and Java memory limits.

## [1.5.5] - 2026-04-04

### Changed

- Translation refinements for Czech, Danish, Norwegian, Polish, Swedish and Ukrainian.

## [1.5.4] - 2026-04-04

### Added

- **Complete option translations** for all 16 non-English languages.

### Changed

- Internal: test coverage expanded.

## [1.5.3] - 2026-04-04

### Fixed

- **A searchable area dropdown in the label editor**, showing areas from Home Assistant and your labels.
- Area dropdown polish: caching, no double-commit on click, Tab or Escape, arrow-up deselects.
- **MQTT reconnection fixed** after a failed first connection attempt.
- **Cover state fixed** for plain on commands without a level.
- **HVAC mode fixed:** a level of zero is a 0 °C setpoint, not off.
- More reliable parsing of level-change events, and a cap on an internal buffer that could grow unbounded.

### Changed

- Performance improved: higher event and command throughput and lower latencies.

### Security

- **Cross-origin protection fixed:** disallowed websites can no longer call the API from a visitor's browser.
- **Rate limiting can no longer be spoofed** through forwarded-address headers.
- All responses now tell browsers not to second-guess content types.

## [1.5.2] - 2026-04-04

### Fixed

- **Upgrading from 1.4.x no longer fails** with a missing-option error.

## [1.5.1] - 2026-04-04

### Added

- **Startup diagnostics summary** logging connections, networks, features and labels on boot.
- **A bridge statistics topic** with version, uptime, connection, queue and discovery stats.
- **A web dashboard** with bridge health, the device list, and recent event counts.
- Warnings for unrecognised settings in standalone mode, catching settings-file typos.
- Validation of the C-Bus name setting, and warnings when the command queue is full.
- The dim up/down timeout is now configurable.

### Fixed

- **Lights no longer appear stuck on** due to a misread level-change event.
- **Very dim lights no longer report as off** at the lowest brightness steps.
- HVAC mode now correctly reports off after a ramp-to-zero command.
- Tree responses arriving before discovery is ready are buffered instead of dropped.
- The bridge no longer gets stuck after all connections drop and recover.
- Writes to a dead socket and malformed C-Gate lines can no longer crash processing.

### Changed

- **The add-on configuration page is much simpler:** about five essential options, with the rest behind "Show unused optional configuration options".
- Improved cleanup on shutdown, stricter input validation, and clearer certificate error messages.

## [1.4.30] - 2026-03-29

### Fixed

- **Devices no longer turn off when the bridge restarts.** Stale retained commands from the broker are now ignored; only fresh commands run.
- Polling applications you don't use now logs a warning instead of an error.

## [1.4.29] - 2026-03-29

### Added

- **A live event log in the label editor**, streaming C-Bus events with click-to-filter, pause and clear.
- **Stale device detection:** devices that stop reporting are counted on a new sensor after a configurable threshold (24 hours default).

## [1.4.28] - 2026-03-29

### Added

- **Per-application poll intervals:** poll different applications at different rates, or disable polling per application.
- **Smooth cover movement:** intermediate positions are published during a position command; duration configurable.

## [1.4.27] - 2026-03-28

### Added

- **Undo and redo in the label editor** (up to 50 steps), including bulk operations and imports.
- **Project XML export** from the web UI.
- **Trigger groups appear as scenes** so they can be fired from the UI and automations (configurable, on by default).

### Changed

- Internal: test configuration fix.

## [1.4.26] - 2026-03-28

### Added

- **Cover tilt support** for venetian and louvre blinds on a separate tilt application.
- **Automatic network discovery** as a fallback when no networks are configured (on by default).
- **Label editor pagination** (25, 50, 100 or all rows), remembered between visits.
- **Label backup download** from the browser.
- **Automatic room suggestions** from device names in the label editor.

### Fixed

- Cover polling responses verified end-to-end, with regression tests.

## [1.4.25] - 2026-03-28

### Fixed

- The area column is now visible and editable in the label editor.

## [1.4.24] - 2026-03-28

### Added

- **Room assignment in the label editor:** Home Assistant auto-assigns the entity to that area on first discovery.
- Documentation for HVAC, trigger groups, PIR and relay applications, plus a C-Bus application reference table.

### Fixed

- **Cover positions and HVAC states are known immediately after a restart**; the startup poll now covers all configured applications.
- Internal: test processes now exit cleanly.

## [1.4.23] - 2026-03-28

### Added

- **HVAC climate zones in Home Assistant**, with current temperature, setpoint control and mode.
- **Fire C-Bus scenes from Home Assistant:** each trigger group gets a companion button entity.
- Trigger groups now appear in the label editor with a read-only type badge and exclude toggle.
- **Automatic cleanup of stale entities** when a device is excluded or changes type.
- **Connection keep-alive pings** on the event connection, with a configurable interval.

### Fixed

- Trigger groups are correctly identified in the label editor, and their type can't be changed accidentally.

## [1.4.22] - 2026-03-28

### Added

- **Trigger events in Home Assistant:** trigger group presses appear as event entities for automations.
- Connection pool tuning options in the add-on UI.
- **Bulk editing in the label editor:** multi-select, bulk type assignment and exclusion, shift-click ranges.

### Fixed

- Cover entities now wait for confirmed position feedback before updating.

### Changed

- Internal: the integration test now validates discovery message format.

## [1.4.21] - 2026-03-28

### Added

- **Encrypted MQTT connections:** TLS options for external brokers, including self-signed CA certificates and optional verification bypass.

## [1.4.20] - 2026-03-28

### Added

- **The C-Gate version appears as a diagnostic entity**, populated automatically in managed mode.
- The label editor's status panel now shows bridge version, uptime and reconnect counts.

### Fixed

- **Multiple networks are all polled**, not just the first.

### Changed

- Internal: the CI pipeline now runs the managed-mode integration test on every push.

## [1.4.19] - 2026-03-28

### Fixed

- **Multiple networks are all polled**, not just the first.
- Bridge diagnostic entity names now publish correctly.
- The status panel's refresh timer is cleaned up when you leave the page.

### Changed

- Internal: the CI pipeline now runs the managed-mode integration test on every push.

## [1.4.18] - 2026-03-28

### Fixed

- Internal: corrected a CI coverage threshold.

## [1.4.17] - 2026-03-28

### Fixed

- Internal: fixed a lint error blocking the build.

## [1.4.16] - 2026-03-28

### Fixed

- **The label editor works through the Home Assistant side panel again** (previously a 502 error).

## [1.4.15] - 2026-03-28

### Added

- Internal: end-to-end integration test covering the full managed-mode stack.

## [1.4.14] - 2026-03-28

### Fixed

- **Managed mode handles Schneider's download package correctly** (it contains a nested archive).
- **The default C-Gate download address works again**, updated from a dead link.
- Clearer errors when a C-Gate download fails.
- Internal: local test environment expanded.

## [1.4.13] - 2026-03-28

### Added

- Internal: a local test environment for validating managed mode without a real Supervisor.

### Fixed

- **Managed mode no longer restart-loops C-Gate.**
- Custom C-Gate ports are now written to C-Gate's configuration during install so they take effect.

## [1.4.12] - 2026-03-10

### Added

- **Bridge health entities in Home Assistant:** ready state, lifecycle, connection status, command queue depth and a reconnect indicator.

### Changed

- Internal: faster event-line parsing.

## [1.4.11] - 2026-03-04

### Fixed

- Interactive commands keep their priority instead of being downgraded behind routine traffic.

### Changed

- Internal: test coverage for command priority handling.

## [1.4.10] - 2026-03-04

### Changed

- Internal: version alignment only.

## [1.4.9] - 2026-03-04

### Changed

- Internal: version alignment only.

## [1.4.8] - 2026-03-04

### Fixed

- Startup validation consolidated, removing duplicated checks.
- Managed-mode installs now verify download checksums and default to local-only interface access.

### Changed

- **Web API hardened by default:** changes now require authentication unless explicitly overridden, cross-origin requests are restricted to a configurable allowlist, and unauthenticated writes require an explicit unsafe toggle.
- **New health endpoints and richer runtime status.**
- More reliable discovery when several tree requests are queued at once.

## [1.2.2] - 2026-02-28

### Fixed

- **Cover position sliders now work for type-overridden covers** on the lighting application.

## [1.2.1] - 2026-02-22

### Fixed

- **Clearer MQTT login errors**, with fix steps for add-on and standalone setups.

## [1.2.0] - 2026-02-22

### Added

- **Label management:** custom names for C-Bus groups, resolved from your labels file, then C-Gate's project data, then a fallback.
- **Toolkit project import** to pull in device labels.
- **A web-based label editor** in the Home Assistant side panel.
- **Type overrides** to mark a group as a light, cover or switch.
- **Entity id hints** to keep existing ids when migrating from manual YAML.
- **Group exclusion** from discovery.
- **Live label reloads:** edits are picked up and republished automatically.
- A command-line tool for label inventory and migration.
- Managed or remote C-Gate modes, automatic MQTT setup from the Supervisor, a 17-language configuration UI, and process supervision for the bundled C-Gate.

### Fixed

- A listener leak on restart, label watching starting at the wrong time, and imports now preserve your type overrides, entity ids and exclusions.

### Changed

- Friendlier entity names in Home Assistant, with no more doubled names.
- Stale discovery entries are cleared automatically when a type override changes an entity's type.
- Discovery is supplemented from your labels file when C-Gate's data is incomplete.

## [1.1.0] - 2026-02-22

### Fixed

- A memory leak where reconnecting connections left orphaned stream handlers behind.

### Changed

- **Much faster publishing:** events reach Home Assistant almost instantly instead of 200-600 ms late, and a full 100-device status poll completes in under a second instead of 40-plus seconds.
- Internal: connection pooling, tree parsing and logging efficiency improvements.

## [1.0.0] - TBD

### Added

- Initial Home Assistant add-on release.
- Automatic configuration from add-on options, with validation and a user-friendly configuration UI.
- Standalone and add-on installation modes.
- Home Assistant MQTT discovery for lights, covers and switches.
- Multi-architecture image support.
- Network access for C-Gate connectivity.
- Documentation and troubleshooting guide.

---

**Note**: This add-on is based on the [cgateweb](https://github.com/dougrathbone/cgateweb) Node.js application. For the core application changelog, see the main repository.
