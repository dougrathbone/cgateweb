# Changelog

All notable changes to the C-Gate Web Bridge Home Assistant add-on will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-dougrathbone-FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/dougrathbone)

If this add-on saves you time, you can [buy me a coffee](https://buymeacoffee.com/dougrathbone).

Releases before 1.22.0 are in the [changelog archive](https://github.com/dougrathbone/cgateweb/blob/master/homeassistant-addon/CHANGELOG-archive.md).

## [1.37.0](https://github.com/dougrathbone/cgateweb/releases/tag/v1.37.0) - 2026-10-07

### Added

- **The add-on log shows your C-Gate version and warns when it is older than 3.8.0, including a remote C-Gate.** ([#122](https://github.com/dougrathbone/cgateweb/issues/122))

## [1.36.2](https://github.com/dougrathbone/cgateweb/releases/tag/v1.36.2) - 2026-10-06

### Fixed

- **A device scan interrupted by another network's scan is retried.**
- **A cover keeps its position when a ramp ends without reporting a level.**
- **Saving settings applies a changed network list and alarm disarm limit without a restart.**

### Security

- **Alarm arm and bypass commands are now rate-limited, separately from disarm.**

## [1.36.1](https://github.com/dougrathbone/cgateweb/releases/tag/v1.36.1) - 2026-10-05

### Fixed

- **An unset C-Gate install source now uses a zip already in the share folder.** Place C-Gate 3.8.0 there if Toolkit leaves the network Closed. ([#122](https://github.com/dougrathbone/cgateweb/issues/122))

## [1.36.0](https://github.com/dougrathbone/cgateweb/releases/tag/v1.36.0) - 2026-10-04

### Fixed

- **Upload mode installs the newest C-Gate zip when several are in the share folder.**
- **A congested C-Gate command is no longer sent twice.**
- **A label edit made outside the web UI is picked up again.**
- **The built-in C-Gate download checksum matches the package Schneider is serving.**

## [1.35.3](https://github.com/dougrathbone/cgateweb/releases/tag/v1.35.3) - 2026-10-02

### Fixed

- **Startup no longer reports the C-Bus network offline while a USB interface is opening.**
- **One bad C-Gate event no longer drops the events that follow it.**

### Security

- **Checking the web API key no longer reveals the key's length.**

## [1.35.2](https://github.com/dougrathbone/cgateweb/releases/tag/v1.35.2) - 2026-10-01

### Fixed

- **An internal MQTT login failure now says to restart the Mosquitto add-on first.** Set a username and password only if it still cannot connect. ([#143](https://github.com/dougrathbone/cgateweb/issues/143))

## [1.35.1](https://github.com/dougrathbone/cgateweb/releases/tag/v1.35.1) - 2026-09-30

### Action required

- **Restart the add-on if Toolkit reports No Catalog Available.**

### Fixed

- **C-Bus Toolkit can load the unit catalogue from managed C-Gate on the current add-on runtime.** The 1.34.14 fix covered the same message only when C-Gate was left in server mode. ([#122](https://github.com/dougrathbone/cgateweb/issues/122))

## [1.35.0](https://github.com/dougrathbone/cgateweb/releases/tag/v1.35.0) - 2026-09-29

### Fixed

- **A USB PC Interface stuck while opening is now closed and reopened automatically.** ([#122](https://github.com/dougrathbone/cgateweb/issues/122))
- **Startup waits for the C-Bus interface before polling, avoiding repeated command failures.** ([#122](https://github.com/dougrathbone/cgateweb/issues/122))
- **Discovery keeps retrying while the C-Bus interface is unavailable.** ([#122](https://github.com/dougrathbone/cgateweb/issues/122))
- **Managed C-Gate file logs stay within 500 MiB between restarts unless you raise the maximum log size.** ([#122](https://github.com/dougrathbone/cgateweb/issues/122))

## [1.34.16](https://github.com/dougrathbone/cgateweb/releases/tag/v1.34.16) - 2026-09-29

### Fixed

- **A stuck USB PC Interface recovers on its own, and managed C-Gate logs are size-limited.** ([#122](https://github.com/dougrathbone/cgateweb/issues/122))

## [1.34.15](https://github.com/dougrathbone/cgateweb/releases/tag/v1.34.15) - 2026-09-28

### Fixed

- **Restarting the add-on no longer logs duplicate MQTT unique id errors.** ([#133](https://github.com/dougrathbone/cgateweb/issues/133))
- **Clock date and time are published at startup, before the next bus broadcast.** ([#131](https://github.com/dougrathbone/cgateweb/issues/131))
- **Holding dim up no longer jumps the light to full brightness.** ([#129](https://github.com/dougrathbone/cgateweb/issues/129))
- **A lighting poll stopped during startup now resumes when device discovery finishes.** ([#122](https://github.com/dougrathbone/cgateweb/issues/122))

## [1.34.14](https://github.com/dougrathbone/cgateweb/releases/tag/v1.34.14) - 2026-09-22

### Action required

- **Restart the add-on if Toolkit reports No Catalog Available.**
- **Turn bridge diagnostics and stale device detection back on if you still want those entities.**

### Fixed

- **C-Bus Toolkit can load the unit catalogue when managed C-Gate is not left in server mode.** ([#122](https://github.com/dougrathbone/cgateweb/issues/122))
- **A state poll that a startup error stopped now resumes once the network finishes syncing.** ([#122](https://github.com/dougrathbone/cgateweb/issues/122))
- **Toolkit connects and disconnects are logged as session events instead of unhandled responses.**
- **The command queue size limit comes from the configuration schema instead of a hardcoded value.**

### Changed

- **Discovered entities show as unavailable in Home Assistant while the bridge is offline.** ([#128](https://github.com/dougrathbone/cgateweb/issues/128))
- **Optional diagnostic entities are off by default.**
- **Measurement channels appear under the device that reports them.**

## [1.34.13](https://github.com/dougrathbone/cgateweb/releases/tag/v1.34.13) - 2026-09-21

### Fixed

- **Blocked alarm arm attempts now show as arming until the panel confirms its mode.** ([#115](https://github.com/dougrathbone/cgateweb/issues/115))

### Security

- **The MQTT client rejects malformed broker packets that could stop the bridge.**

## [1.34.12](https://github.com/dougrathbone/cgateweb/releases/tag/v1.34.12) - 2026-09-18

### Fixed

- **Zones that close after a force-arm leave the bypassed-zones list.** ([#118](https://github.com/dougrathbone/cgateweb/issues/118))
- **Password entry success and failure from the alarm keypad now show in the logs.** ([#116](https://github.com/dougrathbone/cgateweb/issues/116))

## [1.34.11](https://github.com/dougrathbone/cgateweb/releases/tag/v1.34.11) - 2026-09-12

### Security

- **MQTT and C-Gate download addresses no longer log passwords or query tokens.**

## [1.34.10](https://github.com/dougrathbone/cgateweb/releases/tag/v1.34.10) - 2026-09-11

### Fixed

- **The status page reports when it cannot bind.** C-Gate and MQTT stay up, and Home Assistant diagnostics show that the web UI is down.

## [1.34.9](https://github.com/dougrathbone/cgateweb/releases/tag/v1.34.9) - 2026-09-11

### Security

- **Toolkit project imports no longer follow symbolic links while extracting an archive.**

## [1.34.8](https://github.com/dougrathbone/cgateweb/releases/tag/v1.34.8) - 2026-09-11

### Action required

- **Set a web API key before publishing the web port outside Home Assistant Ingress.**

### Fixed

- **Dimmer increase and decrease no longer fail silently.** If the current level is not reported in time, the command is dropped and a warning is logged.

### Security

- **Project imports reject symbolic links inside ZIP archives.**
- **The web UI warns when it is bound off loopback without an API key.**

## [1.34.7](https://github.com/dougrathbone/cgateweb/releases/tag/v1.34.7) - 2026-09-06

### Action required

- **Turn off any C-Gate ports in the Network panel that you do not want published on the host.**

### Fixed

- **C-Bus Toolkit can reach managed C-Gate again after an upgrade.** Command, event, status, and SSL ports are published on the host by default. ([#104](https://github.com/dougrathbone/cgateweb/issues/104))

## [1.34.6](https://github.com/dougrathbone/cgateweb/releases/tag/v1.34.6) - 2026-09-04

### Changed

- **Maintenance release; no user-facing changes.**

## [1.34.5] - 2026-09-04

**This version was not published.** It had no user-facing changes. Install 1.34.6 or later.

### Changed

- **Maintenance release; no user-facing changes.**

## [1.34.4](https://github.com/dougrathbone/cgateweb/releases/tag/v1.34.4) - 2026-09-04

### Changed

- **Maintenance release; no user-facing changes.**

## [1.34.3](https://github.com/dougrathbone/cgateweb/releases/tag/v1.34.3) - 2026-09-04

### Changed

- **Maintenance release; no user-facing changes.**

## [1.34.2](https://github.com/dougrathbone/cgateweb/releases/tag/v1.34.2) - 2026-09-04

**This version was not published.** Its changes are included from 1.34.3.

### Fixed

- **Managed C-Gate still installs when Schneider re-packages the download.** A new wrapper around the same C-Gate no longer fails the checksum check.

## [1.34.1](https://github.com/dougrathbone/cgateweb/releases/tag/v1.34.1) - 2026-09-03

### Fixed

- **The alarm panel entity now appears in Home Assistant.** Installs without Security Panel Control had no panel at all.
- **A C-Bus network whose interface keeps dropping no longer floods C-Gate.** Repeated network syncs now trigger at most one refresh a minute.
- **Failed C-Gate commands now say why.** A dropped interface is named, and identical errors are counted rather than repeated.
- **Saving labels no longer refreshes discovery a second time on a busy system.**

## [1.34.0] - 2026-09-02

**This version was not published.** It had no user-facing changes. Install 1.34.1 or later.

### Changed

- **Maintenance release; no user-facing changes.**

## [1.33.0](https://github.com/dougrathbone/cgateweb/releases/tag/v1.33.0) - 2026-08-27

### Added

- **Raw C-Gate event capture can now be turned on from the add-on.** Leave the application list empty to skip.

### Fixed

- **Turning off unlisted-group discovery now retracts leftover Home Assistant entities.** ([#63](https://github.com/dougrathbone/cgateweb/issues/63))
- **HVAC lighting setpoints now stay within 10 to 32 C, matching the climate entity.**
- **Air-con climate no longer advertises a humidity target Home Assistant would reject.** The setpoint is a diagnostic sensor instead.

## [1.32.0](https://github.com/dougrathbone/cgateweb/releases/tag/v1.32.0) - 2026-08-25

### Added

- **Enable Control groups can be set, labelled, and removed over MQTT.** Opt in with the Enable Control application, usually 203, and send ON on the remove topic to delete a group.

## [1.31.0](https://github.com/dougrathbone/cgateweb/releases/tag/v1.31.0) - 2026-08-25

### Added

- **Bypassed alarm zones are listed on the security panel** as a diagnostic sensor you can put on a dashboard next to the alarm card. ([#62](https://github.com/dougrathbone/cgateweb/issues/62))

### Fixed

- **Alarm panel diagnostics no longer sit unknown after a Home Assistant restart.** Mains, battery, and the other panel sensors are resent with lighting and the clock. ([#62](https://github.com/dougrathbone/cgateweb/issues/62))

## [1.30.1](https://github.com/dougrathbone/cgateweb/releases/tag/v1.30.1) - 2026-08-24

### Fixed

- **Clock date and time sensors now refresh when Home Assistant restarts**, the same way lighting and security already do. ([#66](https://github.com/dougrathbone/cgateweb/issues/66))
- **A clock refresh echo from C-Gate is no longer logged as an unparsed event.** ([#66](https://github.com/dougrathbone/cgateweb/issues/66))

## [1.30.0](https://github.com/dougrathbone/cgateweb/releases/tag/v1.30.0) - 2026-08-23

### Action required

- **Restart the add-on once if managed C-Gate logs have already filled the disk.**

### Fixed

- **Managed C-Gate logs are now rotated and pruned** so they cannot fill the host disk. ([#81](https://github.com/dougrathbone/cgateweb/issues/81))

### Changed

- **The add-on icon and logo are restored** to the earlier blue house-bridge artwork.

## [1.29.0](https://github.com/dougrathbone/cgateweb/releases/tag/v1.29.0) - 2026-08-22

### Added

- **The C-Bus network clock can now be turned on in the add-on.** Date and time from the bus become two diagnostic sensors, and the add-on never sets the clock. ([#66](https://github.com/dougrathbone/cgateweb/issues/66))
- **PIR and relay applications can now be chosen in the add-on.**
- **Groups seen on the bus but missing from Toolkit can become Home Assistant entities.** Off by default, and turning it off does not remove entities already published. ([#63](https://github.com/dougrathbone/cgateweb/issues/63))
- **Temperature Broadcast groups accept a Celsius write** between 0 and 63.75.
- **Scene Module play and record work over MQTT.** Record is off by default because it overwrites module memory.
- **Alarm zones now get C-Gate names, a loop-fault sensor, and password-entry codes 1 to 4.**

### Fixed

- **Clock ticks that arrive with a C-Gate status-channel prefix are now decoded.** ([#66](https://github.com/dougrathbone/cgateweb/issues/66))

## [1.28.1](https://github.com/dougrathbone/cgateweb/releases/tag/v1.28.1) - 2026-08-22

### Changed

- **The changes listed under 1.28.0 reached the add-on repository in this version.**

## [1.28.0] - 2026-08-22

**This version was not published.** Its changes are included from 1.28.1.

### Action required

- **Uninstall and reinstall once if an existing install still builds the add-on on your device.**

### Added

- **The add-on now has its own Home Assistant icon and a first-run guide** covering installation, MQTT setup, and the first ten minutes.

### Fixed

- **Lights now confirm switch and dim commands immediately** instead of waiting for the next C-Bus event.
- **Removed trigger scenes and buttons are now cleaned up** instead of remaining unavailable in Home Assistant.
- **Blank or space-padded MQTT, C-Gate, and web credentials are handled consistently.**
- **Invalid settings reloads are rejected without replacing the working configuration.**

### Changed

- **Home Assistant now downloads a tested prebuilt image** instead of building the add-on on your device.

### Security

- **Sensitive C-Gate, MQTT, and alarm-keypad values are redacted from more error paths.**
- **Label imports now enforce their size limits before parsing** and return safe errors for malformed archives and XML.

## [1.27.0](https://github.com/dougrathbone/cgateweb-homeassistant/releases/tag/v1.27.0) - 2026-08-21

### Breaking changes

- **An alarm that refuses to arm now reports disarmed, not pending.** Pending now means an entry delay, so check automations that trigger on it. ([#42](https://github.com/dougrathbone/cgateweb/issues/42))

### Added

- **Your alarm tells Home Assistant when an entry delay starts.** The panel reports this as pending, which is the state to automate on. ([#42](https://github.com/dougrathbone/cgateweb/issues/42))
- **Air conditioning thermostats now show what the plant is doing.** Damper, plant, fan, comfort, and humidity readings appear as diagnostic entities when the hardware sends them.
- **The C-Bus network clock can be published as a sensor.** Off by default, and the add-on never sets the clock.

### Fixed

- **Managed C-Gate installations now show their installed version and build in diagnostics.** Existing installations showing unknown are repaired on their next start. ([#66](https://github.com/dougrathbone/cgateweb/issues/66))

## [1.26.0](https://github.com/dougrathbone/cgateweb/releases/tag/v1.26.0) - 2026-08-15

### Added

- **You can now see which zones were bypassed when the alarm armed.** Isolated zones are marked on the zone sensor. ([#42](https://github.com/dougrathbone/cgateweb/issues/42))
- **Other C-Bus applications can use the C-Gate client without running this bridge.**

### Fixed

- **Reloading the service now applies your settings file.**
- **The service can start from the directory in the install guide,** including a home-directory checkout and a Node version installed by a version manager.
- **Security and measurement commands with an impossible C-Bus address are now rejected.**
- **The get-all networks setting and the security device-class override are no longer reported as typos.**
- **Checking settings now validates the configuration, and setup no longer overwrites a working settings file.**

### Changed

- **The settings reference covers every setting under both the standalone and add-on names.**
- **The example settings file lists only real settings and the correct C-Gate event port.**

## [1.25.0](https://github.com/dougrathbone/cgateweb/releases/tag/v1.25.0) - 2026-08-15

### Breaking changes

- **Force-arm is no longer included with Security Panel Control.** Turn the separate option on if you still want to arm past an open zone. ([#42](https://github.com/dougrathbone/cgateweb/issues/42), [#62](https://github.com/dougrathbone/cgateweb/issues/62))

### Action required

- **Clear stale measurement readings on your MQTT broker after upgrading.** ([#60](https://github.com/dougrathbone/cgateweb/issues/60))

### Added

- **Analogue sensors on C-Bus now become Home Assistant sensors.** Turn on the Measurement application for readings such as power, temperature, and light level. Off by default. ([#60](https://github.com/dougrathbone/cgateweb/issues/60))

### Fixed

- **Measurement sensors no longer appear as a light at a nonsense brightness.** ([#60](https://github.com/dougrathbone/cgateweb/issues/60))
- **The log now tells you when your project file in the share folder is being ignored,** which file C-Gate is using, and how to make yours replace it. ([#58](https://github.com/dougrathbone/cgateweb/issues/58))
- **A malformed message from C-Gate can no longer stop the add-on.**

### Security

- **Alarm disarm attempts are now limited** to ten every ten minutes per network.
- **Malformed project files, out-of-range addresses, and request floods are rejected** instead of stopping or confusing the add-on.

## [1.24.3](https://github.com/dougrathbone/cgateweb/releases/tag/v1.24.3) - 2026-08-13

### Action required

- **Delete old debug logs or change your alarm PIN if you disarmed with debug logging on in 1.24.0 through 1.24.2.** ([#51](https://github.com/dougrathbone/cgateweb/issues/51))

### Fixed

- **Your alarm PIN no longer appears in debug logs.** ([#51](https://github.com/dougrathbone/cgateweb/issues/51))

### Changed

- **Connecting C-Bus Toolkit to managed C-Gate is now documented.** Map the SSL command port and add your PC to the external clients list. ([#57](https://github.com/dougrathbone/cgateweb/issues/57), [#58](https://github.com/dougrathbone/cgateweb/issues/58))
- **Clearer documentation for the Enable Control application,** including why its groups appear as covers. ([#51](https://github.com/dougrathbone/cgateweb/issues/51))

## [1.24.2](https://github.com/dougrathbone/cgateweb/releases/tag/v1.24.2) - 2026-08-11

### Added

- **C-Gate SSL ports can now be mapped,** so C-Bus Toolkit can connect to a managed C-Gate. This mapping is experimental. ([#57](https://github.com/dougrathbone/cgateweb/issues/57), [#58](https://github.com/dougrathbone/cgateweb/issues/58))

## [1.24.1](https://github.com/dougrathbone/cgateweb/releases/tag/v1.24.1) - 2026-08-11

### Fixed

- **Disarming now actually works.** The PIN added in 1.24.0 was sent but never submitted to the panel. ([#51](https://github.com/dougrathbone/cgateweb/issues/51))
- **Your alarm panel shows its state again after restarting Home Assistant.** ([#51](https://github.com/dougrathbone/cgateweb/issues/51))
- **No more repeated bad object warnings for applications you do not use.** ([#51](https://github.com/dougrathbone/cgateweb/issues/51))

## [1.24.0](https://github.com/dougrathbone/cgateweb/releases/tag/v1.24.0) - 2026-08-10

### Added

- **You can now disarm your alarm from Home Assistant.** Off by default, and the PIN crosses your MQTT broker, so only enable it on a broker you trust. ([#51](https://github.com/dougrathbone/cgateweb/issues/51))

## [1.23.3](https://github.com/dougrathbone/cgateweb/releases/tag/v1.23.3) - 2026-08-07

### Fixed

- **Startup no longer waits on wall switches that drive no load,** and no longer warns that those units failed to sync. ([#37](https://github.com/dougrathbone/cgateweb/issues/37))

## [1.23.2](https://github.com/dougrathbone/cgateweb/releases/tag/v1.23.2) - 2026-08-06

### Fixed

- **Arming the alarm panel from Home Assistant now works.** Away, night, home, and vacation all work. Disarm is not possible over C-Bus. ([#42](https://github.com/dougrathbone/cgateweb/issues/42))
- **A clear error when the add-on is pointed at one of C-Gate's SSL ports** instead of the plain ones, rather than an endless reconnect. ([#52](https://github.com/dougrathbone/cgateweb/issues/52))

## [1.23.1](https://github.com/dougrathbone/cgateweb/releases/tag/v1.23.1) - 2026-08-05

### Fixed

- **The alarm panel Disarm button no longer pretends to work.** C-Bus has no disarm command. Arming still works. ([#42](https://github.com/dougrathbone/cgateweb/issues/42), [#51](https://github.com/dougrathbone/cgateweb/issues/51))
- **Live Events no longer logs transport errors during a backup.** ([#44](https://github.com/dougrathbone/cgateweb/issues/44))

### Changed

- **The add-on now uses the Home Assistant config folder mapping.** Your labels carry over automatically. ([#44](https://github.com/dougrathbone/cgateweb/issues/44))
- **32-bit architectures stay available.** Home Assistant still warns about them. ([#44](https://github.com/dougrathbone/cgateweb/issues/44))

## [1.23.0](https://github.com/dougrathbone/cgateweb/releases/tag/v1.23.0) - 2026-08-04

### Added

- **Your alarm panel now appears as an alarm panel card in Home Assistant,** one per network, with state always coming from the panel. ([#42](https://github.com/dougrathbone/cgateweb/issues/42))
- **Optional arming from Home Assistant,** off by default. The C-Bus arm command carries no PIN, so anything that can publish to your broker can arm the panel. ([#42](https://github.com/dougrathbone/cgateweb/issues/42))

## [1.22.4](https://github.com/dougrathbone/cgateweb/releases/tag/v1.22.4) - 2026-08-03

### Fixed

- **Entity names no longer vanish during a Home Assistant backup.** ([#44](https://github.com/dougrathbone/cgateweb/issues/44))
- **Trigger applications no longer produce error spam.** They do not support level reads. ([#44](https://github.com/dougrathbone/cgateweb/issues/44))

## [1.22.3](https://github.com/dougrathbone/cgateweb/releases/tag/v1.22.3) - 2026-08-02

### Fixed

- **The add-on no longer crashes and restart-loops shortly after startup.** ([#44](https://github.com/dougrathbone/cgateweb/issues/44))
- **Entities come back on their own after an MQTT broker restart.** ([#44](https://github.com/dougrathbone/cgateweb/issues/44))

## [1.22.2](https://github.com/dougrathbone/cgateweb/releases/tag/v1.22.2) - 2026-08-02

### Changed

- **Maintenance release; no user-facing changes.**

## [1.22.1](https://github.com/dougrathbone/cgateweb/releases/tag/v1.22.1) - 2026-08-02

### Fixed

- **Security panel trouble state now survives a restart.** ([#42](https://github.com/dougrathbone/cgateweb/issues/42))

## [1.22.0](https://github.com/dougrathbone/cgateweb/releases/tag/v1.22.0) - 2026-08-02

### Fixed

- **Lights no longer sit at unknown after startup.** Each group is refreshed when C-Gate finishes synchronising the network, even without Get all on start. ([#44](https://github.com/dougrathbone/cgateweb/issues/44))
- **Bridge diagnostics and stale-device entities now come back after an MQTT broker restart.**
- **The air conditioning option now applies when Home Assistant discovery is off.**
- **Security zone labels now export with proper application names.**
