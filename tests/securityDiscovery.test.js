const HaDiscovery = require('../src/haDiscovery');
const { securityZoneLabelKey, parseSecurityZoneLabelKey } = require('../src/securityZoneLabels');

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

        it('skips malformed app-1 label keys instead of announcing bogus entities', () => {
            const hd = makeWithLabels(new Map([
                ['254/1/FrontDoor', 'Not A Zone Key'],
                ['254/1/0', 'Zone Zero'],
                ['254/1/200', 'Out Of Range'],
                ['254/1/35', 'Front Door']
            ]));
            hd._supplementSecurityZonesFromLabels('254');
            const topics = publishFn.mock.calls.map(c => c[0]);
            expect(topics).toContain('homeassistant/binary_sensor/cgateweb_254_208_35/config');
            expect(topics).not.toContain('homeassistant/binary_sensor/cgateweb_254_208_FrontDoor/config');
            expect(topics).not.toContain('homeassistant/binary_sensor/cgateweb_254_208_0/config');
            expect(topics).not.toContain('homeassistant/binary_sensor/cgateweb_254_208_200/config');
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

    describe('label rename republish (updateLabels)', () => {
        function makeSecurityDiscovery(labels, settings = {}) {
            return new HaDiscovery(
                { ha_discovery_enabled: true, ha_discovery_prefix: 'homeassistant', cbus_security_app_id: '208', ...settings },
                publishFn,
                jest.fn(),
                { labels }
            );
        }

        it('republishes the zone config with the new name and device class when its app-1 label changes', () => {
            const hd = makeSecurityDiscovery(new Map([['254/1/35', 'Group 35']]));
            hd.ensureSecurityZoneDiscovery('254', '208', '35'); // announced as "Group 35"
            publishFn.mockClear();

            hd.updateLabels({ labels: new Map([['254/1/35', 'Front Door']]) });

            const calls = publishFn.mock.calls.filter(c => c[0] === 'homeassistant/binary_sensor/cgateweb_254_208_35/config');
            expect(calls).toHaveLength(1);
            const payload = JSON.parse(calls[0][1]);
            expect(payload.device.name).toBe('Front Door');
            expect(payload.device_class).toBe('door');
            expect(payload.unique_id).toBe('cgateweb_254_208_35'); // unchanged → HA updates in place
        });

        it('does not republish when the label is unchanged', () => {
            const hd = makeSecurityDiscovery(new Map([['254/1/35', 'Front Door']]));
            hd.ensureSecurityZoneDiscovery('254', '208', '35');
            publishFn.mockClear();

            hd.updateLabels({ labels: new Map([['254/1/35', 'Front Door']]) });

            expect(publishFn).not.toHaveBeenCalled();
        });

        it('names a zone that was announced with a fallback name once a label first appears', () => {
            const hd = makeSecurityDiscovery(new Map());
            hd.ensureSecurityZoneDiscovery('254', '208', '35'); // fallback "CBus Security Zone …"
            publishFn.mockClear();

            hd.updateLabels({ labels: new Map([['254/1/35', 'Garage PIR']]) });

            const call = publishFn.mock.calls.find(c => c[0] === 'homeassistant/binary_sensor/cgateweb_254_208_35/config');
            expect(call).toBeDefined();
            const payload = JSON.parse(call[1]);
            expect(payload.device.name).toBe('Garage PIR');
            expect(payload.device_class).toBe('motion');
        });

        it('clears the Seen key for a removed label so the next zone event re-announces', () => {
            const hd = makeSecurityDiscovery(new Map([['254/1/35', 'Front Door']]));
            hd.ensureSecurityZoneDiscovery('254', '208', '35');
            publishFn.mockClear();

            hd.updateLabels({ labels: new Map() }); // label removed — no immediate republish
            expect(publishFn).not.toHaveBeenCalled();
            // …but the zone is no longer "seen", so its next event re-announces
            expect(hd.ensureSecurityZoneDiscovery('254', '208', '35')).toBe(true);
        });

        it('does nothing when the security app is disabled', () => {
            const hd = makeSecurityDiscovery(new Map([['254/1/35', 'Group 35']]), { cbus_security_app_id: '0' });
            publishFn.mockClear();
            hd.updateLabels({ labels: new Map([['254/1/35', 'Front Door']]) });
            expect(publishFn).not.toHaveBeenCalled();
        });
    });

    describe('panel trouble sensors', () => {
        const CONDITIONS = ['mains', 'battery', 'tamper', 'panic', 'line', 'arm_failed', 'fire', 'gas', 'other_alarm'];

        function panelPayloads() {
            return publishFn.mock.calls
                .filter(c => c[0].includes('_208_panel_'))
                .map(c => ({ topic: c[0], payload: c[1] ? JSON.parse(c[1]) : null }));
        }

        function payloadFor(condition) {
            const found = panelPayloads().find(p => p.topic.endsWith(`_panel_${condition}/config`));
            return found && found.payload;
        }

        it('publishes one binary_sensor per condition', () => {
            expect(d.ensureSecurityPanelDiscovery('254', '208')).toBe(true);
            expect(panelPayloads()).toHaveLength(CONDITIONS.length);
            for (const condition of CONDITIONS) {
                expect(payloadFor(condition)).toBeDefined();
            }
        });

        it('groups them all on one shared panel device as diagnostics', () => {
            d.ensureSecurityPanelDiscovery('254', '208');
            for (const condition of CONDITIONS) {
                const payload = payloadFor(condition);
                expect(payload.entity_category).toBe('diagnostic');
                expect(payload.device.identifiers).toEqual(['cgateweb_254_208_panel']);
                expect(payload.device.name).toBe('C-Bus Security Panel 254/208');
                expect(payload.device.model).toBe('C-Bus Security Panel');
            }
        });

        it('points each sensor at its own panel state topic', () => {
            d.ensureSecurityPanelDiscovery('254', '208');
            const mains = payloadFor('mains');
            expect(mains.state_topic).toBe('cbus/read/254/208/panel/mains/state');
            expect(mains.unique_id).toBe('cgateweb_254_208_panel_mains');
            expect(mains.payload_on).toBe('ON');
            expect(mains.payload_off).toBe('OFF');
            expect(mains.name).toBe('Mains power');
        });

        it('assigns the agreed device classes', () => {
            d.ensureSecurityPanelDiscovery('254', '208');
            expect(payloadFor('mains').device_class).toBe('problem');
            expect(payloadFor('battery').device_class).toBe('battery');
            expect(payloadFor('tamper').device_class).toBe('tamper');
            expect(payloadFor('panic').device_class).toBe('safety');
            expect(payloadFor('line').device_class).toBe('problem');
            expect(payloadFor('arm_failed').device_class).toBe('problem');
            expect(payloadFor('fire').device_class).toBe('smoke');
        });

        it('is idempotent', () => {
            expect(d.ensureSecurityPanelDiscovery('254', '208')).toBe(true);
            publishFn.mockClear();
            expect(d.ensureSecurityPanelDiscovery('254', '208')).toBe(false);
            expect(publishFn).not.toHaveBeenCalled();
        });

        it('retracts every condition and skips an excluded panel', () => {
            d.exclude.add('254/208/panel');
            expect(d.ensureSecurityPanelDiscovery('254', '208')).toBe(false);
            const retracted = panelPayloads().filter(p => p.payload === null);
            expect(retracted).toHaveLength(CONDITIONS.length);
        });

        it('publishes nothing when HA discovery is disabled', () => {
            const off = new HaDiscovery(
                { ha_discovery_enabled: false, ha_discovery_prefix: 'homeassistant', cbus_security_app_id: '208' },
                publishFn,
                jest.fn()
            );
            publishFn.mockClear();
            expect(off.ensureSecurityPanelDiscovery('254', '208')).toBe(false);
            expect(publishFn).not.toHaveBeenCalled();
        });
    });

    describe('alarm_control_panel entity', () => {
        const ALARM_TOPIC = 'homeassistant/alarm_control_panel/cgateweb_254_208_panel/config';

        function alarmPayload() {
            const call = publishFn.mock.calls.find(c => c[0] === ALARM_TOPIC);
            return call && JSON.parse(call[1]);
        }

        it('publishes the alarm panel on the shared device, read-only by default', () => {
            d.ensureSecurityPanelDiscovery('254', '208');
            const payload = alarmPayload();
            expect(payload).toBeDefined();
            expect(payload.unique_id).toBe('cgateweb_254_208_panel');
            expect(payload.name).toBeNull(); // primary entity takes the device name
            expect(payload.state_topic).toBe('cbus/read/254/208/panel/state');
            expect(payload.json_attributes_topic).toBe('cbus/read/254/208/panel/attributes');
            // arm_custom_bypass is absent here on purpose: it maps to the '#'
            // force-arm keypress, which needs cbus_security_bypass_enabled.
            expect(payload.supported_features).toEqual(['arm_home', 'arm_away', 'arm_night', 'arm_vacation']);
            expect(payload.device.identifiers).toEqual(['cgateweb_254_208_panel']);
            expect(payload.device.name).toBe('C-Bus Security Panel 254/208');
            expect('command_topic' in payload).toBe(false);
        });

        it('adds the command topic when security control is enabled', () => {
            const controlled = new HaDiscovery(
                {
                    ha_discovery_enabled: true,
                    ha_discovery_prefix: 'homeassistant',
                    cbus_security_app_id: '208',
                    cbus_security_control_enabled: true
                },
                publishFn,
                jest.fn()
            );
            controlled.ensureSecurityPanelDiscovery('254', '208');
            expect(alarmPayload().command_topic).toBe('cbus/write/254/208/panel/arm');
        });

        describe('zone bypass button (#42)', () => {
            const BYPASS_TOPIC = 'homeassistant/button/cgateweb_254_208_panel_bypass/config';

            function bypassPayload() {
                const call = publishFn.mock.calls.find(c => c[0] === BYPASS_TOPIC);
                return call && JSON.parse(call[1]);
            }

            function panelWith({ control = false, bypass = false } = {}) {
                return new HaDiscovery(
                    {
                        ha_discovery_enabled: true,
                        ha_discovery_prefix: 'homeassistant',
                        cbus_security_app_id: '208',
                        cbus_security_control_enabled: control,
                        cbus_security_bypass_enabled: bypass
                    },
                    publishFn,
                    jest.fn()
                );
            }

            it('publishes no bypass button while control is disabled (the button could never work)', () => {
                d.ensureSecurityPanelDiscovery('254', '208');
                expect(bypassPayload()).toBeUndefined();
            });

            // Both entity and card action are withheld rather than published
            // and then refused, so Home Assistant never shows a control that
            // does nothing.
            it('publishes no bypass button when control is on but bypass is not', () => {
                panelWith({ control: true }).ensureSecurityPanelDiscovery('254', '208');
                expect(bypassPayload()).toBeUndefined();
            });

            it('withholds arm_custom_bypass from the alarm card unless bypass is enabled', () => {
                panelWith({ control: true }).ensureSecurityPanelDiscovery('254', '208');
                expect(alarmPayload().supported_features).not.toContain('arm_custom_bypass');
            });

            it('publishes the bypass button on the panel device when both are enabled', () => {
                panelWith({ control: true, bypass: true }).ensureSecurityPanelDiscovery('254', '208');
                const payload = bypassPayload();
                expect(payload).toBeDefined();
                expect(payload.name).toBe('Bypass open zones');
                expect(payload.command_topic).toBe('cbus/write/254/208/panel/bypass');
                expect(payload.device.identifiers).toEqual(['cgateweb_254_208_panel']);
            });

            it('offers arm_custom_bypass on the alarm card when both are enabled', () => {
                panelWith({ control: true, bypass: true }).ensureSecurityPanelDiscovery('254', '208');
                expect(alarmPayload().supported_features).toContain('arm_custom_bypass');
            });

            it('does not enable bypass from the bypass setting alone', () => {
                // Bypass rides on control: without a command path there is
                // nothing for the button to write to.
                panelWith({ bypass: true }).ensureSecurityPanelDiscovery('254', '208');
                expect(bypassPayload()).toBeUndefined();
                expect(alarmPayload().supported_features).not.toContain('arm_custom_bypass');
            });
        });

        // Regression for #42: both default to true in Home Assistant, which then
        // refuses to publish the command at all and shows "PIN required". C-Bus
        // arm carries no PIN, so there is no code to enter.
        it('tells Home Assistant no code is needed to arm or disarm', () => {
            d.ensureSecurityPanelDiscovery('254', '208');
            const payload = alarmPayload();
            expect(payload.code_arm_required).toBe(false);
            expect(payload.code_disarm_required).toBe(false);
        });

        describe('keypad disarm (#51)', () => {
            function panelWith(settings) {
                const discovery = new HaDiscovery(
                    {
                        ha_discovery_enabled: true,
                        ha_discovery_prefix: 'homeassistant',
                        cbus_security_app_id: '208',
                        ...settings
                    },
                    publishFn,
                    jest.fn()
                );
                discovery.ensureSecurityPanelDiscovery('254', '208');
                return alarmPayload();
            }

            it('asks Home Assistant for its keypad without storing a PIN', () => {
                const payload = panelWith({
                    cbus_security_control_enabled: true,
                    cbus_security_disarm_enabled: true
                });
                // REMOTE_CODE shows HA's numeric keypad but skips HA-side
                // validation, so the real PIN never has to be configured
                // anywhere — only the panel judges it.
                expect(payload.code).toBe('REMOTE_CODE');
                expect(payload.code_disarm_required).toBe(true);
                // Arming still needs no code.
                expect(payload.code_arm_required).toBe(false);
            });

            it('passes the typed code through in the command payload', () => {
                const payload = panelWith({
                    cbus_security_control_enabled: true,
                    cbus_security_disarm_enabled: true
                });
                expect(payload.command_template).toContain('action');
                expect(payload.command_template).toContain('code');
                // tojson, not hand-quoting: a code is user input and a stray
                // quote would otherwise emit malformed JSON.
                expect(payload.command_template).toContain('tojson');
            });

            it('leaves the panel arm-only when disarm is not enabled', () => {
                const payload = panelWith({ cbus_security_control_enabled: true });
                expect('code' in payload).toBe(false);
                expect('command_template' in payload).toBe(false);
                expect(payload.code_disarm_required).toBe(false);
            });

            it('ignores disarm without control, since there is no command topic', () => {
                const payload = panelWith({ cbus_security_disarm_enabled: true });
                expect('command_topic' in payload).toBe(false);
                expect('code' in payload).toBe(false);
                expect(payload.code_disarm_required).toBe(false);
            });
        });

        it('retracts the alarm panel config when the panel is excluded', () => {
            d.exclude.add('254/208/panel');
            expect(d.ensureSecurityPanelDiscovery('254', '208')).toBe(false);
            const call = publishFn.mock.calls.find(c => c[0] === ALARM_TOPIC);
            expect(call).toBeDefined();
            expect(call[1]).toBe(''); // empty retained payload removes the entity
        });
    });
});

describe('securityZoneLabels — label-key convention', () => {
    it('builds the {net}/1/{zone} key', () => {
        expect(securityZoneLabelKey('254', '35')).toBe('254/1/35');
        expect(securityZoneLabelKey(254, 35)).toBe('254/1/35');
    });

    it('parses valid keys back into their parts', () => {
        expect(parseSecurityZoneLabelKey('254/1/35')).toEqual({ network: '254', zone: '35' });
        expect(parseSecurityZoneLabelKey('1/1/1')).toEqual({ network: '1', zone: '1' });
        expect(parseSecurityZoneLabelKey('254/1/127')).toEqual({ network: '254', zone: '127' });
    });

    it('round-trips through build and parse', () => {
        expect(parseSecurityZoneLabelKey(securityZoneLabelKey('254', '35'))).toEqual({ network: '254', zone: '35' });
    });

    it('rejects malformed keys and out-of-range zones', () => {
        expect(parseSecurityZoneLabelKey('254/1/FrontDoor')).toBeNull();
        expect(parseSecurityZoneLabelKey('254/56/35')).toBeNull();
        expect(parseSecurityZoneLabelKey('254/1/0')).toBeNull();
        expect(parseSecurityZoneLabelKey('254/1/128')).toBeNull();
        expect(parseSecurityZoneLabelKey('254/1/')).toBeNull();
        expect(parseSecurityZoneLabelKey('254/1/35/extra')).toBeNull();
    });
});
