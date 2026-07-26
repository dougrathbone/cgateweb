# Open Issues Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close issues #38, #37 and the #28 follow-up by classifying Home Assistant entities from the C-Bus unit that drives each group, making the USB serial device path survive renumbering, and letting external clients such as C-Bus Toolkit reach the managed C-Gate.

**Architecture:** Five independent changes shipped as one release. Discovery gains a pure classifier module (`src/unitTypeClassifier.js`) plus a tree index, wired into the existing precedence chain in `_tryCreateTypedEntity`. The add-on gains a Node resolver that turns a possibly-stale `cgate_serial_device` into a live path, and a recovery collaborator hooked onto the existing interface-state monitor. `access.txt` generation is corrected to the documented grammar and extended with a managed block for external clients.

**Tech Stack:** Node.js (CommonJS, `// @ts-check`), Jest, bash with bashio (Home Assistant add-on `cont-init.d` / `services.d` scripts), YAML add-on config.

Spec: `docs/superpowers/specs/2026-07-25-open-issues-batch-design.md`

**Ordering note:** the spec lists hot-replug recovery second. It is Task 8 here instead, after the discovery work. It depends on the Task 1 resolver, it is the only change that restarts a service from inside the running bridge, and it carries the one unverified assumption in the batch (the s6 service path). Risky last, per the process in CLAUDE.md.

## Global Constraints

- Every new/changed `src/` and `homeassistant-addon/rootfs/usr/bin/*.js` file starts with `// @ts-check`. `npm run typecheck` must pass.
- Runtime setting keys follow the file they live in: `src/defaultSettings.js` uses `snake_case` for Home Assistant discovery settings (`ha_discovery_*`) and `camelCase` for internal tunables (`cniMonitorIntervalMs`). Match the surrounding convention, do not invent a third.
- New add-on options must be added to **all 17** files in `homeassistant-addon/translations/`, not just `en.yaml`, or `npm run validate:translations` fails.
- Array/object-list schema fields in `homeassistant-addon/config.yaml` **must** have a default in `options` and **cannot** use the `?` optional suffix. Scalar optionals use `?` and must be absent from `options`.
- `package.json` and `homeassistant-addon/config.yaml` versions must always match; CI's `version-sync` job enforces it.
- All new behaviour is additive: with new settings at their defaults, output must be byte-identical to the current release. The one deliberate exception is Task 3 (`access.txt` grammar), which is called out there.
- Bash tests use the `BASHIO_STUB` + `CGATEWEB_INSTALL_SOURCE_ONLY=1` sourcing harness in `tests/cgateInstallScript.test.js`. Reuse it, do not invent a new one.
- Gates before any push: `npm test`, `npm run lint`, `npm run typecheck`, `npm run validate:translations`, `npm run validate:addon-config`.
- Commit messages: conventional format, no AI attribution of any kind.

## File Structure

**Part A — serial resilience (#28)**

| File | Responsibility |
|---|---|
| `homeassistant-addon/rootfs/usr/bin/cgateweb-resolve-serial.js` (create) | Pure resolution logic + CLI. Turns a configured path into a live path via remembered identity. |
| `tests/cgateResolveSerial.test.js` (create) | Unit tests for the resolver against fake `/dev` and `/sys` trees. |
| `homeassistant-addon/rootfs/etc/cont-init.d/cgate-install.sh` (modify) | `_cgateweb_check_serial_device` delegates to the resolver and writes the effective path. |
| `homeassistant-addon/rootfs/etc/cont-init.d/cgate-project-sync.sh` (modify) | Reads the effective path instead of re-resolving. |
| `homeassistant-addon/rootfs/usr/bin/cgateweb-serial-diagnostics` (modify) | Reads the effective path instead of re-resolving. |
| `src/serialDeviceRecovery.js` (create) | Decides report-only vs recover on an interface-down transition; performs recovery. |
| `tests/serialDeviceRecovery.test.js` (create) | Unit tests for every branch of the decision tree. |
| `src/cniNotificationManager.js` (modify) | Delegates to the recovery collaborator on the offline transition. |

**Part B — access control and external clients (#37 second half)**

| File | Responsibility |
|---|---|
| `homeassistant-addon/rootfs/etc/cont-init.d/cgate-install.sh` (modify) | New `_cgateweb_write_access_control` helper; correct grammar + managed block. |
| `tests/cgateAccessControl.test.js` (create) | Unit tests for block creation, update, revocation, preservation, validation. |
| `homeassistant-addon/config.yaml` (modify) | `cgate_external_clients` option/schema; port declarations. |
| `homeassistant-addon/translations/*.yaml` (modify, 17 files) | Option name/description. |

**Part C — unit-type classification (#38, #37 first half)**

| File | Responsibility |
|---|---|
| `src/unitTypeClassifier.js` (create) | Pure functions: type string → category, group info → entity type. |
| `tests/unitTypeClassifier.test.js` (create) | Unit tests for the category table and resolution rules. |
| `src/haDiscoveryTree.js` (modify) | New `collectUnitTypesByGroup`. |
| `src/haDiscovery.js` (modify) | Build the index per run; clear it in the existing `finally`. |
| `src/haDiscoveryPublishers.js` (modify) | New precedence step; on/off light and binary_sensor payloads. |
| `src/defaultSettings.js` (modify) | `ha_discovery_type_from_unit: false`. |
| `src/config/addonOptionMap.js` (modify) | Allowlist row, or the add-on toggle is a silent no-op. |
| `homeassistant-addon/config.yaml` + 17 translations (modify) | Option surface. |

---

## Task 1: Serial device resolver

Turns a configured `cgate_serial_device` into a live path, remembering the device's stable identity so a `ttyUSB0` → `ttyUSB1` renumber recovers automatically.

**Files:**
- Create: `homeassistant-addon/rootfs/usr/bin/cgateweb-resolve-serial.js`
- Test: `tests/cgateResolveSerial.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `identityFromByIdDir(devicePath, opts)` → `string | null` — basename of the `/dev/serial/by-id` link resolving to `devicePath`.
  - `identityFromSysfs(devicePath, opts)` → `string | null` — `"<idVendor>:<idProduct>:<serial>"`.
  - `readIdentity(devicePath, opts)` → `string | null` — by-id first, sysfs fallback.
  - `findDeviceByIdentity(identity, opts)` → `string | null` — live path for a remembered identity.
  - `resolveSerialDevice({ configuredPath, identityFile, devRoot, sysfsRoot })` → `{ path: string|null, source: 'configured'|'recovered', identity: string|null, stablePath: string|null, messages: string[] }`
  - `opts` in all of the above is `{ devRoot = '/dev', sysfsRoot = '/sys' }`, injected so tests can point at a tmpdir.
- Task 2 consumes: the CLI contract — writes the effective path to the file named by `CGATEWEB_SERIAL_DEVICE_FILE` (default `/run/cgateweb/serial-device`), exits 0 on success, exits 1 with messages on stderr when unresolvable.

- [ ] **Step 1: Write the failing test**

Create `tests/cgateResolveSerial.test.js`:

```js
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    identityFromByIdDir,
    findDeviceByIdentity,
    resolveSerialDevice
} = require('../homeassistant-addon/rootfs/usr/bin/cgateweb-resolve-serial.js');

const BY_ID = 'usb-FTDI_FT232R_USB_UART_A50285BI-if00-port0';

// Build a fake /dev with tty character-device stand-ins (plain files are fine:
// the resolver checks existence and symlink targets, not device-node type) and
// a /dev/serial/by-id directory of symlinks pointing at them.
function makeDevRoot({ ttys = [], byId = {} } = {}) {
    const devRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-dev-'));
    for (const tty of ttys) fs.writeFileSync(path.join(devRoot, tty), '');
    if (Object.keys(byId).length) {
        const byIdDir = path.join(devRoot, 'serial', 'by-id');
        fs.mkdirSync(byIdDir, { recursive: true });
        for (const [link, target] of Object.entries(byId)) {
            fs.symlinkSync(path.join(devRoot, target), path.join(byIdDir, link));
        }
    }
    return devRoot;
}

describe('identityFromByIdDir', () => {
    it('returns the by-id link name that resolves to the device', () => {
        const devRoot = makeDevRoot({ ttys: ['ttyUSB0'], byId: { [BY_ID]: 'ttyUSB0' } });

        const identity = identityFromByIdDir(path.join(devRoot, 'ttyUSB0'), { devRoot });

        expect(identity).toBe(BY_ID);
    });

    it('returns null when no by-id link points at the device', () => {
        const devRoot = makeDevRoot({ ttys: ['ttyUSB0', 'ttyUSB1'], byId: { [BY_ID]: 'ttyUSB1' } });

        const identity = identityFromByIdDir(path.join(devRoot, 'ttyUSB0'), { devRoot });

        expect(identity).toBeNull();
    });
});

describe('findDeviceByIdentity', () => {
    it('finds the device the identity now points at after a renumber', () => {
        const devRoot = makeDevRoot({ ttys: ['ttyUSB1'], byId: { [BY_ID]: 'ttyUSB1' } });

        const found = findDeviceByIdentity(BY_ID, { devRoot });

        expect(found).toBe(path.join(devRoot, 'ttyUSB1'));
    });

    it('returns null for an identity that is not present', () => {
        const devRoot = makeDevRoot({ ttys: ['ttyUSB0'] });

        expect(findDeviceByIdentity(BY_ID, { devRoot })).toBeNull();
    });
});

describe('resolveSerialDevice', () => {
    function identityFile() {
        return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-data-')), 'serial-identity.json');
    }

    it('uses the configured path when it exists and records its identity', () => {
        const devRoot = makeDevRoot({ ttys: ['ttyUSB0'], byId: { [BY_ID]: 'ttyUSB0' } });
        const file = identityFile();

        const result = resolveSerialDevice({
            configuredPath: path.join(devRoot, 'ttyUSB0'),
            identityFile: file,
            devRoot
        });

        expect(result.source).toBe('configured');
        expect(result.path).toBe(path.join(devRoot, 'ttyUSB0'));
        expect(JSON.parse(fs.readFileSync(file, 'utf8')).identity).toBe(BY_ID);
    });

    it('recommends the stable by-id path when a raw tty path is configured', () => {
        const devRoot = makeDevRoot({ ttys: ['ttyUSB0'], byId: { [BY_ID]: 'ttyUSB0' } });

        const result = resolveSerialDevice({
            configuredPath: path.join(devRoot, 'ttyUSB0'),
            identityFile: identityFile(),
            devRoot
        });

        expect(result.stablePath).toBe(path.join(devRoot, 'serial', 'by-id', BY_ID));
    });

    it('recovers the new path via remembered identity after a renumber', () => {
        const file = identityFile();
        const before = makeDevRoot({ ttys: ['ttyUSB0'], byId: { [BY_ID]: 'ttyUSB0' } });
        resolveSerialDevice({
            configuredPath: path.join(before, 'ttyUSB0'),
            identityFile: file,
            devRoot: before
        });

        // Replug: the device is now ttyUSB1 and the old path is gone.
        const after = makeDevRoot({ ttys: ['ttyUSB1'], byId: { [BY_ID]: 'ttyUSB1' } });
        const result = resolveSerialDevice({
            configuredPath: path.join(before, 'ttyUSB0'),
            identityFile: file,
            devRoot: after
        });

        expect(result.source).toBe('recovered');
        expect(result.path).toBe(path.join(after, 'ttyUSB1'));
        expect(result.messages.join('\n')).toContain('ttyUSB1');
    });

    it('does not adopt an unrelated device when the identity does not match', () => {
        const file = identityFile();
        const before = makeDevRoot({ ttys: ['ttyUSB0'], byId: { [BY_ID]: 'ttyUSB0' } });
        resolveSerialDevice({
            configuredPath: path.join(before, 'ttyUSB0'),
            identityFile: file,
            devRoot: before
        });

        // A Zigbee stick is the only tty present; its identity differs.
        const after = makeDevRoot({
            ttys: ['ttyUSB0'],
            byId: { 'usb-Silicon_Labs_Zigbee_ZZZ-if00-port0': 'ttyUSB0' }
        });
        const result = resolveSerialDevice({
            configuredPath: path.join(before, 'ttyUSB9'),
            identityFile: file,
            devRoot: after
        });

        expect(result.path).toBeNull();
    });

    it('returns null with a message when nothing is resolvable', () => {
        const devRoot = makeDevRoot({});

        const result = resolveSerialDevice({
            configuredPath: path.join(devRoot, 'ttyUSB0'),
            identityFile: identityFile(),
            devRoot
        });

        expect(result.path).toBeNull();
        expect(result.messages.join('\n')).toMatch(/not found/i);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest tests/cgateResolveSerial.test.js`
Expected: FAIL — `Cannot find module '../homeassistant-addon/rootfs/usr/bin/cgateweb-resolve-serial.js'`

- [ ] **Step 3: Write the implementation**

Create `homeassistant-addon/rootfs/usr/bin/cgateweb-resolve-serial.js`:

```js
#!/usr/bin/env node
// @ts-check
/**
 * Resolve cgate_serial_device to a live device path (issue #28).
 *
 * A USB PC Interface that is unplugged and replugged can come back as a
 * different ttyUSBn, which made cont-init fail on a path that no longer
 * existed. This records the device's stable identity (the /dev/serial/by-id
 * link name, which encodes vendor, product and serial) on every good boot, and
 * uses it to find the device again after a renumber.
 *
 * Adoption requires an identity match, so an unrelated dongle (Zigbee, Z-Wave)
 * on the same host is never picked up by accident.
 *
 * Usage: cgateweb-resolve-serial.js <configured-device-path>
 * Writes the effective path to CGATEWEB_SERIAL_DEVICE_FILE
 * (default /run/cgateweb/serial-device). Exit 0 on success, 1 when unresolvable.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DEVICE_FILE = '/run/cgateweb/serial-device';
const DEFAULT_IDENTITY_FILE = '/data/serial-identity.json';

function byIdDir(devRoot) {
    return path.join(devRoot, 'serial', 'by-id');
}

function realPathOrNull(p) {
    try {
        return fs.realpathSync(p);
    } catch (e) {
        return null;
    }
}

/**
 * The /dev/serial/by-id link name that resolves to devicePath, or null.
 * @param {string} devicePath
 * @param {{ devRoot?: string }} [opts]
 * @returns {string|null}
 */
function identityFromByIdDir(devicePath, opts = {}) {
    const devRoot = opts.devRoot || '/dev';
    const target = realPathOrNull(devicePath);
    if (!target) return null;

    let entries;
    try {
        entries = fs.readdirSync(byIdDir(devRoot));
    } catch (e) {
        return null; // no udev by-id links on this host
    }

    for (const entry of entries) {
        if (realPathOrNull(path.join(byIdDir(devRoot), entry)) === target) return entry;
    }
    return null;
}

/**
 * Fallback identity for hosts without /dev/serial/by-id: walk up from
 * /sys/class/tty/<name>/device looking for a USB device directory carrying
 * idVendor, idProduct and serial.
 * @param {string} devicePath
 * @param {{ sysfsRoot?: string }} [opts]
 * @returns {string|null}
 */
function identityFromSysfs(devicePath, opts = {}) {
    const sysfsRoot = opts.sysfsRoot || '/sys';
    const name = path.basename(realPathOrNull(devicePath) || devicePath);
    let dir = realPathOrNull(path.join(sysfsRoot, 'class', 'tty', name, 'device'));

    for (let depth = 0; dir && depth < 8; depth++) {
        const parts = ['idVendor', 'idProduct', 'serial'].map(f => {
            try {
                return fs.readFileSync(path.join(dir, f), 'utf8').trim();
            } catch (e) {
                return '';
            }
        });
        if (parts[0] && parts[1]) return parts.join(':');
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/**
 * Stable identity for a device: by-id link name preferred, sysfs as fallback.
 * @param {string} devicePath
 * @param {{ devRoot?: string, sysfsRoot?: string }} [opts]
 * @returns {string|null}
 */
function readIdentity(devicePath, opts = {}) {
    return identityFromByIdDir(devicePath, opts) || identityFromSysfs(devicePath, opts);
}

/**
 * Live device path for a remembered identity, or null if absent.
 * @param {string} identity
 * @param {{ devRoot?: string, sysfsRoot?: string }} [opts]
 * @returns {string|null}
 */
function findDeviceByIdentity(identity, opts = {}) {
    const devRoot = opts.devRoot || '/dev';
    if (!identity) return null;

    // by-id identity: the link itself is the lookup.
    const link = path.join(byIdDir(devRoot), identity);
    const viaLink = realPathOrNull(link);
    if (viaLink) return viaLink;

    // sysfs identity: scan candidate ttys for a matching identity.
    let entries;
    try {
        entries = fs.readdirSync(devRoot);
    } catch (e) {
        return null;
    }
    for (const entry of entries) {
        if (!/^tty(USB|ACM)\d+$/.test(entry)) continue;
        const candidate = path.join(devRoot, entry);
        if (identityFromSysfs(candidate, opts) === identity) return candidate;
    }
    return null;
}

function loadRememberedIdentity(identityFile) {
    try {
        const parsed = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
        return typeof parsed.identity === 'string' ? parsed.identity : null;
    } catch (e) {
        return null;
    }
}

function saveRememberedIdentity(identityFile, identity) {
    try {
        fs.mkdirSync(path.dirname(identityFile), { recursive: true });
        fs.writeFileSync(identityFile, JSON.stringify({ identity }, null, 2));
    } catch (e) {
        // Losing the memo only costs us recovery next boot; never fail startup.
    }
}

/**
 * @param {object} args
 * @param {string} args.configuredPath
 * @param {string} [args.identityFile]
 * @param {string} [args.devRoot]
 * @param {string} [args.sysfsRoot]
 * @returns {{ path: string|null, source: 'configured'|'recovered', identity: string|null, stablePath: string|null, messages: string[] }}
 */
function resolveSerialDevice(args) {
    const { configuredPath } = args;
    const identityFile = args.identityFile || DEFAULT_IDENTITY_FILE;
    const opts = { devRoot: args.devRoot || '/dev', sysfsRoot: args.sysfsRoot || '/sys' };
    const messages = [];

    if (fs.existsSync(configuredPath)) {
        const identity = readIdentity(configuredPath, opts);
        if (identity) saveRememberedIdentity(identityFile, identity);
        else messages.push(`No stable identity found for ${configuredPath}; automatic recovery after a replug will not be possible`);

        // Recommend the stable path whenever a raw tty path was configured.
        let stablePath = null;
        const byIdName = identityFromByIdDir(configuredPath, opts);
        if (byIdName) {
            stablePath = path.join(byIdDir(opts.devRoot), byIdName);
            if (path.resolve(configuredPath) !== stablePath) {
                messages.push(`Prefer the stable path: set cgate_serial_device to ${stablePath}`);
            }
        }
        return { path: configuredPath, source: 'configured', identity, stablePath, messages };
    }

    messages.push(`Serial device not found: ${configuredPath}`);
    const remembered = loadRememberedIdentity(identityFile);
    if (!remembered) {
        messages.push('No previously-recorded device identity, so the new path cannot be identified automatically');
        return { path: null, source: 'configured', identity: null, stablePath: null, messages };
    }

    const recovered = findDeviceByIdentity(remembered, opts);
    if (!recovered) {
        messages.push(`Previously-used device (${remembered}) is not present either; is the PC Interface plugged in?`);
        return { path: null, source: 'configured', identity: remembered, stablePath: null, messages };
    }

    const stablePath = path.join(byIdDir(opts.devRoot), remembered);
    messages.push(`Recovered: the previously-used device is now at ${recovered} — adopting it for this boot`);
    messages.push(`Update cgate_serial_device to ${stablePath} so this survives future replugs`);
    return { path: recovered, source: 'recovered', identity: remembered, stablePath, messages };
}

function main() {
    const configuredPath = process.argv[2];
    if (!configuredPath) {
        console.error('usage: cgateweb-resolve-serial.js <configured-device-path>');
        process.exit(1);
    }

    const result = resolveSerialDevice({
        configuredPath,
        identityFile: process.env.CGATEWEB_SERIAL_IDENTITY_FILE || DEFAULT_IDENTITY_FILE
    });
    for (const message of result.messages) console.error(message);

    if (!result.path) process.exit(1);

    const deviceFile = process.env.CGATEWEB_SERIAL_DEVICE_FILE || DEFAULT_DEVICE_FILE;
    try {
        fs.mkdirSync(path.dirname(deviceFile), { recursive: true });
        fs.writeFileSync(deviceFile, result.path);
    } catch (e) {
        console.error(`Could not write ${deviceFile}: ${e.message}`);
        process.exit(1);
    }
    console.log(result.path);
}

if (require.main === module) main();

module.exports = {
    identityFromByIdDir,
    identityFromSysfs,
    readIdentity,
    findDeviceByIdentity,
    resolveSerialDevice
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest tests/cgateResolveSerial.test.js`
Expected: PASS, all 10 cases.

- [ ] **Step 5: Run lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add homeassistant-addon/rootfs/usr/bin/cgateweb-resolve-serial.js tests/cgateResolveSerial.test.js
git commit -m "feat: resolve a renumbered USB serial device by remembered identity (issue #28)

A PC Interface that is unplugged and replugged can come back as a
different ttyUSBn, which made cont-init fail on a path that no longer
exists. Records the device's /dev/serial/by-id name (which encodes
vendor, product and serial) on every good boot and uses it to find the
device again after a renumber, falling back to sysfs vendor/product/serial
on hosts without udev by-id links.

Adoption requires an identity match, so an unrelated Zigbee or Z-Wave
dongle on the same host is never picked up by accident. Not yet wired
into the boot scripts."
```

---

## Task 2: Wire the resolver into the boot scripts

Makes all three consumers of `cgate_serial_device` agree on one resolved path.

**Files:**
- Modify: `homeassistant-addon/rootfs/etc/cont-init.d/cgate-install.sh:168-235` (`_cgateweb_check_serial_device`)
- Modify: `homeassistant-addon/rootfs/etc/cont-init.d/cgate-project-sync.sh:96-111`
- Modify: `homeassistant-addon/rootfs/usr/bin/cgateweb-serial-diagnostics`
- Test: `tests/cgateInstallScript.test.js` (add cases)

**Interfaces:**
- Consumes: the Task 1 CLI — `cgateweb-resolve-serial.js <path>` writes the effective path to `$CGATEWEB_SERIAL_DEVICE_FILE` and exits non-zero when unresolvable.
- Produces: `_cgateweb_effective_serial_device()` in `cgate-install.sh`, echoing the resolved path (empty when unset/unresolvable). `cgate-project-sync.sh` and `cgateweb-serial-diagnostics` read `${CGATEWEB_SERIAL_DEVICE_FILE:-/run/cgateweb/serial-device}` when present, falling back to `bashio::config 'cgate_serial_device'`.

- [ ] **Step 1: Write the failing test**

Append to `tests/cgateInstallScript.test.js`, inside the existing top-level `describeBash` block:

```js
describe('_cgateweb_check_serial_device with the resolver', () => {
    it('writes the resolved path to the device file when the device exists', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-serial-'));
        const device = path.join(dir, 'ttyUSB0');
        fs.writeFileSync(device, '');
        const deviceFile = path.join(dir, 'serial-device');

        const env = {
            ...process.env,
            CGATEWEB_INSTALL_SOURCE_ONLY: '1',
            CGW_INSTALL_SCRIPT: SCRIPT,
            CGW_TEST_cgate_serial_device: device,
            CGW_TEST_cgate_mode: 'managed',
            CGATEWEB_SERIAL_DEVICE_FILE: deviceFile,
            CGATEWEB_SERIAL_IDENTITY_FILE: path.join(dir, 'identity.json')
        };
        const script = `
            set -u
            ${BASHIO_STUB}
            source "$CGW_INSTALL_SCRIPT"
            _cgateweb_check_serial_device
        `;
        execFileSync('bash', ['-c', script], { encoding: 'utf8', env });

        expect(fs.readFileSync(deviceFile, 'utf8')).toBe(device);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('fails when the device is absent and no identity was remembered', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-serial-'));
        const env = {
            ...process.env,
            CGATEWEB_INSTALL_SOURCE_ONLY: '1',
            CGW_INSTALL_SCRIPT: SCRIPT,
            CGW_TEST_cgate_serial_device: path.join(dir, 'ttyUSB0'),
            CGW_TEST_cgate_mode: 'managed',
            CGATEWEB_SERIAL_DEVICE_FILE: path.join(dir, 'serial-device'),
            CGATEWEB_SERIAL_IDENTITY_FILE: path.join(dir, 'identity.json')
        };
        const script = `
            set -u
            ${BASHIO_STUB}
            source "$CGW_INSTALL_SCRIPT"
            _cgateweb_check_serial_device
        `;

        expect(() => execFileSync('bash', ['-c', script], { encoding: 'utf8', env, stdio: 'pipe' }))
            .toThrow();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('is a no-op when cgate_serial_device is unset', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-serial-'));
        const deviceFile = path.join(dir, 'serial-device');
        const env = {
            ...process.env,
            CGATEWEB_INSTALL_SOURCE_ONLY: '1',
            CGW_INSTALL_SCRIPT: SCRIPT,
            CGW_TEST_cgate_mode: 'managed',
            CGATEWEB_SERIAL_DEVICE_FILE: deviceFile
        };
        const script = `
            set -u
            ${BASHIO_STUB}
            source "$CGW_INSTALL_SCRIPT"
            _cgateweb_check_serial_device
        `;
        execFileSync('bash', ['-c', script], { encoding: 'utf8', env });

        expect(fs.existsSync(deviceFile)).toBe(false);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest tests/cgateInstallScript.test.js -t "resolver"`
Expected: FAIL — the device file is not written, because the helper does not call the resolver yet.

- [ ] **Step 3: Modify `_cgateweb_check_serial_device`**

In `homeassistant-addon/rootfs/etc/cont-init.d/cgate-install.sh`, replace the body between the beta banner and the mode check (currently lines 185-220, from `if [[ "${device}" != /dev/* ]]` through the `! -c` warning) with a resolver call. Keep the banner, the `/dev/` prefix check, the inventory logging, and the mode warning exactly as they are.

```bash
    if [[ "${device}" != /dev/* ]]; then
        bashio::log.error "cgate_serial_device must be a device path starting with /dev/ (got: ${device})"
        bashio::log.error "Example: /dev/ttyUSB0 — or better, a stable /dev/serial/by-id/ path"
        return 1
    fi

    # Log every serial-looking device the host exposes, so a user who picked
    # the wrong path (or whose dongle enumerated differently than expected)
    # can see what actually exists. nullglob keeps unmatched patterns from
    # reaching ls as literal strings; a missing /dev/serial/by-id/ is fine.
    local inventory
    inventory=$(shopt -s nullglob; ls -l /dev/ttyUSB* /dev/ttyACM* /dev/serial/by-id/ 2>/dev/null)
    if [[ -n "${inventory}" ]]; then
        bashio::log.info "Detected serial devices on this host:"
        bashio::log.info "${inventory}"
    else
        bashio::log.info "No /dev/ttyUSB* or /dev/ttyACM* devices found and no /dev/serial/by-id/ directory — is the PCI plugged in?"
    fi

    # Resolve the configured path to a live one. A replugged PCI can come back
    # as a different ttyUSBn (issue #28), so the resolver falls back to the
    # device identity recorded on the last good boot rather than failing on a
    # path that no longer exists. Its messages go to stderr; surface them.
    local resolved resolver_output resolver_status=0
    if ! command -v node >/dev/null 2>&1; then
        bashio::log.warning "node unavailable — falling back to a plain existence check for ${device}"
        if [[ ! -e "${device}" ]]; then
            bashio::log.error "Serial device not found: ${device}"
            return 1
        fi
        resolved="${device}"
    else
        resolver_output=$(node /usr/bin/cgateweb-resolve-serial.js "${device}" 2>&1) || resolver_status=$?
        # The resolved path is the last line on success; everything else is a message.
        resolved=$(printf '%s' "${resolver_output}" | tail -n 1)
        while IFS= read -r line; do
            [[ -z "${line}" || "${line}" == "${resolved}" ]] && continue
            bashio::log.warning "${line}"
        done <<< "${resolver_output}"
        if [[ ${resolver_status} -ne 0 ]]; then
            bashio::log.error "Could not resolve cgate_serial_device"
            bashio::log.error "Find the real path in Home Assistant: Settings > System > Hardware > ⋮ (top right) > All hardware"
            bashio::log.error "Look for /dev/ttyUSB* or /dev/ttyACM*; prefer the stable /dev/serial/by-id/ path"
            return 1
        fi
    fi

    bashio::log.info "Using serial device: ${resolved}"
    if [[ ! -c "${resolved}" ]]; then
        bashio::log.warning "${resolved} exists but is not a character device — C-Gate may fail to open it"
    fi
```

Then add this helper immediately after `_cgateweb_check_serial_device`, so later scripts can read one agreed answer:

```bash
# The serial device path agreed on by the resolver at cont-init, or empty when
# the option is unset. Consumers must never re-resolve: a second readlink can
# disagree with the first if the device renumbers between calls.
_cgateweb_effective_serial_device() {
    local file="${CGATEWEB_SERIAL_DEVICE_FILE:-/run/cgateweb/serial-device}"
    if [[ -r "${file}" ]]; then
        cat "${file}"
        return 0
    fi
    printf ''
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest tests/cgateInstallScript.test.js`
Expected: PASS, including the three new cases and all pre-existing ones.

- [ ] **Step 5: Update `cgate-project-sync.sh` to read the resolved path**

Replace line 96 of `homeassistant-addon/rootfs/etc/cont-init.d/cgate-project-sync.sh`:

```bash
SERIAL_DEVICE=$(bashio::config 'cgate_serial_device' '')
```

with:

```bash
# Prefer the path cont-init's resolver agreed on (issue #28): if the device
# renumbered, the configured option still names the old path, and rewriting the
# project to point at a device that no longer exists leaves the network closed.
SERIAL_DEVICE_FILE="${CGATEWEB_SERIAL_DEVICE_FILE:-/run/cgateweb/serial-device}"
if [[ -r "${SERIAL_DEVICE_FILE}" ]]; then
    SERIAL_DEVICE=$(cat "${SERIAL_DEVICE_FILE}")
else
    SERIAL_DEVICE=$(bashio::config 'cgate_serial_device' '')
fi
```

- [ ] **Step 6: Update `cgateweb-serial-diagnostics` the same way**

In `homeassistant-addon/rootfs/usr/bin/cgateweb-serial-diagnostics`, find the line that sets `SERIAL_DEVICE` from `bashio::config` and apply the identical replacement, so the diagnostics block reports the device C-Gate was actually pointed at.

- [ ] **Step 7: Run the full add-on script suite**

Run: `npx jest tests/cgateInstallScript.test.js tests/cgateProjectSync.test.js tests/cgateSerialDiagnostics.test.js tests/cgateProjectSerialFixup.test.js`
Expected: PASS, no regressions.

- [ ] **Step 8: Commit**

```bash
git add homeassistant-addon/rootfs/etc/cont-init.d/cgate-install.sh \
        homeassistant-addon/rootfs/etc/cont-init.d/cgate-project-sync.sh \
        homeassistant-addon/rootfs/usr/bin/cgateweb-serial-diagnostics \
        tests/cgateInstallScript.test.js
git commit -m "fix: agree on one serial device path across the boot scripts (issue #28)

cgate_serial_device was read and resolved independently in three places,
so a device that renumbered between calls could have the install check
pass while the project fixup wrote a stale port name. cont-init now
resolves once via the identity-aware resolver and publishes the answer;
the project sync and diagnostics read it instead of re-resolving.

A replugged PCI that comes back on a different ttyUSBn now recovers at
boot instead of failing cont-init, and the log names the stable
/dev/serial/by-id path to switch to."
```

---

## Task 3: Correct the access.txt grammar

The generated file is malformed by the documented grammar. **Corrected during implementation:** the malformed heredoc was guarded by `if [[ ! -f ]]` and the C-Gate zip ships its own valid `config/access.txt`, so the heredoc never ran and there was no exposure. The task still stands — the add-on should declare its own access explicitly, and the managed block is Task 4's prerequisite — but see the spec's "What the generated access.txt actually does" for the accurate narrative. Do not repeat the empty-access-list claim in release notes.

**Files:**
- Modify: `homeassistant-addon/rootfs/etc/cont-init.d/cgate-install.sh:542-554`
- Test: `tests/cgateAccessControl.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `_cgateweb_write_access_control <access-file>` in `cgate-install.sh`, which creates or rewrites a marker-delimited managed block. Task 4 extends this same function with external client rules.

**Behaviour change note:** this alters a security control on every managed install. The intent is no functional change (localhost keeps full access), but it is the one task in this plan that is not inert by default. It is isolated so it can be reverted alone.

- [ ] **Step 1: Write the failing test**

Create `tests/cgateAccessControl.test.js`:

```js
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { posixBashAvailable } = require('./helpers/posixBash');

const describeBash = posixBashAvailable() ? describe : describe.skip;

const SCRIPT = path.join(
    __dirname, '..', 'homeassistant-addon', 'rootfs', 'etc', 'cont-init.d', 'cgate-install.sh'
);

const BASHIO_STUB = `
    bashio::log.info()    { :; }
    bashio::log.warning() { :; }
    bashio::log.error()   { :; }
    bashio::log.trace()   { :; }
    bashio::config() {
        local key="$1"
        local default_value="\${2:-null}"
        local var_name="CGW_TEST_\${key}"
        if declare -p "$var_name" &>/dev/null; then
            printf '%s' "\${!var_name}"
        else
            printf '%s' "$default_value"
        fi
    }
`;

// Run _cgateweb_write_access_control against a temp access file and return
// { status, contents }. initial === null models a fresh install.
function writeAccessControl({ initial = null, config = {} } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-access-'));
    const file = path.join(dir, 'access.txt');
    if (initial !== null) fs.writeFileSync(file, initial);

    const env = {
        ...process.env,
        CGATEWEB_INSTALL_SOURCE_ONLY: '1',
        CGW_INSTALL_SCRIPT: SCRIPT,
        CGW_ACCESS_FILE: file
    };
    for (const [k, v] of Object.entries(config)) env[`CGW_TEST_${k}`] = v;

    const script = `
        set -u
        ${BASHIO_STUB}
        source "$CGW_INSTALL_SCRIPT"
        _cgateweb_write_access_control "$CGW_ACCESS_FILE"
    `;
    let status = 0;
    try {
        execFileSync('bash', ['-c', script], { encoding: 'utf8', env, stdio: 'pipe' });
    } catch (e) {
        status = e.status;
    }
    const contents = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    fs.rmSync(dir, { recursive: true, force: true });
    return { status, contents };
}

describeBash('_cgateweb_write_access_control', () => {
    it('writes localhost rules using the documented grammar', () => {
        const { status, contents } = writeAccessControl();

        expect(status).toBe(0);
        expect(contents).toContain('remote 127.0.0.1 program');
        expect(contents).toContain('remote 0:0:0:0:0:0:0:1 program');
    });

    it('never emits the malformed lines the old version wrote', () => {
        const { contents } = writeAccessControl();

        // "program" and "monitor" are access levels, not keywords: lines using
        // them as keywords are silently ignored by C-Gate (manual 4.10.1).
        expect(contents).not.toMatch(/^program /m);
        expect(contents).not.toMatch(/^monitor /m);
        // An interface rule matches the server NIC a connection arrives on, so
        // it silently becomes a blanket grant. The add-on must never write one.
        expect(contents).not.toMatch(/^interface /m);
    });

    it('replaces its own managed block on a second run rather than duplicating it', () => {
        const first = writeAccessControl().contents;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-access-'));
        const file = path.join(dir, 'access.txt');
        fs.writeFileSync(file, first);

        const env = {
            ...process.env,
            CGATEWEB_INSTALL_SOURCE_ONLY: '1',
            CGW_INSTALL_SCRIPT: SCRIPT,
            CGW_ACCESS_FILE: file
        };
        execFileSync('bash', ['-c', `
            set -u
            ${BASHIO_STUB}
            source "$CGW_INSTALL_SCRIPT"
            _cgateweb_write_access_control "$CGW_ACCESS_FILE"
        `], { encoding: 'utf8', env });
        const second = fs.readFileSync(file, 'utf8');
        fs.rmSync(dir, { recursive: true, force: true });

        expect(second).toBe(first);
        expect(second.match(/cgateweb managed block/g)).toHaveLength(2); // begin + end
    });

    it('preserves hand-added lines outside the managed block', () => {
        const initial = [
            '# my own rule',
            'remote 10.0.0.9 monitor',
            '# >>> cgateweb managed block - do not edit <<<',
            'remote 127.0.0.1 program',
            '# <<< cgateweb managed block >>>'
        ].join('\n') + '\n';

        const { contents } = writeAccessControl({ initial });

        expect(contents).toContain('# my own rule');
        expect(contents).toContain('remote 10.0.0.9 monitor');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest tests/cgateAccessControl.test.js`
Expected: FAIL — `_cgateweb_write_access_control: command not found`.

- [ ] **Step 3: Add the helper**

In `homeassistant-addon/rootfs/etc/cont-init.d/cgate-install.sh`, add this above the `CGATEWEB_INSTALL_SOURCE_ONLY` guard (so tests can source it):

```bash
# ─── C-Gate access control ─────────────────────────────────────────────────
# Markers delimiting the block this script owns. Anything outside them is the
# user's and is preserved across boots.
CGATEWEB_ACCESS_BEGIN='# >>> cgateweb managed block - do not edit <<<'
CGATEWEB_ACCESS_END='# <<< cgateweb managed block >>>'

# Write C-Gate's access control file (manual 4.10.1).
#
# The grammar is `<keyword> <address> <level>` with exactly three keywords:
# interface (the server NIC a connection arrives on), remote (the connecting
# client's address), and user. Levels, increasing, are none, connect, monitor,
# operate, admin, program, debug. Faulty lines are silently ignored.
#
# Earlier versions of this script wrote `interface 127.0.0.1` with no level plus
# `program 127.0.0.1` and `monitor 127.0.0.1`, using level names as keywords.
# All three are faulty, so managed installs were running with an effectively
# empty access list and relying on C-Gate's built-in default. Combined with
# accept-connections-from defaulting to all, that is not something to publish
# ports on top of.
#
# Only `remote` rules are ever written. An `interface` rule matches every
# connection arriving on that NIC, so one intended as a per-client grant
# silently becomes a blanket grant for the whole LAN.
_cgateweb_write_access_control() {
    local access_file="$1"
    local dir
    dir=$(dirname "${access_file}")
    mkdir -p "${dir}"

    # cgateweb and managed C-Gate share this container, so the bridge connects
    # from loopback. program level because managed mode loads and starts projects.
    local -a rules=(
        "remote 127.0.0.1 program"
        "remote 0:0:0:0:0:0:0:1 program"
    )

    local preserved=""
    if [[ -f "${access_file}" ]]; then
        # Keep everything outside our markers; drop the old block and any
        # pre-marker lines this script previously generated.
        preserved=$(awk -v b="${CGATEWEB_ACCESS_BEGIN}" -v e="${CGATEWEB_ACCESS_END}" '
            $0 == b { inblock = 1; next }
            $0 == e { inblock = 0; next }
            inblock { next }
            /^interface 127\.0\.0\.1$/ { next }
            /^program 127\.0\.0\.1$/   { next }
            /^monitor 127\.0\.0\.1$/   { next }
            { print }
        ' "${access_file}")
    else
        preserved="# C-Gate Access Control
# Lines outside the cgateweb block below are preserved across restarts."
    fi

    {
        printf '%s\n' "${preserved}"
        printf '%s\n' "${CGATEWEB_ACCESS_BEGIN}"
        local rule
        for rule in "${rules[@]}"; do printf '%s\n' "${rule}"; done
        printf '%s\n' "${CGATEWEB_ACCESS_END}"
    } > "${access_file}.tmp"
    mv "${access_file}.tmp" "${access_file}"

    bashio::log.info "Wrote C-Gate access control (${#rules[@]} rule(s))"
    return 0
}
```

- [ ] **Step 4: Replace the old generation block**

Replace lines 542-554 of `cgate-install.sh` (the `# Configure access.txt to allow local connections` block and its heredoc) with:

```bash
# Configure access.txt. Runs on every boot, not only when the file is absent,
# so the grammar fix and any configured external clients reach existing installs.
ACCESS_FILE="${CGATE_DIR}/config/access.txt"
if ! _cgateweb_write_access_control "${ACCESS_FILE}"; then
    bashio::log.error "Failed to write C-Gate access control file"
    exit 1
fi
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest tests/cgateAccessControl.test.js tests/cgateInstallScript.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add homeassistant-addon/rootfs/etc/cont-init.d/cgate-install.sh tests/cgateAccessControl.test.js
git commit -m "fix: generate access.txt using C-Gate's documented grammar

The generated file used access level names as keywords (program 127.0.0.1,
monitor 127.0.0.1) and wrote an interface rule with no level at all. All
three forms are faulty per the C-Gate manual section 4.10.1, and faulty
lines are silently ignored, so managed installs have been running with an
effectively empty access control list and relying on C-Gate's built-in
default. accept-connections-from defaults to all and is explicitly not
the security mechanism, so this needs to be correct before any port is
published.

Replaced with 'remote <addr> program' for IPv4 and IPv6 loopback, written
into a marker-delimited block so hand-added rules survive. Only remote
rules are generated: an interface rule matches every connection arriving
on that NIC, so one intended per-client silently becomes a LAN-wide grant.

Rewritten on every boot rather than only when absent, so the fix reaches
existing installs."
```

---

## Task 4: External client access and port declarations

**Files:**
- Modify: `homeassistant-addon/rootfs/etc/cont-init.d/cgate-install.sh` (extend `_cgateweb_write_access_control`)
- Modify: `homeassistant-addon/config.yaml`
- Modify: all 17 `homeassistant-addon/translations/*.yaml`
- Test: `tests/cgateAccessControl.test.js` (add cases)

**Interfaces:**
- Consumes: `_cgateweb_write_access_control <access-file>` and the `CGATEWEB_ACCESS_BEGIN` / `CGATEWEB_ACCESS_END` markers from Task 3.
- Produces: the `cgate_external_clients` option, read inside `_cgateweb_write_access_control` via `bashio::config`.

- [ ] **Step 1: Add the test seam**

Reading an object list through the bashio stub means reimplementing bashio's list flattening in the stub, which tests the stub rather than the code. Instead, `_cgateweb_write_access_control` will call a separate `_cgateweb_external_client_rules` function that emits one `remote <address> <level>` line per configured client, and the tests override that function. Validation — the part worth testing — stays in `_cgateweb_write_access_control`.

In `tests/cgateAccessControl.test.js`, add this constant below `BASHIO_STUB`:

```js
// Overrides the real _cgateweb_external_client_rules so tests can feed rules in
// directly instead of reimplementing bashio's object-list flattening. Must be
// sourced AFTER the script, so it wins.
const EXTERNAL_RULES_STUB = `
    _cgateweb_external_client_rules() {
        if [[ -n "\${CGW_EXTERNAL_RULES:-}" ]]; then
            printf '%s\\n' "\${CGW_EXTERNAL_RULES}"
        fi
    }
`;
```

and change `writeAccessControl`'s script body to insert it after the `source`:

```js
    const script = `
        set -u
        ${BASHIO_STUB}
        source "$CGW_INSTALL_SCRIPT"
        ${EXTERNAL_RULES_STUB}
        _cgateweb_write_access_control "$CGW_ACCESS_FILE"
    `;
```

`writeAccessControl` already forwards `config` entries as `CGW_TEST_*`; add a pass-through for `CGW_EXTERNAL_RULES` by including it in the `config` object, since the loop sets `CGW_TEST_CGW_EXTERNAL_RULES` otherwise. Change the loop to:

```js
    for (const [k, v] of Object.entries(config)) {
        env[k.startsWith('CGW_') ? k : `CGW_TEST_${k}`] = v;
    }
```

- [ ] **Step 2: Write the failing tests**

Add to the `describeBash('_cgateweb_write_access_control')` block:

```js
    it('adds a remote rule per configured external client', () => {
        const { status, contents } = writeAccessControl({
            config: { CGW_EXTERNAL_RULES: 'remote 192.168.1.60 program\nremote 192.168.1.255 monitor' }
        });

        expect(status).toBe(0);
        expect(contents).toContain('remote 192.168.1.60 program');
        expect(contents).toContain('remote 192.168.1.255 monitor');
        // Localhost access is never dropped when external clients are added.
        expect(contents).toContain('remote 127.0.0.1 program');
    });

    it('revokes access when an address is removed from the option', () => {
        const withClient = writeAccessControl({
            config: { CGW_EXTERNAL_RULES: 'remote 192.168.1.60 program' }
        }).contents;
        expect(withClient).toContain('192.168.1.60');

        const withoutClient = writeAccessControl().contents;
        expect(withoutClient).not.toContain('192.168.1.60');
    });

    it('rejects an address that is not an IP or hostname', () => {
        const { status } = writeAccessControl({
            config: { CGW_EXTERNAL_RULES: 'remote not@a@host program' }
        });

        expect(status).not.toBe(0);
    });

    it('rejects a level outside monitor/operate/program', () => {
        const { status } = writeAccessControl({
            config: { CGW_EXTERNAL_RULES: 'remote 192.168.1.60 debug' }
        });

        expect(status).not.toBe(0);
    });

    it('rejects an entry with a missing level', () => {
        const { status } = writeAccessControl({
            config: { CGW_EXTERNAL_RULES: 'remote 192.168.1.60' }
        });

        expect(status).not.toBe(0);
    });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest tests/cgateAccessControl.test.js`
Expected: FAIL — external client addresses do not appear in the output.

- [ ] **Step 4: Extend the helper**

In `cgate-install.sh`, add the list reader above `_cgateweb_write_access_control`:

```bash
# One "remote <address> <level>" line per configured external client, or
# nothing when the list is empty. Split out so it can be stubbed in tests
# without depending on bashio's list flattening.
_cgateweb_external_client_rules() {
    local count
    count=$(bashio::config 'cgate_external_clients|length' '0')
    [[ "${count}" =~ ^[0-9]+$ ]] || count=0

    local i address level
    for ((i = 0; i < count; i++)); do
        address=$(bashio::config "cgate_external_clients[${i}].address" '')
        level=$(bashio::config "cgate_external_clients[${i}].level" '')
        [[ -z "${address}" || "${address}" == "null" ]] && continue
        [[ -z "${level}" || "${level}" == "null" ]] && level='monitor'
        printf 'remote %s %s\n' "${address}" "${level}"
    done
}
```

Then, inside `_cgateweb_write_access_control`, after the `rules` array is initialised, append and validate the external rules:

```bash
    # External clients (issue #37): C-Gate is a multi-client server, so Toolkit
    # and friends connect to it directly rather than sharing the serial port.
    # Validate here so a typo fails cont-init with a readable error instead of
    # being silently dropped by C-Gate.
    local line address level
    while IFS= read -r line; do
        [[ -z "${line}" ]] && continue
        # shellcheck disable=SC2086
        set -- ${line}
        if [[ $# -ne 3 ]]; then
            bashio::log.error "Invalid cgate_external_clients entry: '${line}'"
            return 1
        fi
        address="$2"
        level="$3"
        if [[ ! "${address}" =~ ^[A-Za-z0-9_.:-]+$ ]]; then
            bashio::log.error "Invalid address in cgate_external_clients: '${address}'"
            bashio::log.error "Use an IP address or hostname. An octet of 255 matches any value, e.g. 192.168.1.255 for the whole subnet."
            return 1
        fi
        case "${level}" in
            monitor|operate|program) ;;
            *)
                bashio::log.error "Invalid level '${level}' for ${address}; use monitor, operate or program"
                return 1
                ;;
        esac
        rules+=("remote ${address} ${level}")
        bashio::log.warning "C-Gate access granted to ${address} at ${level} level"
    done < <(_cgateweb_external_client_rules)

    if [[ ${#rules[@]} -gt 2 ]]; then
        bashio::log.warning "C-Gate has no authentication on its command ports; only publish them if you need external access"
    fi
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest tests/cgateAccessControl.test.js`
Expected: PASS.

- [ ] **Step 6: Add the option to `config.yaml`**

In `options`, alongside the other array defaults (after `web_allowed_origins: []`):

```yaml
  # Object lists cannot be optional, so this needs a default here. Empty means
  # localhost-only access, identical to previous releases.
  cgate_external_clients: []
```

In `schema`, after `cgate_serial_device`:

```yaml
  # External C-Gate access (issue #37). C-Gate is a multi-client server, so
  # Toolkit connects to the managed instance rather than sharing the PCI.
  # An octet of 255 matches any value: 192.168.1.255 is the whole subnet.
  cgate_external_clients:
    - address: "str"
      level: "list(monitor|operate|program)"
```

In `ports` and `ports_description`:

```yaml
ports:
  "8080/tcp": null
  "20023/tcp": null
  "20024/tcp": null
  "20025/tcp": null

ports_description:
  "8080/tcp": "C-Bus Label Editor web interface (optional; ingress works without host mapping — set web_api_key if you expose this port)"
  "20023/tcp": "C-Gate command port (managed mode only). C-Gate has NO authentication: list allowed addresses in cgate_external_clients before publishing this."
  "20024/tcp": "C-Gate event port (managed mode only). Requires cgate_external_clients; see the 20023 warning."
  "20025/tcp": "C-Gate status change port (managed mode only). Requires cgate_external_clients; see the 20023 warning."
```

- [ ] **Step 7: Add translations to all 17 files**

For each file in `homeassistant-addon/translations/`, add a `cgate_external_clients` entry under `configuration:`, matching the structure `en.yaml` uses for other options. English text:

```yaml
    cgate_external_clients:
      name: External C-Gate clients
      description: >-
        Addresses allowed to connect to the managed C-Gate, for tools such as
        C-Bus Toolkit. Leave empty to allow only this add-on. C-Gate has no
        authentication, and program level allows reprogramming C-Bus units, so
        list specific addresses rather than a whole subnet. An octet of 255
        matches any value, so 192.168.1.255 means the entire 192.168.1.x
        network. You must also publish C-Gate's ports in the Network panel.
```

Translate `name` and `description` per language. Keep in English: C-Gate, C-Bus, Toolkit, `monitor`, `operate`, `program`, and all addresses.

- [ ] **Step 8: Run the config and translation validators**

Run: `npm run validate:translations && npm run validate:addon-config && npx jest tests/validateAddonConfig.test.js`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add homeassistant-addon/rootfs/etc/cont-init.d/cgate-install.sh \
        homeassistant-addon/config.yaml \
        homeassistant-addon/translations \
        tests/cgateAccessControl.test.js
git commit -m "feat: let external clients reach managed C-Gate (issue #37)

C-Bus Toolkit could not reach a C-Bus network whose PC Interface was
plugged into the Home Assistant host, because managed C-Gate holds the
serial port exclusively. Exposing the port over TCP as a pretend CNI was
rejected: two masters interleaving PCI confirmation codes can corrupt a
Toolkit programming write.

C-Gate is already a multi-client server, so external clients connect to
it directly and it arbitrates. cgate_external_clients lists the allowed
addresses and their access level (monitor, operate or program; Toolkit
needs program), rendered as remote rules in the access control file.
C-Gate's ports are declared so they can be mapped in the Network panel,
defaulting to unpublished.

Both defaults are inert: an empty client list produces the same
localhost-only file as before, and the ports stay unpublished until the
user maps them."
```

---

## Task 5: Unit-type classifier

**Files:**
- Create: `src/unitTypeClassifier.js`
- Test: `tests/unitTypeClassifier.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `categoriseUnitType(type)` → `'dimmer' | 'relay' | 'input' | 'management' | null`
  - `entityTypeForGroup(groupInfo, settings)` → `'light-dimmable' | 'light-onoff' | 'binary_sensor' | null`. **Superseded during implementation:** `groupInfo` is `{ types }` only. Review removed `hasOutput`/`hasInput` as derivable-and-therefore-desyncable, and added asymmetric unknown handling. See Task 6's Interfaces block for the live contract.
  - `UNKNOWN_TYPE_MARKER` — the string `'unknown'`, used by Task 6's logging.

- [ ] **Step 1: Write the failing test**

Create `tests/unitTypeClassifier.test.js`:

```js
const { categoriseUnitType, entityTypeForGroup } = require('../src/unitTypeClassifier');

const ON = { ha_discovery_type_from_unit: true };

describe('categoriseUnitType', () => {
    it.each([
        ['DIMDN8', 'dimmer'],
        ['DIMMER4', 'dimmer'],
        ['RELDN12', 'relay'],
        ['RELAY2', 'relay'],
        ['SENLL', 'input'],
        ['SENTEMP', 'input'],
        ['PC_CNIED', 'management'],
        ['PCLOCAL4', 'management'],
        ['TEXT', 'management']
    ])('categorises %s as %s', (type, expected) => {
        expect(categoriseUnitType(type)).toBe(expected);
    });

    it('is case-insensitive', () => {
        expect(categoriseUnitType('dimdn8')).toBe('dimmer');
    });

    it('returns null for an unknown type rather than guessing', () => {
        expect(categoriseUnitType('WIDGET9000')).toBeNull();
    });

    it('returns null for missing or blank input', () => {
        expect(categoriseUnitType(undefined)).toBeNull();
        expect(categoriseUnitType('')).toBeNull();
        expect(categoriseUnitType('   ')).toBeNull();
    });
});

describe('entityTypeForGroup', () => {
    it('makes a dimmer-driven group a dimmable light', () => {
        const result = entityTypeForGroup(
            { types: ['DIMDN8'], hasOutput: true, hasInput: false }, ON
        );
        expect(result).toBe('light-dimmable');
    });

    it('makes a relay-driven group an on/off light', () => {
        const result = entityTypeForGroup(
            { types: ['RELDN12'], hasOutput: true, hasInput: false }, ON
        );
        expect(result).toBe('light-onoff');
    });

    it('keeps brightness when a group is driven by both a dimmer and a relay', () => {
        const result = entityTypeForGroup(
            { types: ['RELDN12', 'DIMDN8'], hasOutput: true, hasInput: false }, ON
        );
        expect(result).toBe('light-dimmable');
    });

    it('makes an input-only group a binary sensor', () => {
        const result = entityTypeForGroup(
            { types: ['SENLL'], hasOutput: false, hasInput: true }, ON
        );
        expect(result).toBe('binary_sensor');
    });

    it('keeps a group a light when an input unit also drives an output', () => {
        const result = entityTypeForGroup(
            { types: ['SENLL', 'DIMDN8'], hasOutput: true, hasInput: true }, ON
        );
        expect(result).toBe('light-dimmable');
    });

    it('has no opinion on a management-only group', () => {
        const result = entityTypeForGroup(
            { types: ['PC_CNIED'], hasOutput: false, hasInput: false }, ON
        );
        expect(result).toBeNull();
    });

    it('has no opinion when every driving unit type is unknown', () => {
        const result = entityTypeForGroup(
            { types: ['WIDGET9000'], hasOutput: false, hasInput: false }, ON
        );
        expect(result).toBeNull();
    });

    it('returns null when the setting is off', () => {
        const result = entityTypeForGroup(
            { types: ['RELDN12'], hasOutput: true, hasInput: false },
            { ha_discovery_type_from_unit: false }
        );
        expect(result).toBeNull();
    });

    it('returns null when the auto-type master switch is off', () => {
        const result = entityTypeForGroup(
            { types: ['RELDN12'], hasOutput: true, hasInput: false },
            { ha_discovery_type_from_unit: true, ha_discovery_auto_type: false }
        );
        expect(result).toBeNull();
    });

    it('accepts a Set of types as well as an array', () => {
        const result = entityTypeForGroup(
            { types: new Set(['DIMDN8']), hasOutput: true, hasInput: false }, ON
        );
        expect(result).toBe('light-dimmable');
    });

    it('returns null for missing group info', () => {
        expect(entityTypeForGroup(null, ON)).toBeNull();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest tests/unitTypeClassifier.test.js`
Expected: FAIL — `Cannot find module '../src/unitTypeClassifier'`

- [ ] **Step 3: Write the implementation**

Create `src/unitTypeClassifier.js`:

```js
// @ts-check
/**
 * Classify a C-Bus group by the unit that drives it (issues #38, #37).
 *
 * C-Gate's TREEXML reports a <Type> per unit, so a group's entity type can come
 * from the hardware rather than from guessing at its name. A dimmer channel is a
 * dimmable light, a relay channel is an on/off light, and a group driven only by
 * an input unit (bus coupler, key input, sensor) is a binary sensor.
 *
 * Unknown types return null and fall through to existing behaviour. The catalogue
 * of real type strings is incomplete, so guessing would misclassify hardware
 * nobody here has seen; the caller logs unrecognised types instead.
 */

// Prefixes matched case-insensitively against the unit's TREEXML <Type>.
// Confirmed real values: DIMDN8, RELDN12, RELAY2, PCLOCAL4, SENLL, SENTEMP,
// PC_CNIED, TEXT.
const UNIT_TYPE_PATTERNS = [
    { pattern: /^DIM/i, category: 'dimmer' },
    { pattern: /^REL/i, category: 'relay' },
    { pattern: /^SEN/i, category: 'input' },
    { pattern: /^PC_/i, category: 'management' },
    { pattern: /^PCLOCAL/i, category: 'management' },
    { pattern: /^TEXT/i, category: 'management' }
];

const UNKNOWN_TYPE_MARKER = 'unknown';

/**
 * @param {string} [type] - Raw TREEXML unit type string.
 * @returns {'dimmer'|'relay'|'input'|'management'|null}
 */
function categoriseUnitType(type) {
    if (typeof type !== 'string') return null;
    const trimmed = type.trim();
    if (!trimmed) return null;

    for (const { pattern, category } of UNIT_TYPE_PATTERNS) {
        if (pattern.test(trimmed)) return /** @type {any} */ (category);
    }
    return null;
}

/**
 * Resolve the entity type for a group from the units driving it.
 *
 * Output beats input, so a coupler that also switches a real load stays a light.
 * Dimmer beats relay, so a group on both keeps its brightness slider rather
 * than silently losing it.
 *
 * @param {{ types: Set<string>|string[], hasOutput: boolean, hasInput: boolean }|null} groupInfo
 * @param {Object} settings
 * @param {boolean} [settings.ha_discovery_type_from_unit]
 * @param {boolean} [settings.ha_discovery_auto_type]
 * @returns {'light-dimmable'|'light-onoff'|'binary_sensor'|null}
 */
function entityTypeForGroup(groupInfo, settings = {}) {
    if (settings.ha_discovery_type_from_unit !== true) return null;
    if (settings.ha_discovery_auto_type === false) return null;
    if (!groupInfo || !groupInfo.types) return null;

    const categories = new Set();
    for (const type of groupInfo.types) {
        const category = categoriseUnitType(type);
        if (category) categories.add(category);
    }

    if (categories.has('dimmer')) return 'light-dimmable';
    if (categories.has('relay')) return 'light-onoff';
    if (categories.has('input') && !groupInfo.hasOutput) return 'binary_sensor';
    return null;
}

module.exports = { categoriseUnitType, entityTypeForGroup, UNIT_TYPE_PATTERNS, UNKNOWN_TYPE_MARKER };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest tests/unitTypeClassifier.test.js`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/unitTypeClassifier.js tests/unitTypeClassifier.test.js
git commit -m "feat: classify C-Bus groups by the unit type that drives them

Pure classifier mapping a TREEXML unit type to a category, and a group's
set of driving units to an entity type: dimmer channels become dimmable
lights, relay channels on/off lights, and input-only groups binary
sensors. Output beats input so a coupler that also switches a load stays
a light, and dimmer beats relay so a group on both keeps its brightness.

Unknown types return null rather than guessing. The catalogue of real
type strings is incomplete, so a guess would misclassify hardware nobody
has seen. Not yet wired into discovery."
```

---

## Task 6: Index unit types per group from TREEXML

**Files:**
- Modify: `src/haDiscoveryTree.js` (add `collectUnitTypesByGroup`, extend `module.exports`)
- Test: `tests/haDiscoveryTree.test.js` (add cases)

**Interfaces:**
- Consumes: nothing from Task 5 (kept independent so it is testable alone).
- Produces: `collectUnitTypesByGroup(networkData, targetApps)` → `Map<string, { types: Set<string> }>` keyed `"<appId>/<groupId>"`, plus `unknownUnitTypes(networkData)` → `string[]` of distinct unrecognised type strings for logging. Task 7 consumes both.

**Contract note from Task 5's review:** the classifier's signature is now
`entityTypeForGroup({ types }, settings)`. It derives dimmer/relay/input/unrecognised
from `types` alone, and applies asymmetric unknown handling — a recognised dimmer
or relay still wins even alongside an unrecognised type, but the `binary_sensor`
conclusion requires that no unrecognised type is present, because it is the only
destructive outcome (it removes the command topic and clears the retained light
config). So `collectUnitTypesByGroup` must record **every** non-blank type it
encounters, including unrecognised ones — dropping them would silently re-enable
the misclassification that review caught.

- [ ] **Step 1: Write the failing test**

Append to `tests/haDiscoveryTree.test.js`:

```js
describe('collectUnitTypesByGroup', () => {
    const { collectUnitTypesByGroup, unknownUnitTypes } = require('../src/haDiscoveryTree');

    it('indexes structured TREEXML units by app/group', () => {
        const network = {
            Unit: [
                {
                    UnitAddress: '10', Type: 'DIMDN8',
                    Application: { ApplicationAddress: '56', Group: [{ GroupAddress: '1' }] }
                },
                {
                    UnitAddress: '11', Type: 'RELDN12',
                    Application: { ApplicationAddress: '56', Group: [{ GroupAddress: '2' }] }
                }
            ]
        };

        const index = collectUnitTypesByGroup(network, ['56']);

        expect([...index.get('56/1').types]).toEqual(['DIMDN8']);
        expect([...index.get('56/2').types]).toEqual(['RELDN12']);
    });

    it('indexes the flat TREEXML shape', () => {
        const network = {
            Unit: { UnitAddress: '12', Type: 'RELAY2', Application: '56, 255', Groups: '5,6' }
        };

        const index = collectUnitTypesByGroup(network, ['56']);

        expect([...index.get('56/5').types]).toEqual(['RELAY2']);
        expect([...index.get('56/6').types]).toEqual(['RELAY2']);
    });

    it('merges every unit that drives the same group', () => {
        const network = {
            Unit: [
                { UnitAddress: '10', Type: 'SENLL', Application: { ApplicationAddress: '56', Group: [{ GroupAddress: '7' }] } },
                { UnitAddress: '11', Type: 'DIMDN8', Application: { ApplicationAddress: '56', Group: [{ GroupAddress: '7' }] } }
            ]
        };

        const entry = collectUnitTypesByGroup(network, ['56']).get('56/7');

        // Every driving unit's type is recorded, recognised or not. The
        // classifier derives the categories; the index must not pre-judge.
        expect([...entry.types].sort()).toEqual(['DIMDN8', 'SENLL']);
    });

    it('marks an input-only group as input with no output', () => {
        const network = {
            Unit: { UnitAddress: '20', Type: 'SENLL', Application: { ApplicationAddress: '56', Group: [{ GroupAddress: '40' }] } }
        };

        const entry = collectUnitTypesByGroup(network, ['56']).get('56/40');

        expect([...entry.types]).toEqual(['SENLL']);
    });

    it('ignores applications outside the target list', () => {
        const network = {
            Unit: { UnitAddress: '10', Type: 'DIMDN8', Application: { ApplicationAddress: '99', Group: [{ GroupAddress: '1' }] } }
        };

        expect(collectUnitTypesByGroup(network, ['56']).size).toBe(0);
    });

    it('returns an empty index for missing network data', () => {
        expect(collectUnitTypesByGroup(null, ['56']).size).toBe(0);
    });

    it('lists distinct unrecognised unit types', () => {
        const network = {
            Unit: [
                { UnitAddress: '10', Type: 'WIDGET9000' },
                { UnitAddress: '11', Type: 'WIDGET9000' },
                { UnitAddress: '12', Type: 'DIMDN8' }
            ]
        };

        expect(unknownUnitTypes(network)).toEqual(['WIDGET9000']);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest tests/haDiscoveryTree.test.js -t collectUnitTypesByGroup`
Expected: FAIL — `collectUnitTypesByGroup is not a function`

- [ ] **Step 3: Write the implementation**

Add to `src/haDiscoveryTree.js`, immediately after `collectUnitGroups`:

```js
const { categoriseUnitType } = require('./unitTypeClassifier');

// Which app/group pairs each unit type drives, so discovery can classify a
// group by its hardware instead of its name (issues #38, #37). Mirrors
// collectUnitGroups' handling of both TREEXML shapes, but keeps the unit type
// that collectUnitGroups discards.
function collectUnitTypesByGroup(networkData, targetApps) {
    /** @type {Map<string, { types: Set<string> }>} */
    const index = new Map();
    if (!networkData) return index;

    let units = networkData.Unit || [];
    if (!Array.isArray(units)) units = [units];

    const record = (appId, groupId, type) => {
        const key = `${appId}/${groupId}`;
        if (!index.has(key)) index.set(key, { types: new Set() });
        if (type) index.get(key).types.add(type);
    };

    units.forEach(unit => {
        if (!unit) return;
        const type = (unit.Type !== null && unit.Type !== undefined) ? String(unit.Type).trim() : '';
        if (!unit.Application) return;

        if (typeof unit.Application === 'object') {
            const apps = Array.isArray(unit.Application) ? unit.Application : [unit.Application];
            apps.forEach(app => {
                if (!app || app.ApplicationAddress === null || app.ApplicationAddress === undefined) return;
                const appId = String(app.ApplicationAddress);
                if (!targetApps.includes(appId) || !app.Group) return;
                const groups = Array.isArray(app.Group) ? app.Group : [app.Group];
                groups.forEach(g => {
                    if (g && g.GroupAddress !== null && g.GroupAddress !== undefined) {
                        record(appId, String(g.GroupAddress), type);
                    }
                });
            });
            return;
        }

        const unitAppIds = String(unit.Application).split(',').map(s => s.trim()).filter(Boolean);
        const groupIds = (unit.Groups && typeof unit.Groups === 'string')
            ? unit.Groups.split(',').map(s => s.trim()).filter(Boolean)
            : [];
        if (groupIds.length === 0) return;
        targetApps.filter(t => unitAppIds.includes(t)).forEach(appId => {
            groupIds.forEach(gid => record(appId, gid, type));
        });
    });

    return index;
}

// Distinct unit types in the tree that the classifier does not recognise.
// Logged once per discovery run so a field report can extend the table without
// anyone having to guess at hardware they do not have (issue #37).
function unknownUnitTypes(networkData) {
    if (!networkData) return [];
    let units = networkData.Unit || [];
    if (!Array.isArray(units)) units = [units];

    const unknown = new Set();
    units.forEach(unit => {
        if (!unit || unit.Type === null || unit.Type === undefined) return;
        const type = String(unit.Type).trim();
        if (type && !categoriseUnitType(type)) unknown.add(type);
    });
    return [...unknown];
}
```

Add both to `module.exports`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest tests/haDiscoveryTree.test.js`
Expected: PASS, including all pre-existing cases.

- [ ] **Step 5: Commit**

```bash
git add src/haDiscoveryTree.js tests/haDiscoveryTree.test.js
git commit -m "feat: index TREEXML unit types per group

collectUnitGroups flattens groups across units and discards the unit, so
there was no way to tell what hardware drives a group. Adds a parallel
index keyed by app/group carrying the driving unit types and whether any
of them is an output or an input, handling both TREEXML shapes.

Also lists unrecognised unit types so a field report can extend the
classifier's table. Not yet consumed by discovery."
```

---

## Task 7: Wire classification into discovery

**Files:**
- Modify: `src/haDiscovery.js:285-360` (build and clear the index)
- Modify: `src/haDiscoveryPublishers.js:120-226` (precedence step, on/off light, binary_sensor)
- Modify: `src/defaultSettings.js`
- Modify: `homeassistant-addon/config.yaml` + all 17 translations
- Test: `tests/haDiscovery.test.js` (add cases)

**Interfaces:**
- Consumes: `entityTypeForGroup` from Task 5; `collectUnitTypesByGroup` and `unknownUnitTypes` from Task 6.
- Produces: `this._unitTypeIndex` on the discovery instance — the Task 6 map for the duration of a run, `null` outside one.

- [ ] **Step 1: Write the failing test**

Append to `tests/haDiscovery.test.js`, following the existing setup pattern in that file for building a discovery instance and capturing published topics:

```js
describe('unit-type classification (issues #38, #37)', () => {
    const TREE = {
        Network: {
            NetworkNumber: '254',
            Unit: [
                { UnitAddress: '10', Type: 'DIMDN8', Application: { ApplicationAddress: '56', Group: [{ GroupAddress: '1', Label: 'Kitchen' }] } },
                { UnitAddress: '11', Type: 'RELDN12', Application: { ApplicationAddress: '56', Group: [{ GroupAddress: '2', Label: 'Irrigation' }] } },
                { UnitAddress: '12', Type: 'SENLL', Application: { ApplicationAddress: '56', Group: [{ GroupAddress: '3', Label: 'Hall Coupler' }] } }
            ]
        }
    };

    // Matches the construction pattern the rest of this file uses: HaDiscovery
    // takes (settings, publishFn, sendCommandFn), and the mock publish fn is the
    // record of what discovery emitted. Note the prefix the file's mockSettings
    // uses is 'testhomeassistant', not 'homeassistant'.
    function makeDiscovery(overrides) {
        const publishFn = jest.fn();
        const discovery = new HaDiscovery(
            { ...mockSettings, ...overrides },
            publishFn,
            jest.fn()
        );
        return { discovery, publishFn };
    }

    function payloadFor(publishFn, component, group) {
        const topic = `testhomeassistant/${component}/cgateweb_254_56_${group}/config`;
        const call = publishFn.mock.calls.find(([t, payload]) => t === topic && payload);
        return call ? JSON.parse(call[1]) : null;
    }

    it('publishes a dimmer group as a light with brightness', () => {
        const { discovery, publishFn } = makeDiscovery({ ha_discovery_type_from_unit: true });

        discovery._publishDiscoveryFromTree('254', TREE);

        expect(payloadFor(publishFn, 'light', 1).brightness_command_topic)
            .toBe('cbus/write/254/56/1/ramp');
    });

    it('publishes a relay group as a light with no brightness fields', () => {
        const { discovery, publishFn } = makeDiscovery({ ha_discovery_type_from_unit: true });

        discovery._publishDiscoveryFromTree('254', TREE);
        const payload = payloadFor(publishFn, 'light', 2);

        expect(payload).not.toHaveProperty('brightness_command_topic');
        expect(payload).not.toHaveProperty('brightness_state_topic');
        expect(payload).not.toHaveProperty('brightness_scale');
        expect(payload).not.toHaveProperty('on_command_type');
        expect(payload.command_topic).toBe('cbus/write/254/56/2/switch');
    });

    it('publishes an input-only group as a binary sensor', () => {
        const { discovery, publishFn } = makeDiscovery({ ha_discovery_type_from_unit: true });

        discovery._publishDiscoveryFromTree('254', TREE);

        expect(payloadFor(publishFn, 'binary_sensor', 3).state_topic)
            .toBe('cbus/read/254/56/3/state');
    });

    it('leaves every group a dimmable light when the setting is off', () => {
        const { discovery, publishFn } = makeDiscovery({ ha_discovery_type_from_unit: false });

        discovery._publishDiscoveryFromTree('254', TREE);

        expect(payloadFor(publishFn, 'light', 2).brightness_command_topic)
            .toBe('cbus/write/254/56/2/ramp');
        expect(payloadFor(publishFn, 'binary_sensor', 3)).toBeNull();
    });

    it('lets a manual type override beat unit-type classification', () => {
        const { discovery, publishFn } = makeDiscovery({ ha_discovery_type_from_unit: true });
        discovery.typeOverrides = new Map([['254/56/2', 'cover']]);

        discovery._publishDiscoveryFromTree('254', TREE);

        expect(payloadFor(publishFn, 'cover', 2)).not.toBeNull();
    });

    it('clears the per-run index after the run', () => {
        const { discovery } = makeDiscovery({ ha_discovery_type_from_unit: true });

        discovery._publishDiscoveryFromTree('254', TREE);

        expect(discovery._unitTypeIndex).toBeNull();
    });
});
```

These tests go inside the existing top-level `describe('HaDiscovery')` block so they inherit its `mockSettings` from `beforeEach`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest tests/haDiscovery.test.js -t "unit-type classification"`
Expected: FAIL — relay groups still publish brightness fields.

- [ ] **Step 3: Add the setting**

In `src/defaultSettings.js`, after `ha_discovery_type_from_label_prefix: false,`:

```js
    // Resolve a group's discovery type from the C-Bus unit that drives it
    // (issues #38, #37): dimmer channels become dimmable lights, relay channels
    // on/off lights, and groups driven only by an input unit (bus coupler, key
    // input) become binary sensors. Opt-in, because enabling it can change which
    // entity a group already published as. Manual type_overrides still win, and
    // unrecognised unit types are left alone.
    ha_discovery_type_from_unit: false,
```

- [ ] **Step 4: Build and clear the index in `haDiscovery.js`**

Change the import on line 3:

```js
const { findNetworkData, collectUnitGroups, collectUnitTypesByGroup, unknownUnitTypes } = require('./haDiscoveryTree');
```

In `_publishDiscoveryFromTree`, extend the `finally` block (line 313-316):

```js
        } finally {
            this._labelSnapshot = null;
            this._currentRunTopics = null;
            this._unitTypeIndex = null;
        }
```

In `_runDiscoveryFromTree`, after the `groupsByApp` collection loop (line 348-351):

```js
        // Which unit types drive each group, for classification by hardware
        // rather than by name. Run-scoped instance state, cleared in
        // _publishDiscoveryFromTree's finally, like _labelSnapshot.
        this._unitTypeIndex = collectUnitTypesByGroup(networkData, targetApps);

        if (this.settings.ha_discovery_type_from_unit) {
            const unknown = unknownUnitTypes(networkData);
            if (unknown.length) {
                this.logger.info(
                    `Unit types not recognised for classification on network ${networkId}: ${unknown.join(', ')}. ` +
                    'Groups driven only by these units keep their default type. ' +
                    'Please report them on https://github.com/dougrathbone/cgateweb/issues/37'
                );
            }
        }
```

Also declare the field alongside `_labelSnapshot` in `src/haDiscoveryPublishers.js` so `@ts-check` resolves it:

```js
    /**
     * Per-run map of "<appId>/<groupId>" to the unit types driving that group,
     * installed by _publishDiscoveryFromTree (null outside a run).
     * @type {Map<string, { types: Set<string> }> | null}
     */
    _unitTypeIndex;
```

- [ ] **Step 5: Add the precedence step and the two new payload shapes**

In `src/haDiscoveryPublishers.js`, add the import:

```js
const { entityTypeForGroup } = require('./unitTypeClassifier');
```

Replace `_tryCreateTypedEntity`'s resolution block (lines 198-208) with:

```js
        const { labelMap, typeOverrides } = this._labelSnapshot;
        const labelForClassification = labelMap.get(labelKey) || group.Label || '';

        // Precedence: manual type_overrides, then an explicit entity-id domain
        // prefix in the label (issue #35), then the driving unit's type
        // (issues #38, #37), then the keyword heuristics.
        const unitType = entityTypeForGroup(
            this._unitTypeIndex && this._unitTypeIndex.get(`${appId}/${groupId}`),
            this.settings
        );
        const resolvedType = typeOverrides.get(labelKey)
            || typeFromLabelPrefix(labelForClassification, this.settings)
            || unitType
            || classifyLightingGroup(labelForClassification, this.settings);

        // A dimmer-driven group resolves to the default dimmable light, so there
        // is nothing to do here beyond falling through.
        if (!resolvedType || resolvedType === 'light' || resolvedType === 'light-dimmable') {
            return false;
        }

        if (resolvedType === 'light-onoff') {
            this._createOnOffLightDiscovery(networkId, appId, groupId, group, labelKey);
            return true;
        }

        if (resolvedType === 'binary_sensor') {
            this._createInputBinarySensorDiscovery(networkId, appId, groupId, group, labelKey);
            this._clearStaleLightConfig(networkId, appId, groupId);
            return true;
        }
```

Then add the two publishers after `_clearStaleLightConfig`:

```js
    /**
     * A relay-driven lighting group: still a light (it is wired onto the
     * Lighting application and controls a light group), but with no dim
     * slider. Staying in the light domain keeps entity ids and existing
     * automations working, which moving it to `switch` would break (issue #38).
     * @private
     */
    _createOnOffLightDiscovery(networkId, appId, groupId, group, labelKey) {
        const { labelMap, entityIds, areas } = this._labelSnapshot;
        const customLabel = labelMap.get(labelKey);
        const groupLabel = group.Label;
        const finalLabel = customLabel || groupLabel || `CBus Light ${networkId}/${appId}/${groupId}`;
        if (customLabel) this.labelStats.custom++;
        else if (groupLabel) this.labelStats.treexml++;
        else this.labelStats.fallback++;

        const uniqueId = `cgateweb_${networkId}_${appId}_${groupId}`;
        const entityId = entityIds.get(labelKey);
        const area = areas && areas.get(labelKey);
        const discoveryTopic = `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_LIGHT}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`;

        const payload = {
            name: null,
            unique_id: uniqueId,
            ...(entityId && entityIdFields(HA_COMPONENT_LIGHT, entityId)),
            state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/${groupId}/${MQTT_TOPIC_SUFFIX_STATE}`,
            command_topic: `${MQTT_TOPIC_PREFIX_WRITE}/${networkId}/${appId}/${groupId}/${MQTT_CMD_TYPE_SWITCH}`,
            payload_on: MQTT_STATE_ON,
            payload_off: MQTT_STATE_OFF,
            state_value_template: '{{ value }}',
            qos: 0,
            device: buildDeviceBlock({
                identifiers: [uniqueId],
                name: finalLabel,
                model: HA_MODEL_LIGHTING,
                area
            }),
            origin: buildOriginBlock()
        };

        this._publish(discoveryTopic, JSON.stringify(payload), MQTT_RETAINED_STATE_OPTIONS);
        if (this._currentRunTopics) this._currentRunTopics.add(discoveryTopic);
        this.discoveryCount++;
    }

    /**
     * A group driven only by input units (bus coupler, key input, sensor) with
     * no output unit on it: there is no load to control, so publish a binary
     * sensor to trigger automations from (issue #37). No device_class — a
     * coupler is not necessarily motion.
     * @private
     */
    _createInputBinarySensorDiscovery(networkId, appId, groupId, group, labelKey) {
        const { labelMap, entityIds, areas } = this._labelSnapshot;
        const customLabel = labelMap.get(labelKey);
        const groupLabel = group.Label;
        const finalLabel = customLabel || groupLabel || `CBus Input ${networkId}/${appId}/${groupId}`;
        if (customLabel) this.labelStats.custom++;
        else if (groupLabel) this.labelStats.treexml++;
        else this.labelStats.fallback++;

        const uniqueId = `cgateweb_${networkId}_${appId}_${groupId}`;
        const entityId = entityIds.get(labelKey);
        const area = areas && areas.get(labelKey);
        const discoveryTopic = `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_BINARY_SENSOR}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`;

        const payload = {
            name: null,
            unique_id: uniqueId,
            ...(entityId && entityIdFields(HA_COMPONENT_BINARY_SENSOR, entityId)),
            state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/${groupId}/${MQTT_TOPIC_SUFFIX_STATE}`,
            payload_on: MQTT_STATE_ON,
            payload_off: MQTT_STATE_OFF,
            qos: 0,
            device: buildDeviceBlock({
                identifiers: [uniqueId],
                name: finalLabel,
                model: HA_MODEL_LIGHTING,
                area
            }),
            origin: buildOriginBlock()
        };

        this._publish(discoveryTopic, JSON.stringify(payload), MQTT_RETAINED_STATE_OPTIONS);
        if (this._currentRunTopics) this._currentRunTopics.add(discoveryTopic);
        this.discoveryCount++;
    }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx jest tests/haDiscovery.test.js tests/discoveryE2E.test.js`
Expected: PASS. Any pre-existing test that breaks means the default-off guarantee is violated — fix the implementation, not the test.

- [ ] **Step 7: Add the option and translations**

**First, add the option to the add-on option map** — without this row the toggle is a silent no-op for every HA add-on user, because `ConfigLoader` maps add-on options to runtime settings through an explicit allowlist. In `src/config/addonOptionMap.js`, following the `ha_discovery_type_from_label_prefix` row:

```js
    { src: 'ha_discovery_type_from_unit', dst: 'ha_discovery_type_from_unit', kind: 'boolDefined', when: 'haDiscovery' },
```

Add a test asserting the option survives the add-on-options conversion, so the wiring is pinned rather than assumed.

Then `homeassistant-addon/config.yaml` schema, after `ha_discovery_type_from_label_prefix`:

```yaml
  ha_discovery_type_from_unit: "bool?"
```

It is a scalar optional, so it must **not** be added to `options`.

Add to all 17 translation files under `configuration:`. English:

```yaml
    ha_discovery_type_from_unit:
      name: Set entity type from C-Bus unit type
      description: >-
        Decide each entity's type from the C-Bus unit that drives the group
        rather than from its name. Dimmer channels become dimmable lights, relay
        channels become on/off lights, and groups driven only by an input unit
        such as a bus coupler become binary sensors. Manual type overrides still
        take priority, and groups driven by unrecognised unit types are left
        unchanged. Turning this on can change the type of entities you already
        have.
```

- [ ] **Step 8: Run every gate**

Run: `npm test && npm run lint && npm run typecheck && npm run validate:translations && npm run validate:addon-config`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/haDiscovery.js src/haDiscoveryPublishers.js src/defaultSettings.js \
        homeassistant-addon/config.yaml homeassistant-addon/translations \
        tests/haDiscovery.test.js
git commit -m "feat: derive entity type from the driving C-Bus unit (issues #38, #37)

Installers had to hand-classify every group after discovery, because a
dimmable light and a relay-driven load look identical unless the group
name happens to say so. Discovery now consults the unit driving each
group: dimmer channels stay dimmable lights, relay channels publish as
lights with no brightness fields, and groups driven only by an input unit
publish as binary sensors so bus couplers can trigger automations.

Relay groups stay in the light domain rather than becoming switches.
That is what the requester landed on too: the group really is a light
group, just not a dimmable one, and moving domains would rename entity
ids and break existing automations.

Opt-in via ha_discovery_type_from_unit, since enabling it can change the
type of entities that already exist. Manual type_overrides still win, and
unrecognised unit types are logged and left alone rather than guessed at."
```

---

## Task 8: Serial recovery while running

**Files:**
- Create: `src/serialDeviceRecovery.js`
- Test: `tests/serialDeviceRecovery.test.js`
- Modify: `src/cniNotificationManager.js`
- Modify: `src/defaultSettings.js`

**Interfaces:**
- Consumes: `backoffDelay` from `src/backoff.js`; the Task 1 resolver contract (path written to `CGATEWEB_SERIAL_DEVICE_FILE`).
- Produces: `class SerialDeviceRecovery` with `constructor({ settings, logger, fsImpl, execImpl, now })` and `handleInterfaceDown(networkId)` → `{ action: 'ignored'|'reported'|'recovered'|'failed', message: string|null }`. `CniNotificationManager` gains an optional `serialDeviceRecovery` constructor property and calls it on the offline transition.

- [ ] **Step 1: Write the failing test**

Create `tests/serialDeviceRecovery.test.js`:

```js
const SerialDeviceRecovery = require('../src/serialDeviceRecovery');

function makeLogger() {
    return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

// Minimal fs stand-in: `present` is the set of paths that exist.
function makeFs(present = []) {
    const set = new Set(present);
    return {
        existsSync: p => set.has(p),
        readFileSync: p => {
            if (!set.has(p)) throw new Error('ENOENT');
            return '/dev/ttyUSB0';
        },
        add: p => set.add(p),
        remove: p => set.delete(p)
    };
}

const SETTINGS = {
    cgate_mode: 'managed',
    cgate_serial_device: '/dev/ttyUSB0',
    serial_recovery_enabled: true,
    serial_recovery_max_attempts: 3
};

describe('SerialDeviceRecovery', () => {
    it('ignores the transition when not in managed mode', () => {
        const recovery = new SerialDeviceRecovery({
            settings: { ...SETTINGS, cgate_mode: 'remote' },
            logger: makeLogger(),
            fsImpl: makeFs(),
            execImpl: jest.fn()
        });

        expect(recovery.handleInterfaceDown('254').action).toBe('ignored');
    });

    it('ignores the transition when no serial device is configured', () => {
        const recovery = new SerialDeviceRecovery({
            settings: { ...SETTINGS, cgate_serial_device: null },
            logger: makeLogger(),
            fsImpl: makeFs(),
            execImpl: jest.fn()
        });

        expect(recovery.handleInterfaceDown('254').action).toBe('ignored');
    });

    it('reports without recovering when the device path still exists', () => {
        const execImpl = jest.fn();
        const recovery = new SerialDeviceRecovery({
            settings: SETTINGS,
            logger: makeLogger(),
            fsImpl: makeFs(['/dev/ttyUSB0']),
            execImpl
        });

        // The device is present, so this is a genuine bus fault, not a replug.
        expect(recovery.handleInterfaceDown('254').action).toBe('reported');
        expect(execImpl).not.toHaveBeenCalled();
    });

    it('attempts recovery when the device path has disappeared', () => {
        const execImpl = jest.fn(() => ({ status: 0, stdout: '/dev/ttyUSB1' }));
        const recovery = new SerialDeviceRecovery({
            settings: SETTINGS,
            logger: makeLogger(),
            fsImpl: makeFs([]),
            execImpl
        });

        const result = recovery.handleInterfaceDown('254');

        expect(result.action).toBe('recovered');
        expect(execImpl).toHaveBeenCalled();
    });

    it('reports failure when the device cannot be found again', () => {
        const execImpl = jest.fn(() => ({ status: 1, stdout: '', stderr: 'not found' }));
        const recovery = new SerialDeviceRecovery({
            settings: SETTINGS,
            logger: makeLogger(),
            fsImpl: makeFs([]),
            execImpl
        });

        const result = recovery.handleInterfaceDown('254');

        expect(result.action).toBe('failed');
        expect(result.message).toMatch(/not found|could not/i);
    });

    it('stops attempting after the configured maximum', () => {
        const execImpl = jest.fn(() => ({ status: 1, stdout: '', stderr: 'nope' }));
        const now = jest.fn(() => 0);
        const recovery = new SerialDeviceRecovery({
            settings: { ...SETTINGS, serial_recovery_max_attempts: 2 },
            logger: makeLogger(),
            fsImpl: makeFs([]),
            execImpl,
            now
        });

        recovery.handleInterfaceDown('254');
        recovery.handleInterfaceDown('254');
        const third = recovery.handleInterfaceDown('254');

        expect(third.action).toBe('reported');
        expect(execImpl).toHaveBeenCalledTimes(2);
    });

    it('does nothing when recovery is disabled', () => {
        const execImpl = jest.fn();
        const recovery = new SerialDeviceRecovery({
            settings: { ...SETTINGS, serial_recovery_enabled: false },
            logger: makeLogger(),
            fsImpl: makeFs([]),
            execImpl
        });

        expect(recovery.handleInterfaceDown('254').action).toBe('reported');
        expect(execImpl).not.toHaveBeenCalled();
    });

    it('resets its attempt count once the interface comes back', () => {
        const execImpl = jest.fn(() => ({ status: 1, stdout: '', stderr: 'nope' }));
        const recovery = new SerialDeviceRecovery({
            settings: { ...SETTINGS, serial_recovery_max_attempts: 1 },
            logger: makeLogger(),
            fsImpl: makeFs([]),
            execImpl
        });

        recovery.handleInterfaceDown('254');
        recovery.handleInterfaceUp('254');
        recovery.handleInterfaceDown('254');

        expect(execImpl).toHaveBeenCalledTimes(2);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest tests/serialDeviceRecovery.test.js`
Expected: FAIL — `Cannot find module '../src/serialDeviceRecovery'`

- [ ] **Step 3: Add the settings**

In `src/defaultSettings.js`, after `cni_offline_notification: false,`:

```js
    // Recover from a USB PC Interface that renumbered while running (issue #28).
    // Only ever engages in managed mode with cgate_serial_device set, so this is
    // inert for CNI installs. On an interface-down transition where the
    // configured device path has vanished, re-resolve it, repoint the project,
    // and restart managed C-Gate.
    serial_recovery_enabled: true,
    serial_recovery_max_attempts: 3,
    serialRecoveryInitialDelayMs: 5000,
    serialRecoveryMaxDelayMs: 300000,
```

- [ ] **Step 4: Write the implementation**

Create `src/serialDeviceRecovery.js`:

```js
// @ts-check
'use strict';

const nodeFs = require('fs');
const { execFileSync } = require('child_process');
const { backoffDelay } = require('./backoff');

const SERIAL_DEVICE_FILE = process.env.CGATEWEB_SERIAL_DEVICE_FILE || '/run/cgateweb/serial-device';
const RECOVER_SCRIPT = process.env.CGATEWEB_RECOVER_SCRIPT || '/usr/bin/cgateweb-recover-serial';

/**
 * Recover from a USB PC Interface that renumbered while the add-on was running
 * (issue #28).
 *
 * A replugged PCI can come back on a different ttyUSBn. C-Gate's network goes
 * InterfaceState=closed and stays there, because the port it holds no longer
 * exists. The distinguishing signal is that the configured device path has
 * disappeared: a CNI dropout leaves the path alone, so recovery never fires for
 * CNI installs.
 */
class SerialDeviceRecovery {
    constructor({ settings, logger, fsImpl, execImpl, now } = /** @type {any} */ ({})) {
        this.settings = settings || {};
        this.logger = logger;
        this.fs = fsImpl || nodeFs;
        this.exec = execImpl || ((file, args) => {
            try {
                const stdout = execFileSync(file, args, { encoding: 'utf8' });
                return { status: 0, stdout, stderr: '' };
            } catch (e) {
                return { status: e.status || 1, stdout: e.stdout || '', stderr: e.stderr || e.message };
            }
        });
        this.now = now || Date.now;
        /** @type {Map<string, number>} */
        this.attempts = new Map();
    }

    /** @returns {boolean} True when a local serial PCI is in play at all. */
    _appliesHere() {
        const device = this.settings.cgate_serial_device;
        if (!device) return false;
        return String(this.settings.cgate_mode) === 'managed';
    }

    /** The device path C-Gate was actually pointed at, falling back to the option. */
    _effectiveDevicePath() {
        try {
            const fromFile = String(this.fs.readFileSync(SERIAL_DEVICE_FILE, 'utf8')).trim();
            if (fromFile) return fromFile;
        } catch (e) {
            // Resolver has not run (or we are not in the add-on): use the option.
        }
        return String(this.settings.cgate_serial_device);
    }

    /**
     * Called when a network's interface transitions down.
     * @param {string} networkId
     * @returns {{ action: 'ignored'|'reported'|'recovered'|'failed', message: string|null }}
     */
    handleInterfaceDown(networkId) {
        if (!this._appliesHere()) {
            return { action: 'ignored', message: null };
        }

        const device = this._effectiveDevicePath();
        if (this.fs.existsSync(device)) {
            // The port is still there, so this is a bus or C-Gate fault, not a
            // replug. Leave it to the existing CNI reporting.
            return { action: 'reported', message: null };
        }

        const message = `C-Bus PC Interface ${device} is no longer present (network ${networkId})`;
        if (this.logger) this.logger.warn(message);

        if (this.settings.serial_recovery_enabled === false) {
            return { action: 'reported', message };
        }

        const maxAttempts = Number(this.settings.serial_recovery_max_attempts ?? 3);
        const used = this.attempts.get(networkId) || 0;
        if (used >= maxAttempts) {
            const exhausted = `${message}. Recovery gave up after ${maxAttempts} attempt(s); restart the add-on once the interface is reconnected.`;
            if (this.logger) this.logger.error(exhausted);
            return { action: 'reported', message: exhausted };
        }
        this.attempts.set(networkId, used + 1);

        // Spread retries so a genuinely unplugged PCI does not restart C-Gate
        // in a tight loop. The delay is advisory for the caller/status page;
        // this method itself does not sleep.
        this.lastBackoffMs = backoffDelay(used, {
            initialMs: Number(this.settings.serialRecoveryInitialDelayMs ?? 5000),
            maxMs: Number(this.settings.serialRecoveryMaxDelayMs ?? 300000)
        });

        // One script does the whole sequence: re-resolve, repoint the project
        // databases, restart C-Gate. It has to be all three — restarting the
        // cgate service does NOT re-run cont-init, so the project would still
        // name the old port and C-Gate would reopen onto a closed interface.
        const result = this.exec(RECOVER_SCRIPT, [String(this.settings.cgate_serial_device)]);
        if (result.status !== 0) {
            const failed = `${message}. Recovery failed: ${String(result.stderr || '').trim()}`;
            if (this.logger) this.logger.error(failed);
            return { action: 'failed', message: failed };
        }

        const newPath = String(result.stdout || '').trim().split('\n').pop();
        const recovered = `Interface moved to ${newPath}; repointed the project and restarted C-Gate`;
        if (this.logger) this.logger.warn(recovered);
        return { action: 'recovered', message: recovered };
    }

    /**
     * Called when a network's interface comes back, so a later unrelated
     * dropout gets a fresh set of attempts.
     * @param {string} networkId
     */
    handleInterfaceUp(networkId) {
        this.attempts.delete(networkId);
    }
}

module.exports = SerialDeviceRecovery;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest tests/serialDeviceRecovery.test.js`
Expected: PASS, all 8 cases.

- [ ] **Step 6: Wire it into `CniNotificationManager`**

In `src/cniNotificationManager.js`, accept the collaborator and call it on each transition. In the constructor:

```js
    constructor({ networkInterfaceMonitor, mqttManager, getHaDiscovery, logger, settings, mqttOptions, serialDeviceRecovery }) {
```

and, at the end of the constructor body:

```js
        // Optional: recovers a USB PC Interface that renumbered while running
        // (issue #28). Absent in remote mode and in tests that do not need it.
        this.serialDeviceRecovery = serialDeviceRecovery || null;
```

Inside `handleReading`, in the `if (result.changed && result.online !== null)` block, before the notification handling:

```js
            if (this.serialDeviceRecovery) {
                if (result.online === false) this.serialDeviceRecovery.handleInterfaceDown(networkId);
                else this.serialDeviceRecovery.handleInterfaceUp(networkId);
            }
```

Then construct and inject it in `src/cgateWebBridge.js` beside the existing `CniNotificationManager` construction (around line 232-238), passing `settings` and `logger`.

- [ ] **Step 7: Add the recovery script**

Create `homeassistant-addon/rootfs/usr/bin/cgateweb-recover-serial`. It must do all three steps, not just the restart: restarting the `cgate` s6 service re-runs `/etc/services.d/cgate/run` but **not** `cont-init.d`, so without re-running the project fixup the project database still names the old port and C-Gate reopens straight onto a closed interface.

```bash
#!/usr/bin/env bash
# Recover a renumbered USB PC Interface without an add-on restart (issue #28).
#
# 1. Re-resolve the configured device to its current path (by remembered identity)
# 2. Repoint every synced project database at the new port name
# 3. Restart managed C-Gate so it reopens the network on that port
#
# Step 2 is essential: restarting the cgate service does not re-run cont-init, so
# the project would still reference the old ttyUSBn and the network would come
# back closed.
#
# Prints the resolved device path on stdout. Exits non-zero on any failure.
set -euo pipefail

CONFIGURED="${1:-}"
if [[ -z "${CONFIGURED}" ]]; then
    echo "usage: cgateweb-recover-serial <configured-device-path>" >&2
    exit 1
fi

RESOLVED=$(node /usr/bin/cgateweb-resolve-serial.js "${CONFIGURED}" 2>/dev/null | tail -n 1)
if [[ -z "${RESOLVED}" ]]; then
    echo "could not resolve ${CONFIGURED} to a present device" >&2
    exit 1
fi

PROJECTS_DIR="${CGATEWEB_PROJECTS_DIR:-/data/cgate/Projects}"
shopt -s nullglob
for db in "${PROJECTS_DIR}"/*/*.db; do
    node /usr/bin/cgateweb-project-serial-fixup.js "${db}" "${RESOLVED}" >/dev/null 2>&1 || true
done
shopt -u nullglob

# The base image is home-assistant/*-base:3.21, i.e. s6-overlay v3 running the
# legacy /etc/services.d tree through its compatibility shim. The service
# directory path differs between s6 versions, so probe rather than hardcode.
for dir in /run/service/cgate /run/service/legacy-services-cgate /var/run/s6/services/cgate; do
    if [[ -d "${dir}" ]]; then
        s6-svc -r "${dir}"
        echo "${RESOLVED}"
        exit 0
    fi
done

echo "could not locate the cgate s6 service directory" >&2
exit 1
```

Make it executable (`chmod +x`) and confirm the Dockerfile's rootfs copy preserves the mode, matching how `cgateweb-serial-diagnostics` is handled.

The project fixup is best-effort (`|| true`) for the same reason it is at cont-init: a fixup failure must not block the restart, since C-Gate may still open correctly if the project already named the right port.

**Verification required here:** the s6 service directory is a probe across three candidates. Confirm the real one with `ls /run/service` in a live add-on container before trusting recovery end to end. Also confirm `CGATEWEB_PROJECTS_DIR`'s default matches where `cgate-project-sync.sh` actually writes project databases.

- [ ] **Step 8: Run every gate**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/serialDeviceRecovery.js src/cniNotificationManager.js src/cgateWebBridge.js \
        src/defaultSettings.js homeassistant-addon/rootfs/usr/bin/cgateweb-recover-serial \
        tests/serialDeviceRecovery.test.js
git commit -m "feat: recover a renumbered PC Interface without a manual restart (issue #28)

Unplugging the USB PCI while the add-on is running leaves C-Gate holding
a port that no longer exists: the network sits at InterfaceState=closed
and only an add-on restart fixed it.

The interface-state monitor already detects the transition, so recovery
hangs off it. The distinguishing signal is that the configured device
path has vanished; a CNI dropout leaves the path alone, so this never
fires for CNI installs. On a vanished path it re-resolves the device by
its remembered identity, repoints the project, and restarts C-Gate,
after which the existing connection-pool backoff reconnects.

Attempts are bounded and backed off so a genuinely unplugged interface
does not restart C-Gate in a loop, and the attempt count resets when the
interface returns. Reporting happens whether or not recovery works."
```

---

## Task 9: Documentation and release 1.18.0

**Files:**
- Modify: `README.md`, `homeassistant-addon/DOCS.md`
- Modify: `package.json`, `homeassistant-addon/config.yaml` (version)

- [ ] **Step 1: Document the three new capabilities**

In `README.md` and `homeassistant-addon/DOCS.md`, following each file's existing structure:

1. `ha_discovery_type_from_unit` — what it changes, that it is opt-in, that turning it on can retype existing entities, and that unrecognised unit types are left alone and logged.
2. `cgate_external_clients` — the Toolkit use case, the three levels, that `program` also grants shutdown, the `255`-octet subnet notation, and that C-Gate's ports must also be published in the Network panel. State plainly that C-Gate has no authentication.
3. #28 recovery — that a renumbered device now recovers at boot and while running, and that a `/dev/serial/by-id/` path avoids the problem entirely.

- [ ] **Step 2: Bump the version in both files**

`package.json`: `"version": "1.18.0"`. `homeassistant-addon/config.yaml`: `version: "1.18.0"`. They must match or CI's `version-sync` job fails.

- [ ] **Step 3: Run every gate one final time**

Run: `npm ci && npm test && npm run lint && npm run typecheck && npm run validate:translations && npm run validate:addon-config`

`npm ci` first: CI installs the TypeScript version pinned in `package-lock.json`, which can be stricter than a stale local `node_modules`.
Expected: all pass.

- [ ] **Step 4: Commit the release**

```bash
git add README.md homeassistant-addon/DOCS.md package.json homeassistant-addon/config.yaml
git commit -m "chore: release v1.18.0

Entity types from C-Bus unit type (issues #38, #37): dimmer channels
become dimmable lights, relay channels on/off lights, and groups driven
only by an input unit such as a bus coupler become binary sensors. Opt-in
via ha_discovery_type_from_unit.

External C-Gate access (issue #37): cgate_external_clients lists the
addresses allowed to reach managed C-Gate and at what level, so C-Bus
Toolkit can program a network whose PC Interface lives in the Home
Assistant host. C-Gate's ports are declared for mapping in the Network
panel, unpublished by default.

USB serial resilience (issue #28): a PC Interface that renumbers across a
replug now recovers, both at boot and while running, instead of failing
startup or sitting on a closed interface.

Also corrects generated access.txt to C-Gate's documented grammar. The
previous form used access level names as keywords, so managed installs
were running with an effectively empty access control list."
```

- [ ] **Step 5: Push and watch CI**

```bash
git push origin master
gh run watch
```

Expected: all jobs green, including `version-sync` and the add-on config/translation validation job.

- [ ] **Step 6: Tag and push the tag**

The tag is what triggers `hacs-distribution.yml`. Without it, Home Assistant never sees the release.

```bash
git tag v1.18.0
git push origin v1.18.0
```

- [ ] **Step 7: Backfill the source-repo release**

```bash
gh release create v1.18.0 --title "v1.18.0" --notes "<the release commit body>"
```

- [ ] **Step 8: Follow up on the issues**

- **#38**: report what shipped and that relay groups became on/off lights rather than switches, per the requester's own correction.
- **#37**: report the binary-sensor support and the external-access option. Ask again for the bus coupler's unit type if it has not arrived, and ask for confirmation that Toolkit can program through the exposed C-Gate. **Do not close either half without that confirmation.**
- **#28**: report the boot and runtime recovery, and recommend the `/dev/serial/by-id/` path.

---

## Deferred

Not in this plan, recorded so it is not lost:

- **The bus coupler unit type.** Task 5's table has no coupler entry because no fixture, log or report in the repo contains one. Until DewetTDS supplies it, coupler groups fall through to the default light. The Task 7 logging is what makes his next report actionable.
- **Whether `operate` suffices for cgateweb at localhost.** Task 3 grants `program` because managed mode loads projects. The production install runs at `program`, which proves sufficient but not necessary. Narrowing it is a follow-up.
- **Doug's own `access.txt`.** His production C-Gate grants `Program` to the whole `192.168.0.0/16` via `interface 192.168.0.22 Program`. Unrelated to shipping this, but the fix is `remote` rules for the two hosts that need access. Add the `remote` rules and verify both clients still work *before* removing the `interface` line, since access.txt is re-read on every connection and a mistake takes effect immediately.
