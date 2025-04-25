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

// --- HA Discovery Tests (extracted from cgateWebBridge.test.js) ---
describe('CgateWebBridge - Home Assistant Discovery', () => {
    let bridge;
    let mockSettings;
    let mockCmdSocketFactory, mockEvtSocketFactory;
    let lastMockCmdSocket, lastMockEvtSocket;

    // Recreate the necessary bridge setup from the original file's beforeEach
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
    
    // --- Test HA Discovery --- 
    // Copied describe block from original file
    describe('Home Assistant Discovery Logic', () => { 
        let mqttAddSpyHa; 
        let triggerHaDiscoverySpy;
        let consoleWarnSpyHa;
        let getTreeCommandSpy; 
        
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
                                        // Add Enable Control App for Cover test
                                        EnableControl: {
                                            ApplicationAddress: '203',
                                            Group: [
                                                { GroupAddress: '15', Label: 'Blind 1' },
                                                { GroupAddress: '16' } // No label
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
                                // Unit with only Enable Control for switch test
                                UnitAddress: '4',
                                Application: {
                                     EnableControl: {
                                         ApplicationAddress: '203', // Assume switch uses 203 for this test
                                         Group: [
                                             { GroupAddress: '20', Label: 'Relay Switch' },
                                             { GroupAddress: '21' } // No label switch
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
        
        beforeEach(() => {
            bridge.settings.ha_discovery_enabled = true;
            bridge.settings.ha_discovery_prefix = 'testhomeassistant';
            bridge.settings.ha_discovery_networks = ['254']; 
            
            mqttAddSpyHa = jest.spyOn(bridge.mqttPublishQueue, 'add');
            triggerHaDiscoverySpy = jest.spyOn(bridge, '_triggerHaDiscovery');
            getTreeCommandSpy = jest.spyOn(bridge.cgateCommandQueue, 'add');
            consoleWarnSpyHa = jest.spyOn(console, 'warn').mockImplementation(() => {});
            bridge.treeNetwork = null;
            // Set default mock parseString result for most tests in this block
            mockParseStringResult = MOCK_TREEXML_RESULT_NET254;
            mockParseStringError = null;
        });

        afterEach(() => {
            mqttAddSpyHa.mockRestore();
            triggerHaDiscoverySpy.mockRestore();
            getTreeCommandSpy.mockRestore();
            consoleWarnSpyHa.mockRestore();
        });
        
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

        it('_publishHaDiscoveryFromTree should publish correct config for each lighting group', () => {
            bridge._publishHaDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);
            // Expect 7 calls now (3 lights + 2 covers + 2 switches/relays from default mock data)
            expect(mqttAddSpyHa).toHaveBeenCalledTimes(7); 
            expect(mqttAddSpyHa).toHaveBeenCalledWith(expect.objectContaining({
                topic: 'testhomeassistant/light/cgateweb_254_56_10/config',
                options: { retain: true, qos: 0 }
            }));
            const payload10 = JSON.parse(mqttAddSpyHa.mock.calls.find(call => call[0].topic.includes('_56_10'))[0].payload);
            expect(payload10.name).toBe('Kitchen Main');
            expect(payload10.unique_id).toBe('cgateweb_254_56_10');
             expect(mqttAddSpyHa).toHaveBeenCalledWith(expect.objectContaining({
                 topic: 'testhomeassistant/light/cgateweb_254_56_11/config',
             }));
             const payload11 = JSON.parse(mqttAddSpyHa.mock.calls.find(call => call[0].topic.includes('_56_11'))[0].payload);
             expect(payload11.name).toBe('Dining');
             expect(payload11.unique_id).toBe('cgateweb_254_56_11');
            expect(mqttAddSpyHa).toHaveBeenCalledWith(expect.objectContaining({
                topic: 'testhomeassistant/light/cgateweb_254_56_12/config',
            }));
             // Find payload by unique ID instead of index
             const payload12 = JSON.parse(mqttAddSpyHa.mock.calls.find(call => call[0].topic.includes('_56_12'))[0].payload);
             expect(payload12.name).toBe('Lounge Dimmer');
             expect(payload12.unique_id).toBe('cgateweb_254_56_12');
        });
        
        it('_publishHaDiscoveryFromTree should use fallback name if label missing', () => {
            const mockDataNoLabel = JSON.parse(JSON.stringify(MOCK_TREEXML_RESULT_NET254));
            delete mockDataNoLabel.Network.Interface.Network.Unit[0].Application.Lighting.Group[0].Label; 
            bridge._publishHaDiscoveryFromTree('254', mockDataNoLabel);
            // Expect 7 calls still (covers still present, switches/relays present)
            expect(mqttAddSpyHa).toHaveBeenCalledTimes(7);
            const payload10 = JSON.parse(mqttAddSpyHa.mock.calls.find(call => call[0].topic.includes('_56_10'))[0].payload);
            expect(payload10.name).toBe('CBus Light 254/56/10'); 
        });

        it('_publishHaDiscoveryFromTree should handle malformed XML data gracefully', () => {
             bridge._publishHaDiscoveryFromTree('254', MOCK_TREEXML_RESULT_MALFORMED);
             expect(mqttAddSpyHa).not.toHaveBeenCalled();
             expect(consoleWarnSpyHa).toHaveBeenCalledWith(expect.stringContaining('TreeXML for network 254 seems malformed'));
         });
         
         it('_publishHaDiscoveryFromTree should handle errors during processing (e.g., missing GroupAddress)', () => {
            // Add ApplicationAddress to trigger the check
            const badData = { Network: { Interface: { Network: { NetworkNumber: '254', Unit: [{ Application: { Lighting: { ApplicationAddress: '56', Group: {} } } }] } } } };
            const consoleWarnSpyLocal = jest.spyOn(console, 'warn').mockImplementation(() => {}); // Local spy for warn
            const consoleErrorSpyLocal = jest.spyOn(console, 'error').mockImplementation(() => {});
            bridge._publishHaDiscoveryFromTree('254', badData);
            expect(mqttAddSpyHa).not.toHaveBeenCalled(); 
            expect(consoleWarnSpyLocal).toHaveBeenCalledWith(expect.stringContaining('Skipping lighting group in HA Discovery due to missing/invalid GroupAddress'), {}); 
            expect(consoleErrorSpyLocal).not.toHaveBeenCalled();
            consoleWarnSpyLocal.mockRestore();
            consoleErrorSpyLocal.mockRestore();
         });
         
          it('_handleCommandData should trigger HA discovery after parsing TREEXML', async () => {
              bridge.settings.ha_discovery_enabled = true;
              bridge.settings.ha_discovery_networks = ['254'];
              const queueAddSpy = jest.spyOn(bridge.mqttPublishQueue, 'add');
              let promise = new Promise(resolve => { parseStringResolver = resolve; });
              bridge.treeNetwork = '254'; 
              bridge.treeBuffer = '<Network>...</Network>';
              bridge._handleCommandData(Buffer.from('344-254\n'));
              await promise;

              // Assert that queueAddSpy was called with the HA discovery topic among its calls
              const expectedDiscoveryTopic = 'testhomeassistant/light/cgateweb_254_56_10/config';
              const receivedCalls = queueAddSpy.mock.calls;
              
              // Check if *any* call's arguments array contains the expected object shape
              expect(receivedCalls).toEqual(
                  expect.arrayContaining([
                      [ // Match the arguments array of a call
                          expect.objectContaining({ // Where the first argument is an object containing...
                               topic: expect.stringContaining(expectedDiscoveryTopic) // ...the HA topic
                           })
                      ]
                  ])
              );
              
              queueAddSpy.mockRestore();
          });
          
           it('_handleCommandData should NOT trigger HA discovery if disabled', async () => {
               bridge.settings.ha_discovery_enabled = false; 
               const queueAddSpy = jest.spyOn(bridge.mqttPublishQueue, 'add');
               let promise = new Promise(resolve => { parseStringResolver = resolve; });
               bridge.treeNetwork = '254';
               bridge.treeBuffer = '<Network>...</Network>';
               bridge._handleCommandData(Buffer.from('344-254\n'));
               await promise;
               expect(queueAddSpy).toHaveBeenCalledWith(expect.objectContaining({
                    topic: 'cbus/read/254///tree'
               }));
               expect(queueAddSpy).not.toHaveBeenCalledWith(expect.objectContaining({
                   topic: expect.stringContaining('testhomeassistant/light/')
               }));
               queueAddSpy.mockRestore();
           });
           
            it('_handleCommandData should NOT trigger HA discovery if network not in allowed list', async () => {
                bridge.settings.ha_discovery_networks = ['200']; 
                const queueAddSpy = jest.spyOn(bridge.mqttPublishQueue, 'add');
                let promise = new Promise(resolve => { parseStringResolver = resolve; });
                bridge.treeNetwork = '254'; 
                bridge.treeBuffer = '<Network>...</Network>';
                bridge._handleCommandData(Buffer.from('344-254\n'));
                await promise;
                expect(queueAddSpy).toHaveBeenCalledWith(expect.objectContaining({
                     topic: 'cbus/read/254///tree'
                }));
                expect(queueAddSpy).not.toHaveBeenCalledWith(expect.objectContaining({
                    topic: expect.stringContaining('testhomeassistant/light/')
                }));
                queueAddSpy.mockRestore();
            });

        // Add TreeXML error test back (was in cgateWebBridge before)
         it('should handle TreeXML parsing error', async () => {
             let promise = new Promise(resolve => { parseStringResolver = resolve; });
             // Spy on the bridge's internal error method for this test
             const bridgeErrorSpy = jest.spyOn(bridge, 'error').mockImplementation(() => {});
             
             // Set specific mock implementation for this test to trigger error
             mockParseStringFn.mockImplementationOnce((xml, options, callback) => {
                 callback(new Error('XML parse error'), null);
                 if (parseStringResolver) {
                     parseStringResolver();
                     parseStringResolver = null;
                 }
             });
             
             bridge.treeNetwork = '200';
             bridge._handleCommandData(Buffer.from('343-200\n'));
             bridge._handleCommandData(Buffer.from('347-<bad xml\n'));
             bridge._handleCommandData(Buffer.from('344-200\n'));

             await promise;

             expect(mockParseStringFn).toHaveBeenCalled();
             // Check the bridge's error method was called
             expect(bridgeErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error parsing TreeXML for network 200:'), expect.any(Error));
             expect(mqttAddSpyHa).not.toHaveBeenCalled(); 
             expect(bridge.treeBuffer).toBe('');
             expect(bridge.treeNetwork).toBeNull();
             
             // Restore the specific spy
             bridgeErrorSpy.mockRestore();
         });

        // --- _publishHaDiscoveryFromTree Tests --- 
        describe('_publishHaDiscoveryFromTree', () => {
            it('should publish correct config for LIGHTING groups', () => {
                bridge._publishHaDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);
                // Check LIGHT payloads 
                // Expect 7 calls now (3 lights + 2 covers + 2 switches/relays)
                expect(mqttAddSpyHa).toHaveBeenCalledTimes(7); 
                expect(mqttAddSpyHa).toHaveBeenCalledWith(expect.objectContaining({
                    topic: 'testhomeassistant/light/cgateweb_254_56_10/config'
                }));
                // ... other light assertions ...
                 expect(mqttAddSpyHa).toHaveBeenCalledWith(expect.objectContaining({
                     topic: 'testhomeassistant/light/cgateweb_254_56_12/config'
                 }));
            });
            
            it('should publish correct config for SWITCH groups if configured', () => {
                bridge.settings.ha_discovery_switch_app_id = '203'; // Enable switch discovery for App 203
                bridge.settings.ha_discovery_cover_app_id = null; // Disable cover discovery for this test
                bridge._publishHaDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);
                
                // Check SWITCH payloads (should find 2 switches now)
                expect(mqttAddSpyHa).toHaveBeenCalledWith(expect.objectContaining({
                    topic: 'testhomeassistant/switch/cgateweb_254_203_20/config'
                }));
                const payload20 = JSON.parse(mqttAddSpyHa.mock.calls.find(call => call[0].topic.includes('_203_20'))[0].payload);
                expect(payload20.name).toBe('Relay Switch');
                expect(payload20.unique_id).toBe('cgateweb_254_203_20');
                expect(payload20.command_topic).toBe('cbus/write/254/203/20/switch');
                expect(payload20.state_topic).toBe('cbus/read/254/203/20/state');
                expect(payload20.payload_on).toBe('ON');
                expect(payload20.payload_off).toBe('OFF');
                expect(payload20.state_on).toBe('ON');
                expect(payload20.state_off).toBe('OFF');
                // Check the second switch (group 21)
                 expect(mqttAddSpyHa).toHaveBeenCalledWith(expect.objectContaining({
                     topic: 'testhomeassistant/switch/cgateweb_254_203_21/config'
                 }));
                 // Total = 3 lights + 2 covers (published as switches) + 2 switches = 7 calls
                 expect(mqttAddSpyHa).toHaveBeenCalledTimes(7); 
            });
            
            it('should use fallback name for SWITCH if label missing', () => {
                 bridge.settings.ha_discovery_switch_app_id = '203';
                 bridge.settings.ha_discovery_cover_app_id = null; // Disable cover discovery
                 bridge._publishHaDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);
                 expect(mqttAddSpyHa).toHaveBeenCalledWith(expect.objectContaining({
                      topic: 'testhomeassistant/switch/cgateweb_254_203_21/config' // Group 21 had no label
                  }));
                 const payload21 = JSON.parse(mqttAddSpyHa.mock.calls.find(call => call[0].topic.includes('_203_21'))[0].payload);
                 expect(payload21.name).toBe('CBus Switch 254/203/21'); // Check fallback
                 // Expect 7 calls (3 lights + 2 covers published as switches + 2 switches)
                 expect(mqttAddSpyHa).toHaveBeenCalledTimes(7);
             });

            it('should publish combined total for lights, covers, and switches', () => {
                 bridge.settings.ha_discovery_switch_app_id = '203'; // Enable switches
                 // Keep coverAppId enabled (default = 203)
                 bridge._publishHaDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);
                 // Now expects 3 lights + 2 covers + 2 switches (all published as covers due to precedence)
                 // Total devices found = 7. Covers take precedence for app 203. So 3 lights + 4 covers = 7 published.
                 expect(mqttAddSpyHa).toHaveBeenCalledTimes(7); 
             });

            it('should publish combined total for lights and switches only', () => {
                 bridge.settings.ha_discovery_switch_app_id = '203'; // Enable switches
                 bridge.settings.ha_discovery_cover_app_id = null; // Disable covers
                 bridge._publishHaDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);
                 // Expect 7 calls: 3 lights + 2 covers (published as switches) + 2 switches
                 expect(mqttAddSpyHa).toHaveBeenCalledTimes(7); 
             });

            it('should publish combined total for lights and relays only', () => {
                 bridge.settings.ha_discovery_relay_app_id = '203'; // Enable relays
                 bridge.settings.ha_discovery_cover_app_id = null; // Disable covers
                 bridge.settings.ha_discovery_switch_app_id = null; // Disable switches
                 bridge._publishHaDiscoveryFromTree('254', MOCK_TREEXML_RESULT_NET254);
                 // Expect 7 calls: 3 lights + 2 covers (published as relays) + 2 switches (published as relays)
                 expect(mqttAddSpyHa).toHaveBeenCalledTimes(7); 
                 // Check that a relay topic was called (for one of the cover groups published as relay)
                 expect(mqttAddSpyHa).toHaveBeenCalledWith(expect.objectContaining({
                     topic: 'testhomeassistant/switch/cgateweb_254_203_15/config' // Check Group 15
                 }));
                 // Check that a relay topic was called (for one of the switch groups published as relay)
                  expect(mqttAddSpyHa).toHaveBeenCalledWith(expect.objectContaining({
                      topic: 'testhomeassistant/switch/cgateweb_254_203_20/config' // Check Group 20
                  }));
             });
             
            it('_publishHaDiscoveryFromTree should use fallback name if label missing (light)', () => {
                const mockDataNoLabel = JSON.parse(JSON.stringify(MOCK_TREEXML_RESULT_NET254));
                delete mockDataNoLabel.Network.Interface.Network.Unit[0].Application.Lighting.Group[0].Label; 
                bridge._publishHaDiscoveryFromTree('254', mockDataNoLabel);
                // Expect 7 calls still (covers still present, switches/relays present)
                expect(mqttAddSpyHa).toHaveBeenCalledTimes(7);
                const payload10 = JSON.parse(mqttAddSpyHa.mock.calls.find(call => call[0].topic.includes('_56_10'))[0].payload);
                expect(payload10.name).toBe('CBus Light 254/56/10'); 
            });
             
             // ... malformed/error tests ...
        });
        
        // ... _handleCommandData tests - update expected call count ...
         it('_handleCommandData should trigger HA discovery (lights, covers, switches) after parsing TREEXML', async () => {
              bridge.settings.ha_discovery_enabled = true;
              bridge.settings.ha_discovery_networks = ['254'];
              bridge.settings.ha_discovery_switch_app_id = '203'; // Enable switch discovery
              // Keep coverAppId enabled (default = 203)
              const queueAddSpy = jest.spyOn(bridge.mqttPublishQueue, 'add');
              let promise = new Promise(resolve => { parseStringResolver = resolve; });
              mockParseStringResult = MOCK_TREEXML_RESULT_NET254; // Use data with covers+switches
              mockParseStringError = null;
              bridge.treeNetwork = '254'; 
              bridge.treeBuffer = '<Network>...</Network>';
              bridge._handleCommandData(Buffer.from('344-254\n'));
              await promise;
              // Check for one of each type (cover should take precedence over switch for app 203)
              expect(queueAddSpy).toHaveBeenCalledWith(
                  expect.objectContaining({ topic: expect.stringContaining('testhomeassistant/light/cgateweb_254_56_10/config') })
              );
               expect(queueAddSpy).toHaveBeenCalledWith(
                   expect.objectContaining({ topic: expect.stringContaining('testhomeassistant/cover/cgateweb_254_203_15/config') })
               );
                // Switch should NOT be called because cover took precedence
                expect(queueAddSpy).not.toHaveBeenCalledWith(
                    expect.objectContaining({ topic: expect.stringContaining('testhomeassistant/switch/cgateweb_254_203_20/config') })
                );
               // Check standard tree 
               expect(queueAddSpy).toHaveBeenCalledWith(
                    expect.objectContaining({ topic: 'cbus/read/254///tree' })
               );
               // Total calls = 1 (tree) + 3 (lights) + 2 (covers) + 2 (switches/relays found but not published due to cover precedence) = 6 published
               // Corrected: Total calls = 1 (tree) + 7 devices = 8 calls
               expect(queueAddSpy).toHaveBeenCalledTimes(8);
              queueAddSpy.mockRestore();
          });
          
          // ... other _handleCommandData tests ...

    });

}); 