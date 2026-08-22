const HaDiscovery = require('../src/haDiscovery');

describe('HaDiscovery — unlisted live groups (#63)', () => {
    let publishFn;
    let d;

    beforeEach(() => {
        publishFn = jest.fn();
        d = new HaDiscovery(
            {
                ha_discovery_enabled: true,
                ha_discovery_prefix: 'homeassistant',
                ha_discovery_unlisted_groups: true
            },
            publishFn,
            jest.fn()
        );
    });

    it('is off by default', () => {
        const off = new HaDiscovery(
            { ha_discovery_enabled: true, ha_discovery_prefix: 'homeassistant' },
            publishFn,
            jest.fn()
        );
        expect(off.ensureUnlistedGroupDiscovery('254', '56', '251')).toBe(false);
        expect(publishFn).not.toHaveBeenCalled();
    });

    it('publishes a lighting entity the first time an unlisted group is seen', () => {
        expect(d.ensureUnlistedGroupDiscovery('254', '56', '251')).toBe(true);
        const call = publishFn.mock.calls.find(
            (c) => c[0] === 'homeassistant/light/cgateweb_254_56_251/config'
        );
        expect(call).toBeDefined();
        expect(d.ensureUnlistedGroupDiscovery('254', '56', '251')).toBe(false);
    });

    it('honours the exclude list', () => {
        d.exclude.add('254/56/251');
        expect(d.ensureUnlistedGroupDiscovery('254', '56', '251')).toBe(false);
        expect(publishFn.mock.calls.some((c) => c[1])).toBe(false);
    });

    it('skips applications that are not lighting-style', () => {
        expect(d.ensureUnlistedGroupDiscovery('254', '208', '1')).toBe(false);
        expect(publishFn).not.toHaveBeenCalled();
    });

    it('publishes a PIR binary_sensor when that application is configured', () => {
        d.settings.ha_discovery_pir_app_id = '8';
        expect(d.ensureUnlistedGroupDiscovery('254', '8', '12')).toBe(true);
        const call = publishFn.mock.calls.find(
            (c) => c[0] === 'homeassistant/binary_sensor/cgateweb_254_8_12/config'
        );
        expect(call).toBeDefined();
    });
});
