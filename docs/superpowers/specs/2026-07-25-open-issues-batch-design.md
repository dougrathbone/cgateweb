# Open Issues Batch: Unit-Type Discovery, Serial Resilience, External C-Gate Access

Date: 2026-07-25
Issues: #38, #37, #28
Target release: 1.18.0 (single release, all four items)

## Context

Three issues are open. Two of them turn out to share one mechanism, and one of
them splits into two unrelated asks:

- **#38** (djagerif): entity type should follow the physical output unit — a
  dimmer group becomes a light, a relay group becomes something on/off — instead
  of requiring the installer to hand-classify every group after discovery.
- **#37** (DewetTDS), first half: C-Bus bus couplers and other input units
  should appear in Home Assistant so automations can trigger off them.
- **#37**, second half: expose the C-Bus network so C-Bus Toolkit can reach it
  over the LAN instead of requiring the USB PC Interface to be unplugged from
  the Home Assistant host.
- **#28** (DewetTDS), outstanding follow-up: the configured serial device path
  moved from `/dev/ttyUSB0` to `/dev/ttyUSB1` after a replug, breaking startup.

#38 and #37's first half are the same underlying capability: classify a group by
the unit that drives it. They are specified together as Item 1.

## Decisions

| Decision | Choice |
|---|---|
| Relay-driven lighting group | `light` entity with brightness omitted, not `switch` |
| Unit-type classification default | Opt-in, `ha_discovery_type_from_unit` default false |
| Input-only group | `binary_sensor` |
| Toolkit access approach | Expose managed C-Gate to external clients; no serial multiplexing or handoff |
| External access config | Object list of `{address, level}` mirroring `access.txt` |
| `access.txt` write strategy | Marker-delimited managed block, preserving hand-added lines |
| Offered levels | `monitor`, `operate`, `program` |
| Malformed localhost rules | Fixed in the same release, kept localhost-only |
| Serial path recovery at boot | Remembered USB identity, adopt the new path |
| Serial path recovery while running | Detect, report, and attempt recovery |
| Release shape | One release containing all four items |

## Item 1: Unit-type entity classification (#38, #37 first half)

### Where the data comes from

C-Gate's `TREEXML` returns a `<Type>` per `<Unit>` alongside that unit's group
bindings. `collectUnitGroups` (`src/haDiscoveryTree.js:228`) already walks both
TREEXML shapes (structured `Application` objects, and the flat `"56, 255"` /
`Groups "10,11"` form) but flattens groups across units and discards the unit.

Type strings present in the repo's existing test fixtures, which is the only
inventory of real values available: `DIMDN8`, `RELDN12`, `RELAY2`, `PCLOCAL4`,
`SENLL`, `SENTEMP`, `PC_CNIED`, `TEXT`. This list is certainly incomplete, which
is why unknown types must be inert rather than guessed at.

### New module

`src/unitTypeClassifier.js` — pure functions, no I/O:

- `categoriseUnitType(type)` → `'dimmer' | 'relay' | 'input' | 'management' | null`
- `entityTypeForGroup(groupInfo, settings)` → `'light-dimmable' | 'light-onoff' | 'binary_sensor' | null`

Those three strings are resolution outcomes internal to this feature, not keys
into `getDiscoveryConfig`'s table (`cover`, `switch`, `relay`, `pir`, `trigger`,
`trigger_button`, `hvac`, `scene`). Each gets its own branch in
`_tryCreateTypedEntity` ahead of that lookup — see Integration below — so none of
them ever reaches it and trips the "Unknown resolved type" warning.

Category table. Patterns are anchored prefixes, matched case-insensitively:

| Pattern | Category | Resulting entity |
|---|---|---|
| `^DIM` | dimmer output | `light` with brightness (unchanged from today) |
| `^REL` | relay output | `light`, brightness fields omitted |
| `^SEN` | input | `binary_sensor`, only when no output unit drives the group |
| `^PC_`, `^PCLOCAL`, `^TEXT` | management | no opinion |
| anything else | unknown | **no opinion — falls through to today's default** |

Unknown types never guess. Every unrecognised type is logged once per discovery
run at info level with the unit address and the decision made, so a field report
can extend the table in one round trip.

### Tree indexing

Add `collectUnitTypesByGroup(networkData, targetApps)` to
`src/haDiscoveryTree.js`, alongside `collectUnitGroups` and sharing its
shape-handling. Returns:

```js
Map<"<appId>/<groupId>", {
    types: Set<string>,   // raw unit type strings driving this group
    hasOutput: boolean,   // any dimmer or relay unit
    hasInput: boolean     // any input unit
}>
```

### Resolution rules

1. `hasOutput && types` contains a dimmer → `light` with brightness.
2. `hasOutput && types` contains only relays → `light` without brightness.
3. `hasInput && !hasOutput` → `binary_sensor`.
4. Otherwise → `null`, falling through to existing behaviour.

Output wins over input, and dimmer wins over relay, so a group driven by both a
dimmer and a relay keeps its brightness slider rather than losing it.

### Integration

`_tryCreateTypedEntity` (`src/haDiscoveryPublishers.js:197`) gains a step
between the two existing ones. Final precedence, highest first:

1. Manual `type_overrides` — explicit user intent always wins.
2. `typeFromLabelPrefix` (existing, opt-in).
3. **Unit-type classification (new, opt-in).**
4. `classifyLightingGroup` name heuristics (existing).
5. Default dimmable light.

The index is exposed to the publisher as a run-scoped instance property
(`this._unitTypeIndex`) set at the start of a discovery pass and cleared at the
end — the same pattern `_labelSnapshot` uses. Not threaded as another positional
argument; see the `labelSnapshot` note in CLAUDE.md.

### Dispatching the new resolved types

Today `_tryCreateTypedEntity` returns false for `null` and `'light'` and treats
every other value as a key into `getDiscoveryConfig`. The three values
`entityTypeForGroup` can return are not in that table, so they must be dispatched
before the lookup or they would log "Unknown resolved type" and fall through.
The new branches sit immediately after the existing `resolvedType` assignment:

- `'light-dimmable'` joins `null` and `'light'` in the early `return false`. A
  dimmer-driven group is exactly today's default dimmable light, so the right
  action is to fall through to the existing path rather than publish anything
  new.
- `'light-onoff'` calls a new `_createOnOffLightDiscovery` and returns true.
- `'binary_sensor'` calls a new `_createInputBinarySensorDiscovery`, clears any
  stale retained light config, and returns true.

Only after these three does control reach the unchanged
`getDiscoveryConfig(resolvedType)` lookup, which continues to serve the manual
overrides, label prefixes and name heuristics as it does today. The warning path
therefore keeps its original meaning: a genuinely unrecognised type.

The relay case reuses the existing light publishing path with
`brightness_state_topic`, `brightness_command_topic`, `brightness_scale`,
`on_command_type` and `brightness_value_template` omitted, and `command_topic`
pointing at `switch` rather than `ramp`. It stays in the `light` domain, so
entity ids and existing automations survive.

The `binary_sensor` case publishes the same payload shape as the `pir` config in
`src/haDiscoveryConfigs.js` — state topic, `payload_on`/`payload_off`, no command
topic — but omits `device_class`, since a coupler is not necessarily motion. It
is written as a dedicated publisher rather than a new entry in the
`getDiscoveryConfig` table, so that table stays the list of types a user can name
in `type_overrides`.

### Setting

`ha_discovery_type_from_unit`, default `false`. Schema `"bool?"`, so it is a
scalar optional and needs no entry in `options` — nothing is written into
existing users' saved configs on upgrade.

Nested under the existing `ha_discovery_auto_type` master switch: when that is
explicitly `false`, unit-type classification does not run either, matching how
`ha_discovery_auto_type_name_heuristics` behaves.

### Known gap

No fixture, log, or issue report in the repo contains the `<Type>` string a
C-Bus bus coupler reports. Until DewetTDS supplies it, his coupler groups will
fall through to the default light rather than becoming sensors. The
unknown-type logging above is what makes his next report actionable. **#37's
first half must not be described as fixed until he confirms against his own
hardware.**

## Item 2: Serial device path resolution at boot (#28)

### Problem

`cgate_serial_device` is read independently in three places, each calling
`bashio::config` and each doing its own `readlink`:

- `_cgateweb_check_serial_device` (`cgate-install.sh:168`) — validates, fails hard when absent
- `cgate-project-sync.sh:96` — passes the path to the project fixup
- `cgateweb-serial-diagnostics` — logs it

A replug that renumbers `ttyUSB0` to `ttyUSB1` makes the first of these fail the
add-on at cont-init, and the user must edit config by hand to recover.

### Design

One resolver, `homeassistant-addon/rootfs/usr/bin/cgateweb-resolve-serial`,
runs first and writes the effective path to `/run/cgateweb/serial-device`. The
other three consumers read that file instead of resolving independently, so all
of them agree on one answer.

Resolution order:

1. Configured path exists → use it. Record its USB identity.
2. Configured path missing → load the remembered identity and scan for it.
   Match found → adopt the new path, log loudly at warning level, and print the
   `/dev/serial/by-id/` path the user should switch to.
3. No remembered identity, or no match → fail with the device inventory, exactly
   as today.

Identity is the basename of the `/dev/serial/by-id/` symlink that resolves to
the same device, e.g. `usb-FTDI_FT232R_USB_UART_A50285BI-if00-port0`. That name
already encodes vendor, product and serial number, so it is both the identity and
the stable path to recommend — no `/sys` parsing needed. Persisted to
`/data/serial-identity.json` on each successful boot.

Where `/dev/serial/by-id/` is absent (a host without udev populating it), fall
back to reading `idVendor`, `idProduct` and `serial` from `/sys` by walking up
from `/sys/class/tty/<name>/device`. If neither source yields an identity, log
that recovery will not be possible and behave exactly as today.

Adoption requires an identity match, so a Zigbee or Z-Wave stick on the same host
is never adopted by accident.

When the configured path is a raw `/dev/ttyUSB*` or `/dev/ttyACM*` and a
`/dev/serial/by-id/` symlink resolves to the same target, log the stable path as
a recommendation on every boot, not only on failure.

## Item 3: Serial recovery while running (#28)

### Trigger

`CniNotificationManager.handleReading` (`src/cniNotificationManager.js:27`)
already fires on the offline transition and already raises an HA persistent
notification. A new `src/serialDeviceRecovery.js` collaborates with it rather
than growing that class a second responsibility.

```
InterfaceState → down
  ├─ not managed mode, or no serial device configured → report only (today's path)
  ├─ configured device path still exists              → report only (real bus/CNI fault)
  └─ device path gone
       ├─ report: log + status page + HA notification naming the new path
       └─ recover: re-resolve by identity
                   → re-run cgateweb-project-serial-fixup.js
                   → restart the cgate service
                   → existing pool backoff reconnects
```

The precondition "the configured device path no longer exists" is what keeps
this from firing for CNI installs, where `InterfaceState=closed` means a genuine
network fault and no local device is involved.

Recovery attempts are rate-limited via `src/backoff.js` (`backoffDelay`) so a
genuinely unplugged PCI does not restart C-Gate in a loop. Reporting happens
whether or not recovery succeeds, and a failed recovery says so explicitly
rather than silently retrying.

New tunables, additive with defaults equal to current behaviour:

- `serial_recovery_enabled` (default `true`; recovery only ever engages when a
  serial device is configured, so this is inert for CNI users)
- `serial_recovery_max_attempts` (default 3)
- `serial_recovery_initial_delay_ms` / `serial_recovery_max_delay_ms`

## Item 4: External C-Gate access (#37 second half)

### Why this shape

C-Gate is a multi-client TCP server; cgateweb itself holds three command
connections plus one event connection concurrently. Toolkit connecting to a
remote C-Gate is a supported pattern, and Doug's own C-Gate at 192.168.0.22 has
rules intended for exactly that. So the answer is to let external clients reach
the managed C-Gate — not to multiplex or hand off the serial port. C-Gate stays
the single owner of the PCI and arbitrates between clients itself.

Rejected: a socat serial-to-TCP bridge exposing the PCI as a pseudo-CNI.
Sharing the port means two masters interleaving PCI smart-mode confirmation
codes, which can corrupt a Toolkit programming operation. An exclusive handoff
that stops C-Gate for the duration was also rejected once it became clear
C-Gate can simply serve both clients.

### access.txt grammar (manual §4.10.1)

Three keywords, and only three:

```
interface <ip> <level>        # the server interface the connection arrives on
remote    <ip> <level>        # the connecting client's address
user      <id> <pass> <level>
```

Levels, each incorporating the previous: `none`, `connect`, `monitor`,
`operate`, `admin`, `program`, `debug`. Faulty lines are silently ignored.
Addresses may be hostnames or dotted quads; **an octet of `255` matches any
value**, so `remote 192.168.1.255 monitor` grants the whole `192.168.1.*`
network. This is the subnet notation — not CIDR.

Note `program` sits above `admin`, so granting Toolkit what it needs to program
units necessarily also grants C-Gate shutdown. There is no way to separate
these, and the option documentation must say so.

**The add-on must only ever write `remote` rules, never `interface` rules.**
Doug's production C-Gate is a live demonstration of why. Its only non-loopback
interface is `eth0` at `192.168.0.22/16`, and its `access.txt` contains
`interface 192.168.0.22 Program` alongside `interface 192.168.1.7 Program` and
`interface 192.168.1.60 Clipsal`. Because `interface` matches the *server*
interface a connection arrives on, the latter two match nothing — no interface
holds those addresses — while the first grants `Program` to every client on the
whole `192.168.0.0/16` LAN. An `interface` rule intended as a per-client grant
silently becomes a blanket grant for everything arriving on that NIC.

This also settles the level question: Toolkit connects from 192.168.1.60, whose
own rule is inert, so the level it actually operates at is the `Program` from the
`eth0` rule. `program` is sufficient for Toolkit, and the undocumented `Clipsal`
level is not needed.

### What the generated access.txt actually does

**Corrected during implementation.** The original premise here was that the
add-on generates malformed rules and therefore every managed install runs with
an effectively empty access control list. That was wrong, and the correction
matters for the release notes.

`cgate-install.sh` did contain a malformed heredoc — `interface 127.0.0.1` with
no level, plus `program 127.0.0.1` and `monitor 127.0.0.1`, all three faulty by
the grammar above. But it was guarded by `if [[ ! -f "${ACCESS_FILE}" ]]`, and
the C-Gate distribution zip **ships its own `config/access.txt`**, which the
install copies to disk wholesale. So the guard was always false and the heredoc
never ran.

What every managed install actually has is C-Gate's stock file, carrying three
*valid* loopback grants:

```
## Created:Tue Oct 05 16:22:26 CST 2004
interface 0:0:0:0:0:0:0:1 Program
interface 127.0.0.1 Program
interface localhost Program
```

Verified against a real captured install (`test-env/volumes/data/cgate/config/access.txt`,
mtime matching the zip extraction). So there was **no security exposure** to fix
and the changelog must not claim one. Note also that this stock file is what
taught the `interface` idiom to anyone who has hand-edited their own
`access.txt` — which is why per-client `interface` rules are a common and
ineffective pattern in the wild.

Two things remain worth doing, and are what shipped:

1. The add-on should state its own access explicitly and correctly, rather than
   depending on a vendor default file it does not control.
2. A managed block is the prerequisite for Task 4's external clients.

The stock `interface` rules are preserved outside the managed block, unchanged.
They are loopback-only, so they neither widen access nor conflict with the
`remote` rules the add-on writes. The malformed-line strip patterns are retained
as defensive cleanup, in case some C-Gate version's zip omits the stock file.

Fixed in the same release, kept localhost-only and minimal:

```
remote 127.0.0.1 program
remote 0:0:0:0:0:0:0:1 program
```

`program` because managed mode loads and starts projects. This is a real change
to a security control on every managed install, so it lands as its own commit,
before the commit that declares the ports.

### Options

```yaml
cgate_external_clients:
  - address: 192.168.1.60
    level: program      # Toolkit
  - address: 192.168.1.255
    level: monitor      # whole 192.168.1.* subnet, read-only
```

Schema:

```yaml
cgate_external_clients:
  - address: "str"
    level: "list(monitor|operate|program)"
```

Per the config.yaml rules in CLAUDE.md, an object-list schema field cannot be
optional, so it needs a default in `options`. Default is `[]`, following the
`getall_app_periods: []` precedent — inert on upgrade, and the generated
`access.txt` is byte-identical to the localhost-only form when the list is
empty.

### access.txt writing

A marker-delimited managed block, rewritten on every boot. Lines outside the
markers are preserved, so a user who hand-edited the file keeps their edits:

```
# >>> cgateweb managed block - do not edit <<<
remote 127.0.0.1 program
remote 0:0:0:0:0:0:0:1 program
remote 192.168.1.60 program
remote 192.168.1.255 monitor
# <<< cgateweb managed block >>>
```

Rewriting rather than appending means removing an address from the option
actually revokes its access, which append-only would not.

Addresses are validated at boot: a malformed address or an unknown level fails
cont-init with a readable error rather than being silently dropped by C-Gate.

### Ports

`config.yaml` declares C-Gate's ports with `null` defaults so publishing stays a
deliberate act in HA's Network panel, exactly as `8080/tcp` works today:

```yaml
ports:
  "8080/tcp": null
  "20023/tcp": null
  "20024/tcp": null
  "20025/tcp": null
```

`ports_description` states plainly that C-Gate has no authentication on these
ports and that `cgate_external_clients` must be configured before publishing
them.

Confirmed against the production install: `accept-connections-from=all` and
`access-control-file=access.txt`, matching the documented defaults. There is no
IP filter in front of access control, so the `remote` rules are the only thing
standing between a published port and full control.

## Testing

Following the existing standards: Jest, `/tests/*.test.js`, Arrange-Act-Assert,
mocked network and timers, unit tests preferred over integration.

| Area | Coverage |
|---|---|
| `unitTypeClassifier` | Each category; unknown types return null; case-insensitivity; every confirmed real type string |
| `collectUnitTypesByGroup` | Both TREEXML shapes; single vs array `Unit`; mixed dimmer+relay; input-only; management-only |
| Publisher integration | Precedence order against `type_overrides` and label prefix; relay payload omits every brightness field; `binary_sensor` payload; no "Unknown resolved type" warning is logged for any of the three new resolved types; setting off means byte-identical output to today |
| Serial resolver | Configured path present; missing with identity match; missing without match; by-id recommendation; the three consumers agreeing |
| `serialDeviceRecovery` | Each branch of the trigger tree; rate limiting; CNI install never triggers; failed recovery reports |
| access.txt | Managed block created, updated, and address removal revoking; hand-added lines preserved; empty list produces localhost-only; malformed address and unknown level both fail |

Existing suites that must stay green: `tests/haDiscovery.test.js`,
`tests/haDiscoveryTree.test.js`, `tests/discoveryE2E.test.js`,
`tests/cgateInstallScript.test.js`, `tests/cgateProjectSync.test.js`,
`tests/cgateProjectSerialFixup.test.js`, `tests/cgateSerialDiagnostics.test.js`,
`tests/validateAddonConfig.test.js`.

## Translations

Two new user-facing option keys: `ha_discovery_type_from_unit` and
`cgate_external_clients`. Both need `name` and `description` in all 17 files in
`homeassistant-addon/translations/`, not just `en.yaml`, or the
`validate:translations` gate fails. Technical terms stay in English: C-Gate,
C-Bus, Toolkit, access levels (`monitor`/`operate`/`program`), device paths.

The `serial_recovery_*` tunables are runtime settings, not add-on options, so
they need no translation entries.

## Sequencing

One commit per item, least risky first, per the process in CLAUDE.md:

1. Serial device resolver (Item 2) — self-contained, no new options
2. Serial recovery (Item 3) — new module, existing hook point
3. `access.txt` grammar fix (Item 4a) — security control, localhost-only, isolated for independent revert
4. External clients option and port declarations (Item 4b)
5. Unit-type classification (Item 1) — largest user-visible surface
6. `chore: release v1.18.0` — version bump in both `package.json` and `homeassistant-addon/config.yaml`, plus the changelog entry

Gates before pushing: `npm test`, `npm run lint`, `npm run typecheck`,
`npm run validate:translations`, `npm run validate:addon-config`. Then tag
`v1.18.0` and push the tag to trigger the HACS distribution workflow, and
backfill the source-repo GitHub Release.

### Note on the single-release choice

Item 4 opens network ports on a service with no authentication, which argued for
shipping it alone. Shipping all four together was chosen instead. The risk is
contained because both of item 4's user-facing defaults are inert: the client
list defaults to `[]` and the ports default to unpublished, so an upgrading user
sees no change in exposure unless they act. The `access.txt` grammar fix is the
one part that changes on every managed install regardless, which is why it is
isolated as its own commit.

## Verification still required

These are open questions that must be answered during implementation rather than
assumed:

1. **Bus coupler `<Type>` string** — unknown. Ask DewetTDS on #37 for the
   unit-type log. #37's first half stays open until he confirms.
2. **s6 service path for restarting C-Gate** — the base image is
   `home-assistant/*-base:3.21`, s6-overlay v3 running `/etc/services.d`
   through the legacy shim. Confirm the real path in a running container instead
   of guessing `s6-svc -r /run/service/cgate`.
3. **The minimum access level cgateweb needs at localhost** — the fix assumes
   `program` because managed mode loads projects. The production install runs at
   `program`, which confirms it is sufficient but not that it is necessary.
   Worth confirming `operate` is genuinely insufficient before settling on the
   more privileged grant.

Resolved during design:

- **Whether `Clipsal` is a real access level** — moot. Toolkit's effective level
  in the production install is `program`, so the offered list needs no change.
- **Whether the production Pi is dual-homed** — no. One `eth0` at
  `192.168.0.22/16`, which is what makes the `interface` per-client rules inert
  and confirms `remote` is the correct keyword.
