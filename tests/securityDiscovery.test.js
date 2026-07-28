const HaDiscovery = require('../src/haDiscovery');

describe('HaDiscovery — app 208 security zones', () => {
    let publishFn;
    let d;

    beforeEach(() => {
        publishFn = jest.fn();
        d = new HaDiscovery(
            { ha_discovery_enabled: true, ha_discovery_prefix: 'homeassistant', cbus_security_app_id: '208' },
            publishFn,
            jest.fn()
        );
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => jest.restoreAllMocks());

    it('publishes a binary_sensor pointing at the zone state and attributes topics', () => {
        expect(d.ensureSecurityZoneDiscovery('254', '208', '35')).toBe(true);
        const call = publishFn.mock.calls.find(c => c[0] === 'homeassistant/binary_sensor/cgateweb_254_208_35/config');
        expect(call).toBeDefined();
        const payload = JSON.parse(call[1]);
        expect(payload.state_topic).toBe('cbus/read/254/208/35/state');
        expect(payload.payload_on).toBe('ON');
        expect(payload.payload_off).toBe('OFF');
        expect(payload.json_attributes_topic).toBe('cbus/read/254/208/35/attributes');
        expect(payload.unique_id).toBe('cgateweb_254_208_35');
        expect(payload.device.name).toBe('CBus Security Zone 254/208/35');
        expect(payload.device.model).toBe('C-Bus Security Zone');
        // No keyword in the fallback name → no device_class key at all
        expect('device_class' in payload).toBe(false);
    });

    it('uses the application-1 zone label as the name and infers the device class from it', () => {
        const labelled = new HaDiscovery(
            { ha_discovery_enabled: true, ha_discovery_prefix: 'homeassistant', cbus_security_app_id: '208' },
            publishFn,
            jest.fn(),
            { labels: new Map([['254/1/35', 'Front Door']]) }
        );
        labelled.ensureSecurityZoneDiscovery('254', '208', '35');
        const call = publishFn.mock.calls.find(c => c[0] === 'homeassistant/binary_sensor/cgateweb_254_208_35/config');
        const payload = JSON.parse(call[1]);
        expect(payload.device.name).toBe('Front Door');
        expect(payload.device_class).toBe('door');
    });

    it('maps PIR/motion, garage, window and smoke labels to device classes', () => {
        const cases = [
            ['254/1/1', 'Garage PIR', 'motion', 1],
            ['254/1/2', 'Living Room Motion Sensor', 'motion', 2],
            ['254/1/3', 'Garage Door', 'garage_door', 3],
            ['254/1/4', 'Kitchen Window', 'window', 4],
            ['254/1/5', 'Hallway Smoke Detector', 'smoke', 5],
            ['254/1/6', 'Group6', undefined, 6]
        ];
        const labelled = new HaDiscovery(
            { ha_discovery_enabled: true, ha_discovery_prefix: 'homeassistant', cbus_security_app_id: '208' },
            publishFn,
            jest.fn(),
            { labels: new Map(cases.map(([key, label]) => [key, label])) }
        );
        for (const [, , , zone] of cases) {
            labelled.ensureSecurityZoneDiscovery('254', '208', String(zone));
        }
        for (const [, , deviceClass, zone] of cases) {
            const call = publishFn.mock.calls.find(c => c[0] === `homeassistant/binary_sensor/cgateweb_254_208_${zone}/config`);
            const payload = JSON.parse(call[1]);
            if (deviceClass) expect(payload.device_class).toBe(deviceClass);
            else expect('device_class' in payload).toBe(false);
        }
    });

    it('honours a device-class keyword override map from settings', () => {
        const custom = new HaDiscovery(
            {
                ha_discovery_enabled: true,
                ha_discovery_prefix: 'homeassistant',
                cbus_security_app_id: '208',
                ha_discovery_security_device_class_keywords: { reed: 'door' }
            },
            publishFn,
            jest.fn(),
            { labels: new Map([['254/1/7', 'Patio Reed Switch'], ['254/1/8', 'Front Door']]) }
        );
        custom.ensureSecurityZoneDiscovery('254', '208', '7');
        custom.ensureSecurityZoneDiscovery('254', '208', '8');
        const reed = JSON.parse(publishFn.mock.calls.find(c => c[0] === 'homeassistant/binary_sensor/cgateweb_254_208_7/config')[1]);
        const door = JSON.parse(publishFn.mock.calls.find(c => c[0] === 'homeassistant/binary_sensor/cgateweb_254_208_8/config')[1]);
        expect(reed.device_class).toBe('door');
        // The override map replaces the default, so the built-in 'door' keyword no longer applies
        expect('device_class' in door).toBe(false);
    });

    it('is idempotent per zone, and independent across zones', () => {
        expect(d.ensureSecurityZoneDiscovery('254', '208', '35')).toBe(true);
        expect(d.ensureSecurityZoneDiscovery('254', '208', '35')).toBe(false);
        expect(d.ensureSecurityZoneDiscovery('254', '208', '36')).toBe(true);
        const configCalls = publishFn.mock.calls.filter(c => c[0] === 'homeassistant/binary_sensor/cgateweb_254_208_35/config');
        expect(configCalls).toHaveLength(1);
    });

    it('does nothing when HA discovery is disabled', () => {
        const off = new HaDiscovery({ ha_discovery_enabled: false, ha_discovery_prefix: 'homeassistant' }, publishFn, jest.fn());
        expect(off.ensureSecurityZoneDiscovery('254', '208', '35')).toBe(false);
        expect(publishFn).not.toHaveBeenCalled();
    });

    it('clears a previously published entity when the zone is excluded (either key shape)', () => {
        for (const excludeKey of ['254/208/35', '254/1/35']) {
            publishFn.mockClear();
            const excluded = new HaDiscovery(
                { ha_discovery_enabled: true, ha_discovery_prefix: 'homeassistant', cbus_security_app_id: '208' },
                publishFn,
                jest.fn(),
                { exclude: new Set([excludeKey]) }
            );
            expect(excluded.ensureSecurityZoneDiscovery('254', '208', '35')).toBe(false);
            const call = publishFn.mock.calls.find(c => c[0] === 'homeassistant/binary_sensor/cgateweb_254_208_35/config');
            expect(call).toBeDefined();
            expect(call[1]).toBe(''); // empty retained payload removes the entity
            // …and it stays quiet on subsequent events
            expect(excluded.ensureSecurityZoneDiscovery('254', '208', '35')).toBe(false);
            expect(publishFn.mock.calls.filter(c => c[0] === 'homeassistant/binary_sensor/cgateweb_254_208_35/config')).toHaveLength(1);
        }
    });

    it('registers the topic as event-driven so tree-run stale cleanup skips it', () => {
        d.ensureSecurityZoneDiscovery('254', '208', '35');
        const topic = 'homeassistant/binary_sensor/cgateweb_254_208_35/config';
        expect(d._publishedTopics.has(topic)).toBe(true);
        expect(d._eventDrivenDiscoveryTopics.has(topic)).toBe(true);
    });

    describe('label-driven startup discovery (_supplementSecurityZonesFromLabels)', () => {
        function makeWithLabels(labels, settings = {}) {
            const hd = new HaDiscovery(
                { ha_discovery_enabled: true, ha_discovery_prefix: 'homeassistant', cbus_security_app_id: '208', ...settings },
                publishFn,
                jest.fn(),
                { labels }
            );
            // Mirror the per-run snapshot _publishDiscoveryFromTree installs.
            hd._labelSnapshot = { labelMap: hd.labelMap, typeOverrides: hd.typeOverrides, entityIds: hd.entityIds, exclude: hd.exclude, areas: hd.areas };
            return hd;
        }

        it('announces one binary_sensor per application-1 zone label, keyed on app 208', () => {
            const hd = makeWithLabels(new Map([
                ['254/1/35', 'Front Door'],
                ['254/1/36', 'Back Window'],
                ['254/56/4', 'Kitchen Light'], // lighting label — not a zone
                ['255/1/12', 'Other Network Zone'] // different network
            ]));
            hd._supplementSecurityZonesFromLabels('254');
            const topics = publishFn.mock.calls.map(c => c[0]);
            expect(topics).toContain('homeassistant/binary_sensor/cgateweb_254_208_35/config');
            expect(topics).toContain('homeassistant/binary_sensor/cgateweb_254_208_36/config');
            expect(topics).not.toContain('homeassistant/binary_sensor/cgateweb_254_208_4/config');
            expect(topics).not.toContain('homeassistant/binary_sensor/cgateweb_255_208_12/config');
            const payload = JSON.parse(publishFn.mock.calls.find(c => c[0] === 'homeassistant/binary_sensor/cgateweb_254_208_35/config')[1]);
            expect(payload.device.name).toBe('Front Door');
            expect(payload.device_class).toBe('door');
        });

        it('does nothing when the security app is disabled', () => {
            const hd = makeWithLabels(new Map([['254/1/35', 'Front Door']]), { cbus_security_app_id: '0' });
            hd._supplementSecurityZonesFromLabels('254');
            expect(publishFn).not.toHaveBeenCalled();
        });

        it('does nothing without labels', () => {
            const hd = makeWithLabels(new Map());
            hd._supplementSecurityZonesFromLabels('254');
            expect(publishFn).not.toHaveBeenCalled();
        });
    });

    describe('status re-request after network sync (762)', () => {
        it('sends status_request 1 and 2 on handleNetworkSyncComplete when the security app is enabled', () => {
            const sendCommand = jest.fn();
            const hd = new HaDiscovery(
                {
                    ha_discovery_enabled: true,
                    ha_discovery_prefix: 'homeassistant',
                    ha_discovery_networks: ['254'],
                    cbus_security_app_id: '208',
                    cbusname: 'MIDSTRM'
                },
                publishFn,
                sendCommand
            );
            hd.handleNetworkSyncComplete('254');
            const syncCommands = sendCommand.mock.calls
                .map(c => c[0])
                .filter(cmd => typeof cmd === 'string' && cmd.startsWith('security status_request'));
            expect(syncCommands).toEqual([
                'security status_request //MIDSTRM/254/208 1\n',
                'security status_request //MIDSTRM/254/208 2\n'
            ]);
        });

        it('sends nothing on sync complete when the security app is disabled', () => {
            const sendCommand = jest.fn();
            const hd = new HaDiscovery(
                {
                    ha_discovery_enabled: true,
                    ha_discovery_prefix: 'homeassistant',
                    ha_discovery_networks: ['254'],
                    cbus_security_app_id: '0',
                    cbusname: 'MIDSTRM'
                },
                publishFn,
                sendCommand
            );
            hd.handleNetworkSyncComplete('254');
            const syncCommands = sendCommand.mock.calls
                .map(c => c[0])
                .filter(cmd => typeof cmd === 'string' && cmd.startsWith('security status_request'));
            expect(syncCommands).toEqual([]);
        });
    });
});
