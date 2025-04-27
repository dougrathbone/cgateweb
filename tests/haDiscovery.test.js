// tests/haDiscovery.test.js

// Import necessary classes/functions
const { CgateWebBridge, settings: defaultSettings } = require('../index.js');
const EventEmitter = require('events'); 

// --- Mock Modules ---
let parseStringResolver; 
let mockParseStringResult = null; // Variable to hold mock result
let mockParseStringError = null; // Variable to hold mock error

let mockParseStringFn = jest.fn((xml, options, callback) => {
    // Default mock implementation using the variables
    callback(mockParseStringError, mockParseStringResult);
    if (parseStringResolver) {
        parseStringResolver();
        parseStringResolver = null;
    }
});
jest.mock('xml2js', () => ({
    parseString: (...args) => mockParseStringFn(...args) 
}));

const mockMqttClient = new EventEmitter(); 
mockMqttClient.connect = jest.fn(); 
mockMqttClient.subscribe = jest.fn((topic, options, callback) => callback ? callback(null) : null);
mockMqttClient.publish = jest.fn();
mockMqttClient.end = jest.fn();
mockMqttClient.removeAllListeners = jest.fn();
mockMqttClient.on = jest.fn(); 
jest.mock('mqtt', () => ({
    connect: jest.fn(() => mockMqttClient) 
}));

// Mock console methods 
const mockConsoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => { });
const mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => { });

afterAll(() => {
    mockConsoleWarn.mockRestore();
    mockConsoleError.mockRestore();
});

// --- Define Mock Data at Top Level --- 
const MOCK_TREEXML_RESULT_NET254 = {
     Network: {
         Interface: {
             Network: {
                 NetworkNumber: '254',
                 Unit: [
                    {
                        UnitAddress: '1',
                        Application: {
                            Lighting: {
                                ApplicationAddress: '56',
                                Group: [
                                    { GroupAddress: '10', Label: 'Kitchen Main'},
                                    { GroupAddress: '11', Label: 'Dining' } 
                                ],
                                EnableControl: { // Nested EnableControl (Covers)
                                    ApplicationAddress: '203',
                                    Group: [
                                        { GroupAddress: '15', Label: 'Blind 1' },
                                        { GroupAddress: '16' } 
                                    ]
                                }
                            }
                        }
                    },
                    {
                        UnitAddress: '2',
                        Application: {
                             SomeOtherApp: { Group: { GroupAddress: '100' } }
                        }
                    },
                     {
                         UnitAddress: '3',
                         Application: {
                             Lighting: {
                                 ApplicationAddress: '56',
                                 Group: { GroupAddress: '12', Label: 'Lounge Dimmer' }
                             }
                         }
                     },
                    {
                        UnitAddress: '4',
                        Application: { // Top-Level EnableControl (Switches/Relays)
                             EnableControl: {
                                 ApplicationAddress: '203', 
                                 Group: [
                                     { GroupAddress: '20', Label: 'Relay Switch' },
                                     { GroupAddress: '21' } 
                                 ]
                             }
                        }
                    }
                ]
            }
        }
    }
};
const MOCK_TREEXML_RESULT_MALFORMED = { Network: {} };
// --- End Mock Data Definition ---

// --- HA Discovery Tests (extracted from cgateWebBridge.test.js) ---
describe('CgateWebBridge - Home Assistant Discovery', () => {
    let bridge;
    let mockSettings;
    let mockCmdSocketFactory, mockEvtSocketFactory;
    let lastMockCmdSocket, lastMockEvtSocket;

    beforeEach(() => {
        mockMqttClient.removeAllListeners.mockClear();
        mockMqttClient.subscribe.mockClear();
        mockMqttClient.publish.mockClear();
        mockMqttClient.end.mockClear();
        mockMqttClient.on.mockClear();
        const mqtt = require('mqtt');
        mqtt.connect.mockClear();

        mockSettings = { ...defaultSettings }; 
        mockSettings.logging = false;
        mockSettings.messageinterval = 10; 
        mockSettings.reconnectinitialdelay = 10;
        mockSettings.reconnectmaxdelay = 100;

        lastMockCmdSocket = null;
        lastMockEvtSocket = null;
        mockCmdSocketFactory = jest.fn(() => {
            const socket = new EventEmitter();
            socket.connect = jest.fn();
            socket.write = jest.fn();
            socket.destroy = jest.fn();
            socket.removeAllListeners = jest.fn();
            socket.on = jest.fn(); 
            socket.connecting = false; 
            socket.destroyed = false;  
            lastMockCmdSocket = socket; 
            return socket;
        });
        mockEvtSocketFactory = jest.fn(() => {
            const socket = new EventEmitter();
            socket.connect = jest.fn();
            socket.write = jest.fn(); 
            socket.destroy = jest.fn();
            socket.removeAllListeners = jest.fn();
            socket.on = jest.fn(); 
            socket.connecting = false;
            socket.destroyed = false;
            lastMockEvtSocket = socket; 
            return socket;
        });
        
        bridge = new CgateWebBridge(
            mockSettings,
            null, 
            mockCmdSocketFactory, 
            mockEvtSocketFactory
        );
    });

    afterEach(() => {
         jest.clearAllTimers();
         mockConsoleWarn.mockClear();
         mockConsoleError.mockClear();
         mockParseStringFn.mockClear();
         // Reset mock control variables
         mockParseStringResult = null;
         mockParseStringError = null;
     });
    
    describe('Home Assistant Discovery Logic', () => { 
        let mqttAddSpyHa; 
        let triggerHaDiscoverySpy;
        let consoleWarnSpyHa;
        let getTreeCommandSpy; 
        let parseStringResolver; // Moved here for wider scope
        let publishHaSpy; // Moved here for wider scope
        
        beforeEach(() => {
            // Setup spies specific to HA discovery logic
            bridge.settings.ha_discovery_enabled = true;
            bridge.settings.ha_discovery_prefix = 'testhomeassistant';
            bridge.settings.ha_discovery_networks = ['254']; 
            mqttAddSpyHa = jest.spyOn(bridge.mqttPublishQueue, 'add');
            triggerHaDiscoverySpy = jest.spyOn(bridge, '_triggerHaDiscovery');
            getTreeCommandSpy = jest.spyOn(bridge.cgateCommandQueue, 'add');
            consoleWarnSpyHa = jest.spyOn(console, 'warn').mockImplementation(() => {});
            publishHaSpy = jest.spyOn(bridge, '_publishHaDiscoveryFromTree'); // Define spy here
            bridge.treeNetwork = null;
            parseStringResolver = null; 
        });

        afterEach(() => {
            mqttAddSpyHa.mockRestore();
            triggerHaDiscoverySpy.mockRestore();
            getTreeCommandSpy.mockRestore();
            consoleWarnSpyHa.mockRestore();
            publishHaSpy.mockRestore(); // Restore spy
            parseStringResolver = null;
            mockParseStringFn.mockClear(); // Clear the mock function itself
        });
        
        // Tests for _checkAllConnected, _triggerHaDiscovery, manual trigger
        // ... these tests should be fine here as they don't directly use MOCK_TREEXML_RESULT_NET254
        it('_checkAllConnected should call _triggerHaDiscovery if enabled', () => {
            bridge.clientConnected = true;
            bridge.commandConnected = true;
            bridge.eventConnected = true;
            bridge._checkAllConnected();
            expect(triggerHaDiscoverySpy).toHaveBeenCalledTimes(1);
        });
        
        it('_checkAllConnected should NOT call _triggerHaDiscovery if disabled', () => {
             bridge.settings.ha_discovery_enabled = false; 
             bridge.clientConnected = true;
             bridge.commandConnected = true;
             bridge.eventConnected = true;
             bridge._checkAllConnected();
             expect(triggerHaDiscoverySpy).not.toHaveBeenCalled();
         });
         
         it('_triggerHaDiscovery should queue TREEXML for configured networks', () => {
            bridge.settings.ha_discovery_networks = ['254', '200'];
            bridge._triggerHaDiscovery();
            expect(getTreeCommandSpy).toHaveBeenCalledWith('TREEXML 254\n');
            expect(getTreeCommandSpy).toHaveBeenCalledWith('TREEXML 200\n');
            expect(getTreeCommandSpy).toHaveBeenCalledTimes(2);
         });
         
         it('_triggerHaDiscovery should use getallnetapp network if discovery networks empty', () => {
             bridge.settings.ha_discovery_networks = [];
             bridge.settings.getallnetapp = '254/56';
             bridge._triggerHaDiscovery();
             expect(getTreeCommandSpy).toHaveBeenCalledWith('TREEXML 254\n');
             expect(getTreeCommandSpy).toHaveBeenCalledTimes(1);
         });
         
          it('_triggerHaDiscovery should warn and return if no networks configured/derivable', () => {
              bridge.settings.ha_discovery_networks = [];
              bridge.settings.getallnetapp = null; 
              bridge._triggerHaDiscovery();
              expect(getTreeCommandSpy).not.toHaveBeenCalled();
              expect(consoleWarnSpyHa).toHaveBeenCalledWith(expect.stringContaining('No HA discovery networks configured'));
          });
         
         it('Manual trigger should call _triggerHaDiscovery if enabled', () => {
             const topic = 'cbus/write/bridge/announce';
             bridge._handleMqttMessage(topic, Buffer.from(''));
             expect(triggerHaDiscoverySpy).toHaveBeenCalledTimes(1);
         });
         
          it('Manual trigger should warn if HA discovery disabled', () => {
              bridge.settings.ha_discovery_enabled = false;
              const topic = 'cbus/write/bridge/announce';
              bridge._handleMqttMessage(topic, Buffer.from(''));
              expect(triggerHaDiscoverySpy).not.toHaveBeenCalled();
              expect(consoleWarnSpyHa).toHaveBeenCalledWith(expect.stringContaining('Manual HA Discovery trigger received, but feature is disabled'));
          });

        // Malformed/Error handling for the whole tree
        it('_publishHaDiscoveryFromTree should handle malformed XML data gracefully', () => {
             bridge._publishHaDiscoveryFromTree('254', MOCK_TREEXML_RESULT_MALFORMED);
             expect(mqttAddSpyHa).not.toHaveBeenCalled();
             expect(consoleWarnSpyHa).toHaveBeenCalledWith(expect.stringContaining('TreeXML for network 254 seems malformed'));
         });

        it('should handle TreeXML parsing error', async () => {
             let promise = new Promise(resolve => { parseStringResolver = resolve; });
             const bridgeErrorSpy = jest.spyOn(bridge, 'error').mockImplementation(() => {});
             mockParseStringFn.mockImplementationOnce((xml, options, callback) => {
                 callback(new Error('XML parse error'), null);
                 if (parseStringResolver) { parseStringResolver(); parseStringResolver = null; }
             });
             bridge.treeNetwork = '200';
             bridge._handleCommandData(Buffer.from('343-200\n'));
             bridge._handleCommandData(Buffer.from('347-<bad xml\n'));
             bridge._handleCommandData(Buffer.from('344-200\n'));
             await promise;
             expect(mockParseStringFn).toHaveBeenCalled();
             expect(bridgeErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error parsing TreeXML for network 200 (took '), expect.any(Error));
             expect(mqttAddSpyHa).not.toHaveBeenCalled(); 
             expect(bridge.treeBuffer).toBe('');
             expect(bridge.treeNetwork).toBeNull();
             bridgeErrorSpy.mockRestore();
         });

        describe('_publishHaDiscoveryFromTree Specific Payloads', () => {
            // Tests focused specifically on processing MOCK_TREEXML_RESULT_NET254
            
            it('should publish correct config for LIGHTING groups', () => {
                bridge._publishHaDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);
                expect(mqttAddSpyHa).toHaveBeenCalledTimes(7); // 3 lights + 4 covers (default)
                expect(mqttAddSpyHa).toHaveBeenCalledWith(expect.objectContaining({ topic: 'testhomeassistant/light/cgateweb_254_56_10/config'}));
                 // ... other light assertions ...
            });
            
            it('should publish correct config for SWITCH groups if configured', () => {
                 bridge.settings.ha_discovery_switch_app_id = '203';
                 bridge.settings.ha_discovery_cover_app_id = null; 
                 bridge._publishHaDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);
                 expect(mqttAddSpyHa).toHaveBeenCalledTimes(7); // 3 lights + 4 groups published as switches 
                 expect(mqttAddSpyHa).toHaveBeenCalledWith(expect.objectContaining({ topic: 'testhomeassistant/switch/cgateweb_254_203_20/config' }));
                 // ... other switch assertions ...
             });

            it('should publish correct config for COVER groups if configured (default)', () => {
                 // Uses default settings where coverAppId = '203'
                 bridge._publishHaDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);
                 expect(mqttAddSpyHa).toHaveBeenCalledTimes(7); // 3 lights + 4 covers
                 expect(mqttAddSpyHa).toHaveBeenCalledWith(expect.objectContaining({ topic: 'testhomeassistant/cover/cgateweb_254_203_15/config' }));
                 // ... other cover assertions ...
            });

             it('should publish correct config for RELAY groups if configured', () => {
                 bridge.settings.ha_discovery_relay_app_id = '203';
                 bridge.settings.ha_discovery_cover_app_id = null;
                 bridge.settings.ha_discovery_switch_app_id = null;
                 bridge._publishHaDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);
                 expect(mqttAddSpyHa).toHaveBeenCalledTimes(7); // 3 lights + 4 groups published as relays (switch component)
                 expect(mqttAddSpyHa).toHaveBeenCalledWith(expect.objectContaining({ topic: 'testhomeassistant/switch/cgateweb_254_203_20/config' }));
                 // ... other relay assertions ...
            });

            it('should publish correct config for PIR Motion Sensor groups if configured', () => {
                bridge.settings.ha_discovery_pir_app_id = '203'; // Use 203 for PIR in this test
                bridge.settings.ha_discovery_cover_app_id = null; 
                bridge.settings.ha_discovery_switch_app_id = null;
                bridge.settings.ha_discovery_relay_app_id = null;
                
                bridge._publishHaDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);
                
                // Expect 3 lights + 4 PIRs = 7 calls
                expect(mqttAddSpyHa).toHaveBeenCalledTimes(7); 
                
                // Check one PIR payload (Group 15, originally a cover)
                expect(mqttAddSpyHa).toHaveBeenCalledWith(expect.objectContaining({
                    topic: 'testhomeassistant/binary_sensor/cgateweb_254_203_15/config'
                }));
                const payload15 = JSON.parse(mqttAddSpyHa.mock.calls.find(call => call[0].topic.includes('_203_15'))[0].payload);
                expect(payload15.name).toBe('Blind 1');
                expect(payload15.device_class).toBe('motion');
                expect(payload15.device.model).toBe('PIR Motion Sensor'); // Correct assertion

                 // Check another PIR payload (Group 20, originally a switch/relay)
                 expect(mqttAddSpyHa).toHaveBeenCalledWith(expect.objectContaining({
                    topic: 'testhomeassistant/binary_sensor/cgateweb_254_203_20/config'
                }));
                 const payload20 = JSON.parse(mqttAddSpyHa.mock.calls.find(call => call[0].topic.includes('_203_20'))[0].payload);
                 expect(payload20.name).toBe('Relay Switch');
                 expect(payload20.device_class).toBe('motion');
                 expect(payload20.device.model).toBe('PIR Motion Sensor'); // Correct assertion
            });
            
            it('should NOT publish PIR if pir app ID is null (default)', () => {
                bridge.settings.ha_discovery_pir_app_id = null; // Default
                bridge._publishHaDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);
                // Expect 7 calls based on default settings (3 lights + 4 covers)
                expect(mqttAddSpyHa).toHaveBeenCalledTimes(7); 
                expect(mqttAddSpyHa).not.toHaveBeenCalledWith(expect.objectContaining({
                    topic: expect.stringContaining('/binary_sensor/')
                }));
            });

            it('_publishHaDiscoveryFromTree should use fallback name if label missing (light)', () => {
                 const mockDataNoLabel = JSON.parse(JSON.stringify(MOCK_TREEXML_RESULT_NET254));
                 delete mockDataNoLabel.Network.Interface.Network.Unit[0].Application.Lighting.Group[0].Label; 
                 bridge._publishHaDiscoveryFromTree('254', mockDataNoLabel);
                 expect(mqttAddSpyHa).toHaveBeenCalledTimes(7); // Call count remains 7
                 const payload10 = JSON.parse(mqttAddSpyHa.mock.calls.find(call => call[0].topic.includes('_56_10'))[0].payload);
                 expect(payload10.name).toBe('CBus Light 254/56/10'); 
             });
             
             // ... other specific payload processing tests ...
        }); // <<< END describe _publishHaDiscoveryFromTree Specific Payloads
        
        // Test for HA Discovery triggered by _handleCommandData 
        it('_handleCommandData should trigger HA discovery after parsing TREEXML', async () => {
          bridge.settings.ha_discovery_enabled = true;
          bridge.settings.ha_discovery_networks = ['254'];
          // Use default settings (cover=203, switch=null, relay=null)
          const queueAddSpy = jest.spyOn(bridge.mqttPublishQueue, 'add');
          
          // Set up mock specifically for this test, including resolver
          let resolverFunc;
          const promise = new Promise(resolve => { resolverFunc = resolve; });
          mockParseStringFn.mockImplementationOnce((xml, options, callback) => {
              callback(null, MOCK_TREEXML_RESULT_NET254); // Use mock data directly
              if(resolverFunc) resolverFunc(); // Resolve the promise
          });

          bridge.treeNetwork = '254';
          bridge.treeBuffer = '<Network>...</Network>';
          
          // Trigger the action
          bridge._handleCommandData(Buffer.from('344-254\n'));
          
          // Wait for the async callback to resolve
          await promise;
          
          // Check that _publishHaDiscoveryFromTree was called correctly
          expect(publishHaSpy).toHaveBeenCalledWith('254', MOCK_TREEXML_RESULT_NET254);
          
          // Check that at least one expected discovery message was queued 
          expect(queueAddSpy).toHaveBeenCalledWith(
              expect.objectContaining({ topic: expect.stringContaining('testhomeassistant/light/cgateweb_254_56_10/config') })
          );
           expect(queueAddSpy).toHaveBeenCalledWith(
               expect.objectContaining({ topic: expect.stringContaining('testhomeassistant/cover/cgateweb_254_203_15/config') })
           );
           // Also check the standard tree message was published
           expect(queueAddSpy).toHaveBeenCalledWith(
                expect.objectContaining({ topic: 'cbus/read/254///tree' })
           );
          queueAddSpy.mockRestore();
      });

    }); // End describe Home Assistant Discovery Logic

}); // End describe CgateWebBridge - Home Assistant Discovery 