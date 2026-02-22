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
            expect(haDiscovery.treeBuffer).toBe('');
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
            
            expect(haDiscovery.treeBuffer).toBe('');
        });

        it('should accumulate tree data', () => {
            haDiscovery.handleTreeData('line1');
            haDiscovery.handleTreeData('line2');
            
            expect(haDiscovery.treeBuffer).toBe(`line1${NEWLINE}line2${NEWLINE}`);
        });

        it('should process tree end and publish discovery', () => {
            haDiscovery.treeNetwork = '254';
            haDiscovery.treeBuffer = '<xml>test</xml>';
            
            // Mock parseString to return our test data
            jest.spyOn(require('xml2js'), 'parseString').mockImplementation((xml, _opts, callback) => {
                callback(null, MOCK_TREEXML_RESULT_NET254);
            });

            haDiscovery.handleTreeEnd('Tree end');

            expect(mockPublishFn).toHaveBeenCalled();
            expect(haDiscovery.treeBuffer).toBe('');
            expect(haDiscovery.treeNetwork).toBeNull();
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
            haDiscovery.treeBuffer = 'invalid xml';
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
            expect(haDiscovery.treeBuffer).toBe('');
            
            haDiscovery.handleTreeData('data1');
            haDiscovery.handleTreeData('data2');
            expect(haDiscovery.treeBuffer).toBe(`data1${NEWLINE}data2${NEWLINE}`);
        });
    });
});