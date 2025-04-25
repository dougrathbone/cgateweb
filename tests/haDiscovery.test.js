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
            expect(mqttAddSpyHa).toHaveBeenCalledTimes(3); 
            expect(mqttAddSpyHa).toHaveBeenCalledWith(expect.objectContaining({
                topic: 'testhomeassistant/light/cgateweb_254_56_10/config',
                options: { retain: true, qos: 0 }
            }));
            const payload10 = JSON.parse(mqttAddSpyHa.mock.calls[0][0].payload);
            expect(payload10.name).toBe('Kitchen Main');
            expect(payload10.unique_id).toBe('cgateweb_254_56_10');
             expect(mqttAddSpyHa).toHaveBeenCalledWith(expect.objectContaining({
                 topic: 'testhomeassistant/light/cgateweb_254_56_11/config',
             }));
             const payload11 = JSON.parse(mqttAddSpyHa.mock.calls[1][0].payload);
             expect(payload11.name).toBe('Dining');
             expect(payload11.unique_id).toBe('cgateweb_254_56_11');
            expect(mqttAddSpyHa).toHaveBeenCalledWith(expect.objectContaining({
                topic: 'testhomeassistant/light/cgateweb_254_56_12/config',
            }));
             const payload12 = JSON.parse(mqttAddSpyHa.mock.calls[2][0].payload);
             expect(payload12.name).toBe('Lounge Dimmer');
             expect(payload12.unique_id).toBe('cgateweb_254_56_12');
        });
        
        it('_publishHaDiscoveryFromTree should use fallback name if label missing', () => {
            const mockDataNoLabel = JSON.parse(JSON.stringify(MOCK_TREEXML_RESULT_NET254));
            delete mockDataNoLabel.Network.Interface.Network.Unit[0].Application.Lighting.Group[0].Label; 
            bridge._publishHaDiscoveryFromTree('254', mockDataNoLabel);
            expect(mqttAddSpyHa).toHaveBeenCalledTimes(3);
            const payload10 = JSON.parse(mqttAddSpyHa.mock.calls[0][0].payload);
            expect(payload10.name).toBe('CBus Light 254/56/10'); 
        });

        it('_publishHaDiscoveryFromTree should handle malformed XML data gracefully', () => {
             bridge._publishHaDiscoveryFromTree('254', MOCK_TREEXML_RESULT_MALFORMED);
             expect(mqttAddSpyHa).not.toHaveBeenCalled();
             expect(consoleWarnSpyHa).toHaveBeenCalledWith(expect.stringContaining('TreeXML for network 254 seems malformed'));
         });
         
         it('_publishHaDiscoveryFromTree should handle errors during processing (e.g., missing GroupAddress)', () => {
            const badData = { Network: { Interface: { Network: { NetworkNumber: '254', Unit: [{ Application: { Lighting: { Group: {} } } }] } } } };
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

    });

}); 