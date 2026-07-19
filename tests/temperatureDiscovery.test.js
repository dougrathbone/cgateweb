const HaDiscovery = require('../src/haDiscovery');

describe('HaDiscovery — app 25 temperature sensors', () => {
    let publishFn;
    let d;

    beforeEach(() => {
        publishFn = jest.fn();
        d = new HaDiscovery(
            { ha_discovery_enabled: true, ha_discovery_prefix: 'homeassistant' },
            publishFn,
            jest.fn()
        );
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => jest.restoreAllMocks());

    it('publishes a temperature sensor pointing at the current_temperature topic', () => {
        expect(d.ensureTemperatureDiscovery('254', '25', '3')).toBe(true);
        const call = publishFn.mock.calls.find(c => c[0] === 'homeassistant/sensor/cgateweb_254_25_3/config');
        expect(call).toBeDefined();
        const payload = JSON.parse(call[1]);
        expect(payload.device_class).toBe('temperature');
        expect(payload.state_class).toBe('measurement');
        expect(payload.unit_of_measurement).toBe('°C');
        expect(payload.state_topic).toBe('cbus/read/254/25/3/current_temperature');
        expect(payload.unique_id).toBe('cgateweb_254_25_3');
        expect(payload.device.name).toBe('CBus Temperature 254/25/3');
    });

    it('uses the custom label when one is configured for the group', () => {
        const labelled = new HaDiscovery(
            { ha_discovery_enabled: true, ha_discovery_prefix: 'homeassistant' },
            publishFn,
            jest.fn(),
            { labels: new Map([['254/25/3', 'Living Room Temperature']]) }
        );
        labelled.ensureTemperatureDiscovery('254', '25', '3');
        const call = publishFn.mock.calls.find(c => c[0] === 'homeassistant/sensor/cgateweb_254_25_3/config');
        const payload = JSON.parse(call[1]);
        expect(payload.device.name).toBe('Living Room Temperature');
    });

    it('is idempotent per group, and independent across groups', () => {
        expect(d.ensureTemperatureDiscovery('254', '25', '3')).toBe(true);
        expect(d.ensureTemperatureDiscovery('254', '25', '3')).toBe(false);
        expect(d.ensureTemperatureDiscovery('254', '25', '4')).toBe(true);
        const configCalls = publishFn.mock.calls.filter(c => c[0] === 'homeassistant/sensor/cgateweb_254_25_3/config');
        expect(configCalls).toHaveLength(1);
    });

    it('does nothing when HA discovery is disabled', () => {
        const off = new HaDiscovery({ ha_discovery_enabled: false, ha_discovery_prefix: 'homeassistant' }, publishFn, jest.fn());
        expect(off.ensureTemperatureDiscovery('254', '25', '3')).toBe(false);
        expect(publishFn).not.toHaveBeenCalled();
    });

    it('clears a previously published entity when the group is excluded', () => {
        const excluded = new HaDiscovery(
            { ha_discovery_enabled: true, ha_discovery_prefix: 'homeassistant' },
            publishFn,
            jest.fn(),
            { exclude: new Set(['254/25/3']) }
        );
        expect(excluded.ensureTemperatureDiscovery('254', '25', '3')).toBe(false);
        const call = publishFn.mock.calls.find(c => c[0] === 'homeassistant/sensor/cgateweb_254_25_3/config');
        expect(call).toBeDefined();
        expect(call[1]).toBe(''); // empty retained payload removes the entity
        // …and it stays quiet on subsequent events
        expect(excluded.ensureTemperatureDiscovery('254', '25', '3')).toBe(false);
        expect(publishFn.mock.calls.filter(c => c[0] === 'homeassistant/sensor/cgateweb_254_25_3/config')).toHaveLength(1);
    });
});
