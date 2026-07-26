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
