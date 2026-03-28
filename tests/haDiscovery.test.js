// tests/haDiscovery.test.js - Direct testing of HaDiscovery class

const HaDiscovery = require('../src/haDiscovery');
const { CGATE_CMD_TREEXML, NEWLINE } = require('../src/constants');

// Mock XML data for testing - matches actual C-Gate tree structure
const MOCK_TREEXML_RESULT_NET254 = {
    Network: {
        Interface: {
            Network: {
                NetworkNumber: '254',
                Unit: [
                    {
                        UnitAddress: '100',
                        Application: [
                            {
                                ApplicationAddress: '56',
                                Group: [
                                    { GroupAddress: '10', Label: 'Kitchen Light' },
                                    { GroupAddress: '11', Label: 'Living Room' },
                                    { GroupAddress: '12', Label: 'Bedroom Light' }
                                ]
                            },
                            {
                                ApplicationAddress: '203',
                                Group: [
                                    { GroupAddress: '15', Label: 'Blind 1' },
                                    { GroupAddress: '16', Label: 'Blind 2' },
                                    { GroupAddress: '17', Label: 'Garage Door' },
                                    { GroupAddress: '20', Label: 'Relay Switch' }
                                ]
                            }
                        ]
                    }
                ]
            }
        }
    }
};

describe('HaDiscovery', () => {
    let haDiscovery;
    let mockSettings;
    let mockPublishFn;
    let mockSendCommandFn;

    beforeEach(() => {
        mockSettings = {
            ha_discovery_enabled: true,
            ha_discovery_prefix: 'testhomeassistant',
            ha_discovery_networks: ['254'],
            ha_discovery_cover_app_id: '203',
            ha_discovery_switch_app_id: null,
            ha_discovery_relay_app_id: null,
            ha_discovery_pir_app_id: null,
            cbusname: 'TESTPROJECT',
            getallnetapp: null
        };

        mockPublishFn = jest.fn();
        mockSendCommandFn = jest.fn();

        haDiscovery = new HaDiscovery(mockSettings, mockPublishFn, mockSendCommandFn);
        
        // Mock console methods
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('Constructor', () => {
        it('should initialize with correct properties', () => {
            expect(haDiscovery.settings).toBe(mockSettings);
            expect(haDiscovery._publish).toBe(mockPublishFn);
            expect(haDiscovery._sendCommand).toBe(mockSendCommandFn);
            expect(haDiscovery.treeBufferParts).toEqual([]);
            expect(haDiscovery.treeNetwork).toBeNull();
            expect(haDiscovery.discoveryCount).toBe(0);
        });
    });

    describe('trigger()', () => {
        it('should return early if HA discovery is disabled', () => {
            mockSettings.ha_discovery_enabled = false;
            haDiscovery.trigger();
            expect(mockSendCommandFn).not.toHaveBeenCalled();
        });

        it('should send TREEXML commands for configured networks', () => {
            mockSettings.ha_discovery_networks = ['254', '200'];
            haDiscovery.trigger();
            
            expect(mockSendCommandFn).toHaveBeenCalledWith(`${CGATE_CMD_TREEXML} 254${NEWLINE}`);
            expect(mockSendCommandFn).toHaveBeenCalledWith(`${CGATE_CMD_TREEXML} 200${NEWLINE}`);
            expect(mockSendCommandFn).toHaveBeenCalledTimes(2);
        });

        it('should use getallnetapp network if networks list is empty', () => {
            mockSettings.ha_discovery_networks = [];
            mockSettings.getallnetapp = '254';
            haDiscovery.trigger();
            
            expect(mockSendCommandFn).toHaveBeenCalledWith(`${CGATE_CMD_TREEXML} 254${NEWLINE}`);
            expect(mockSendCommandFn).toHaveBeenCalledTimes(1);
        });

        it('should warn if no networks are configured', () => {
            mockSettings.ha_discovery_networks = [];
            mockSettings.getallnetapp = null;
            const warnSpy = jest.spyOn(console, 'warn');
            
            haDiscovery.trigger();
            
            expect(warnSpy).toHaveBeenCalled();
            expect(mockSendCommandFn).not.toHaveBeenCalled();
        });
    });

    describe('Tree XML Handling', () => {
        it('should handle tree start correctly', () => {
            haDiscovery.treeNetwork = '254';
            haDiscovery.handleTreeStart('Tree start for network 254');
            
            expect(haDiscovery.treeBufferParts).toEqual([]);
        });

        it('should accumulate tree data in array', () => {
            haDiscovery.handleTreeData('line1');
            haDiscovery.handleTreeData('line2');
            
            expect(haDiscovery.treeBufferParts).toEqual(['line1', 'line2']);
        });

        it('should join buffer parts with newlines on tree end', () => {
            haDiscovery.treeNetwork = '254';
            haDiscovery.handleTreeStart('start');
            haDiscovery.handleTreeData('<xml>');
            haDiscovery.handleTreeData('test');
            haDiscovery.handleTreeData('</xml>');

            jest.spyOn(require('xml2js'), 'parseString').mockImplementation((xml, _opts, callback) => {
                expect(xml).toBe(`<xml>${NEWLINE}test${NEWLINE}</xml>${NEWLINE}`);
                callback(null, MOCK_TREEXML_RESULT_NET254);
            });

            haDiscovery.handleTreeEnd('Tree end');
            expect(mockPublishFn).toHaveBeenCalled();
        });

        it('should process tree end and publish discovery', () => {
            haDiscovery.treeNetwork = '254';
            haDiscovery.treeBufferParts = ['<xml>test</xml>'];
            
            // Mock parseString to return our test data
            jest.spyOn(require('xml2js'), 'parseString').mockImplementation((xml, _opts, callback) => {
                callback(null, MOCK_TREEXML_RESULT_NET254);
            });

            haDiscovery.handleTreeEnd('Tree end');

            expect(mockPublishFn).toHaveBeenCalled();
            expect(haDiscovery.treeBufferParts).toEqual([]);
            expect(haDiscovery.treeNetwork).toBeNull();
        });

        it('should isolate network context across queued TreeXML requests', () => {
            mockSettings.ha_discovery_networks = ['254', '200'];
            haDiscovery.trigger();

            jest.spyOn(require('xml2js'), 'parseString').mockImplementation((xml, _opts, callback) => {
                callback(null, MOCK_TREEXML_RESULT_NET254);
            });

            haDiscovery.handleTreeStart('start');
            haDiscovery.handleTreeData('<xml>first</xml>');
            haDiscovery.handleTreeEnd('end');

            haDiscovery.handleTreeStart('start');
            haDiscovery.handleTreeData('<xml>second</xml>');
            haDiscovery.handleTreeEnd('end');

            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254///tree',
                expect.any(String),
                { retain: true, qos: 0 }
            );
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/200///tree',
                expect.any(String),
                { retain: true, qos: 0 }
            );
        });
    });

    describe('Discovery Publishing', () => {
        beforeEach(() => {
            // Mock parseString for all discovery tests
            jest.spyOn(require('xml2js'), 'parseString').mockImplementation((xml, _opts, callback) => {
                callback(null, MOCK_TREEXML_RESULT_NET254);
            });
        });

        it('should publish correct configs for LIGHTING groups', () => {
            haDiscovery._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            // Check that light configs were published
            expect(mockPublishFn).toHaveBeenCalledWith(
                'testhomeassistant/light/cgateweb_254_56_10/config',
                expect.stringContaining('"name":"Kitchen Light"'),
                { retain: true, qos: 0 }
            );
        });

        it('should publish correct configs for COVER groups', () => {
            haDiscovery._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            // Check that cover configs were published
            expect(mockPublishFn).toHaveBeenCalledWith(
                'testhomeassistant/cover/cgateweb_254_203_15/config',
                expect.stringContaining('"name":"Blind 1"'),
                { retain: true, qos: 0 }
            );
        });

        it('should publish cover config with position support', () => {
            haDiscovery._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            // Find the cover config call
            const coverCall = mockPublishFn.mock.calls.find(
                call => call[0] === 'testhomeassistant/cover/cgateweb_254_203_15/config'
            );
            expect(coverCall).toBeDefined();
            
            const payload = JSON.parse(coverCall[1]);
            
            // Verify position topics are included
            expect(payload.position_topic).toBe('cbus/read/254/203/15/position');
            expect(payload.set_position_topic).toBe('cbus/write/254/203/15/position');
            expect(payload.stop_topic).toBe('cbus/write/254/203/15/stop');
            expect(payload.payload_stop).toBe('STOP');
            expect(payload.position_open).toBe(100);
            expect(payload.position_closed).toBe(0);
            expect(payload.optimistic).toBe(false);
        });

        it('should publish cover config with correct device class', () => {
            haDiscovery._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            // Check that cover configs include shutter device class
            const coverCall = mockPublishFn.mock.calls.find(
                call => call[0] === 'testhomeassistant/cover/cgateweb_254_203_15/config'
            );
            expect(coverCall).toBeDefined();
            
            const payload = JSON.parse(coverCall[1]);
            expect(payload.device_class).toBe('shutter');
        });

        it('should publish cover config with open/close payloads', () => {
            haDiscovery._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            const coverCall = mockPublishFn.mock.calls.find(
                call => call[0] === 'testhomeassistant/cover/cgateweb_254_203_15/config'
            );
            expect(coverCall).toBeDefined();
            
            const payload = JSON.parse(coverCall[1]);
            
            // Verify open/close payloads
            expect(payload.payload_open).toBe('ON');
            expect(payload.payload_close).toBe('OFF');
            expect(payload.state_open).toBe('ON');
            expect(payload.state_closed).toBe('OFF');
        });

        it('should publish PIR configs when PIR app ID is configured', () => {
            mockSettings.ha_discovery_pir_app_id = '203';
            mockSettings.ha_discovery_cover_app_id = null;
            
            haDiscovery._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            // Check that PIR sensor configs were published
            expect(mockPublishFn).toHaveBeenCalledWith(
                'testhomeassistant/binary_sensor/cgateweb_254_203_15/config',
                expect.stringContaining('"device_class":"motion"'),
                { retain: true, qos: 0 }
            );
        });

        it('should publish SWITCH configs when switch app ID is configured', () => {
            mockSettings.ha_discovery_switch_app_id = '203';
            mockSettings.ha_discovery_cover_app_id = null;
            
            haDiscovery._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            // Check that switch configs were published
            expect(mockPublishFn).toHaveBeenCalledWith(
                'testhomeassistant/switch/cgateweb_254_203_15/config',
                expect.stringContaining('"name":"Blind 1"'),
                { retain: true, qos: 0 }
            );
        });

        it('should publish RELAY configs when relay app ID is configured', () => {
            mockSettings.ha_discovery_relay_app_id = '203';
            mockSettings.ha_discovery_cover_app_id = null;

            haDiscovery._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            // Check that relay configs were published
            expect(mockPublishFn).toHaveBeenCalledWith(
                'testhomeassistant/switch/cgateweb_254_203_15/config',
                expect.stringContaining('"device_class":"outlet"'),
                { retain: true, qos: 0 }
            );
        });

        it('should publish TRIGGER (event) configs when trigger app ID is configured', () => {
            mockSettings.ha_discovery_trigger_app_id = '203';
            mockSettings.ha_discovery_cover_app_id = null;

            haDiscovery._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            // Check that event entity configs were published
            expect(mockPublishFn).toHaveBeenCalledWith(
                'testhomeassistant/event/cgateweb_254_203_15/config',
                expect.any(String),
                { retain: true, qos: 0 }
            );

            // Verify event entity payload structure
            const eventCall = mockPublishFn.mock.calls.find(
                c => c[0] === 'testhomeassistant/event/cgateweb_254_203_15/config'
            );
            expect(eventCall).toBeDefined();
            const payload = JSON.parse(eventCall[1]);
            expect(payload.event_types).toEqual(['trigger']);
            expect(payload.state_topic).toBe('cbus/read/254/203/15/event');
            expect(payload.retain).toBeUndefined();
        });

        it('should publish companion button entity for each trigger group', () => {
            mockSettings.ha_discovery_trigger_app_id = '203';
            mockSettings.ha_discovery_cover_app_id = null;

            haDiscovery._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            expect(mockPublishFn).toHaveBeenCalledWith(
                'testhomeassistant/button/cgateweb_254_203_15_btn/config',
                expect.any(String),
                { retain: true, qos: 0 }
            );
        });

        it('should publish button entity with correct command_topic and payload_press', () => {
            mockSettings.ha_discovery_trigger_app_id = '203';
            mockSettings.ha_discovery_cover_app_id = null;

            haDiscovery._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            const buttonCall = mockPublishFn.mock.calls.find(
                c => c[0] === 'testhomeassistant/button/cgateweb_254_203_15_btn/config'
            );
            expect(buttonCall).toBeDefined();
            const payload = JSON.parse(buttonCall[1]);
            expect(payload.command_topic).toBe('cbus/write/254/203/15/trigger');
            expect(payload.payload_press).toBe('ON');
            expect(payload.unique_id).toBe('cgateweb_254_203_15_btn');
        });

        it('should link button entity to the same device as the event entity', () => {
            mockSettings.ha_discovery_trigger_app_id = '203';
            mockSettings.ha_discovery_cover_app_id = null;

            haDiscovery._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            const buttonCall = mockPublishFn.mock.calls.find(
                c => c[0] === 'testhomeassistant/button/cgateweb_254_203_15_btn/config'
            );
            expect(buttonCall).toBeDefined();
            const payload = JSON.parse(buttonCall[1]);
            // Button device identifiers should match the event entity's unique_id
            expect(payload.device.identifiers).toEqual(['cgateweb_254_203_15']);
        });

        it('should publish both event and button entities for each trigger group', () => {
            mockSettings.ha_discovery_trigger_app_id = '203';
            mockSettings.ha_discovery_cover_app_id = null;

            haDiscovery._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            // There are 4 groups in app 203 — expect 4 event + 4 button entities
            const eventCalls = mockPublishFn.mock.calls.filter(
                c => c[0].includes('/event/') && c[0].endsWith('/config')
            );
            const buttonCalls = mockPublishFn.mock.calls.filter(
                c => c[0].includes('/button/') && c[0].endsWith('/config')
            );
            expect(eventCalls.length).toBe(4);
            expect(buttonCalls.length).toBe(4);
        });

        it('should handle numeric ApplicationAddress from XML parsing', () => {
            const numericAppIdData = {
                Network: {
                    Interface: {
                        Network: {
                            NetworkNumber: '254',
                            Unit: [{
                                UnitAddress: '100',
                                Application: [
                                    {
                                        ApplicationAddress: 56,
                                        Group: [
                                            { GroupAddress: '10', Label: 'Kitchen Light' }
                                        ]
                                    },
                                    {
                                        ApplicationAddress: 203,
                                        Group: [
                                            { GroupAddress: '15', Label: 'Blind 1' }
                                        ]
                                    }
                                ]
                            }]
                        }
                    }
                }
            };

            haDiscovery._publishDiscoveryFromTree('254', numericAppIdData);

            expect(mockPublishFn).toHaveBeenCalledWith(
                'testhomeassistant/light/cgateweb_254_56_10/config',
                expect.stringContaining('"name":"Kitchen Light"'),
                { retain: true, qos: 0 }
            );
            expect(mockPublishFn).toHaveBeenCalledWith(
                'testhomeassistant/cover/cgateweb_254_203_15/config',
                expect.stringContaining('"name":"Blind 1"'),
                { retain: true, qos: 0 }
            );
        });

        it('should handle numeric settings app IDs matching string ApplicationAddress', () => {
            mockSettings.ha_discovery_cover_app_id = 203;

            haDiscovery._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            expect(mockPublishFn).toHaveBeenCalledWith(
                'testhomeassistant/cover/cgateweb_254_203_15/config',
                expect.stringContaining('"name":"Blind 1"'),
                { retain: true, qos: 0 }
            );
        });

        it('should handle missing group labels gracefully', () => {
            const mockDataWithoutLabels = {
                Network: {
                    Interface: {
                        Network: {
                            NetworkNumber: '254',
                            Unit: [{
                                UnitAddress: '100',
                                Application: [{
                                    ApplicationAddress: '56',
                                    Group: [{ GroupAddress: '10' }] // No GroupName
                                }]
                            }]
                        }
                    }
                }
            };
            
            haDiscovery._publishDiscoveryFromTree('254', mockDataWithoutLabels);

            // Should use fallback name
            expect(mockPublishFn).toHaveBeenCalledWith(
                expect.any(String),
                expect.stringContaining('"name":"CBus Light 254/56/10"'),
                expect.any(Object)
            );
        });

        it('should handle flat C-Gate TREEXML format (Application as string, Groups as string)', () => {
            const flatTreeData = {
                Network: {
                    Unit: [
                        {
                            Type: 'RELDN12',
                            Address: '25',
                            PartName: 'RELAY1',
                            Application: '56, 255',
                            Groups: '79,80,81'
                        },
                        {
                            Type: 'DIMDN8',
                            Address: '37',
                            PartName: 'DIM1',
                            Application: '56, 255',
                            Groups: '4,15'
                        }
                    ]
                }
            };

            haDiscovery._publishDiscoveryFromTree('254', flatTreeData);

            // Should discover 5 unique lighting groups
            const lightCalls = mockPublishFn.mock.calls.filter(
                call => call[0].includes('/light/')
            );
            expect(lightCalls.length).toBe(5);

            // Verify one of the group discovery configs
            expect(mockPublishFn).toHaveBeenCalledWith(
                'testhomeassistant/light/cgateweb_254_56_79/config',
                expect.stringContaining('"unique_id":"cgateweb_254_56_79"'),
                { retain: true, qos: 0 }
            );
        });

        it('should handle flat format Network without NetworkNumber attribute', () => {
            const flatTreeData = {
                Network: {
                    Unit: [{
                        Application: '56, 255',
                        Groups: '10,11'
                    }]
                }
            };

            haDiscovery._publishDiscoveryFromTree('254', flatTreeData);

            expect(mockPublishFn).toHaveBeenCalledWith(
                'testhomeassistant/light/cgateweb_254_56_10/config',
                expect.any(String),
                { retain: true, qos: 0 }
            );
        });

        it('should skip units with empty Groups in flat format', () => {
            const flatTreeData = {
                Network: {
                    Unit: [
                        { Application: '56, 255', Groups: '' },
                        { Application: '56, 255', Groups: '42' }
                    ]
                }
            };

            haDiscovery._publishDiscoveryFromTree('254', flatTreeData);

            const lightCalls = mockPublishFn.mock.calls.filter(
                call => call[0].includes('/light/')
            );
            expect(lightCalls.length).toBe(1);
        });

        it('should handle XML parsing errors gracefully', () => {
            jest.spyOn(require('xml2js'), 'parseString').mockImplementation((xml, _opts, callback) => {
                callback(new Error('Invalid XML'), null);
            });

            const errorSpy = jest.spyOn(console, 'error');
            
            haDiscovery.treeNetwork = '254';
            haDiscovery.treeBufferParts = ['invalid xml'];
            haDiscovery.handleTreeEnd('Tree end');

            expect(errorSpy).toHaveBeenCalled();
        });
    });

    describe('Integration with CgateWebBridge', () => {
        it('should be triggered when all connections are established', () => {
            // This test verifies the integration point exists
            expect(typeof haDiscovery.trigger).toBe('function');
        });

        it('should handle tree responses from C-Gate correctly', () => {
            haDiscovery.treeNetwork = '254';
            
            haDiscovery.handleTreeStart('start');
            expect(haDiscovery.treeBufferParts).toEqual([]);
            
            haDiscovery.handleTreeData('data1');
            haDiscovery.handleTreeData('data2');
            expect(haDiscovery.treeBufferParts).toEqual(['data1', 'data2']);
        });
    });

    describe('Custom Label Override (three-tier priority)', () => {
        beforeEach(() => {
            jest.spyOn(require('xml2js'), 'parseString').mockImplementation((xml, _opts, callback) => {
                callback(null, MOCK_TREEXML_RESULT_NET254);
            });
        });

        it('should use custom label over TREEXML label when both exist', () => {
            const labelMap = new Map([['254/56/10', 'My Custom Kitchen']]);
            const haWithLabels = new HaDiscovery(mockSettings, mockPublishFn, mockSendCommandFn, labelMap);
            haWithLabels._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            const call = mockPublishFn.mock.calls.find(
                c => c[0] === 'testhomeassistant/light/cgateweb_254_56_10/config'
            );
            expect(call).toBeDefined();
            const payload = JSON.parse(call[1]);
            expect(payload.name).toBeNull();
            expect(payload.device.name).toBe('My Custom Kitchen');
        });

        it('should use TREEXML label when no custom label exists', () => {
            const haWithLabels = new HaDiscovery(mockSettings, mockPublishFn, mockSendCommandFn, new Map());
            haWithLabels._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            const call = mockPublishFn.mock.calls.find(
                c => c[0] === 'testhomeassistant/light/cgateweb_254_56_10/config'
            );
            expect(call).toBeDefined();
            const payload = JSON.parse(call[1]);
            expect(payload.name).toBeNull();
            expect(payload.device.name).toBe('Kitchen Light');
        });

        it('should use custom label for cover groups too', () => {
            const labelMap = new Map([['254/203/15', 'Master Bedroom Blind']]);
            const haWithLabels = new HaDiscovery(mockSettings, mockPublishFn, mockSendCommandFn, labelMap);
            haWithLabels._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            const call = mockPublishFn.mock.calls.find(
                c => c[0] === 'testhomeassistant/cover/cgateweb_254_203_15/config'
            );
            expect(call).toBeDefined();
            const payload = JSON.parse(call[1]);
            expect(payload.name).toBeNull();
            expect(payload.device.name).toBe('Master Bedroom Blind');
        });

        it('should track label stats correctly', () => {
            const labelMap = new Map([
                ['254/56/10', 'Custom Kitchen'],
                ['254/203/16', 'Custom Blind 2']
            ]);
            const haWithLabels = new HaDiscovery(mockSettings, mockPublishFn, mockSendCommandFn, labelMap);
            haWithLabels._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            // 2 custom (254/56/10, 254/203/16), rest are treexml labels
            expect(haWithLabels.labelStats.custom).toBe(2);
            expect(haWithLabels.labelStats.treexml).toBeGreaterThan(0);
            expect(haWithLabels.labelStats.fallback).toBe(0);
        });

        it('should update labels via updateLabels() method', () => {
            haDiscovery.updateLabels(new Map([['254/56/10', 'Updated Name']]));
            expect(haDiscovery.labelMap.get('254/56/10')).toBe('Updated Name');

            haDiscovery._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            const call = mockPublishFn.mock.calls.find(
                c => c[0] === 'testhomeassistant/light/cgateweb_254_56_10/config'
            );
            const payload = JSON.parse(call[1]);
            expect(payload.name).toBeNull();
            expect(payload.device.name).toBe('Updated Name');
        });

        it('should initialize with empty label map by default', () => {
            const ha = new HaDiscovery(mockSettings, mockPublishFn, mockSendCommandFn);
            expect(ha.labelMap).toBeInstanceOf(Map);
            expect(ha.labelMap.size).toBe(0);
        });

        it('should accept labelData object with all sections', () => {
            const labelData = {
                labels: new Map([['254/56/10', 'Kitchen']]),
                typeOverrides: new Map([['254/56/10', 'switch']]),
                entityIds: new Map([['254/56/10', 'kitchen_light']]),
                exclude: new Set(['254/56/255'])
            };
            const ha = new HaDiscovery(mockSettings, mockPublishFn, mockSendCommandFn, labelData);
            expect(ha.labelMap.get('254/56/10')).toBe('Kitchen');
            expect(ha.typeOverrides.get('254/56/10')).toBe('switch');
            expect(ha.entityIds.get('254/56/10')).toBe('kitchen_light');
            expect(ha.exclude.has('254/56/255')).toBe(true);
        });

        it('should update all sections via updateLabels()', () => {
            const labelData = {
                labels: new Map([['254/56/10', 'New Name']]),
                typeOverrides: new Map([['254/56/10', 'cover']]),
                entityIds: new Map([['254/56/10', 'my_cover']]),
                exclude: new Set(['254/56/99'])
            };
            haDiscovery.updateLabels(labelData);
            expect(haDiscovery.labelMap.get('254/56/10')).toBe('New Name');
            expect(haDiscovery.typeOverrides.get('254/56/10')).toBe('cover');
            expect(haDiscovery.entityIds.get('254/56/10')).toBe('my_cover');
            expect(haDiscovery.exclude.has('254/56/99')).toBe(true);
        });
    });

    describe('Type Overrides, Exclusions, and Entity IDs', () => {
        beforeEach(() => {
            jest.spyOn(require('xml2js'), 'parseString').mockImplementation((xml, _opts, callback) => {
                callback(null, MOCK_TREEXML_RESULT_NET254);
            });
        });

        it('should exclude groups in the exclude set', () => {
            const labelData = {
                labels: new Map(),
                typeOverrides: new Map(),
                entityIds: new Map(),
                exclude: new Set(['254/56/10'])
            };
            const ha = new HaDiscovery(mockSettings, mockPublishFn, mockSendCommandFn, labelData);
            ha._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            const excludedCall = mockPublishFn.mock.calls.find(
                c => c[0] === 'testhomeassistant/light/cgateweb_254_56_10/config'
            );
            expect(excludedCall).toBeUndefined();
        });

        it('should override a lighting group to cover type', () => {
            const labelData = {
                labels: new Map([['254/56/10', 'Kitchen Blind']]),
                typeOverrides: new Map([['254/56/10', 'cover']]),
                entityIds: new Map(),
                exclude: new Set()
            };
            const ha = new HaDiscovery(mockSettings, mockPublishFn, mockSendCommandFn, labelData);
            ha._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            // Should be published as cover, not light
            // The old light topic should be cleared with an empty payload (stale cleanup)
            const lightCall = mockPublishFn.mock.calls.find(
                c => c[0] === 'testhomeassistant/light/cgateweb_254_56_10/config'
            );
            expect(lightCall).toBeDefined();
            expect(lightCall[1]).toBe('');

            const coverCall = mockPublishFn.mock.calls.find(
                c => c[0] === 'testhomeassistant/cover/cgateweb_254_56_10/config'
            );
            expect(coverCall).toBeDefined();
            const payload = JSON.parse(coverCall[1]);
            expect(payload.name).toBeNull();
            expect(payload.device.name).toBe('Kitchen Blind');
            expect(payload.device_class).toBe('shutter');
        });

        it('should override a lighting group to switch type', () => {
            const labelData = {
                labels: new Map([['254/56/10', 'Pond Pump']]),
                typeOverrides: new Map([['254/56/10', 'switch']]),
                entityIds: new Map(),
                exclude: new Set()
            };
            const ha = new HaDiscovery(mockSettings, mockPublishFn, mockSendCommandFn, labelData);
            ha._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            const switchCall = mockPublishFn.mock.calls.find(
                c => c[0] === 'testhomeassistant/switch/cgateweb_254_56_10/config'
            );
            expect(switchCall).toBeDefined();
            const payload = JSON.parse(switchCall[1]);
            expect(payload.name).toBeNull();
            expect(payload.device.name).toBe('Pond Pump');
        });

        it('should inject object_id when entity_ids has an entry', () => {
            const labelData = {
                labels: new Map([['254/56/10', 'Kitchen']]),
                typeOverrides: new Map(),
                entityIds: new Map([['254/56/10', 'kitchen_light']]),
                exclude: new Set()
            };
            const ha = new HaDiscovery(mockSettings, mockPublishFn, mockSendCommandFn, labelData);
            ha._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            const call = mockPublishFn.mock.calls.find(
                c => c[0] === 'testhomeassistant/light/cgateweb_254_56_10/config'
            );
            expect(call).toBeDefined();
            const payload = JSON.parse(call[1]);
            expect(payload.object_id).toBe('kitchen_light');
        });

        it('should not include object_id when no entity_id is configured', () => {
            const labelData = {
                labels: new Map(),
                typeOverrides: new Map(),
                entityIds: new Map(),
                exclude: new Set()
            };
            const ha = new HaDiscovery(mockSettings, mockPublishFn, mockSendCommandFn, labelData);
            ha._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            const call = mockPublishFn.mock.calls.find(
                c => c[0] === 'testhomeassistant/light/cgateweb_254_56_10/config'
            );
            expect(call).toBeDefined();
            const payload = JSON.parse(call[1]);
            expect(payload.object_id).toBeUndefined();
        });

        it('should inject object_id on type-overridden cover entities', () => {
            const labelData = {
                labels: new Map([['254/56/10', 'Main Blind']]),
                typeOverrides: new Map([['254/56/10', 'cover']]),
                entityIds: new Map([['254/56/10', 'main_blind']]),
                exclude: new Set()
            };
            const ha = new HaDiscovery(mockSettings, mockPublishFn, mockSendCommandFn, labelData);
            ha._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            const coverCall = mockPublishFn.mock.calls.find(
                c => c[0] === 'testhomeassistant/cover/cgateweb_254_56_10/config'
            );
            expect(coverCall).toBeDefined();
            const payload = JSON.parse(coverCall[1]);
            expect(payload.object_id).toBe('main_blind');
            expect(payload.name).toBeNull();
            expect(payload.device.name).toBe('Main Blind');
        });

        it('should also exclude groups from _createDiscovery (cover app)', () => {
            const labelData = {
                labels: new Map(),
                typeOverrides: new Map(),
                entityIds: new Map(),
                exclude: new Set(['254/203/15'])
            };
            const ha = new HaDiscovery(mockSettings, mockPublishFn, mockSendCommandFn, labelData);
            ha._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            const excludedCover = mockPublishFn.mock.calls.find(
                c => c[0] === 'testhomeassistant/cover/cgateweb_254_203_15/config'
            );
            expect(excludedCover).toBeUndefined();
        });
    });

    describe('Label Supplementation', () => {
        beforeEach(() => {
            jest.spyOn(require('xml2js'), 'parseString').mockImplementation((xml, _opts, callback) => {
                callback(null, MOCK_TREEXML_RESULT_NET254);
            });
        });

        it('should create discovery entities for labeled groups not found in TREEXML', () => {
            const labelData = {
                labels: new Map([
                    ['254/56/10', 'Kitchen Lights'],
                    ['254/56/200', 'Extra Group Not In Tree'],
                    ['254/56/201', 'Another Extra Group']
                ]),
                typeOverrides: new Map(),
                entityIds: new Map([['254/56/200', 'extra_group']]),
                exclude: new Set()
            };
            const ha = new HaDiscovery(mockSettings, mockPublishFn, mockSendCommandFn, labelData);
            ha._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            const extraCall = mockPublishFn.mock.calls.find(
                c => c[0] === 'testhomeassistant/light/cgateweb_254_56_200/config'
            );
            expect(extraCall).toBeDefined();
            const payload = JSON.parse(extraCall[1]);
            expect(payload.name).toBeNull();
            expect(payload.device.name).toBe('Extra Group Not In Tree');
            expect(payload.object_id).toBe('extra_group');

            const anotherCall = mockPublishFn.mock.calls.find(
                c => c[0] === 'testhomeassistant/light/cgateweb_254_56_201/config'
            );
            expect(anotherCall).toBeDefined();
            const anotherPayload = JSON.parse(anotherCall[1]);
            expect(anotherPayload.name).toBeNull();
            expect(anotherPayload.device.name).toBe('Another Extra Group');
        });

        it('should not duplicate groups already found in TREEXML', () => {
            const labelData = {
                labels: new Map([['254/56/10', 'Kitchen Override']]),
                typeOverrides: new Map(),
                entityIds: new Map(),
                exclude: new Set()
            };
            const ha = new HaDiscovery(mockSettings, mockPublishFn, mockSendCommandFn, labelData);
            ha._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            const calls = mockPublishFn.mock.calls.filter(
                c => c[0] === 'testhomeassistant/light/cgateweb_254_56_10/config'
            );
            expect(calls).toHaveLength(1);
        });

        it('should not supplement excluded groups', () => {
            const labelData = {
                labels: new Map([['254/56/200', 'Should Be Excluded']]),
                typeOverrides: new Map(),
                entityIds: new Map(),
                exclude: new Set(['254/56/200'])
            };
            const ha = new HaDiscovery(mockSettings, mockPublishFn, mockSendCommandFn, labelData);
            ha._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            const excludedCall = mockPublishFn.mock.calls.find(
                c => c[0] === 'testhomeassistant/light/cgateweb_254_56_200/config'
            );
            expect(excludedCall).toBeUndefined();
        });

        it('should apply type overrides to supplemented groups', () => {
            const labelData = {
                labels: new Map([['254/56/200', 'Extra Blind']]),
                typeOverrides: new Map([['254/56/200', 'cover']]),
                entityIds: new Map([['254/56/200', 'extra_blind']]),
                exclude: new Set()
            };
            const ha = new HaDiscovery(mockSettings, mockPublishFn, mockSendCommandFn, labelData);
            ha._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            const coverCall = mockPublishFn.mock.calls.find(
                c => c[0] === 'testhomeassistant/cover/cgateweb_254_56_200/config'
            );
            expect(coverCall).toBeDefined();
            const payload = JSON.parse(coverCall[1]);
            expect(payload.name).toBeNull();
            expect(payload.device.name).toBe('Extra Blind');
            expect(payload.object_id).toBe('extra_blind');
        });
    });

    describe('Stale Discovery Cleanup', () => {
        beforeEach(() => {
            jest.spyOn(require('xml2js'), 'parseString').mockImplementation((xml, _opts, callback) => {
                callback(null, MOCK_TREEXML_RESULT_NET254);
            });
        });

        it('should not send any cleanup messages on first run (no prior published topics)', () => {
            // Fresh instance — _publishedTopics is empty
            haDiscovery._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            // All publishes should have non-empty payloads (no stale cleanup)
            const emptyPayloadCalls = mockPublishFn.mock.calls.filter(
                c => c[0].includes('/config') && c[1] === ''
            );
            expect(emptyPayloadCalls).toHaveLength(0);
        });

        it('should clear a discovery topic when the device is excluded on second run', () => {
            // First run: device 254/56/10 is included
            haDiscovery._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            // Verify the topic was published normally in run 1
            expect(haDiscovery._publishedTopics.has('testhomeassistant/light/cgateweb_254_56_10/config')).toBe(true);

            // Second run: device 254/56/10 is now excluded
            haDiscovery.updateLabels({
                labels: new Map(),
                typeOverrides: new Map(),
                entityIds: new Map(),
                exclude: new Set(['254/56/10'])
            });
            mockPublishFn.mockClear();

            haDiscovery._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            // The previously-published light topic should be cleared with an empty payload
            const staleCleanupCall = mockPublishFn.mock.calls.find(
                c => c[0] === 'testhomeassistant/light/cgateweb_254_56_10/config' && c[1] === ''
            );
            expect(staleCleanupCall).toBeDefined();
            expect(staleCleanupCall[2]).toEqual({ retain: true, qos: 0 });

            // The topic should no longer be tracked as published
            expect(haDiscovery._publishedTopics.has('testhomeassistant/light/cgateweb_254_56_10/config')).toBe(false);
        });

        it('should clear the old light topic when a device changes type from light to cover across runs', () => {
            // First run: device 254/56/10 published as a light
            haDiscovery._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);
            expect(haDiscovery._publishedTopics.has('testhomeassistant/light/cgateweb_254_56_10/config')).toBe(true);

            // Second run: device 254/56/10 now has a type override to cover
            haDiscovery.updateLabels({
                labels: new Map([['254/56/10', 'Kitchen Blind']]),
                typeOverrides: new Map([['254/56/10', 'cover']]),
                entityIds: new Map(),
                exclude: new Set()
            });
            mockPublishFn.mockClear();

            haDiscovery._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            // The old light topic must be cleared
            const lightCleanupCall = mockPublishFn.mock.calls.find(
                c => c[0] === 'testhomeassistant/light/cgateweb_254_56_10/config' && c[1] === ''
            );
            expect(lightCleanupCall).toBeDefined();

            // The new cover topic must be published
            const coverCall = mockPublishFn.mock.calls.find(
                c => c[0] === 'testhomeassistant/cover/cgateweb_254_56_10/config' && c[1] !== ''
            );
            expect(coverCall).toBeDefined();

            // Session tracking should reflect the new state
            expect(haDiscovery._publishedTopics.has('testhomeassistant/light/cgateweb_254_56_10/config')).toBe(false);
            expect(haDiscovery._publishedTopics.has('testhomeassistant/cover/cgateweb_254_56_10/config')).toBe(true);
        });

        it('should not clear topics from other networks when running for a specific network', () => {
            // Simulate a previously published topic for network 200
            haDiscovery._publishedTopics.add('testhomeassistant/light/cgateweb_200_56_5/config');

            // Run discovery for network 254 only
            haDiscovery._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            // The network-200 topic must NOT be cleared
            const network200Cleanup = mockPublishFn.mock.calls.find(
                c => c[0] === 'testhomeassistant/light/cgateweb_200_56_5/config' && c[1] === ''
            );
            expect(network200Cleanup).toBeUndefined();

            // The network-200 topic should still be in the published set
            expect(haDiscovery._publishedTopics.has('testhomeassistant/light/cgateweb_200_56_5/config')).toBe(true);
        });

        it('should update _publishedTopics to reflect the new set of topics after each run', () => {
            // First run
            haDiscovery._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);
            const topicsAfterRun1 = new Set(haDiscovery._publishedTopics);
            expect(topicsAfterRun1.has('testhomeassistant/light/cgateweb_254_56_10/config')).toBe(true);

            // Second run with a device excluded
            haDiscovery.updateLabels({
                labels: new Map(),
                typeOverrides: new Map(),
                entityIds: new Map(),
                exclude: new Set(['254/56/10'])
            });
            haDiscovery._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            // The excluded device should be removed from tracking
            expect(haDiscovery._publishedTopics.has('testhomeassistant/light/cgateweb_254_56_10/config')).toBe(false);
            // Other devices should still be tracked
            expect(haDiscovery._publishedTopics.has('testhomeassistant/light/cgateweb_254_56_11/config')).toBe(true);
        });
    });

    describe('suggested_area in discovery payloads', () => {
        it('should include suggested_area in light device payload when area is set', () => {
            haDiscovery.updateLabels({
                labels: new Map(),
                typeOverrides: new Map(),
                entityIds: new Map(),
                exclude: new Set(),
                areas: new Map([['254/56/10', 'Kitchen']])
            });

            haDiscovery._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            const lightCall = mockPublishFn.mock.calls.find(
                call => call[0] === 'testhomeassistant/light/cgateweb_254_56_10/config'
            );
            expect(lightCall).toBeDefined();
            const payload = JSON.parse(lightCall[1]);
            expect(payload.device.suggested_area).toBe('Kitchen');
        });

        it('should not include suggested_area in light device payload when area is not set', () => {
            haDiscovery.updateLabels({
                labels: new Map(),
                typeOverrides: new Map(),
                entityIds: new Map(),
                exclude: new Set(),
                areas: new Map()
            });

            haDiscovery._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            const lightCall = mockPublishFn.mock.calls.find(
                call => call[0] === 'testhomeassistant/light/cgateweb_254_56_10/config'
            );
            expect(lightCall).toBeDefined();
            const payload = JSON.parse(lightCall[1]);
            expect(payload.device.suggested_area).toBeUndefined();
        });

        it('should include suggested_area in cover device payload when area is set', () => {
            haDiscovery.updateLabels({
                labels: new Map(),
                typeOverrides: new Map(),
                entityIds: new Map(),
                exclude: new Set(),
                areas: new Map([['254/203/15', 'Lounge']])
            });

            haDiscovery._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            const coverCall = mockPublishFn.mock.calls.find(
                call => call[0] === 'testhomeassistant/cover/cgateweb_254_203_15/config'
            );
            expect(coverCall).toBeDefined();
            const payload = JSON.parse(coverCall[1]);
            expect(payload.device.suggested_area).toBe('Lounge');
        });

        it('should not include suggested_area in cover device payload when area is not set', () => {
            haDiscovery._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            const coverCall = mockPublishFn.mock.calls.find(
                call => call[0] === 'testhomeassistant/cover/cgateweb_254_203_15/config'
            );
            expect(coverCall).toBeDefined();
            const payload = JSON.parse(coverCall[1]);
            expect(payload.device.suggested_area).toBeUndefined();
        });

        it('should include suggested_area in HVAC device payload when area is set', () => {
            const hvacTreeData = {
                Network: {
                    Interface: {
                        Network: {
                            NetworkNumber: '254',
                            Unit: [{
                                UnitAddress: '100',
                                Application: [{
                                    ApplicationAddress: '201',
                                    Group: [{ GroupAddress: '5', Label: 'Main Zone' }]
                                }]
                            }]
                        }
                    }
                }
            };

            mockSettings.ha_discovery_hvac_app_id = '201';
            mockSettings.ha_discovery_cover_app_id = null;

            haDiscovery.updateLabels({
                labels: new Map(),
                typeOverrides: new Map(),
                entityIds: new Map(),
                exclude: new Set(),
                areas: new Map([['254/201/5', 'Office']])
            });

            haDiscovery._publishDiscoveryFromTree('254', hvacTreeData);

            const hvacCall = mockPublishFn.mock.calls.find(
                call => call[0] === 'testhomeassistant/climate/cgateweb_254_201_5/config'
            );
            expect(hvacCall).toBeDefined();
            const payload = JSON.parse(hvacCall[1]);
            expect(payload.device.suggested_area).toBe('Office');
        });

        it('should not include suggested_area in HVAC device payload when area is not set', () => {
            const hvacTreeData = {
                Network: {
                    Interface: {
                        Network: {
                            NetworkNumber: '254',
                            Unit: [{
                                UnitAddress: '100',
                                Application: [{
                                    ApplicationAddress: '201',
                                    Group: [{ GroupAddress: '5', Label: 'Main Zone' }]
                                }]
                            }]
                        }
                    }
                }
            };

            mockSettings.ha_discovery_hvac_app_id = '201';
            mockSettings.ha_discovery_cover_app_id = null;

            haDiscovery._publishDiscoveryFromTree('254', hvacTreeData);

            const hvacCall = mockPublishFn.mock.calls.find(
                call => call[0] === 'testhomeassistant/climate/cgateweb_254_201_5/config'
            );
            expect(hvacCall).toBeDefined();
            const payload = JSON.parse(hvacCall[1]);
            expect(payload.device.suggested_area).toBeUndefined();
        });

        it('should apply areas from initial labelData passed to constructor', () => {
            const labelData = {
                labels: new Map(),
                typeOverrides: new Map(),
                entityIds: new Map(),
                exclude: new Set(),
                areas: new Map([['254/56/11', 'Living Room']])
            };
            const discovery = new HaDiscovery(mockSettings, mockPublishFn, mockSendCommandFn, labelData);

            discovery._publishDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);

            const lightCall = mockPublishFn.mock.calls.find(
                call => call[0] === 'testhomeassistant/light/cgateweb_254_56_11/config'
            );
            expect(lightCall).toBeDefined();
            const payload = JSON.parse(lightCall[1]);
            expect(payload.device.suggested_area).toBe('Living Room');
        });
    });

    describe('Cover Tilt Discovery', () => {
        const tiltTreeData = {
            Network: {
                Interface: {
                    Network: {
                        NetworkNumber: '254',
                        Unit: [{
                            UnitAddress: '100',
                            Application: [
                                {
                                    ApplicationAddress: '203',
                                    Group: [
                                        { GroupAddress: '5', Label: 'Blind 1' },
                                        { GroupAddress: '6', Label: 'Blind 2' }
                                    ]
                                },
                                {
                                    ApplicationAddress: '204',
                                    Group: [
                                        { GroupAddress: '5', Label: 'Tilt Group 5' },
                                        { GroupAddress: '6', Label: 'Tilt Group 6' }
                                    ]
                                }
                            ]
                        }]
                    }
                }
            }
        };

        it('should include tilt topics in cover discovery payload when tilt app is configured', () => {
            mockSettings.ha_discovery_cover_app_id = '203';
            mockSettings.ha_discovery_cover_tilt_app_id = '204';
            haDiscovery = new HaDiscovery(mockSettings, mockPublishFn, mockSendCommandFn);

            haDiscovery._publishDiscoveryFromTree('254', tiltTreeData);

            const coverCall = mockPublishFn.mock.calls.find(
                call => call[0] === 'testhomeassistant/cover/cgateweb_254_203_5/config'
            );
            expect(coverCall).toBeDefined();

            const payload = JSON.parse(coverCall[1]);
            expect(payload.tilt_status_topic).toBe('cbus/read/254/204/5/tilt');
            expect(payload.tilt_command_topic).toBe('cbus/write/254/204/5/tilt');
            expect(payload.tilt_min).toBe(0);
            expect(payload.tilt_max).toBe(100);
            expect(payload.tilt_optimistic).toBe(false);
        });

        it('should NOT include tilt topics in cover discovery payload when tilt app is not configured', () => {
            mockSettings.ha_discovery_cover_app_id = '203';
            mockSettings.ha_discovery_cover_tilt_app_id = null;
            haDiscovery = new HaDiscovery(mockSettings, mockPublishFn, mockSendCommandFn);

            haDiscovery._publishDiscoveryFromTree('254', tiltTreeData);

            const coverCall = mockPublishFn.mock.calls.find(
                call => call[0] === 'testhomeassistant/cover/cgateweb_254_203_5/config'
            );
            expect(coverCall).toBeDefined();

            const payload = JSON.parse(coverCall[1]);
            expect(payload.tilt_status_topic).toBeUndefined();
            expect(payload.tilt_command_topic).toBeUndefined();
            expect(payload.tilt_min).toBeUndefined();
            expect(payload.tilt_max).toBeUndefined();
        });

        it('should not publish standalone discovery entities for tilt app groups', () => {
            mockSettings.ha_discovery_cover_app_id = '203';
            mockSettings.ha_discovery_cover_tilt_app_id = '204';
            haDiscovery = new HaDiscovery(mockSettings, mockPublishFn, mockSendCommandFn);

            haDiscovery._publishDiscoveryFromTree('254', tiltTreeData);

            // Tilt app groups must NOT produce standalone entities
            const tiltCoverCall = mockPublishFn.mock.calls.find(
                call => typeof call[0] === 'string' && call[0].includes('cgateweb_254_204_')
            );
            expect(tiltCoverCall).toBeUndefined();
        });

        it('should include tilt topics for group 6 (paired by group number)', () => {
            mockSettings.ha_discovery_cover_app_id = '203';
            mockSettings.ha_discovery_cover_tilt_app_id = '204';
            haDiscovery = new HaDiscovery(mockSettings, mockPublishFn, mockSendCommandFn);

            haDiscovery._publishDiscoveryFromTree('254', tiltTreeData);

            const coverCall = mockPublishFn.mock.calls.find(
                call => call[0] === 'testhomeassistant/cover/cgateweb_254_203_6/config'
            );
            expect(coverCall).toBeDefined();

            const payload = JSON.parse(coverCall[1]);
            expect(payload.tilt_status_topic).toBe('cbus/read/254/204/6/tilt');
            expect(payload.tilt_command_topic).toBe('cbus/write/254/204/6/tilt');
        });
    });
});