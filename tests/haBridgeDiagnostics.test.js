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
                eventReconnectAttempts: 1
            },
            metrics: {
                commandQueue: { depth: 4 }
            }
        }));
        diagnostics = new HaBridgeDiagnostics(settings, publishFn, getStatusFn);
    });

    test('publishes discovery and state on first publishNow call', () => {
        diagnostics.publishNow('test');

        expect(publishFn).toHaveBeenCalledTimes(14);
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
            'cbus/read/bridge/diagnostics/command_queue_depth/state',
            '4',
            { retain: true, qos: 0 }
        );
    });

    test('does not republish discovery after initial call', () => {
        diagnostics.publishNow('first');
        publishFn.mockClear();

        diagnostics.publishNow('second');

        expect(publishFn).toHaveBeenCalledTimes(7);
        expect(publishFn).not.toHaveBeenCalledWith(
            expect.stringContaining('/config'),
            expect.any(String),
            expect.any(Object)
        );
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
});
