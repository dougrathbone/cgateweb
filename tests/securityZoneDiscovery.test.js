const HaDiscovery = require('../src/haDiscovery');

describe('HaDiscovery — security loop fault and zone names', () => {
    it('publishes a diagnostic loop-fault sensor on the zone device', () => {
        const publishFn = jest.fn();
        const d = new HaDiscovery(
            { ha_discovery_enabled: true, ha_discovery_prefix: 'homeassistant', cbus_security_app_id: '208' },
            publishFn,
            jest.fn()
        );
        d.ensureSecurityZoneDiscovery('254', '208', '35');
        const call = publishFn.mock.calls.find(
            (c) => c[0] === 'homeassistant/binary_sensor/cgateweb_254_208_35_loop_fault/config'
        );
        expect(call).toBeDefined();
        const payload = JSON.parse(call[1]);
        expect(payload.state_topic).toBe('cbus/read/254/208/35/loop_fault');
        expect(payload.device_class).toBe('problem');
        expect(payload.entity_category).toBe('diagnostic');
        expect(payload.device.identifiers).toEqual(['cgateweb_254_208_35']);
    });

    it('applies a C-Gate zone name only when Toolkit did not already label it', () => {
        const publishFn = jest.fn();
        const d = new HaDiscovery(
            { ha_discovery_enabled: true, ha_discovery_prefix: 'homeassistant', cbus_security_app_id: '208' },
            publishFn,
            jest.fn(),
            { labels: new Map() }
        );
        expect(d.applySecurityZoneName('254', '12', 'Front Door')).toBe(true);
        expect(d.labelMap.get('254/1/12')).toBe('Front Door');
        expect(d.applySecurityZoneName('254', '12', 'Other')).toBe(false);
        expect(d.labelMap.get('254/1/12')).toBe('Front Door');
    });
});
