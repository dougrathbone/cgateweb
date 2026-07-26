'use strict';

const CniNotificationManager = require('../src/cniNotificationManager');
const SerialDeviceRecovery = require('../src/serialDeviceRecovery');
const haNotifier = require('../src/haNotifier');

jest.mock('../src/haNotifier', () => ({
    createPersistentNotification: jest.fn(),
    dismissPersistentNotification: jest.fn()
}));

function makeMonitor() {
    // A simple stand-in for NetworkInterfaceMonitor that mirrors the real
    // online/offline transition semantics (online === true when 'running').
    const states = new Map();
    return {
        update: jest.fn((networkId, reading) => {
            const online = reading.interfaceState === 'running'
                ? true
                : reading.interfaceState === 'closed'
                    ? false
                    : null;
            const prev = states.has(networkId) ? states.get(networkId) : undefined;
            const changed = prev !== online;
            states.set(networkId, online);
            return { changed, online, interfaceState: reading.interfaceState };
        }),
        getSnapshot: jest.fn(() => [])
    };
}

function makeDeps(overrides = {}) {
    return {
        networkInterfaceMonitor: makeMonitor(),
        mqttManager: { publish: jest.fn() },
        getHaDiscovery: () => null,
        logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
        settings: { cni_offline_notification: true },
        mqttOptions: { qos: 0 },
        ...overrides
    };
}

describe('CniNotificationManager', () => {
    let prevToken;

    beforeEach(() => {
        jest.clearAllMocks();
        prevToken = process.env.SUPERVISOR_TOKEN;
        process.env.SUPERVISOR_TOKEN = 'test-token';
        haNotifier.createPersistentNotification.mockResolvedValue({ statusCode: 200 });
        haNotifier.dismissPersistentNotification.mockResolvedValue({ statusCode: 200 });
    });

    afterEach(() => {
        if (prevToken === undefined) {
            delete process.env.SUPERVISOR_TOKEN;
        } else {
            process.env.SUPERVISOR_TOKEN = prevToken;
        }
    });

    it('publishes retained CNI connectivity state on a transition', () => {
        const deps = makeDeps();
        const mgr = new CniNotificationManager(deps);
        mgr.handleReading('254', { interfaceState: 'closed' });
        const offCall = deps.mqttManager.publish.mock.calls.find(c => c[0] === 'cbus/read/254/cni/state');
        expect(offCall).toBeDefined();
        expect(offCall[1]).toBe('OFF');
        expect(offCall[2].retain).toBe(true);

        mgr.handleReading('254', { interfaceState: 'running' });
        const onCall = deps.mqttManager.publish.mock.calls.reverse().find(c => c[0] === 'cbus/read/254/cni/state');
        expect(onCall[1]).toBe('ON');
    });

    it('raises an HA notification once when a network goes offline', () => {
        const deps = makeDeps();
        const mgr = new CniNotificationManager(deps);
        mgr.handleReading('254', { interfaceState: 'closed' });
        expect(haNotifier.createPersistentNotification).toHaveBeenCalledTimes(1);
        expect(haNotifier.createPersistentNotification.mock.calls[0][0]).toMatchObject({
            notificationId: 'cgateweb_cni_254',
            token: 'test-token'
        });
    });

    it('does not re-notify or re-publish on a second consecutive offline reading', () => {
        // The real NetworkInterfaceMonitor only flags changed:true on a transition.
        // Two consecutive 'closed' readings => changed:true then changed:false.
        const deps = makeDeps();
        const mgr = new CniNotificationManager(deps);
        mgr.handleReading('254', { interfaceState: 'closed' });
        mgr.handleReading('254', { interfaceState: 'closed' });
        // The result.changed gate must suppress everything past the first reading.
        expect(haNotifier.createPersistentNotification).toHaveBeenCalledTimes(1);
        const stateCalls = deps.mqttManager.publish.mock.calls.filter(c => c[0] === 'cbus/read/254/cni/state');
        expect(stateCalls).toHaveLength(1);
    });

    it('dismisses the notification when the network comes back online', () => {
        const deps = makeDeps();
        const mgr = new CniNotificationManager(deps);
        mgr.handleReading('254', { interfaceState: 'closed' });
        mgr.handleReading('254', { interfaceState: 'running' });
        expect(haNotifier.dismissPersistentNotification).toHaveBeenCalledTimes(1);
        expect(haNotifier.dismissPersistentNotification.mock.calls[0][0]).toMatchObject({
            notificationId: 'cgateweb_cni_254'
        });
    });

    it('does not notify when cni_offline_notification is disabled', () => {
        const deps = makeDeps({ settings: { cni_offline_notification: false } });
        const mgr = new CniNotificationManager(deps);
        mgr.handleReading('254', { interfaceState: 'closed' });
        expect(haNotifier.createPersistentNotification).not.toHaveBeenCalled();
    });

    it('does not throw raising a CNI notification when SUPERVISOR_TOKEN is absent', () => {
        delete process.env.SUPERVISOR_TOKEN;
        const deps = makeDeps();
        const mgr = new CniNotificationManager(deps);
        expect(() => mgr.handleReading('254', { interfaceState: 'closed' })).not.toThrow();
        expect(haNotifier.createPersistentNotification).not.toHaveBeenCalled();
    });

    it('ensures the connectivity discovery config when haDiscovery is present', () => {
        const ensureNetworkConnectivityDiscovery = jest.fn();
        const deps = makeDeps({ getHaDiscovery: () => ({ ensureNetworkConnectivityDiscovery }) });
        const mgr = new CniNotificationManager(deps);
        mgr.handleReading('254', { interfaceState: 'closed' });
        expect(ensureNetworkConnectivityDiscovery).toHaveBeenCalledWith('254');
    });

    describe('serial device recovery hand-off (issue #28)', () => {
        function makeRecovery() {
            return {
                handleInterfaceDown: jest.fn(() => ({ action: 'ignored', message: null })),
                handleInterfaceUp: jest.fn()
            };
        }

        it('hands an offline transition to the recovery collaborator', () => {
            const serialDeviceRecovery = makeRecovery();
            const deps = makeDeps({ serialDeviceRecovery });
            const mgr = new CniNotificationManager(deps);
            mgr.handleReading('254', { interfaceState: 'closed' });
            expect(serialDeviceRecovery.handleInterfaceDown).toHaveBeenCalledWith('254');
            expect(serialDeviceRecovery.handleInterfaceUp).not.toHaveBeenCalled();
        });

        it('hands a recovery back to it so the attempt budget can reset', () => {
            const serialDeviceRecovery = makeRecovery();
            const deps = makeDeps({ serialDeviceRecovery });
            const mgr = new CniNotificationManager(deps);
            mgr.handleReading('254', { interfaceState: 'closed' });
            mgr.handleReading('254', { interfaceState: 'running' });
            expect(serialDeviceRecovery.handleInterfaceUp).toHaveBeenCalledWith('254');
        });

        it('recovers regardless of the cni_offline_notification setting', () => {
            // Recovery is not a notification feature; it must not be gated on one.
            const serialDeviceRecovery = makeRecovery();
            const deps = makeDeps({ serialDeviceRecovery, settings: { cni_offline_notification: false } });
            const mgr = new CniNotificationManager(deps);
            mgr.handleReading('254', { interfaceState: 'closed' });
            expect(serialDeviceRecovery.handleInterfaceDown).toHaveBeenCalledWith('254');
        });

        it('re-triggers recovery on a repeated offline reading', () => {
            // Deliberately not gated on result.changed. A network that is already
            // closed reports closed on every poll with changed:false, so a
            // transition-only hand-off would get exactly one attempt -- taken
            // while the PC Interface is still unplugged. The replug produces no
            // transition, so recovery has to be offered every offline reading.
            const serialDeviceRecovery = makeRecovery();
            const deps = makeDeps({ serialDeviceRecovery });
            const mgr = new CniNotificationManager(deps);
            mgr.handleReading('254', { interfaceState: 'closed' });
            mgr.handleReading('254', { interfaceState: 'closed' });
            mgr.handleReading('254', { interfaceState: 'closed' });
            expect(serialDeviceRecovery.handleInterfaceDown).toHaveBeenCalledTimes(3);
        });

        it('still notifies and publishes only once across those repeated readings', () => {
            // The recovery hand-off moved out of the result.changed block; the
            // notification and the retained state publish must not follow it.
            const serialDeviceRecovery = makeRecovery();
            const deps = makeDeps({ serialDeviceRecovery });
            const mgr = new CniNotificationManager(deps);
            mgr.handleReading('254', { interfaceState: 'closed' });
            mgr.handleReading('254', { interfaceState: 'closed' });
            expect(haNotifier.createPersistentNotification).toHaveBeenCalledTimes(1);
            expect(deps.mqttManager.publish.mock.calls.filter(c => c[0] === 'cbus/read/254/cni/state'))
                .toHaveLength(1);
        });

        it('hands an interface that stays up back only on the transition', () => {
            // handleInterfaceUp stamps "up since now", which is what decides
            // whether the next outage earns a fresh attempt budget; re-stamping
            // it every poll would mean no outage ever qualified.
            const serialDeviceRecovery = makeRecovery();
            const deps = makeDeps({ serialDeviceRecovery });
            const mgr = new CniNotificationManager(deps);
            mgr.handleReading('254', { interfaceState: 'running' });
            mgr.handleReading('254', { interfaceState: 'running' });
            expect(serialDeviceRecovery.handleInterfaceUp).toHaveBeenCalledTimes(1);
        });

        it('recovers a replug that finishes after the outage was first seen (issue #28)', () => {
            // The physical sequence this feature exists for, with the real
            // collaborator: running, unplug, one failed attempt while the device
            // is genuinely absent, replug onto a different port, then another
            // *unchanged* offline poll -- which is all the monitor produces once
            // the network is closed.
            const clock = { t: 1000 };
            const present = new Set(['/dev/ttyUSB0']);
            const enoent = (p) => {
                const err = new Error(`ENOENT: ${p}`);
                /** @type {any} */ (err).code = 'ENOENT';
                return err;
            };
            const fsImpl = {
                existsSync: (p) => present.has(p),
                // Not the add-on: no published device file, so the option is used.
                readFileSync: (p) => { throw enoent(p); },
                realpathSync: (p) => {
                    if (!present.has(p)) throw enoent(p);
                    return p;
                }
            };
            // The helper re-resolves by remembered identity: it fails while
            // nothing is plugged in and succeeds once the new port appears.
            const execImpl = jest.fn(() => (present.has('/dev/ttyUSB1')
                ? { status: 0, stdout: '/dev/ttyUSB1\n', stderr: '' }
                : { status: 1, stdout: '', stderr: 'WARN: /dev/ttyUSB0 is not present' }));
            const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
            const serialDeviceRecovery = new SerialDeviceRecovery({
                settings: { cgate_mode: 'managed', cgate_serial_device: '/dev/ttyUSB0' },
                logger,
                fsImpl,
                execImpl,
                now: () => clock.t
            });
            const mgr = new CniNotificationManager(makeDeps({ serialDeviceRecovery }));

            mgr.handleReading('254', { interfaceState: 'running' });
            present.delete('/dev/ttyUSB0');
            clock.t += 30000;
            mgr.handleReading('254', { interfaceState: 'closed' });
            expect(execImpl).toHaveBeenCalledTimes(1);

            present.add('/dev/ttyUSB1'); // the user plugs it back in
            clock.t += 30000;            // the next poll: closed again, changed:false
            mgr.handleReading('254', { interfaceState: 'closed' });

            expect(execImpl).toHaveBeenCalledTimes(2);
            expect(logger.warn).toHaveBeenCalledWith(
                expect.stringMatching(/Re-resolved the PC Interface to \/dev\/ttyUSB1/)
            );
        });

        it('never attempts a restart for a CNI install however long it stays offline', () => {
            // No cgate_serial_device: an ethernet CNI outage is a genuine network
            // fault, and there is no local device to re-resolve. Feeding every
            // offline poll to recovery must not change that.
            const execImpl = jest.fn();
            const serialDeviceRecovery = new SerialDeviceRecovery({
                settings: { cgate_mode: 'managed', cgate_serial_device: null },
                logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
                execImpl
            });
            const mgr = new CniNotificationManager(makeDeps({ serialDeviceRecovery }));
            for (let i = 0; i < 5; i++) mgr.handleReading('254', { interfaceState: 'closed' });
            expect(execImpl).not.toHaveBeenCalled();
        });

        it('works without the collaborator', () => {
            const deps = makeDeps();
            const mgr = new CniNotificationManager(deps);
            expect(() => mgr.handleReading('254', { interfaceState: 'closed' })).not.toThrow();
        });
    });

    it('does not publish or notify for a transitional (online === null) reading', () => {
        // An interfaceState that is neither 'running' nor 'closed' maps to online:null
        // (unknown/transitional). The result.online !== null guard must skip it.
        const deps = makeDeps();
        const mgr = new CniNotificationManager(deps);
        mgr.handleReading('254', { interfaceState: 'opening' });
        const stateCalls = deps.mqttManager.publish.mock.calls.filter(c => c[0] === 'cbus/read/254/cni/state');
        expect(stateCalls).toHaveLength(0);
        expect(haNotifier.createPersistentNotification).not.toHaveBeenCalled();
        expect(haNotifier.dismissPersistentNotification).not.toHaveBeenCalled();
    });
});
