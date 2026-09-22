const HaBridgeDiagnostics = require('../src/haBridgeDiagnostics');

describe('HaBridgeDiagnostics', () => {
    let settings;
    let publishFn;
    let getStatusFn;
    let diagnostics;

    beforeEach(() => {
        settings = {
            ha_bridge_diagnostics_enabled: true,
            ha_bridge_diagnostics_interval_sec: 60,
            ha_discovery_prefix: 'homeassistant'
        };
        publishFn = jest.fn();
        getStatusFn = jest.fn(() => ({
            ready: true,
            lifecycle: { state: 'ready' },
            connections: {
                mqtt: true,
                event: true,
                commandPool: { healthyConnections: 3, pendingReconnects: 0 },
                eventReconnectAttempts: 1,
                web: { listening: true, error: null }
            },
            metrics: {
                commandQueue: { depth: 4 }
            }
        }));
        diagnostics = new HaBridgeDiagnostics(settings, publishFn, getStatusFn);
    });

    test('publishes discovery and state on first publishNow call', () => {
        diagnostics.publishNow('test');

        // 9 legacy configs + 9 migration markers + 1 device config + 9 legacy
        // clears + 9 states + 1 consolidated stats.
        expect(publishFn).toHaveBeenCalledTimes(38);
        expect(publishFn).toHaveBeenCalledWith(
            'homeassistant/binary_sensor/cgateweb_bridge_ready/config',
            expect.any(String),
            { retain: true, qos: 0 }
        );
        expect(publishFn).toHaveBeenCalledWith(
            'cbus/read/bridge/diagnostics/ready/state',
            'ON',
            { retain: true, qos: 0 }
        );
        expect(publishFn).toHaveBeenCalledWith(
            'cbus/read/bridge/diagnostics/web_listening/state',
            'ON',
            { retain: true, qos: 0 }
        );
    });

    test('does not republish discovery on every publishNow', () => {
        diagnostics.publishNow('first');
        publishFn.mockClear();

        diagnostics.publishNow('second');

        expect(publishFn).toHaveBeenCalledTimes(10); // 9 state + 1 consolidated stats
        expect(publishFn).not.toHaveBeenCalledWith(
            expect.stringContaining('/config'),
            expect.any(String),
            expect.any(Object)
        );
    });

    test('defaults noisy operational diagnostics to disabled', () => {
        diagnostics.publishNow('test');

        for (const key of ['command_queue_depth', 'reconnect_indicator']) {
            const call = publishFn.mock.calls.find(c => c[0].includes(`cgateweb_bridge_${key}/config`));
            expect(call).toBeDefined();
            expect(JSON.parse(call[1]).enabled_by_default).toBe(false);
        }

        const ready = publishFn.mock.calls.find(c => c[0].includes('cgateweb_bridge_ready/config'));
        expect(JSON.parse(ready[1]).enabled_by_default).toBeUndefined();
    });

    test('republishes discovery on broker reconnect (republishDiscovery)', () => {
        diagnostics.publishNow('first');
        publishFn.mockClear();

        diagnostics.republishDiscovery();

        expect(publishFn).toHaveBeenCalledTimes(1); // bundled device config only
        expect(publishFn).toHaveBeenCalledWith(
            'homeassistant/device/cgateweb_bridge/config',
            expect.any(String),
            { retain: true, qos: 0 }
        );
        // …and regular publishNow still doesn't repeat them afterwards
        publishFn.mockClear();
        diagnostics.publishNow('second');
        expect(publishFn).not.toHaveBeenCalledWith(
            expect.stringContaining('/config'),
            expect.any(String),
            expect.any(Object)
        );
    });

    test('republishDiscovery is a no-op before the first publishNow and when disabled', () => {
        diagnostics.republishDiscovery();
        expect(publishFn).not.toHaveBeenCalled();

        const disabled = new HaBridgeDiagnostics(
            { ...settings, ha_bridge_diagnostics_enabled: false },
            publishFn,
            getStatusFn
        );
        disabled.republishDiscovery();
        expect(publishFn).not.toHaveBeenCalled();
    });

    test('migrates bridge diagnostics into one device discovery payload', () => {
        diagnostics.publishNow('test');

        const deviceCall = publishFn.mock.calls.find(
            c => c[0] === 'homeassistant/device/cgateweb_bridge/config'
        );
        expect(deviceCall).toBeDefined();
        const payload = JSON.parse(deviceCall[1]);
        expect(Object.keys(payload.components)).toHaveLength(9);
        expect(payload.components.cgateweb_bridge_ready.platform).toBe('binary_sensor');
        expect(payload.components.cgateweb_bridge_ready.unique_id).toBe('cgateweb_bridge_ready');
        expect(payload.device.identifiers).toEqual(['cgateweb_bridge']);
        expect(payload.availability_topic).toBe('hello/cgateweb');

        const readyTopicCalls = publishFn.mock.calls.filter(
            c => c[0] === 'homeassistant/binary_sensor/cgateweb_bridge_ready/config'
        );
        expect(JSON.parse(readyTopicCalls[1][1])).toEqual({ migrate_discovery: true });
        expect(readyTopicCalls[2][1]).toBe('');
    });

    test('does not publish when disabled', () => {
        diagnostics = new HaBridgeDiagnostics(
            { ...settings, ha_bridge_diagnostics_enabled: false },
            publishFn,
            getStatusFn
        );
        diagnostics.publishNow('disabled');
        expect(publishFn).not.toHaveBeenCalled();
    });

    test('publishes on configured interval', () => {
        jest.useFakeTimers();
        diagnostics.start();
        jest.advanceTimersByTime(60000);
        diagnostics.stop();
        jest.useRealTimers();

        expect(publishFn).toHaveBeenCalled();
    });

    test('clamps a zero diagnostics interval to the 10s floor', () => {
        jest.useFakeTimers();
        diagnostics = new HaBridgeDiagnostics(
            { ...settings, ha_bridge_diagnostics_interval_sec: 0 },
            publishFn,
            getStatusFn
        );
        diagnostics.start();
        publishFn.mockClear();

        jest.advanceTimersByTime(9999);
        expect(publishFn).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        expect(publishFn).toHaveBeenCalled();

        diagnostics.stop();
        jest.useRealTimers();
    });

    test('consolidated stats topic contains correct JSON structure', () => {
        diagnostics.publishNow('test');

        const statsCall = publishFn.mock.calls.find(c => c[0] === 'cbus/read/bridge/stats');
        expect(statsCall).toBeDefined();

        const stats = JSON.parse(statsCall[1]);
        expect(stats).toHaveProperty('uptime');
        expect(stats).toHaveProperty('ready', true);
        expect(stats.connections).toEqual({
            mqtt: true,
            event: true,
            commandPoolHealthy: 3,
            commandPoolTotal: 0,
            webListening: true
        });
        expect(stats.queue).toHaveProperty('depth', 4);
        expect(stats.publisher).toHaveProperty('published');
        expect(stats).toHaveProperty('cgate_version', 'unknown');

        // Verify it's published with retain
        expect(statsCall[2]).toEqual({ retain: true, qos: 0 });
    });
});
