const HaDiscovery = require('../src/haDiscovery');

describe('HaDiscovery — app 228 measurement sensors', () => {
    let publishFn;
    let d;

    const reading = { unit: 'W', deviceClass: 'power' };

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

    it('publishes a measurement sensor pointing at the value topic, with unit/device_class from the reading', () => {
        expect(d.ensureMeasurementDiscovery('254', '228', '0', '0', reading)).toBe(true);
        const call = publishFn.mock.calls.find(c => c[0] === 'homeassistant/sensor/cgateweb_254_228_0_0/config');
        expect(call).toBeDefined();
        const payload = JSON.parse(call[1]);
        expect(payload.device_class).toBe('power');
        expect(payload.state_class).toBe('measurement');
        expect(payload.unit_of_measurement).toBe('W');
        expect(payload.state_topic).toBe('cbus/read/254/228/0/0/value');
        expect(payload.unique_id).toBe('cgateweb_254_228_0_0');
        expect(payload.device.name).toBe('CBus Measurement 254/228/0/0');
    });

    it('omits device_class/unit_of_measurement for a unitless reading', () => {
        d.ensureMeasurementDiscovery('254', '228', '1', '0', { unit: null, deviceClass: null });
        const call = publishFn.mock.calls.find(c => c[0] === 'homeassistant/sensor/cgateweb_254_228_1_0/config');
        const payload = JSON.parse(call[1]);
        expect(payload.device_class).toBeUndefined();
        expect(payload.unit_of_measurement).toBeUndefined();
    });

    it('is idempotent per device/channel, and independent across channels of the same device', () => {
        expect(d.ensureMeasurementDiscovery('254', '228', '0', '0', reading)).toBe(true);
        expect(d.ensureMeasurementDiscovery('254', '228', '0', '0', reading)).toBe(false);
        expect(d.ensureMeasurementDiscovery('254', '228', '0', '1', reading)).toBe(true);
        const configCalls = publishFn.mock.calls.filter(c => c[0] === 'homeassistant/sensor/cgateweb_254_228_0_0/config');
        expect(configCalls).toHaveLength(1);
    });

    it('does not collide across different devices sharing the same channel number', () => {
        expect(d.ensureMeasurementDiscovery('254', '228', '0', '0', reading)).toBe(true);
        expect(d.ensureMeasurementDiscovery('254', '228', '1', '0', reading)).toBe(true);
        const uniqueIds = publishFn.mock.calls
            .filter(c => c[0].startsWith('homeassistant/sensor/'))
            .map(c => JSON.parse(c[1]).unique_id);
        expect(new Set(uniqueIds).size).toBe(uniqueIds.length);
    });

    it('does nothing when HA discovery is disabled', () => {
        const off = new HaDiscovery({ ha_discovery_enabled: false, ha_discovery_prefix: 'homeassistant' }, publishFn, jest.fn());
        expect(off.ensureMeasurementDiscovery('254', '228', '0', '0', reading)).toBe(false);
        expect(publishFn).not.toHaveBeenCalled();
    });

    it('uses the custom label when one is configured for the channel', () => {
        const labelled = new HaDiscovery(
            { ha_discovery_enabled: true, ha_discovery_prefix: 'homeassistant' },
            publishFn,
            jest.fn(),
            { labels: new Map([['254/228/0/0', 'Solar Inverter Power']]) }
        );
        labelled.ensureMeasurementDiscovery('254', '228', '0', '0', reading);
        const call = publishFn.mock.calls.find(c => c[0] === 'homeassistant/sensor/cgateweb_254_228_0_0/config');
        const payload = JSON.parse(call[1]);
        expect(payload.device.name).toBe('Solar Inverter Power');
    });

    it('clears a previously published entity when the channel is excluded', () => {
        const excluded = new HaDiscovery(
            { ha_discovery_enabled: true, ha_discovery_prefix: 'homeassistant' },
            publishFn,
            jest.fn(),
            { exclude: new Set(['254/228/0/0']) }
        );
        expect(excluded.ensureMeasurementDiscovery('254', '228', '0', '0', reading)).toBe(false);
        const call = publishFn.mock.calls.find(c => c[0] === 'homeassistant/sensor/cgateweb_254_228_0_0/config');
        expect(call).toBeDefined();
        expect(call[1]).toBe(''); // empty retained payload removes the entity
        expect(excluded.ensureMeasurementDiscovery('254', '228', '0', '0', reading)).toBe(false);
        expect(publishFn.mock.calls.filter(c => c[0] === 'homeassistant/sensor/cgateweb_254_228_0_0/config')).toHaveLength(1);
    });
});
