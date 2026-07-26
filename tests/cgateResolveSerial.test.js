const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    identityFromByIdDir,
    identityFromSysfs,
    readIdentity,
    findDeviceByIdentity,
    resolveSerialDevice
} = require('../homeassistant-addon/rootfs/usr/bin/cgateweb-resolve-serial.js');

const BY_ID = 'usb-FTDI_FT232R_USB_UART_A50285BI-if00-port0';
const FTDI = { idVendor: '0403', idProduct: '6001', serial: 'A50285BI' };

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
        expect(result.messages.join('\n')).toMatch(/recovery after a replug will not be possible/i);
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
        expect(result.messages.join('\n')).toContain('ttyUSB1');
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
        expect(result.messages.join('\n')).toMatch(/is not present either/i);
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
        expect(result.messages.join('\n')).toMatch(/No previously-recorded device identity/i);
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
