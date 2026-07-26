'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const SerialDeviceRecovery = require('../src/serialDeviceRecovery');
const { defaultSettings } = require('../src/defaultSettings');
const { posixBashAvailable } = require('./helpers/posixBash');

const DEVICE_FILE = '/run/cgateweb/serial-device';

function makeLogger() {
    return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

/** An fs error with the errno code real fs errors carry. */
function fsError(code, p) {
    const err = new Error(`${code}: ${p}`);
    /** @type {any} */ (err).code = code;
    return err;
}

/**
 * Minimal fs stand-in. `present` is the set of paths that exist; `contents`
 * maps a path to what readFileSync returns; `links` maps a path to its
 * realpath target (defaulting to the path itself, as for a real device node).
 */
function makeFs({ present = [], contents = {}, links = {} } = {}) {
    const set = new Set([...present, ...Object.keys(contents)]);
    return {
        existsSync: p => set.has(p),
        readFileSync: p => {
            if (!(p in contents)) throw fsError('ENOENT', p);
            return contents[p];
        },
        realpathSync: p => {
            if (!set.has(p)) throw fsError('ENOENT', p);
            return links[p] || p;
        }
    };
}

const SETTINGS = {
    cgate_mode: 'managed',
    cgate_serial_device: '/dev/ttyUSB0',
    serialRecoveryEnabled: true,
    serialRecoveryMaxAttempts: 3,
    serialRecoveryInitialDelayMs: 5000,
    serialRecoveryMaxDelayMs: 300000,
    serialRecoveryStableWindowMs: 900000
};

function makeRecovery(overrides = {}) {
    const clock = { t: 1000 };
    const deps = {
        settings: { ...SETTINGS, ...(overrides.settings || {}) },
        logger: overrides.logger || makeLogger(),
        fsImpl: overrides.fsImpl || makeFs(),
        execImpl: overrides.execImpl || jest.fn(() => ({ status: 0, stdout: '/dev/ttyUSB1\n', stderr: '' })),
        now: overrides.now || (() => clock.t)
    };
    return { recovery: new SerialDeviceRecovery(deps), clock, ...deps };
}

describe('SerialDeviceRecovery', () => {
    describe('does not engage where no local PC Interface is in play', () => {
        it('ignores the transition when not in managed mode', () => {
            const { recovery, execImpl } = makeRecovery({ settings: { cgate_mode: 'remote' } });
            expect(recovery.handleInterfaceDown('254').action).toBe('ignored');
            expect(execImpl).not.toHaveBeenCalled();
        });

        it('ignores the transition when no serial device is configured', () => {
            // The CNI case: InterfaceState=closed is a genuine network fault and
            // there is no local device to re-resolve.
            const { recovery, execImpl } = makeRecovery({ settings: { cgate_serial_device: null } });
            expect(recovery.handleInterfaceDown('254').action).toBe('ignored');
            expect(execImpl).not.toHaveBeenCalled();
        });

        it('ignores the transition when settings are absent entirely', () => {
            const recovery = new SerialDeviceRecovery({});
            expect(recovery.handleInterfaceDown('254').action).toBe('ignored');
        });
    });

    describe('trigger precision', () => {
        it('reports without recovering when the device path still exists on the same port', () => {
            const { recovery, execImpl } = makeRecovery({
                fsImpl: makeFs({ present: ['/dev/ttyUSB0'] })
            });
            recovery.handleInterfaceUp('254'); // records the port in use
            expect(recovery.handleInterfaceDown('254').action).toBe('reported');
            expect(execImpl).not.toHaveBeenCalled();
        });

        it('uses the path the resolver published, not the stale configured option', () => {
            // cont-init already recovered a renumber this boot: the option still
            // says ttyUSB0 but C-Gate was pointed at ttyUSB1, which is present.
            // Judging by the option alone would restart C-Gate for nothing.
            const { recovery, execImpl } = makeRecovery({
                fsImpl: makeFs({
                    present: ['/dev/ttyUSB1'],
                    contents: { [DEVICE_FILE]: '/dev/ttyUSB1\n' }
                })
            });
            expect(recovery.handleInterfaceDown('254').action).toBe('reported');
            expect(execImpl).not.toHaveBeenCalled();
        });

        it('recovers when the device path has disappeared', () => {
            const { recovery, execImpl, logger } = makeRecovery({ fsImpl: makeFs() });
            const result = recovery.handleInterfaceDown('254');

            expect(result.action).toBe('recovered');
            // The *configured* option is what the recovery script re-resolves.
            expect(execImpl).toHaveBeenCalledWith(
                expect.stringContaining('cgateweb-recover-serial'),
                ['/dev/ttyUSB0']
            );
            expect(result.message).toMatch(/\/dev\/ttyUSB1/);
            expect(logger.warn).toHaveBeenCalled();
        });

        it('recovers when a stable by-id path now points at a different port', () => {
            // The recommended config: /dev/serial/by-id/... survives a replug, so
            // the path check alone can never see the renumber. The link's target
            // moving from ttyUSB0 to ttyUSB1 is the renumber.
            const fsImpl = makeFs({
                present: ['/dev/serial/by-id/usb-pci'],
                links: { '/dev/serial/by-id/usb-pci': '/dev/ttyUSB0' }
            });
            const { recovery, execImpl } = makeRecovery({
                settings: { cgate_serial_device: '/dev/serial/by-id/usb-pci' },
                fsImpl
            });

            recovery.handleInterfaceUp('254'); // captures ttyUSB0 as the port in use
            fsImpl.realpathSync = () => '/dev/ttyUSB1';

            expect(recovery.handleInterfaceDown('254').action).toBe('recovered');
            expect(execImpl).toHaveBeenCalledWith(
                expect.stringContaining('cgateweb-recover-serial'),
                ['/dev/serial/by-id/usb-pci']
            );
        });

        it('reports rather than restarts when the device path cannot be examined', () => {
            // Only ENOENT says the device is gone. EACCES, ELOOP or an I/O error
            // say we could not look - which is no evidence of a replug, and this
            // decision restarts a service.
            const fsImpl = makeFs();
            fsImpl.realpathSync = () => { throw fsError('EACCES', '/dev/ttyUSB0'); };
            const { recovery, execImpl, logger } = makeRecovery({ fsImpl });

            const result = recovery.handleInterfaceDown('254');

            expect(result.action).toBe('reported');
            expect(result.message).toMatch(/could not be examined/);
            expect(result.message).toMatch(/EACCES/);
            expect(execImpl).not.toHaveBeenCalled();
            expect(logger.warn).toHaveBeenCalled();
        });

        it('does not treat an unreadable path as a moved by-id link either', () => {
            // The baseline port is unknown when it could not be read, so the
            // "moved" comparison must decline instead of comparing against null.
            const fsImpl = makeFs();
            fsImpl.realpathSync = () => { throw fsError('ELOOP', '/dev/serial/by-id/usb-pci'); };
            const { recovery, execImpl } = makeRecovery({
                settings: { cgate_serial_device: '/dev/serial/by-id/usb-pci' },
                fsImpl
            });

            recovery.handleInterfaceUp('254');
            expect(recovery.handleInterfaceDown('254').action).toBe('reported');
            expect(execImpl).not.toHaveBeenCalled();
        });

        it('does not recover on a by-id path whose target has not moved', () => {
            const fsImpl = makeFs({
                present: ['/dev/serial/by-id/usb-pci'],
                links: { '/dev/serial/by-id/usb-pci': '/dev/ttyUSB0' }
            });
            const { recovery, execImpl } = makeRecovery({
                settings: { cgate_serial_device: '/dev/serial/by-id/usb-pci' },
                fsImpl
            });

            recovery.handleInterfaceUp('254');
            expect(recovery.handleInterfaceDown('254').action).toBe('reported');
            expect(execImpl).not.toHaveBeenCalled();
        });
    });

    describe('failure reporting', () => {
        it('reports failure when the device cannot be found again', () => {
            const execImpl = jest.fn(() => ({
                status: 1,
                stdout: '',
                stderr: 'WARN: /dev/ttyUSB0 is not present and no previously-used device could be found\n'
            }));
            const { recovery, logger } = makeRecovery({ fsImpl: makeFs(), execImpl });

            const result = recovery.handleInterfaceDown('254');

            expect(result.action).toBe('failed');
            expect(result.message).toMatch(/not present/i);
            expect(logger.error).toHaveBeenCalled();
        });

        it('says the helper is missing when the recovery script is not installed', () => {
            // Standalone managed mode: the add-on's rootfs scripts do not exist.
            const execImpl = jest.fn(() => ({
                status: 1, stdout: '', stderr: '', error: { code: 'ENOENT' }
            }));
            const { recovery } = makeRecovery({ fsImpl: makeFs(), execImpl });

            const result = recovery.handleInterfaceDown('254');
            expect(result.action).toBe('failed');
            expect(result.message).toMatch(/not installed/i);
        });
    });

    describe('bounding the restarts', () => {
        it('waits out the backoff before a second attempt', () => {
            const { recovery, clock, execImpl } = makeRecovery({ fsImpl: makeFs() });

            expect(recovery.handleInterfaceDown('254').action).toBe('recovered');
            clock.t += 1000; // well inside the 5s initial backoff
            recovery.handleInterfaceUp('254');
            const second = recovery.handleInterfaceDown('254');

            expect(second.action).toBe('reported');
            expect(second.message).toMatch(/before the next recovery attempt/);
            expect(execImpl).toHaveBeenCalledTimes(1);
        });

        it('attempts again once the backoff has elapsed', () => {
            const { recovery, clock, execImpl } = makeRecovery({ fsImpl: makeFs() });

            recovery.handleInterfaceDown('254');
            clock.t += 6000; // past the 5s initial backoff
            recovery.handleInterfaceUp('254');
            expect(recovery.handleInterfaceDown('254').action).toBe('recovered');
            expect(execImpl).toHaveBeenCalledTimes(2);
        });

        it('gives up after the configured maximum and says how to recover', () => {
            const { recovery, clock, execImpl, logger } = makeRecovery({
                settings: { serialRecoveryMaxAttempts: 2 },
                fsImpl: makeFs()
            });

            // A flapping interface: each down/up cycle spaced past the backoff.
            let last = null;
            for (let i = 0; i < 3; i++) {
                clock.t += 120000;
                recovery.handleInterfaceUp('254');
                clock.t += 1000;
                last = recovery.handleInterfaceDown('254');
            }

            expect(last.action).toBe('reported');
            expect(last.message).toMatch(/gave up after 2/);
            expect(execImpl).toHaveBeenCalledTimes(2);
            expect(logger.error).toHaveBeenCalled();
        });

        it('gives a fresh budget to an outage that follows a stable period', () => {
            const { recovery, clock, execImpl } = makeRecovery({
                settings: { serialRecoveryMaxAttempts: 1 },
                fsImpl: makeFs()
            });

            recovery.handleInterfaceDown('254');
            recovery.handleInterfaceUp('254');
            clock.t += 900000; // the interface stayed up for the stable window
            expect(recovery.handleInterfaceDown('254').action).toBe('recovered');
            expect(execImpl).toHaveBeenCalledTimes(2);
        });

        it('does not give a fresh budget when the interface only flapped briefly', () => {
            const { recovery, clock, execImpl } = makeRecovery({
                settings: { serialRecoveryMaxAttempts: 1 },
                fsImpl: makeFs()
            });

            recovery.handleInterfaceDown('254');
            recovery.handleInterfaceUp('254');
            clock.t += 60000; // back up for a minute, then down again
            expect(recovery.handleInterfaceDown('254').action).toBe('reported');
            expect(execImpl).toHaveBeenCalledTimes(1);
        });

        it('tracks each network\'s budget separately', () => {
            const { recovery, execImpl } = makeRecovery({
                settings: { serialRecoveryMaxAttempts: 1 },
                fsImpl: makeFs()
            });

            recovery.handleInterfaceDown('254');
            expect(recovery.handleInterfaceDown('200').action).toBe('recovered');
            expect(execImpl).toHaveBeenCalledTimes(2);
        });

        it('does not spend the budget on a run that restarted nothing', () => {
            // The helper exits 1 before touching a project or C-Gate when there is
            // no device to find. Nothing was disrupted, so nothing is owed: the
            // poll loop has to still be looking whenever the user plugs the
            // interface back in, which may be hours later.
            const absent = { status: 1, stdout: '', stderr: 'WARN: /dev/ttyUSB0 is not present' };
            const execImpl = jest.fn(() => absent);
            const { recovery, clock } = makeRecovery({
                settings: { serialRecoveryMaxAttempts: 2 },
                fsImpl: makeFs(),
                execImpl
            });

            for (let i = 0; i < 6; i++) {
                clock.t += 30000; // the CNI monitor's poll interval
                expect(recovery.handleInterfaceDown('254').action).toBe('failed');
            }
            expect(execImpl).toHaveBeenCalledTimes(6);
        });

        it('still spends the budget on a broken helper', () => {
            // A helper that cannot be spawned reports the same status as an absent
            // device, but it will never behave differently, so it has to be
            // allowed to run out rather than be retried on every poll forever.
            const execImpl = jest.fn(() => ({ status: 1, stdout: '', stderr: '', error: { code: 'ENOENT' } }));
            const { recovery, clock } = makeRecovery({
                settings: { serialRecoveryMaxAttempts: 2 },
                fsImpl: makeFs(),
                execImpl
            });

            let last = null;
            for (let i = 0; i < 4; i++) {
                clock.t += 30000;
                last = recovery.handleInterfaceDown('254');
            }
            expect(execImpl).toHaveBeenCalledTimes(2);
            expect(last.message).toMatch(/gave up after 2/);
        });

        it('says the same thing once per outage, not once per poll', () => {
            // handleInterfaceDown now runs on every offline poll, so an interface
            // left unplugged would otherwise repeat the same warning forever.
            const { recovery, logger } = makeRecovery({
                settings: { serialRecoveryEnabled: false },
                fsImpl: makeFs()
            });

            recovery.handleInterfaceDown('254');
            recovery.handleInterfaceDown('254');
            recovery.handleInterfaceDown('254');
            expect(logger.warn).toHaveBeenCalledTimes(1);

            // A new outage is new news.
            recovery.handleInterfaceUp('254');
            recovery.handleInterfaceDown('254');
            expect(logger.warn).toHaveBeenCalledTimes(2);
        });

        it('does nothing but report when recovery is disabled', () => {
            const { recovery, execImpl } = makeRecovery({
                settings: { serialRecoveryEnabled: false },
                fsImpl: makeFs()
            });

            expect(recovery.handleInterfaceDown('254').action).toBe('reported');
            expect(execImpl).not.toHaveBeenCalled();
        });
    });

    describe('default child-process runner', () => {
        // These exercise the runner the bridge actually uses in production
        // (execFileSync), which every injected execImpl above bypasses.
        let dir;
        let prevScript;

        beforeEach(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-recovery-exec-'));
            prevScript = process.env.CGATEWEB_RECOVER_SCRIPT;
        });

        afterEach(() => {
            if (prevScript === undefined) delete process.env.CGATEWEB_RECOVER_SCRIPT;
            else process.env.CGATEWEB_RECOVER_SCRIPT = prevScript;
            fs.rmSync(dir, { recursive: true, force: true });
        });

        it('reports a missing recovery script rather than throwing', () => {
            process.env.CGATEWEB_RECOVER_SCRIPT = path.join(dir, 'not-installed');
            const recovery = new SerialDeviceRecovery({
                settings: SETTINGS, logger: makeLogger(), fsImpl: makeFs()
            });

            const result = recovery.handleInterfaceDown('254');
            expect(result.action).toBe('failed');
            expect(result.message).toMatch(/not installed/i);
        });

        (posixBashAvailable() ? it : it.skip)('reads the resolved path from a real script', () => {
            const script = path.join(dir, 'recover');
            fs.writeFileSync(script, '#!/usr/bin/env bash\necho "INFO: noise" >&2\necho "$1 seen"\necho /dev/ttyUSB7\n', { mode: 0o755 });
            process.env.CGATEWEB_RECOVER_SCRIPT = script;
            const recovery = new SerialDeviceRecovery({
                settings: SETTINGS, logger: makeLogger(), fsImpl: makeFs()
            });

            const result = recovery.handleInterfaceDown('254');
            expect(result.action).toBe('recovered');
            expect(result.message).toMatch(/\/dev\/ttyUSB7/);
        });

        (posixBashAvailable() ? it : it.skip)('gives up on a helper that hangs instead of blocking with it', () => {
            // The helper runs synchronously on the bridge's event loop, so MQTT
            // keepalive, LWT and the pool health checks all wait behind it. The
            // timeout is the only bound on that stall.
            const script = path.join(dir, 'recover');
            fs.writeFileSync(script, '#!/usr/bin/env bash\nsleep 5\n', { mode: 0o755 });
            process.env.CGATEWEB_RECOVER_SCRIPT = script;
            const recovery = new SerialDeviceRecovery({
                settings: { ...SETTINGS, serialRecoveryTimeoutMs: 1000 },
                logger: makeLogger(),
                fsImpl: makeFs()
            });

            const startedAt = Date.now();
            const result = recovery.handleInterfaceDown('254');

            expect(result.action).toBe('failed');
            expect(result.message).toMatch(/timed out/);
            expect(Date.now() - startedAt).toBeLessThan(4000);
        });

        it('will not let a zero timeout mean "wait forever"', () => {
            // execFileSync reads timeout: 0 as no timeout at all, which would
            // hand a wedged helper the whole bridge.
            const zero = new SerialDeviceRecovery({ settings: { ...SETTINGS, serialRecoveryTimeoutMs: 0 } });
            expect(zero._timeoutMs()).toBe(defaultSettings.serialRecoveryTimeoutMs);

            const tiny = new SerialDeviceRecovery({ settings: { ...SETTINGS, serialRecoveryTimeoutMs: 5 } });
            expect(tiny._timeoutMs()).toBe(1000);

            const configured = new SerialDeviceRecovery({ settings: { ...SETTINGS, serialRecoveryTimeoutMs: 30000 } });
            expect(configured._timeoutMs()).toBe(30000);
        });

        (posixBashAvailable() ? it : it.skip)('surfaces the stderr of a failing script', () => {
            const script = path.join(dir, 'recover');
            fs.writeFileSync(script, '#!/usr/bin/env bash\necho "WARN: the interface is gone" >&2\nexit 1\n', { mode: 0o755 });
            process.env.CGATEWEB_RECOVER_SCRIPT = script;
            const recovery = new SerialDeviceRecovery({
                settings: SETTINGS, logger: makeLogger(), fsImpl: makeFs()
            });

            const result = recovery.handleInterfaceDown('254');
            expect(result.action).toBe('failed');
            expect(result.message).toMatch(/the interface is gone/);
        });
    });
});
