const HaDiscovery = require('../src/haDiscovery');

describe('HaDiscovery — CNI connectivity binary_sensor', () => {
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

    it('publishes a connectivity binary_sensor pointing at the cni state topic', () => {
        expect(d.ensureNetworkConnectivityDiscovery('254')).toBe(true);
        const call = publishFn.mock.calls.find(c => c[0] === 'homeassistant/binary_sensor/cgateweb_254_cni/config');
        expect(call).toBeDefined();
        const payload = JSON.parse(call[1]);
        expect(payload.device_class).toBe('connectivity');
        expect(payload.state_topic).toBe('cbus/read/254/cni/state');
        expect(payload.payload_on).toBe('ON');
        expect(payload.payload_off).toBe('OFF');
        expect(payload.unique_id).toBe('cgateweb_254_cni');
        expect(payload.device.name).toBe('C-Bus Network 254');
    });

    it('is idempotent per network', () => {
        expect(d.ensureNetworkConnectivityDiscovery('254')).toBe(true);
        expect(d.ensureNetworkConnectivityDiscovery('254')).toBe(false);
        const configCalls = publishFn.mock.calls.filter(c => c[0] === 'homeassistant/binary_sensor/cgateweb_254_cni/config');
        expect(configCalls).toHaveLength(1);
    });

    it('does nothing when HA discovery is disabled', () => {
        const off = new HaDiscovery({ ha_discovery_enabled: false, ha_discovery_prefix: 'homeassistant' }, publishFn, jest.fn());
        expect(off.ensureNetworkConnectivityDiscovery('254')).toBe(false);
        expect(publishFn).not.toHaveBeenCalled();
    });
});
