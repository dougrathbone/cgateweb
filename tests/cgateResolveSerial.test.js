const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
    identityFromByIdDir,
    identityFromSysfs,
    readIdentity,
    findDeviceByIdentity,
    resolveSerialDevice
} = require('../homeassistant-addon/rootfs/usr/bin/cgateweb-resolve-serial.js');

const SCRIPT = path.join(
    __dirname, '..', 'homeassistant-addon', 'rootfs', 'usr', 'bin', 'cgateweb-resolve-serial.js'
);

const BY_ID = 'usb-FTDI_FT232R_USB_UART_A50285BI-if00-port0';
const FTDI = { idVendor: '0403', idProduct: '6001', serial: 'A50285BI' };
// The Linux Foundation's real root-hub vendor:product pair. Present on every
// device tree, at devices/usb1, one level above the device directories built
// below — used to prove the sysfs walk stops at the device and never climbs
// this far.
const ROOT_HUB = { idVendor: '1d6b', idProduct: '0002', serial: 'HUBROOT' };

const tmpDirs = [];

function tmpDir(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

// Build a fake /dev with tty character-device stand-ins (plain files are fine:
// the resolver checks existence and symlink targets, not device-node type) and
// a /dev/serial/by-id directory of symlinks pointing at them.
function makeDevRoot({ ttys = [], byId = {} } = {}) {
    const devRoot = tmpDir('cgw-dev-');
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

// Build a fake /sys mirroring the real kernel layout for USB serial ports:
//
//   class/tty/ttyUSB0 -> ../../devices/usb1/1-1/1-1:1.0/ttyUSB0/tty/ttyUSB0
//   devices/usb1/1-1/1-1:1.0/ttyUSB0/tty/ttyUSB0/device -> ../../../ttyUSB0
//   devices/usb1/1-1/{idVendor,idProduct,serial}
//
// Both the ancestor component (class/tty/<name>) and the "device" link are
// symlinks, and the device link's target is relative to the *canonical*
// location, so resolving it needs full realpath semantics.
function makeSysfsRoot(devices = {}) {
    const sysfsRoot = tmpDir('cgw-sys-');
    const classTty = path.join(sysfsRoot, 'class', 'tty');
    fs.mkdirSync(classTty, { recursive: true });

    // Root hub, shared by every device below (devices/usb1/1-N is the device;
    // devices/usb1 is the hub it hangs off). It carries its own
    // idVendor/idProduct/serial, exactly like a real root hub does, so tests
    // can assert the walk in identityFromSysfs never climbs this far.
    const hubDir = path.join(sysfsRoot, 'devices', 'usb1');
    fs.mkdirSync(hubDir, { recursive: true });
    for (const [attr, value] of Object.entries(ROOT_HUB)) {
        fs.writeFileSync(path.join(hubDir, attr), `${value}\n`);
    }

    let port = 0;
    for (const [tty, attrs] of Object.entries(devices)) {
        port += 1;
        const usbDev = path.join('devices', 'usb1', `1-${port}`);
        const iface = path.join(usbDev, `1-${port}:1.0`);
        const ttyDir = path.join(iface, tty, 'tty', tty);
        fs.mkdirSync(path.join(sysfsRoot, ttyDir), { recursive: true });

        for (const [attr, value] of Object.entries(attrs)) {
            fs.writeFileSync(path.join(sysfsRoot, usbDev, attr), `${value}\n`);
        }
        fs.symlinkSync(path.join('..', '..', ttyDir), path.join(classTty, tty));
        fs.symlinkSync(path.join('..', '..', '..', tty), path.join(sysfsRoot, ttyDir, 'device'));
    }
    return sysfsRoot;
}

function identityFile() {
    return path.join(tmpDir('cgw-data-'), 'serial-identity.json');
}

// Diagnostics are {level, text} so the caller can log advice as advice; most
// assertions only care about the text.
function messageText(result) {
    return result.messages.map(m => m.text).join('\n');
}

function messageAt(result, pattern) {
    return result.messages.find(m => pattern.test(m.text));
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

describe('identityFromSysfs', () => {
    it('reads vendor:product:serial through the symlinked sysfs device chain', () => {
        const sysfsRoot = makeSysfsRoot({ ttyUSB0: FTDI });

        const identity = identityFromSysfs('/dev/ttyUSB0', { sysfsRoot });

        expect(identity).toBe('0403:6001:A50285BI');
    });

    it('returns null when the device exposes no serial number', () => {
        // A CH340 with no serial: vendor:product alone is shared with countless
        // Zigbee/Z-Wave sticks, so it must not become an adoptable identity.
        const sysfsRoot = makeSysfsRoot({ ttyUSB0: { idVendor: '1a86', idProduct: '7523' } });

        expect(identityFromSysfs('/dev/ttyUSB0', { sysfsRoot })).toBeNull();
    });

    it('returns null when the tty has no sysfs entry', () => {
        const sysfsRoot = makeSysfsRoot({ ttyUSB0: FTDI });

        expect(identityFromSysfs('/dev/ttyUSB9', { sysfsRoot })).toBeNull();
    });

    it('stops at the device and does not climb to the root hub for its identity', () => {
        // The fixture's root hub carries ROOT_HUB's identity one level above
        // the device directory. If the walk climbed past the device, it would
        // return the hub's shared identity instead of the device's own.
        const sysfsRoot = makeSysfsRoot({ ttyUSB0: FTDI });

        expect(identityFromSysfs('/dev/ttyUSB0', { sysfsRoot })).toBe('0403:6001:A50285BI');
    });

    it('returns null for a serial-less device rather than inheriting the root hub identity', () => {
        // A CH340 with no serial stops (and returns null) at the device level;
        // it must not keep climbing to the root hub above, which does have a
        // full vendor:product:serial identity in this fixture.
        const sysfsRoot = makeSysfsRoot({ ttyUSB0: { idVendor: '1a86', idProduct: '7523' } });

        expect(identityFromSysfs('/dev/ttyUSB0', { sysfsRoot })).toBeNull();
    });
});

describe('readIdentity', () => {
    it('falls back to sysfs when the host has no /dev/serial/by-id directory', () => {
        const devRoot = makeDevRoot({ ttys: ['ttyUSB0'] });
        const sysfsRoot = makeSysfsRoot({ ttyUSB0: FTDI });

        const identity = readIdentity(path.join(devRoot, 'ttyUSB0'), { devRoot, sysfsRoot });

        expect(identity).toBe('0403:6001:A50285BI');
    });

    it('prefers the by-id link name when udev provides one', () => {
        const devRoot = makeDevRoot({ ttys: ['ttyUSB0'], byId: { [BY_ID]: 'ttyUSB0' } });
        const sysfsRoot = makeSysfsRoot({ ttyUSB0: FTDI });

        const identity = readIdentity(path.join(devRoot, 'ttyUSB0'), { devRoot, sysfsRoot });

        expect(identity).toBe(BY_ID);
    });

    it('discards an identity containing a path separator rather than returning it as usable', () => {
        // A USB string descriptor can legally contain '/'. Such an identity
        // could never be re-read by loadRememberedIdentity's own validation,
        // so it must be treated as no identity at the point it is produced —
        // otherwise it gets silently saved and then permanently rejected on
        // load, losing recovery without ever warning that it was lost.
        const devRoot = makeDevRoot({ ttys: ['ttyUSB0'] });
        const sysfsRoot = makeSysfsRoot({ ttyUSB0: { ...FTDI, serial: 'A50/285BI' } });

        const identity = readIdentity(path.join(devRoot, 'ttyUSB0'), { devRoot, sysfsRoot });

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

    it('ignores a by-id link that does not resolve to a serial tty', () => {
        const devRoot = makeDevRoot({ ttys: ['not-a-tty'], byId: { [BY_ID]: 'not-a-tty' } });

        expect(findDeviceByIdentity(BY_ID, { devRoot })).toBeNull();
    });

    it('rejects a traversing identity instead of resolving it to an arbitrary path', () => {
        const devRoot = makeDevRoot({ ttys: ['ttyUSB7'] });

        expect(findDeviceByIdentity('../../ttyUSB7', { devRoot })).toBeNull();
    });

    it('matches on serial when two same-model devices share vendor:product', () => {
        const devRoot = makeDevRoot({ ttys: ['ttyUSB0', 'ttyUSB1'] });
        const sysfsRoot = makeSysfsRoot({
            ttyUSB0: { ...FTDI, serial: 'DECOY123' },
            ttyUSB1: FTDI
        });

        const found = findDeviceByIdentity('0403:6001:A50285BI', { devRoot, sysfsRoot });

        expect(found).toBe(path.join(devRoot, 'ttyUSB1'));
    });
});

describe('resolveSerialDevice', () => {
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

    it('tags the stable-path recommendation as advice, not a warning', () => {
        // Nothing is wrong when a raw tty path resolves: suggesting a better
        // path is advice. Logging it as a warning trains users to ignore the
        // warnings that do mean something.
        const devRoot = makeDevRoot({ ttys: ['ttyUSB0'], byId: { [BY_ID]: 'ttyUSB0' } });

        const result = resolveSerialDevice({
            configuredPath: path.join(devRoot, 'ttyUSB0'),
            identityFile: identityFile(),
            devRoot
        });

        expect(messageAt(result, /Prefer the stable path/).level).toBe('info');
    });

    it('warns that recovery is impossible when the device has no stable identity', () => {
        const devRoot = makeDevRoot({ ttys: ['ttyUSB0'] });
        const sysfsRoot = makeSysfsRoot({ ttyUSB0: { idVendor: '1a86', idProduct: '7523' } });

        const result = resolveSerialDevice({
            configuredPath: path.join(devRoot, 'ttyUSB0'),
            identityFile: identityFile(),
            devRoot,
            sysfsRoot
        });

        expect(result.path).toBe(path.join(devRoot, 'ttyUSB0'));
        expect(result.identity).toBeNull();
        expect(messageAt(result, /recovery after a replug will not be possible/i).level).toBe('warning');
    });

    it('treats an identity containing a path separator as no identity and warns honestly', () => {
        const devRoot = makeDevRoot({ ttys: ['ttyUSB0'] });
        const sysfsRoot = makeSysfsRoot({ ttyUSB0: { ...FTDI, serial: 'A50/285BI' } });
        const file = identityFile();

        const result = resolveSerialDevice({
            configuredPath: path.join(devRoot, 'ttyUSB0'),
            identityFile: file,
            devRoot,
            sysfsRoot
        });

        expect(result.identity).toBeNull();
        expect(messageText(result)).toMatch(/recovery after a replug will not be possible/i);
        expect(fs.existsSync(file)).toBe(false);
    });

    it('recovers the new path via remembered identity after a renumber', () => {
        const file = identityFile();
        const before = makeDevRoot({ ttys: ['ttyUSB0'], byId: { [BY_ID]: 'ttyUSB0' } });
        const configuredPath = path.join(before, 'ttyUSB0');
        resolveSerialDevice({ configuredPath, identityFile: file, devRoot: before });

        // Replug: the device is now ttyUSB1 and the old path is gone.
        fs.rmSync(configuredPath);
        const after = makeDevRoot({ ttys: ['ttyUSB1'], byId: { [BY_ID]: 'ttyUSB1' } });
        const result = resolveSerialDevice({ configuredPath, identityFile: file, devRoot: after });

        expect(result.source).toBe('recovered');
        expect(result.path).toBe(path.join(after, 'ttyUSB1'));
        expect(messageText(result)).toContain('ttyUSB1');
    });

    it('recommends the by-id path when recovery went through /dev/serial/by-id', () => {
        const file = identityFile();
        const before = makeDevRoot({ ttys: ['ttyUSB0'], byId: { [BY_ID]: 'ttyUSB0' } });
        const configuredPath = path.join(before, 'ttyUSB0');
        resolveSerialDevice({ configuredPath, identityFile: file, devRoot: before });

        fs.rmSync(configuredPath);
        const after = makeDevRoot({ ttys: ['ttyUSB1'], byId: { [BY_ID]: 'ttyUSB1' } });
        const result = resolveSerialDevice({ configuredPath, identityFile: file, devRoot: after });

        expect(result.stablePath).toBe(path.join(after, 'serial', 'by-id', BY_ID));
        expect(messageText(result)).toMatch(/Update cgate_serial_device to/);
    });

    it('does not recommend a nonexistent by-id path when recovery went through sysfs only', () => {
        // This host has no /dev/serial/by-id directory at all, so the only
        // route to an identity is the vendor:product:serial sysfs fallback —
        // recommending a by-id path built from that identity would name a
        // path that can never exist on this host.
        const file = identityFile();
        const before = makeDevRoot({ ttys: ['ttyUSB0'] });
        const beforeSysfs = makeSysfsRoot({ ttyUSB0: FTDI });
        const configuredPath = path.join(before, 'ttyUSB0');
        const recorded = resolveSerialDevice({
            configuredPath, identityFile: file, devRoot: before, sysfsRoot: beforeSysfs
        });
        expect(recorded.identity).toBe('0403:6001:A50285BI');

        // Replug: renumbered, still no by-id links on this host.
        fs.rmSync(configuredPath);
        const after = makeDevRoot({ ttys: ['ttyUSB1'] });
        const afterSysfs = makeSysfsRoot({ ttyUSB1: FTDI });
        const result = resolveSerialDevice({
            configuredPath, identityFile: file, devRoot: after, sysfsRoot: afterSysfs
        });

        expect(result.source).toBe('recovered');
        expect(result.path).toBe(path.join(after, 'ttyUSB1'));
        expect(result.stablePath).toBeNull();
        expect(messageText(result)).not.toContain(
            path.join(after, 'serial', 'by-id', '0403:6001:A50285BI')
        );
        expect(messageText(result)).toMatch(/no stable path/i);
    });

    it('does not adopt an unrelated device when the identity does not match', () => {
        const file = identityFile();
        const before = makeDevRoot({ ttys: ['ttyUSB0'], byId: { [BY_ID]: 'ttyUSB0' } });
        const configuredPath = path.join(before, 'ttyUSB0');
        resolveSerialDevice({ configuredPath, identityFile: file, devRoot: before });

        // A Zigbee stick is the only tty present; its identity differs.
        fs.rmSync(configuredPath);
        const after = makeDevRoot({
            ttys: ['ttyUSB0'],
            byId: { 'usb-Silicon_Labs_Zigbee_ZZZ-if00-port0': 'ttyUSB0' }
        });
        const result = resolveSerialDevice({ configuredPath, identityFile: file, devRoot: after });

        expect(result.path).toBeNull();
    });

    it('does not adopt a same-model device that differs only by serial', () => {
        const file = identityFile();
        const before = makeDevRoot({ ttys: ['ttyUSB0'] });
        const beforeSysfs = makeSysfsRoot({ ttyUSB0: FTDI });
        const configuredPath = path.join(before, 'ttyUSB0');
        const recorded = resolveSerialDevice({
            configuredPath, identityFile: file, devRoot: before, sysfsRoot: beforeSysfs
        });
        expect(recorded.identity).toBe('0403:6001:A50285BI');

        // Only a different FTDI device is present: same vendor:product, other serial.
        fs.rmSync(configuredPath);
        const after = makeDevRoot({ ttys: ['ttyUSB0'] });
        const afterSysfs = makeSysfsRoot({ ttyUSB0: { ...FTDI, serial: 'ZZ999999' } });
        const result = resolveSerialDevice({
            configuredPath, identityFile: file, devRoot: after, sysfsRoot: afterSysfs
        });

        expect(result.path).toBeNull();
        expect(messageText(result)).toMatch(/is not present either/i);
    });

    it('ignores a corrupt remembered identity rather than resolving a traversal', () => {
        const devRoot = makeDevRoot({ ttys: ['ttyUSB7'] });
        const file = identityFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ identity: '../../ttyUSB7' }));

        const result = resolveSerialDevice({
            configuredPath: path.join(devRoot, 'ttyUSB0'),
            identityFile: file,
            devRoot
        });

        expect(result.path).toBeNull();
        expect(messageText(result)).toMatch(/No previously-recorded device identity/i);
    });

    it('returns null with a message when nothing is resolvable', () => {
        const devRoot = makeDevRoot({});

        const result = resolveSerialDevice({
            configuredPath: path.join(devRoot, 'ttyUSB0'),
            identityFile: identityFile(),
            devRoot
        });

        expect(result.path).toBeNull();
        expect(messageText(result)).toMatch(/not found/i);
    });
});

describe('main() (spawned CLI)', () => {
    // Every diagnostic line is tagged so cont-init can log advice as info and
    // problems as warnings; strip the tags when asserting on the text.
    function untag(stderr) {
        return stderr.replace(/^(INFO|WARN): /gm, '');
    }

    it('exits 2 with a usage message when no path argument is given', () => {
        // Not exit 1: cont-init reads 1 as "the configured device is missing"
        // and prints device-hunting advice, which a usage bug is not.
        const result = spawnSync('node', [SCRIPT], { encoding: 'utf8' });

        expect(result.status).toBe(2);
        expect(untag(result.stderr)).toMatch(/usage: cgateweb-resolve-serial\.js/);
    });

    it('tags every diagnostic line with a level cont-init can route on', () => {
        const dir = tmpDir('cgw-cli-');
        const devRoot = makeDevRoot({ ttys: ['ttyUSB0'], byId: { [BY_ID]: 'ttyUSB0' } });

        const result = spawnSync('node', [SCRIPT, path.join(devRoot, 'ttyUSB0')], {
            encoding: 'utf8',
            env: {
                ...process.env,
                CGATEWEB_SERIAL_IDENTITY_FILE: path.join(dir, 'serial-identity.json'),
                CGATEWEB_SERIAL_DEVICE_FILE: path.join(dir, 'serial-device'),
                CGATEWEB_SERIAL_DEV_ROOT: devRoot,
                CGATEWEB_SERIAL_SYSFS_ROOT: makeSysfsRoot({})
            }
        });

        expect(result.status).toBe(0);
        const lines = result.stderr.split('\n').filter(Boolean);
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) expect(line).toMatch(/^(INFO|WARN): /);
        expect(result.stderr).toMatch(/^INFO: Prefer the stable path/m);
    });

    it('exits 1 with messages on stderr when the device cannot be resolved', () => {
        const identityPath = path.join(tmpDir('cgw-cli-'), 'serial-identity.json');

        const result = spawnSync(
            'node',
            [SCRIPT, '/nonexistent/cgateweb-test-device'],
            { encoding: 'utf8', env: { ...process.env, CGATEWEB_SERIAL_IDENTITY_FILE: identityPath } }
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/Serial device not found/);
        expect(result.stderr).toMatch(/No previously-recorded device identity/);
    });

    it('exits 0 on the happy path and writes the resolved path to CGATEWEB_SERIAL_DEVICE_FILE', () => {
        const dir = tmpDir('cgw-cli-');
        const configuredPath = path.join(dir, 'my-device');
        fs.writeFileSync(configuredPath, '');
        const identityPath = path.join(dir, 'serial-identity.json');
        const deviceFile = path.join(dir, 'serial-device');

        const result = spawnSync(
            'node',
            [SCRIPT, configuredPath],
            {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    CGATEWEB_SERIAL_IDENTITY_FILE: identityPath,
                    CGATEWEB_SERIAL_DEVICE_FILE: deviceFile
                }
            }
        );

        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe(configuredPath);
        expect(fs.readFileSync(deviceFile, 'utf8')).toBe(configuredPath);
    });

    it('still succeeds when the device file cannot be written and the path is unchanged', () => {
        // An unwritable /run must not abort add-on startup: the consumers fall
        // back to reading cgate_serial_device, which is this very path, so
        // nothing downstream can end up pointed at the wrong port.
        const dir = tmpDir('cgw-cli-');
        const configuredPath = path.join(dir, 'my-device');
        fs.writeFileSync(configuredPath, '');
        const blocker = path.join(dir, 'blocker');
        fs.writeFileSync(blocker, '');

        const result = spawnSync('node', [SCRIPT, configuredPath], {
            encoding: 'utf8',
            env: {
                ...process.env,
                CGATEWEB_SERIAL_IDENTITY_FILE: path.join(dir, 'serial-identity.json'),
                CGATEWEB_SERIAL_DEVICE_FILE: path.join(blocker, 'serial-device')
            }
        });

        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe(configuredPath);
        expect(untag(result.stderr)).toMatch(/Could not write .*serial-device/);
        expect(untag(result.stderr)).toMatch(/same path .* so this is not fatal/);
    });

    it('fails naming the write when a recovered path cannot be published', () => {
        // The dangerous half of the case above: the resolver adopted a
        // different device, so the consumers' fallback to cgate_serial_device
        // would rewrite the project to the stale, now-absent port. Failing
        // loudly beats booting C-Gate onto the wrong device.
        const dir = tmpDir('cgw-cli-');
        const identityPath = path.join(dir, 'serial-identity.json');
        const sysfsRoot = makeSysfsRoot({});
        const before = makeDevRoot({ ttys: ['ttyUSB0'], byId: { [BY_ID]: 'ttyUSB0' } });
        const configuredPath = path.join(before, 'ttyUSB0');
        const baseEnv = {
            ...process.env,
            CGATEWEB_SERIAL_IDENTITY_FILE: identityPath,
            CGATEWEB_SERIAL_SYSFS_ROOT: sysfsRoot
        };

        // First boot records the identity through the real CLI.
        const recorded = spawnSync('node', [SCRIPT, configuredPath], {
            encoding: 'utf8',
            env: {
                ...baseEnv,
                CGATEWEB_SERIAL_DEVICE_FILE: path.join(dir, 'serial-device'),
                CGATEWEB_SERIAL_DEV_ROOT: before
            }
        });
        expect(recorded.status).toBe(0);

        // Replug: the device renumbered, and /run is unwritable this time.
        fs.rmSync(configuredPath);
        const after = makeDevRoot({ ttys: ['ttyUSB1'], byId: { [BY_ID]: 'ttyUSB1' } });
        const blocker = path.join(dir, 'blocker');
        fs.writeFileSync(blocker, '');

        const result = spawnSync('node', [SCRIPT, configuredPath], {
            encoding: 'utf8',
            env: {
                ...baseEnv,
                CGATEWEB_SERIAL_DEVICE_FILE: path.join(blocker, 'serial-device'),
                CGATEWEB_SERIAL_DEV_ROOT: after
            }
        });

        expect(result.status).toBe(2);
        expect(untag(result.stderr)).toMatch(/Could not write .*serial-device/);
        expect(untag(result.stderr)).toMatch(
            new RegExp(`recovered at ${path.join(after, 'ttyUSB1')}`)
        );
    });

    it('publishes the recovered path when the device renumbered', () => {
        const dir = tmpDir('cgw-cli-');
        const identityPath = path.join(dir, 'serial-identity.json');
        const deviceFile = path.join(dir, 'serial-device');
        const sysfsRoot = makeSysfsRoot({});
        const before = makeDevRoot({ ttys: ['ttyUSB0'], byId: { [BY_ID]: 'ttyUSB0' } });
        const configuredPath = path.join(before, 'ttyUSB0');
        const env = {
            ...process.env,
            CGATEWEB_SERIAL_IDENTITY_FILE: identityPath,
            CGATEWEB_SERIAL_DEVICE_FILE: deviceFile,
            CGATEWEB_SERIAL_SYSFS_ROOT: sysfsRoot
        };

        spawnSync('node', [SCRIPT, configuredPath], {
            encoding: 'utf8',
            env: { ...env, CGATEWEB_SERIAL_DEV_ROOT: before }
        });
        fs.rmSync(configuredPath);
        const after = makeDevRoot({ ttys: ['ttyUSB1'], byId: { [BY_ID]: 'ttyUSB1' } });

        const result = spawnSync('node', [SCRIPT, configuredPath], {
            encoding: 'utf8',
            env: { ...env, CGATEWEB_SERIAL_DEV_ROOT: after }
        });

        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe(path.join(after, 'ttyUSB1'));
        expect(fs.readFileSync(deviceFile, 'utf8')).toBe(path.join(after, 'ttyUSB1'));
    });
});

describe('the default serial-device file path', () => {
    // cont-init publishes the resolved device here. The JS resolver has its
    // own inlined default (a different language and process, per
    // cgateweb-resolve-serial.js's own comment); the three bash boot scripts
    // (cgate-install.sh, cgate-project-sync.sh, cgateweb-serial-diagnostics)
    // instead all source the shared
    // homeassistant-addon/rootfs/usr/lib/cgateweb/serial-device.sh, so they
    // can only ever agree with each other. What can still drift is the JS
    // constant vs. the shared bash default, and a consumer quietly going back
    // to inlining its own literal instead of sourcing the shared file — both
    // are checked here rather than by a single literal comparison.
    const ROOT = path.join(__dirname, '..', 'homeassistant-addon', 'rootfs');
    const LIB_FILE = path.join(ROOT, 'usr', 'lib', 'cgateweb', 'serial-device.sh');
    const CONSUMERS = [
        path.join(ROOT, 'etc', 'cont-init.d', 'cgate-install.sh'),
        path.join(ROOT, 'etc', 'cont-init.d', 'cgate-project-sync.sh'),
        path.join(ROOT, 'usr', 'bin', 'cgateweb-serial-diagnostics')
    ];

    it('is spelled identically in the JS resolver and the shared bash helper', () => {
        const jsMatch = fs.readFileSync(path.join(ROOT, 'usr', 'bin', 'cgateweb-resolve-serial.js'), 'utf8')
            .match(/DEFAULT_DEVICE_FILE = '([^']+)'/);
        const libMatch = fs.readFileSync(LIB_FILE, 'utf8')
            .match(/CGATEWEB_SERIAL_DEVICE_DEFAULT_FILE="([^"]+)"/);

        expect(jsMatch).not.toBeNull();
        expect(libMatch).not.toBeNull();
        expect(jsMatch[1]).toBe('/run/cgateweb/serial-device');
        expect(libMatch[1]).toBe('/run/cgateweb/serial-device');
    });

    it('is sourced by all three bash consumers rather than re-inlined', () => {
        CONSUMERS.forEach(file => {
            const contents = fs.readFileSync(file, 'utf8');
            expect(contents).toMatch(/CGATEWEB_SERIAL_DEVICE_LIB:-\/usr\/lib\/cgateweb\/serial-device\.sh/);
            expect(contents).not.toContain('/run/cgateweb/serial-device');
        });
    });
});
