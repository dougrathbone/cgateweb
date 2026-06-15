const BridgeReadiness = require('../src/bridgeReadiness');

function makeReadiness() {
    return new BridgeReadiness();
}

describe('BridgeReadiness', () => {
    describe('initial state', () => {
        it('starts in the booting lifecycle state with the startup reason', () => {
            const r = makeReadiness();
            const snapshot = r.getLifecycleSnapshot();
            expect(snapshot.state).toBe('booting');
            expect(snapshot.reason).toBe('startup');
            expect(snapshot.transitions).toBe(0);
            expect(typeof snapshot.since).toBe('number');
        });

        it('is not ready before any connections are up', () => {
            const r = makeReadiness();
            const result = r.update({ mqttConnected: false, eventConnected: false, healthyCommandConnections: 0 }, 'startup');
            expect(result.ready).toBe(false);
        });
    });

    describe('update', () => {
        const allConnected = { mqttConnected: true, eventConnected: true, healthyCommandConnections: 2 };

        it('transitions to ready when mqtt, event and a healthy command connection are all up', () => {
            const r = makeReadiness();
            const result = r.update(allConnected, 'all-connected');
            expect(result.ready).toBe(true);
            expect(result.reason).toBe('all-connected');
            expect(r.getLifecycleSnapshot().state).toBe('ready');
        });

        it('returns to degraded (not booting) after having been ready once', () => {
            const r = makeReadiness();
            r.update(allConnected, 'all-connected');
            const result = r.update({ mqttConnected: false, eventConnected: true, healthyCommandConnections: 2 }, 'mqtt-disconnected');
            expect(result.ready).toBe(false);
            expect(r.getLifecycleSnapshot().state).toBe('degraded');
        });

        it('stays in booting when never ready and connections are missing', () => {
            const r = makeReadiness();
            const result = r.update({ mqttConnected: true, eventConnected: false, healthyCommandConnections: 0 }, 'event-disconnected');
            expect(result.ready).toBe(false);
            expect(r.getLifecycleSnapshot().state).toBe('booting');
        });

        it('does not leave the stopping state when an update arrives during shutdown', () => {
            const r = makeReadiness();
            r.setLifecycleState('stopping', 'shutdown');
            r.update({ mqttConnected: false, eventConnected: false, healthyCommandConnections: 0 }, 'shutdown');
            expect(r.getLifecycleSnapshot().state).toBe('stopping');
        });

        it('emits readinessChanged on every update call (not only on transitions)', () => {
            const r = makeReadiness();
            const spy = jest.fn();
            r.on('readinessChanged', spy);
            r.update(allConnected, 'all-connected');
            r.update(allConnected, 'noop'); // same connection state, still emits
            expect(spy).toHaveBeenCalledTimes(2);
            expect(spy.mock.calls[0][0]).toMatchObject({ ready: true, reason: 'all-connected' });
            expect(spy.mock.calls[1][0]).toMatchObject({ ready: true, reason: 'noop' });
        });
    });

    describe('setLifecycleState', () => {
        it('is edge-triggered: identical state+reason does not bump transitions', () => {
            const r = makeReadiness();
            r.setLifecycleState('booting', 'startup'); // same as initial
            expect(r.getLifecycleSnapshot().transitions).toBe(0);
        });

        it('bumps transitions only when the state changes', () => {
            const r = makeReadiness();
            r.setLifecycleState('booting', 'new-reason'); // reason changes, state same
            expect(r.getLifecycleSnapshot().transitions).toBe(0);
            r.setLifecycleState('ready', 'all-connected'); // state changes
            expect(r.getLifecycleSnapshot().transitions).toBe(1);
        });
    });
});
