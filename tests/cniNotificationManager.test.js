'use strict';

const CniNotificationManager = require('../src/cniNotificationManager');
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
});
