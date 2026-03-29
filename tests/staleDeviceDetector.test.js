const StaleDeviceDetector = require('../src/staleDeviceDetector');

describe('StaleDeviceDetector', () => {
    let publishFn;
    let mqttClient;
    let deviceStateManager;
    let settings;
    let logger;
    let labelLoader;

    const NOW = 1743246000000; // fixed timestamp for deterministic tests

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(NOW);

        publishFn = jest.fn();
        mqttClient = { publish: publishFn };

        deviceStateManager = {
            getAllLastSeen: jest.fn(() => new Map())
        };

        settings = {
            stale_device_detection_enabled: true,
            stale_device_threshold_hours: 24,
            stale_device_check_interval_sec: 3600,
            ha_discovery_prefix: 'homeassistant'
        };

        logger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        };

        labelLoader = {
            getLabels: jest.fn(() => new Map())
        };
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    function makeDetector(overrides = {}) {
        return new StaleDeviceDetector({
            deviceStateManager,
            mqttClient,
            settings: { ...settings, ...overrides },
            labelLoader,
            logger
        });
    }

    // ── _getStaleDevices ──────────────────────────────────────────────────────

    describe('_getStaleDevices', () => {
        it('returns empty array when no devices have been seen', () => {
            deviceStateManager.getAllLastSeen.mockReturnValue(new Map());
            const detector = makeDetector();
            expect(detector._getStaleDevices(24 * 60 * 60 * 1000)).toEqual([]);
        });

        it('returns empty array when all devices have been seen recently', () => {
            deviceStateManager.getAllLastSeen.mockReturnValue(new Map([
                ['254/56/1', NOW - 1000],       // 1 second ago
                ['254/56/2', NOW - 3600 * 1000] // 1 hour ago
            ]));
            const detector = makeDetector();
            expect(detector._getStaleDevices(24 * 60 * 60 * 1000)).toEqual([]);
        });

        it('returns stale devices correctly', () => {
            const staleTs = NOW - 25 * 60 * 60 * 1000; // 25 hours ago
            deviceStateManager.getAllLastSeen.mockReturnValue(new Map([
                ['254/56/5', staleTs]
            ]));
            const detector = makeDetector();
            const result = detector._getStaleDevices(24 * 60 * 60 * 1000);

            expect(result).toHaveLength(1);
            expect(result[0].address).toBe('254/56/5');
            expect(result[0].hours_ago).toBe(25);
            expect(result[0].last_seen).toBe(new Date(staleTs).toISOString());
        });

        it('ignores devices never seen (no lastSeen entry)', () => {
            // getAllLastSeen only returns entries that exist — devices without an entry
            // never appear in the map, so they are implicitly excluded.
            deviceStateManager.getAllLastSeen.mockReturnValue(new Map());
            const detector = makeDetector();
            expect(detector._getStaleDevices(24 * 60 * 60 * 1000)).toEqual([]);
        });

        it('threshold respects stale_device_threshold_hours setting', () => {
            const ts = NOW - 2 * 60 * 60 * 1000; // 2 hours ago
            deviceStateManager.getAllLastSeen.mockReturnValue(new Map([
                ['254/56/3', ts]
            ]));
            const detector = makeDetector({ stale_device_threshold_hours: 1 });
            // threshold is 1 hour; device is 2 hours old → stale
            const result = detector._getStaleDevices(1 * 60 * 60 * 1000);
            expect(result).toHaveLength(1);
        });

        it('hours_ago is calculated correctly', () => {
            const staleTs = NOW - 30 * 60 * 60 * 1000; // exactly 30 hours ago
            deviceStateManager.getAllLastSeen.mockReturnValue(new Map([
                ['254/56/9', staleTs]
            ]));
            const detector = makeDetector();
            const result = detector._getStaleDevices(24 * 60 * 60 * 1000);
            expect(result[0].hours_ago).toBe(30);
        });

        it('resolves labels from labelLoader when available', () => {
            const staleTs = NOW - 25 * 60 * 60 * 1000;
            deviceStateManager.getAllLastSeen.mockReturnValue(new Map([
                ['254/56/5', staleTs]
            ]));
            labelLoader.getLabels.mockReturnValue(new Map([
                ['254/56/5', 'Office Light']
            ]));
            const detector = makeDetector();
            const result = detector._getStaleDevices(24 * 60 * 60 * 1000);
            expect(result[0].label).toBe('Office Light');
        });

        it('uses address as label when no label is set', () => {
            const staleTs = NOW - 25 * 60 * 60 * 1000;
            deviceStateManager.getAllLastSeen.mockReturnValue(new Map([
                ['254/56/5', staleTs]
            ]));
            labelLoader.getLabels.mockReturnValue(new Map()); // no labels
            const detector = makeDetector();
            const result = detector._getStaleDevices(24 * 60 * 60 * 1000);
            expect(result[0].label).toBe('254/56/5');
        });
    });

    // ── _publishStaleCount ────────────────────────────────────────────────────

    describe('_publishStaleCount', () => {
        it('publishes correct count to state topic', () => {
            const detector = makeDetector();
            detector._publishStaleCount(3, []);
            expect(publishFn).toHaveBeenCalledWith(
                'cbus/bridge/stale_devices',
                '3',
                { retain: true, qos: 0 }
            );
        });

        it('publishes zero count when no stale devices', () => {
            const detector = makeDetector();
            detector._publishStaleCount(0, []);
            expect(publishFn).toHaveBeenCalledWith(
                'cbus/bridge/stale_devices',
                '0',
                { retain: true, qos: 0 }
            );
        });

        it('publishes JSON attributes with stale device details', () => {
            const staleDevices = [
                { address: '254/56/5', label: 'Office Light', last_seen: '2026-03-28T10:00:00.000Z', hours_ago: 25 }
            ];
            const detector = makeDetector();
            detector._publishStaleCount(1, staleDevices);

            const attrCall = publishFn.mock.calls.find(c => c[0] === 'cbus/bridge/stale_devices_detail');
            expect(attrCall).toBeDefined();

            const payload = JSON.parse(attrCall[1]);
            expect(payload.stale_devices).toEqual(staleDevices);
            expect(payload.threshold_hours).toBe(24);
            expect(payload.checked_at).toBeDefined();
        });
    });

    // ── _publishDiscovery ─────────────────────────────────────────────────────

    describe('_publishDiscovery', () => {
        it('publishes to correct discovery topic', () => {
            const detector = makeDetector();
            detector._publishDiscovery();
            expect(publishFn).toHaveBeenCalledWith(
                'homeassistant/sensor/cgateweb_stale_devices/config',
                expect.any(String),
                { retain: true, qos: 0 }
            );
        });

        it('discovery payload has correct component fields', () => {
            const detector = makeDetector();
            detector._publishDiscovery();

            const call = publishFn.mock.calls.find(c => c[0].includes('/config'));
            const payload = JSON.parse(call[1]);

            expect(payload.unique_id).toBe('cgateweb_stale_devices');
            expect(payload.state_topic).toBe('cbus/bridge/stale_devices');
            expect(payload.json_attributes_topic).toBe('cbus/bridge/stale_devices_detail');
            expect(payload.unit_of_measurement).toBe('devices');
        });

        it('discovery payload uses configured ha_discovery_prefix', () => {
            const detector = makeDetector({ ha_discovery_prefix: 'custom_prefix' });
            detector._publishDiscovery();
            expect(publishFn).toHaveBeenCalledWith(
                'custom_prefix/sensor/cgateweb_stale_devices/config',
                expect.any(String),
                expect.any(Object)
            );
        });

        it('discovery payload has correct device block', () => {
            const detector = makeDetector();
            detector._publishDiscovery();

            const call = publishFn.mock.calls.find(c => c[0].includes('/config'));
            const payload = JSON.parse(call[1]);

            expect(payload.device.identifiers).toContain('cgateweb_bridge');
        });
    });

    // ── start / stop / timer ──────────────────────────────────────────────────

    describe('start', () => {
        it('publishes discovery on start', () => {
            const detector = makeDetector();
            detector.start();
            detector.stop();

            const discoveryCall = publishFn.mock.calls.find(
                c => c[0].includes('/config')
            );
            expect(discoveryCall).toBeDefined();
        });

        it('runs an immediate check on start', () => {
            deviceStateManager.getAllLastSeen.mockReturnValue(new Map());
            const detector = makeDetector();
            detector.start();
            detector.stop();

            // Immediate check should publish state + attributes
            expect(publishFn).toHaveBeenCalledWith(
                'cbus/bridge/stale_devices',
                '0',
                expect.any(Object)
            );
        });

        it('does not start when stale_device_detection_enabled is false', () => {
            const detector = makeDetector({ stale_device_detection_enabled: false });
            detector.start();

            expect(publishFn).not.toHaveBeenCalled();
        });
    });

    describe('stop', () => {
        it('clears the timer so no further checks fire', () => {
            deviceStateManager.getAllLastSeen.mockReturnValue(new Map());
            const detector = makeDetector({ stale_device_check_interval_sec: 10 });
            detector.start();
            publishFn.mockClear();

            detector.stop();
            jest.advanceTimersByTime(30000); // 3 × interval

            // No additional publishes after stop
            expect(publishFn).not.toHaveBeenCalled();
        });
    });

    describe('timer fires _check at configured interval', () => {
        it('fires check after each interval', () => {
            deviceStateManager.getAllLastSeen.mockReturnValue(new Map());
            const detector = makeDetector({ stale_device_check_interval_sec: 60 });
            detector.start();
            publishFn.mockClear(); // ignore immediate check

            jest.advanceTimersByTime(60000);
            expect(publishFn).toHaveBeenCalledWith(
                'cbus/bridge/stale_devices',
                '0',
                expect.any(Object)
            );

            publishFn.mockClear();
            jest.advanceTimersByTime(60000);
            expect(publishFn).toHaveBeenCalledWith(
                'cbus/bridge/stale_devices',
                '0',
                expect.any(Object)
            );

            detector.stop();
        });
    });
});
