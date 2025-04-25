// tests/parser.test.js (Renamed from main-suite.test.js implicitly)

// Import necessary classes/functions
const { CBusEvent, CBusCommand, CgateWebBridge, settings: defaultSettings } = require('../index.js');
const xml2js = require('xml2js'); // Keep require for type info if needed, but mock it below

// --- Mock xml2js Module --- 
// We need a reference to the mocked parseString for verification
let mockParseStringFn = jest.fn();
jest.mock('xml2js', () => ({
    parseString: (...args) => mockParseStringFn(...args) // Delegate calls to our mock function
}));

// Mock console.warn for tests that expect warnings on invalid input
const mockConsoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => { });

// Restore console.warn after all tests in this file
afterAll(() => {
    mockConsoleWarn.mockRestore();
});

describe('CBusEvent Parsing', () => {
    beforeEach(() => {
        // Clear mocks before each test in this suite if needed
        mockConsoleWarn.mockClear();
    });

    it('should correctly parse a lighting ON event', () => {
        const eventData = 'lighting on 254/56/10  # OID etc.';
        const cbusEvent = new CBusEvent(eventData);
        expect(cbusEvent.isValid()).toBe(true);
        expect(cbusEvent.DeviceType()).toBe('lighting');
        expect(cbusEvent.Action()).toBe('on');
        expect(cbusEvent.Host()).toBe('254');
        expect(cbusEvent.Group()).toBe('56');
        expect(cbusEvent.Device()).toBe('10');
        expect(cbusEvent.Level()).toBe('100');
    });

    it('should correctly parse a lighting OFF event', () => {
        const eventData = 'lighting off 10/38/123'; // No extra OID info
        const cbusEvent = new CBusEvent(eventData);
        expect(cbusEvent.isValid()).toBe(true);
        expect(cbusEvent.DeviceType()).toBe('lighting');
        expect(cbusEvent.Action()).toBe('off');
        expect(cbusEvent.Host()).toBe('10');
        expect(cbusEvent.Group()).toBe('38');
        expect(cbusEvent.Device()).toBe('123');
        expect(cbusEvent.Level()).toBe('0');
    });

    it('should correctly parse a lighting RAMP event with level', () => {
        const eventData = 'lighting ramp 200/56/1 128'; // 128 = ~50%
        const cbusEvent = new CBusEvent(eventData);
        expect(cbusEvent.isValid()).toBe(true);
        expect(cbusEvent.DeviceType()).toBe('lighting');
        expect(cbusEvent.Action()).toBe('ramp');
        expect(cbusEvent.Host()).toBe('200');
        expect(cbusEvent.Group()).toBe('56');
        expect(cbusEvent.Device()).toBe('1');
        expect(cbusEvent.Level()).toBe('50');
    });

    it('should correctly parse a lighting RAMP event to 0', () => {
        const eventData = 'lighting ramp 200/56/2 0';
        const cbusEvent = new CBusEvent(eventData);
        expect(cbusEvent.isValid()).toBe(true);
        expect(cbusEvent.DeviceType()).toBe('lighting');
        expect(cbusEvent.Action()).toBe('ramp');
        expect(cbusEvent.Host()).toBe('200');
        expect(cbusEvent.Group()).toBe('56');
        expect(cbusEvent.Device()).toBe('2');
        expect(cbusEvent.Level()).toBe('0');
    });

     it('should correctly parse a lighting RAMP event to 255', () => {
         const eventData = 'lighting ramp 200/56/3 255';
         const cbusEvent = new CBusEvent(eventData);
         expect(cbusEvent.isValid()).toBe(true);
         expect(cbusEvent.DeviceType()).toBe('lighting');
         expect(cbusEvent.Action()).toBe('ramp');
         expect(cbusEvent.Host()).toBe('200');
         expect(cbusEvent.Group()).toBe('56');
         expect(cbusEvent.Device()).toBe('3');
         expect(cbusEvent.Level()).toBe('100');
     });

    // Test for command port responses that mimic events
    it('should parse a 300- lighting ON event (partially)', () => {
        // Note: CBusEvent is designed for event port format.
        // It parses this command-port format, but DeviceType will be incorrect.
        const eventData = '300-lighting on 254/56/9';
        const cbusEvent = new CBusEvent(eventData);
        expect(cbusEvent.isValid()).toBe(true); // It *is* considered valid by the parser logic
        expect(cbusEvent.DeviceType()).toBe('300-lighting'); // Assert the actual parsed value
        expect(cbusEvent.Action()).toBe('on');
        expect(cbusEvent.Host()).toBe('254');
        expect(cbusEvent.Group()).toBe('56');
        expect(cbusEvent.Device()).toBe('9');
        expect(cbusEvent.Level()).toBe('100');
        // It parses without warning because all basic fields are found
        expect(mockConsoleWarn).not.toHaveBeenCalled();
    });

    it('should handle malformed event data gracefully', () => {
        const eventData = 'this is not valid';
        const cbusEvent = new CBusEvent(eventData);
        expect(cbusEvent.isValid()).toBe(false);
        expect(cbusEvent.DeviceType()).toBeNull();
        expect(cbusEvent.Action()).toBeNull();
        expect(cbusEvent.Host()).toBeNull();
        expect(cbusEvent.Group()).toBeNull();
        expect(cbusEvent.Device()).toBeNull();
        expect(cbusEvent.Level()).toBe('0'); // Default level
        expect(mockConsoleWarn).toHaveBeenCalled();
    });

    it('should handle event data with missing parts gracefully', () => {
        const eventData = 'lighting on'; // Missing address
        const cbusEvent = new CBusEvent(eventData);
        expect(cbusEvent.isValid()).toBe(false);
        expect(mockConsoleWarn).toHaveBeenCalled();
    });
});

describe('CBusCommand Parsing', () => {
    beforeEach(() => {
        mockConsoleWarn.mockClear();
    });

    it('should correctly parse a switch ON command', () => {
        const topic = 'cbus/write/254/56/10/switch';
        const message = 'ON';
        const cbusCmd = new CBusCommand(topic, message);
        expect(cbusCmd.isValid()).toBe(true);
        expect(cbusCmd.Host()).toBe('254');
        expect(cbusCmd.Group()).toBe('56');
        expect(cbusCmd.Device()).toBe('10');
        expect(cbusCmd.CommandType()).toBe('switch');
        expect(cbusCmd.Message()).toBe('ON');
        expect(cbusCmd.Level()).toBe('100');
        expect(cbusCmd.RawLevel()).toBe(255);
        expect(cbusCmd.RampTime()).toBeNull();
    });

    it('should correctly parse a switch OFF command', () => {
        const topic = 'cbus/write/10/38/123/switch';
        const message = 'OFF';
        const cbusCmd = new CBusCommand(topic, message);
        expect(cbusCmd.isValid()).toBe(true);
        expect(cbusCmd.Host()).toBe('10');
        expect(cbusCmd.Group()).toBe('38');
        expect(cbusCmd.Device()).toBe('123');
        expect(cbusCmd.CommandType()).toBe('switch');
        expect(cbusCmd.Message()).toBe('OFF');
        expect(cbusCmd.Level()).toBe('0');
        expect(cbusCmd.RawLevel()).toBe(0);
        expect(cbusCmd.RampTime()).toBeNull();
    });

    it('should correctly parse a ramp level command', () => {
        const topic = 'cbus/write/200/56/1/ramp';
        const message = '50';
        const cbusCmd = new CBusCommand(topic, message);
        expect(cbusCmd.isValid()).toBe(true);
        expect(cbusCmd.Host()).toBe('200');
        expect(cbusCmd.Group()).toBe('56');
        expect(cbusCmd.Device()).toBe('1');
        expect(cbusCmd.CommandType()).toBe('ramp');
        expect(cbusCmd.Message()).toBe('50');
        expect(cbusCmd.Level()).toBe('50');
        expect(cbusCmd.RawLevel()).toBe(128); // ~50%
        expect(cbusCmd.RampTime()).toBeNull();
    });

    it('should correctly parse a ramp level,time command', () => {
        const topic = 'cbus/write/200/56/2/ramp';
        const message = '75,4s';
        const cbusCmd = new CBusCommand(topic, message);
        expect(cbusCmd.isValid()).toBe(true);
        expect(cbusCmd.Host()).toBe('200');
        expect(cbusCmd.Group()).toBe('56');
        expect(cbusCmd.Device()).toBe('2');
        expect(cbusCmd.CommandType()).toBe('ramp');
        expect(cbusCmd.Message()).toBe('75,4s');
        expect(cbusCmd.Level()).toBe('75');
        expect(cbusCmd.RawLevel()).toBe(191); // ~75%
        expect(cbusCmd.RampTime()).toBe('4s');
    });

     it('should correctly parse a ramp ON command', () => {
         const topic = 'cbus/write/200/56/3/ramp';
         const message = 'ON';
         const cbusCmd = new CBusCommand(topic, message);
         expect(cbusCmd.isValid()).toBe(true);
         expect(cbusCmd.CommandType()).toBe('ramp');
         expect(cbusCmd.Message()).toBe('ON');
         expect(cbusCmd.Level()).toBe('100');
         expect(cbusCmd.RawLevel()).toBe(255);
         expect(cbusCmd.RampTime()).toBeNull();
     });

     it('should correctly parse a ramp OFF command', () => {
         const topic = 'cbus/write/200/56/4/ramp';
         const message = 'OFF';
         const cbusCmd = new CBusCommand(topic, message);
         expect(cbusCmd.isValid()).toBe(true);
         expect(cbusCmd.CommandType()).toBe('ramp');
         expect(cbusCmd.Message()).toBe('OFF');
         expect(cbusCmd.Level()).toBe('0');
         expect(cbusCmd.RawLevel()).toBe(0);
         expect(cbusCmd.RampTime()).toBeNull();
     });

      it('should correctly parse a ramp INCREASE command', () => {
          const topic = 'cbus/write/200/56/5/ramp';
          const message = 'INCREASE';
          const cbusCmd = new CBusCommand(topic, message);
          expect(cbusCmd.isValid()).toBe(true);
          expect(cbusCmd.CommandType()).toBe('ramp');
          expect(cbusCmd.Message()).toBe('INCREASE');
          expect(cbusCmd.Level()).toBeNull(); // Cannot determine level from INCREASE alone
          expect(cbusCmd.RawLevel()).toBeNull();
          expect(cbusCmd.RampTime()).toBeNull();
      });

       it('should correctly parse a ramp DECREASE command', () => {
           const topic = 'cbus/write/200/56/6/ramp';
           const message = 'DECREASE';
           const cbusCmd = new CBusCommand(topic, message);
           expect(cbusCmd.isValid()).toBe(true);
           expect(cbusCmd.CommandType()).toBe('ramp');
           expect(cbusCmd.Message()).toBe('DECREASE');
           expect(cbusCmd.Level()).toBeNull();
           expect(cbusCmd.RawLevel()).toBeNull();
           expect(cbusCmd.RampTime()).toBeNull();
       });

    it('should correctly parse a getall command', () => {
        const topic = 'cbus/write/254/56//getall'; // Note empty device ID
        const message = '';
        const cbusCmd = new CBusCommand(topic, message);
        expect(cbusCmd.isValid()).toBe(true);
        expect(cbusCmd.Host()).toBe('254');
        expect(cbusCmd.Group()).toBe('56');
        expect(cbusCmd.Device()).toBe(''); // Device ID is empty
        expect(cbusCmd.CommandType()).toBe('getall');
        expect(cbusCmd.Message()).toBe('');
        expect(cbusCmd.Level()).toBeNull();
        expect(cbusCmd.RawLevel()).toBeNull();
        expect(cbusCmd.RampTime()).toBeNull();
    });

    it('should correctly parse a gettree command', () => {
        const topic = 'cbus/write/254///gettree'; // Empty group and device
        const message = null; // Test null message
        const cbusCmd = new CBusCommand(topic, message);
        expect(cbusCmd.isValid()).toBe(true);
        expect(cbusCmd.Host()).toBe('254');
        expect(cbusCmd.Group()).toBe('');
        expect(cbusCmd.Device()).toBe('');
        expect(cbusCmd.CommandType()).toBe('gettree');
        expect(cbusCmd.Message()).toBe('');
        expect(cbusCmd.Level()).toBeNull();
        expect(cbusCmd.RawLevel()).toBeNull();
        expect(cbusCmd.RampTime()).toBeNull();
    });

    it('should handle malformed topic (too few parts)', () => {
        const topic = 'cbus/write/254/56/switch'; // Missing device
        const message = 'ON';
        const cbusCmd = new CBusCommand(topic, message);
        expect(cbusCmd.isValid()).toBe(false);
        expect(cbusCmd.Host()).toBeNull();
        expect(mockConsoleWarn).toHaveBeenCalled();
    });

    it('should handle malformed topic (wrong prefix)', () => {
        const topic = 'cbus/read/254/56/10/switch';
        const message = 'ON';
        const cbusCmd = new CBusCommand(topic, message);
        expect(cbusCmd.isValid()).toBe(false);
        expect(mockConsoleWarn).toHaveBeenCalled();
    });

     it('should handle numeric ramp value greater than 100', () => {
         const topic = 'cbus/write/200/56/1/ramp';
         const message = '150';
         const cbusCmd = new CBusCommand(topic, message);
         expect(cbusCmd.isValid()).toBe(true);
         expect(cbusCmd.Level()).toBe('100'); // Should clamp to 100
         expect(cbusCmd.RawLevel()).toBe(255);
     });

      it('should handle numeric ramp value less than 0', () => {
          const topic = 'cbus/write/200/56/1/ramp';
          const message = '-50';
          const cbusCmd = new CBusCommand(topic, message);
          expect(cbusCmd.isValid()).toBe(true);
          expect(cbusCmd.Level()).toBe('0'); // Should clamp to 0
          expect(cbusCmd.RawLevel()).toBe(0);
      });

      it('should handle non-numeric ramp value gracefully', () => {
          const topic = 'cbus/write/200/56/1/ramp';
          const message = 'dim';
          const cbusCmd = new CBusCommand(topic, message);
          expect(cbusCmd.isValid()).toBe(true);
          expect(cbusCmd.Level()).toBeNull(); // Cannot determine level
          expect(cbusCmd.RawLevel()).toBeNull();
      });
});

// --- CgateWebBridge Tests ---
describe('CgateWebBridge', () => {
    let bridge;
    let mockSettings;

    // Reset mocks and setup default bridge before each test in this block
    beforeEach(() => {
        // Start with a copy of the actual defaults, ensure all needed keys are present
        mockSettings = { ...defaultSettings }; 
        // Override specific settings for testing purposes if needed
        mockSettings.logging = false;
        mockSettings.messageinterval = 10; // Use a short interval for tests
        mockSettings.reconnectinitialdelay = 10;
        mockSettings.reconnectmaxdelay = 100;
        
        // Create the bridge instance for tests in this block
        // Factories will be mocked in specific tests needing them
        bridge = new CgateWebBridge(mockSettings);
    });

    // Test Constructor and Initial State
    describe('Constructor & Initial State', () => {
        it('should initialize with correct default settings when passed empty object', () => {
            // Create bridge with empty settings, constructor should merge with internal defaults
            const bridgeWithDefaults = new CgateWebBridge({});
            // Check a few key defaults that should have been merged
            expect(bridgeWithDefaults.settings.mqtt).toBe(defaultSettings.mqtt);
            expect(bridgeWithDefaults.settings.cbusip).toBe(defaultSettings.cbusip);
            expect(bridgeWithDefaults.settings.messageinterval).toBe(defaultSettings.messageinterval);
            expect(bridgeWithDefaults.settings.retainreads).toBe(defaultSettings.retainreads);
            // Importantly, check that the queues were created without error
            expect(bridgeWithDefaults.mqttPublishQueue).toBeDefined();
            expect(bridgeWithDefaults.cgateCommandQueue).toBeDefined();
        });

        it('should correctly merge provided settings over defaults', () => {
            const userSettings = {
                mqtt: 'mqtt.example.com:1884', // Override
                logging: true,                 // Override
                messageinterval: 50,           // Override
                // cbusip should retain the default value
            };
            // Constructor merges userSettings with internal defaults
            const mergedBridge = new CgateWebBridge(userSettings);
            
            // Check overridden values
            expect(mergedBridge.settings.mqtt).toBe('mqtt.example.com:1884');
            expect(mergedBridge.settings.logging).toBe(true);
            expect(mergedBridge.settings.messageinterval).toBe(50);
            
            // Check that a default value was correctly retained
            expect(mergedBridge.settings.cbusip).toBe(defaultSettings.cbusip); 
            // Check another default to be sure
            expect(mergedBridge.settings.cbusname).toBe(defaultSettings.cbusname);
        });

        it('should initialize connection flags to false', () => {
            expect(bridge.clientConnected).toBe(false);
            expect(bridge.commandConnected).toBe(false);
            expect(bridge.eventConnected).toBe(false);
        });

        it('should initialize sockets and client to null', () => {
            expect(bridge.client).toBeNull();
            expect(bridge.commandSocket).toBeNull();
            expect(bridge.eventSocket).toBeNull();
        });

        it('should initialize buffers and treeNetwork to empty/null', () => {
            expect(bridge.commandBuffer).toBe("");
            expect(bridge.eventBuffer).toBe("");
            expect(bridge.treeBuffer).toBe("");
            expect(bridge.treeNetwork).toBeNull();
        });

        it('should initialize queues', () => {
            expect(bridge.mqttPublishQueue).toBeDefined();
            expect(bridge.cgateCommandQueue).toBeDefined();
            // Check if they are instances of ThrottledQueue (optional but good)
            // Need to import ThrottledQueue for this
            const { ThrottledQueue } = require('../index.js');
            expect(bridge.mqttPublishQueue).toBeInstanceOf(ThrottledQueue);
            expect(bridge.cgateCommandQueue).toBeInstanceOf(ThrottledQueue);
        });

        it('should initialize reconnect properties to null/0', () => {
            expect(bridge.periodicGetAllInterval).toBeNull();
            expect(bridge.commandReconnectTimeout).toBeNull();
            expect(bridge.eventReconnectTimeout).toBeNull();
            expect(bridge.commandReconnectAttempts).toBe(0);
            expect(bridge.eventReconnectAttempts).toBe(0);
        });

         it('should set MQTT options based on retainreads setting', () => {
             const bridgeRetain = new CgateWebBridge({ ...mockSettings, retainreads: true });
             const bridgeNoRetain = new CgateWebBridge({ ...mockSettings, retainreads: false });
             expect(bridgeRetain._mqttOptions.retain).toBe(true);
             expect(bridgeNoRetain._mqttOptions.retain).toBeUndefined(); // or expect({})... depends on impl.
         });

         // Add test for factory assignment if needed
         it('should assign provided factories', () => {
            const mockMqttFactory = jest.fn();
            const mockCmdFactory = jest.fn();
            const mockEvtFactory = jest.fn();
            const bridgeWithFactories = new CgateWebBridge(
                mockSettings,
                mockMqttFactory,
                mockCmdFactory,
                mockEvtFactory
            );
            expect(bridgeWithFactories.mqttClientFactory).toBe(mockMqttFactory);
            expect(bridgeWithFactories.commandSocketFactory).toBe(mockCmdFactory);
            expect(bridgeWithFactories.eventSocketFactory).toBe(mockEvtFactory);
        });

    });

    // --- Test Start/Stop Methods ---
    describe('Start/Stop Methods', () => {
        let connectMqttSpy, connectCommandSpy, connectEventSpy;
        let clearTimeoutSpy, clearIntervalSpy;
        let mockClient, mockCommandSocket, mockEventSocket;
        let mqttQueueClearSpy, cgateQueueClearSpy, emitterRemoveSpy;

        beforeEach(() => {
            // --- Mocks for start() ---
            // Spy on the actual implementation but prevent execution
            connectMqttSpy = jest.spyOn(bridge, '_connectMqtt').mockImplementation(() => { });
            connectCommandSpy = jest.spyOn(bridge, '_connectCommandSocket').mockImplementation(() => { });
            connectEventSpy = jest.spyOn(bridge, '_connectEventSocket').mockImplementation(() => { });

            // --- Mocks/Spies for stop() ---
            clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
            clearIntervalSpy = jest.spyOn(global, 'clearInterval');

            // Create mock client/sockets with necessary methods
            mockClient = { end: jest.fn(), removeAllListeners: jest.fn() }; // Add removeAllListeners if needed by stop
            mockCommandSocket = { destroy: jest.fn(), removeAllListeners: jest.fn() };
            mockEventSocket = { destroy: jest.fn(), removeAllListeners: jest.fn() };

            // Spy on queue clear methods
            mqttQueueClearSpy = jest.spyOn(bridge.mqttPublishQueue, 'clear');
            cgateQueueClearSpy = jest.spyOn(bridge.cgateCommandQueue, 'clear');

            // Spy on internal event emitter
            emitterRemoveSpy = jest.spyOn(bridge.internalEventEmitter, 'removeAllListeners');
        });

        afterEach(() => {
            // Restore all spies
            connectMqttSpy.mockRestore();
            connectCommandSpy.mockRestore();
            connectEventSpy.mockRestore();
            clearTimeoutSpy.mockRestore();
            clearIntervalSpy.mockRestore();
            mqttQueueClearSpy.mockRestore();
            cgateQueueClearSpy.mockRestore();
            emitterRemoveSpy.mockRestore();
        });

        it('start() should call connection methods', () => {
            bridge.start();
            expect(connectMqttSpy).toHaveBeenCalledTimes(1);
            expect(connectCommandSpy).toHaveBeenCalledTimes(1);
            expect(connectEventSpy).toHaveBeenCalledTimes(1);
        });

        it('stop() should clean up resources and reset state', () => {
            // Simulate an active state before stopping
            bridge.client = mockClient;
            bridge.commandSocket = mockCommandSocket;
            bridge.eventSocket = mockEventSocket;
            bridge.clientConnected = true;
            bridge.commandConnected = true;
            bridge.eventConnected = true;
            bridge.commandReconnectTimeout = setTimeout(() => { }, 1000); // Assign dummy timeout IDs
            bridge.eventReconnectTimeout = setTimeout(() => { }, 1000);
            bridge.periodicGetAllInterval = setInterval(() => { }, 1000); // Assign dummy interval ID
            const cmdTimeoutId = bridge.commandReconnectTimeout;
            const evtTimeoutId = bridge.eventReconnectTimeout;
            const getAllIntervalId = bridge.periodicGetAllInterval;

            // Act
            bridge.stop();

            // Assertions
            expect(clearTimeoutSpy).toHaveBeenCalledWith(cmdTimeoutId);
            expect(clearTimeoutSpy).toHaveBeenCalledWith(evtTimeoutId);
            expect(clearIntervalSpy).toHaveBeenCalledWith(getAllIntervalId);
            expect(mqttQueueClearSpy).toHaveBeenCalledTimes(1);
            expect(cgateQueueClearSpy).toHaveBeenCalledTimes(1);
            expect(mockClient.end).toHaveBeenCalledWith(true); // Expect force close
            expect(mockCommandSocket.destroy).toHaveBeenCalledTimes(1);
            expect(mockEventSocket.destroy).toHaveBeenCalledTimes(1);
            expect(emitterRemoveSpy).toHaveBeenCalledTimes(1);
            expect(bridge.clientConnected).toBe(false);
            expect(bridge.commandConnected).toBe(false);
            expect(bridge.eventConnected).toBe(false);
            expect(bridge.client).toBeNull();
            expect(bridge.commandSocket).toBeNull();
            expect(bridge.eventSocket).toBeNull();
            expect(bridge.commandReconnectTimeout).toBeNull();
            expect(bridge.eventReconnectTimeout).toBeNull();
            expect(bridge.periodicGetAllInterval).toBeNull();
        });

        it('stop() should handle null resources gracefully', () => {
             // Ensure everything is null/default before stop()
             bridge.client = null;
             bridge.commandSocket = null;
             bridge.eventSocket = null;
             bridge.commandReconnectTimeout = null;
             bridge.eventReconnectTimeout = null;
             bridge.periodicGetAllInterval = null;
             bridge.clientConnected = false; // Already false but good to be explicit
 
             // Act & Assert - should not throw errors
             expect(() => bridge.stop()).not.toThrow();
 
             // Verify mocks were NOT called for null resources
             expect(clearTimeoutSpy).not.toHaveBeenCalled();
             expect(clearIntervalSpy).not.toHaveBeenCalled();
             // Queues and emitter are always present, so clear/removeAllListeners are called
             expect(mqttQueueClearSpy).toHaveBeenCalledTimes(1);
             expect(cgateQueueClearSpy).toHaveBeenCalledTimes(1);
             expect(emitterRemoveSpy).toHaveBeenCalledTimes(1);
         });

    });

    // --- Test Connection Handlers ---
    describe('Connection Handlers', () => {
        let mockClient;
        let mockCommandSocket;
        let mockEventSocket;
        let mqttAddSpy, checkAllSpy, clearTimeoutSpy;
        let cmdWriteSpy; // For direct EVENT ON write

        beforeEach(() => {
            // Create mocks with necessary methods used by handlers
            mockClient = {
                subscribe: jest.fn((topic, cb) => cb(null)), // Simulate successful subscription
                publish: jest.fn(), // <<< ADDED MOCK FOR PUBLISH
                removeAllListeners: jest.fn(),
                on: jest.fn(), // Needed if handlers re-attach listeners
                // Add other methods if needed by the handlers
            };
            mockCommandSocket = {
                write: jest.fn(),
                removeAllListeners: jest.fn(),
                on: jest.fn(),
                 connect: jest.fn(), // Add connect if needed
                 destroy: jest.fn(), // Add destroy if needed
            };
             mockEventSocket = {
                 removeAllListeners: jest.fn(),
                 on: jest.fn(),
                 connect: jest.fn(),
                 destroy: jest.fn(),
             };

            // Assign mocks to the bridge instance *before* calling handlers
            bridge.client = mockClient;
            bridge.commandSocket = mockCommandSocket;
            bridge.eventSocket = mockEventSocket;

            // Spy on methods called by the handlers
            mqttAddSpy = jest.spyOn(bridge.mqttPublishQueue, 'add');
            checkAllSpy = jest.spyOn(bridge, '_checkAllConnected').mockImplementation(() => { }); // Prevent execution
            clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
            cmdWriteSpy = jest.spyOn(bridge.commandSocket, 'write'); // Spy on write of the *mock* socket

        });

        afterEach(() => {
            // Restore spies
            mqttAddSpy.mockRestore();
            checkAllSpy.mockRestore();
            clearTimeoutSpy.mockRestore();
            cmdWriteSpy.mockRestore();
            // It's good practice to clear mock calls too
            mockClient.subscribe.mockClear();
            mockCommandSocket.write.mockClear();
        });

        it('_handleMqttConnect should set flag, subscribe, publish online, and check all connected', () => {
            bridge.clientConnected = false; // Ensure starting state
            bridge._handleMqttConnect();

            expect(bridge.clientConnected).toBe(true);
            expect(mockClient.subscribe).toHaveBeenCalledWith('cbus/write/#', expect.any(Function));
            expect(mqttAddSpy).toHaveBeenCalledWith({ topic: 'hello/cgateweb', payload: 'Online', options: { retain: false } });
            expect(checkAllSpy).toHaveBeenCalledTimes(1);
        });

        it('_handleCommandConnect should set flag, reset attempts, clear timeout, send EVENT ON, and check all connected', () => {
            bridge.commandConnected = false;
            bridge.commandReconnectAttempts = 5;
            bridge.commandReconnectTimeout = setTimeout(() => { }, 5000); // Dummy timeout
            const timeoutId = bridge.commandReconnectTimeout;

            bridge._handleCommandConnect();

            expect(bridge.commandConnected).toBe(true);
            expect(bridge.commandReconnectAttempts).toBe(0);
            expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutId);
            expect(bridge.commandReconnectTimeout).toBeNull();
            expect(cmdWriteSpy).toHaveBeenCalledWith('EVENT ON\n');
            expect(checkAllSpy).toHaveBeenCalledTimes(1);
        });

        it('_handleEventConnect should set flag, reset attempts, clear timeout, and check all connected', () => {
             bridge.eventConnected = false;
             bridge.eventReconnectAttempts = 3;
             bridge.eventReconnectTimeout = setTimeout(() => { }, 5000); // Dummy timeout
             const timeoutId = bridge.eventReconnectTimeout;

             bridge._handleEventConnect();

             expect(bridge.eventConnected).toBe(true);
             expect(bridge.eventReconnectAttempts).toBe(0);
             expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutId);
             expect(bridge.eventReconnectTimeout).toBeNull();
             expect(checkAllSpy).toHaveBeenCalledTimes(1);
        });

    });

    // --- Test Disconnection and Error Handlers ---
    describe('Disconnection and Error Handlers', () => {
        let mockClient, mockCommandSocket, mockEventSocket;
        let scheduleReconnectSpy, consoleWarnSpy, consoleErrorSpy, processExitSpy;
        let clientRemoveListenersSpy, cmdRemoveListenersSpy, evtRemoveListenersSpy;
        let cmdDestroySpy, evtDestroySpy;

        beforeEach(() => {
            // Mock console logging
            consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });
            consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => { });
            processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit called'); }); // Throw error to stop test execution

            // Create basic mocks
            mockClient = { removeAllListeners: jest.fn() };
            mockCommandSocket = { removeAllListeners: jest.fn(), destroy: jest.fn(), destroyed: false }; // Add destroyed flag
            mockEventSocket = { removeAllListeners: jest.fn(), destroy: jest.fn(), destroyed: false }; // Add destroyed flag

            // Assign mocks to bridge
            bridge.client = mockClient;
            bridge.commandSocket = mockCommandSocket;
            bridge.eventSocket = mockEventSocket;

            // Spy on methods
            scheduleReconnectSpy = jest.spyOn(bridge, '_scheduleReconnect').mockImplementation(() => { });
            clientRemoveListenersSpy = jest.spyOn(mockClient, 'removeAllListeners');
            cmdRemoveListenersSpy = jest.spyOn(mockCommandSocket, 'removeAllListeners');
            evtRemoveListenersSpy = jest.spyOn(mockEventSocket, 'removeAllListeners');
            cmdDestroySpy = jest.spyOn(mockCommandSocket, 'destroy');
            evtDestroySpy = jest.spyOn(mockEventSocket, 'destroy');

            // Reset connection flags for tests
            bridge.clientConnected = true;
            bridge.commandConnected = true;
            bridge.eventConnected = true;
        });

        afterEach(() => {
            // Restore all mocks/spies
            consoleWarnSpy.mockRestore();
            consoleErrorSpy.mockRestore();
            processExitSpy.mockRestore();
            scheduleReconnectSpy.mockRestore();
        });

        // --- Close Handlers ---
        it('_handleMqttClose should reset flag, null client, remove listeners and warn', () => {
            bridge._handleMqttClose();
            expect(bridge.clientConnected).toBe(false);
            expect(bridge.client).toBeNull();
            expect(clientRemoveListenersSpy).toHaveBeenCalledTimes(1);
            expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('MQTT Client Closed'));
            expect(scheduleReconnectSpy).not.toHaveBeenCalled(); // MQTT library handles reconnect
        });

        it('_handleCommandClose should reset flag, null socket, remove listeners, warn and schedule reconnect', () => {
            bridge._handleCommandClose(false); // Test without error
            expect(bridge.commandConnected).toBe(false);
            expect(bridge.commandSocket).toBeNull();
            expect(cmdRemoveListenersSpy).toHaveBeenCalledTimes(1);
            expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('COMMAND PORT DISCONNECTED'));
            expect(consoleWarnSpy).not.toHaveBeenCalledWith(expect.stringContaining('with error'));
            expect(scheduleReconnectSpy).toHaveBeenCalledWith('command');
        });

        it('_handleCommandClose(hadError=true) should log warning with error', () => {
            bridge._handleCommandClose(true);
            expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('COMMAND PORT DISCONNECTED with error'));
            expect(scheduleReconnectSpy).toHaveBeenCalledWith('command'); // Still schedules reconnect
        });

        it('_handleEventClose should reset flag, null socket, remove listeners, warn and schedule reconnect', () => {
            bridge._handleEventClose(false); // Test without error
            expect(bridge.eventConnected).toBe(false);
            expect(bridge.eventSocket).toBeNull();
            expect(evtRemoveListenersSpy).toHaveBeenCalledTimes(1);
            expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('EVENT PORT DISCONNECTED'));
             expect(consoleWarnSpy).not.toHaveBeenCalledWith(expect.stringContaining('with error'));
            expect(scheduleReconnectSpy).toHaveBeenCalledWith('event');
        });
        
         it('_handleEventClose(hadError=true) should log warning with error', () => {
             bridge._handleEventClose(true);
             expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('EVENT PORT DISCONNECTED with error'));
             expect(scheduleReconnectSpy).toHaveBeenCalledWith('event'); // Still schedules reconnect
         });

        // --- Error Handlers ---
        it('_handleMqttError (Auth Error code 5) should log specific error and exit', () => {
            const authError = new Error('Auth failed');
            authError.code = 5;
            // Expect process.exit to be called, which we mock to throw
            expect(() => {
                bridge._handleMqttError(authError);
            }).toThrow('process.exit called');

            expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('MQTT Connection Error: Authentication failed'));
            expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Exiting due to fatal MQTT authentication error.'));
            expect(processExitSpy).toHaveBeenCalledWith(1);
            // Flag should NOT be reset before process.exit in the refactored code
            expect(bridge.clientConnected).toBe(true); // Corrected assertion
            // Client *is* nulled before exit in refactored code
            expect(bridge.client).toBeNull();
            expect(clientRemoveListenersSpy).toHaveBeenCalledTimes(1);
        });

        it('_handleMqttError (Generic Error) should log, reset flag, null client, remove listeners', () => {
            const genericError = new Error('Some MQTT error');
            bridge._handleMqttError(genericError);

            expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('MQTT Client Error:'), genericError);
            // Flag should be reset in this case
            expect(bridge.clientConnected).toBe(false); // <<< VERIFY THIS IS CHECKED
            expect(bridge.client).toBeNull();
            expect(clientRemoveListenersSpy).toHaveBeenCalledTimes(1);
            expect(processExitSpy).not.toHaveBeenCalled();
            expect(scheduleReconnectSpy).not.toHaveBeenCalled(); // MQTT handles reconnect
        });

        it('_handleCommandError should log error, reset flag, destroy socket, and null socket', () => {
            const cmdError = new Error('Command socket failed');
            bridge._handleCommandError(cmdError);

            expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('C-Gate Command Socket Error:'), cmdError);
            expect(bridge.commandConnected).toBe(false);
            expect(cmdDestroySpy).toHaveBeenCalledTimes(1);
            expect(bridge.commandSocket).toBeNull();
            expect(scheduleReconnectSpy).not.toHaveBeenCalled(); // Relies on close event
        });
        
         it('_handleCommandError should not destroy already destroyed socket', () => {
             mockCommandSocket.destroyed = true; // Simulate already destroyed
             const cmdError = new Error('Command socket failed again');
             bridge._handleCommandError(cmdError);
 
             expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('C-Gate Command Socket Error:'), cmdError);
             expect(bridge.commandConnected).toBe(false);
             expect(cmdDestroySpy).not.toHaveBeenCalled(); // Should not call destroy again
             expect(bridge.commandSocket).toBeNull();
         });

        it('_handleEventError should log error, reset flag, destroy socket, and null socket', () => {
            const evtError = new Error('Event socket failed');
            bridge._handleEventError(evtError);

            expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('C-Gate Event Socket Error:'), evtError);
            expect(bridge.eventConnected).toBe(false);
            expect(evtDestroySpy).toHaveBeenCalledTimes(1);
            expect(bridge.eventSocket).toBeNull();
            expect(scheduleReconnectSpy).not.toHaveBeenCalled(); // Relies on close event
        });
        
         it('_handleEventError should not destroy already destroyed socket', () => {
             mockEventSocket.destroyed = true; // Simulate already destroyed
             const evtError = new Error('Event socket failed again');
             bridge._handleEventError(evtError);
 
             expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('C-Gate Event Socket Error:'), evtError);
             expect(bridge.eventConnected).toBe(false);
             expect(evtDestroySpy).not.toHaveBeenCalled(); // Should not call destroy again
             expect(bridge.eventSocket).toBeNull();
         });

    });

    // --- Test Data Handlers ---
    describe('Data Handlers', () => {

        describe('_handleMqttMessage', () => {
            let cgateQueueAddSpy, emitterOnceSpy, consoleWarnSpy;

            beforeEach(() => {
                // Spy on methods called by _handleMqttMessage
                cgateQueueAddSpy = jest.spyOn(bridge.cgateCommandQueue, 'add');
                emitterOnceSpy = jest.spyOn(bridge.internalEventEmitter, 'once');
                consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });

                // Ensure project name matches default test settings
                bridge.settings.cbusname = 'TestProject';
            });

            afterEach(() => {
                cgateQueueAddSpy.mockRestore();
                emitterOnceSpy.mockRestore();
                consoleWarnSpy.mockRestore();
            });

            it('should queue ON command for switch ON message', () => {
                const topic = 'cbus/write/254/56/10/switch';
                const message = Buffer.from('ON');
                bridge._handleMqttMessage(topic, message);
                expect(cgateQueueAddSpy).toHaveBeenCalledWith('ON //TestProject/254/56/10\n');
            });

            it('should queue OFF command for switch OFF message', () => {
                const topic = 'cbus/write/254/56/10/switch';
                const message = Buffer.from('OFF');
                bridge._handleMqttMessage(topic, message);
                expect(cgateQueueAddSpy).toHaveBeenCalledWith('OFF //TestProject/254/56/10\n');
            });

            it('should warn on invalid switch payload', () => {
                const topic = 'cbus/write/254/56/10/switch';
                const message = Buffer.from('INVALID');
                bridge._handleMqttMessage(topic, message);
                expect(cgateQueueAddSpy).not.toHaveBeenCalled();
                expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid payload for switch'));
            });

            it('should queue RAMP command for ramp percentage message', () => {
                const topic = 'cbus/write/254/56/11/ramp';
                const message = Buffer.from('75');
                bridge._handleMqttMessage(topic, message);
                expect(cgateQueueAddSpy).toHaveBeenCalledWith('RAMP //TestProject/254/56/11 191\n'); // 75% = 191
            });

            it('should queue RAMP command for ramp percentage,time message', () => {
                const topic = 'cbus/write/254/56/11/ramp';
                const message = Buffer.from('50,2s');
                bridge._handleMqttMessage(topic, message);
                expect(cgateQueueAddSpy).toHaveBeenCalledWith('RAMP //TestProject/254/56/11 128 2s\n'); // 50% = 128
            });

            it('should queue ON command for ramp ON message', () => {
                const topic = 'cbus/write/254/56/11/ramp';
                const message = Buffer.from('ON');
                bridge._handleMqttMessage(topic, message);
                expect(cgateQueueAddSpy).toHaveBeenCalledWith('ON //TestProject/254/56/11\n');
            });

             it('should queue OFF command for ramp OFF message', () => {
                 const topic = 'cbus/write/254/56/11/ramp';
                 const message = Buffer.from('OFF');
                 bridge._handleMqttMessage(topic, message);
                 expect(cgateQueueAddSpy).toHaveBeenCalledWith('OFF //TestProject/254/56/11\n');
             });

            it('should queue GET and add listener for ramp INCREASE message', () => {
                const topic = 'cbus/write/254/56/12/ramp';
                const message = Buffer.from('INCREASE');
                bridge._handleMqttMessage(topic, message);
                expect(emitterOnceSpy).toHaveBeenCalledWith('level', expect.any(Function));
                // Should queue GET first to find current level
                expect(cgateQueueAddSpy).toHaveBeenCalledWith('GET //TestProject/254/56/12 level\n');
            });

             it('should queue GET and add listener for ramp DECREASE message', () => {
                 const topic = 'cbus/write/254/56/12/ramp';
                 const message = Buffer.from('DECREASE');
                 bridge._handleMqttMessage(topic, message);
                 expect(emitterOnceSpy).toHaveBeenCalledWith('level', expect.any(Function));
                 expect(cgateQueueAddSpy).toHaveBeenCalledWith('GET //TestProject/254/56/12 level\n');
             });

            it('should warn on invalid ramp payload', () => {
                const topic = 'cbus/write/254/56/11/ramp';
                const message = Buffer.from('DIM'); // Invalid percentage/keyword
                bridge._handleMqttMessage(topic, message);
                expect(cgateQueueAddSpy).not.toHaveBeenCalled();
                expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid payload for ramp command'));
            });
            
            it('should warn on ramp command missing device ID', () => {
                const topic = 'cbus/write/254/56//ramp'; // Missing device
                const message = Buffer.from('50');
                bridge._handleMqttMessage(topic, message);
                expect(cgateQueueAddSpy).not.toHaveBeenCalled();
                // Expect the earlier, more general warning about the empty device ID
                expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('has empty device ID')); 
            });

            it('should queue GET command for getall message', () => {
                const topic = 'cbus/write/254/56//getall';
                const message = Buffer.from('');
                bridge._handleMqttMessage(topic, message);
                expect(cgateQueueAddSpy).toHaveBeenCalledWith('GET //TestProject/254/56/* level\n');
            });

            it('should queue TREEXML command for gettree message', () => {
                const topic = 'cbus/write/254///gettree';
                const message = Buffer.from('');
                bridge._handleMqttMessage(topic, message);
                expect(bridge.treeNetwork).toBe('254'); // Check context is set
                expect(cgateQueueAddSpy).toHaveBeenCalledWith('TREEXML 254\n');
            });

            it('should warn on unknown command type', () => {
                const topic = 'cbus/write/254/56/10/unknowncmd';
                const message = Buffer.from('DATA');
                bridge._handleMqttMessage(topic, message);
                expect(cgateQueueAddSpy).not.toHaveBeenCalled();
                expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown MQTT command type received: unknowncmd'));
            });

            it('should warn and ignore invalid topic', () => {
                 const topic = 'cbus/write/invalid';
                 const message = Buffer.from('ON');
                 bridge._handleMqttMessage(topic, message);
                 expect(cgateQueueAddSpy).not.toHaveBeenCalled();
                 expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Ignoring invalid MQTT command'));
             });
        });

        // --- _handleCommandData Tests ---
        describe('_handleCommandData', () => {
            let mqttAddSpy, eventEmitSpy, consoleErrorSpy, consoleWarnSpy;
            let parseStringResolver; // To signal async completion

            beforeEach(() => {
                mqttAddSpy = jest.spyOn(bridge.mqttPublishQueue, 'add');
                eventEmitSpy = jest.spyOn(bridge.internalEventEmitter, 'emit');
                // Re-enable console.error mocking
                consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => { });
                consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });

                // Reset and configure the mock function for xml2js.parseString
                mockParseStringFn.mockImplementation((xml, options, callback) => {
                    // Default behavior: Simulate successful parsing
                    callback(null, { mockParsedXml: true });
                    if (parseStringResolver) {
                        parseStringResolver();
                        parseStringResolver = null;
                    }
                });

                bridge.commandBuffer = ""; 
                bridge.settings.cbusname = 'TestProject'; // Consistent project name
            });

            afterEach(() => {
                mqttAddSpy.mockRestore();
                eventEmitSpy.mockRestore();
                // Restore console.error
                if (consoleErrorSpy) consoleErrorSpy.mockRestore();
                consoleWarnSpy.mockRestore();
                mockParseStringFn.mockClear(); // Clear calls to the mock function
            });

            it('should process buffered data correctly', () => {
                bridge._handleCommandData(Buffer.from('300 //TestProject/254/56/1 level=128\n300 //TestProj'));
                bridge._handleCommandData(Buffer.from('ect/254/56/2 level=0\n'));
                expect(mqttAddSpy).toHaveBeenCalledTimes(4); // state+level for each
                expect(mqttAddSpy).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/1/state', payload: 'ON' }));
                expect(mqttAddSpy).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/2/state', payload: 'OFF' }));
                expect(bridge.commandBuffer).toBe(''); // Buffer should be empty
            });

             it('should handle partial lines correctly', () => {
                 bridge._handleCommandData(Buffer.from('300 //TestProject/254/56/1 level=25')); // No newline
                 expect(mqttAddSpy).not.toHaveBeenCalled();
                 expect(bridge.commandBuffer).toBe('300 //TestProject/254/56/1 level=25');
                 bridge._handleCommandData(Buffer.from('5\n')); // Complete the line
                 expect(mqttAddSpy).toHaveBeenCalledTimes(2);
                 expect(mqttAddSpy).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/1/level', payload: '100' }));
                 expect(bridge.commandBuffer).toBe('');
             });

            it('should parse "300 //... level=X" and publish state/level', () => {
                bridge._handleCommandData(Buffer.from('300 //TestProject/254/56/3 level=51\n')); // ~20%
                expect(mqttAddSpy).toHaveBeenCalledTimes(2);
                expect(mqttAddSpy).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/3/state', payload: 'ON' }));
                expect(mqttAddSpy).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/3/level', payload: '20' }));
                expect(eventEmitSpy).toHaveBeenCalledWith('level', '254/56/3', 51);
            });
            
            it('should parse "300 //... level=0" and publish state/level', () => {
                bridge._handleCommandData(Buffer.from('300 //TestProject/254/56/4 level=0\n'));
                expect(mqttAddSpy).toHaveBeenCalledTimes(2);
                expect(mqttAddSpy).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/4/state', payload: 'OFF' }));
                expect(mqttAddSpy).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/4/level', payload: '0' }));
                expect(eventEmitSpy).toHaveBeenCalledWith('level', '254/56/4', 0);
            });
            
             it('should parse "300 //... level=255" and publish state/level', () => {
                 bridge._handleCommandData(Buffer.from('300 //TestProject/254/56/5 level=255\n'));
                 expect(mqttAddSpy).toHaveBeenCalledTimes(2);
                 expect(mqttAddSpy).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/5/state', payload: 'ON' }));
                 expect(mqttAddSpy).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/5/level', payload: '100' }));
                 expect(eventEmitSpy).toHaveBeenCalledWith('level', '254/56/5', 255);
             });

            it('should parse "300-lighting on ..." and publish state/level', () => {
                bridge._handleCommandData(Buffer.from('300-lighting on 254/56/6 ignored OID info\n'));
                expect(mqttAddSpy).toHaveBeenCalledTimes(2);
                expect(mqttAddSpy).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/6/state', payload: 'ON' }));
                expect(mqttAddSpy).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/6/level', payload: '100' }));
                 expect(eventEmitSpy).toHaveBeenCalledWith('level', '254/56/6', 255); // 255 for 'on'
            });
            
             it('should parse "300-lighting ramp ... 128" and publish state/level', () => {
                 bridge._handleCommandData(Buffer.from('300-lighting ramp 254/56/7 128\n')); // 50%
                 expect(mqttAddSpy).toHaveBeenCalledTimes(2);
                 expect(mqttAddSpy).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/7/state', payload: 'ON' }));
                 expect(mqttAddSpy).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/7/level', payload: '50' }));
                 expect(eventEmitSpy).toHaveBeenCalledWith('level', '254/56/7', 128); 
             });

            it('should handle TreeXML sequence and publish result', async () => {
                let promise = new Promise(resolve => { parseStringResolver = resolve; });

                bridge.treeNetwork = '200';
                bridge._handleCommandData(Buffer.from('343-200\n'));
                bridge._handleCommandData(Buffer.from('347-<root></root>\n'));
                bridge._handleCommandData(Buffer.from('344-200\n'));

                await promise;

                // Check assertions using the mock function directly
                expect(mockParseStringFn).toHaveBeenCalledWith(expect.any(String), { explicitArray: false }, expect.any(Function));
                expect(mqttAddSpy).toHaveBeenCalledTimes(1);
                expect(mqttAddSpy).toHaveBeenCalledWith(expect.objectContaining({
                    topic: 'cbus/read/200///tree',
                    payload: JSON.stringify({ mockParsedXml: true })
                }));
                expect(bridge.treeBuffer).toBe('');
                expect(bridge.treeNetwork).toBeNull();
            });
            
             it('should handle TreeXML parsing error', async () => {
                 let promise = new Promise(resolve => { parseStringResolver = resolve; });

                 // Set specific mock implementation for this test
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

                 // Check assertions using the mock function
                 expect(mockParseStringFn).toHaveBeenCalled();
                 expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error parsing TreeXML'), expect.any(Error));
                 expect(mqttAddSpy).not.toHaveBeenCalled();
                 expect(bridge.treeBuffer).toBe('');
                 expect(bridge.treeNetwork).toBeNull();
             });

            it('should log 4xx/5xx C-Gate errors', () => {
                bridge._handleCommandData(Buffer.from('401 Bad object\n'));
                bridge._handleCommandData(Buffer.from('500 Server error\n'));
                expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('C-Gate Command Error Response: 401 Bad object'));
                expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('C-Gate Command Error Response: 500 Server error'));
            });
            
             it('should ignore unhandled status responses (like 300 without level=)', () => {
                 bridge._handleCommandData(Buffer.from('300 Some other status\n'));
                 expect(mqttAddSpy).not.toHaveBeenCalled();
                 expect(eventEmitSpy).not.toHaveBeenCalled();
                 // Could check for specific log message if needed
             });

            it('should ignore empty lines', () => {
                bridge._handleCommandData(Buffer.from('\n300 //TestProject/254/56/8 level=0\n\n'));
                expect(mqttAddSpy).toHaveBeenCalledTimes(2);
            });
        });

        // --- _handleEventData Tests ---
        describe('_handleEventData', () => {
             let mqttAddSpy, eventEmitSpy, consoleWarnSpy;

            beforeEach(() => {
                mqttAddSpy = jest.spyOn(bridge.mqttPublishQueue, 'add');
                eventEmitSpy = jest.spyOn(bridge.internalEventEmitter, 'emit');
                consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });
                bridge.eventBuffer = ""; // Reset buffer
            });

            afterEach(() => {
                mqttAddSpy.mockRestore();
                eventEmitSpy.mockRestore();
                consoleWarnSpy.mockRestore();
            });
            
            it('should process buffered data correctly', () => {
                bridge._handleEventData(Buffer.from('lighting on 254/56/10\nlighti'));
                bridge._handleEventData(Buffer.from('ng off 254/56/11\n'));
                expect(mqttAddSpy).toHaveBeenCalledTimes(4); // state+level for each
                expect(mqttAddSpy).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/10/state', payload: 'ON' }));
                expect(mqttAddSpy).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/11/state', payload: 'OFF' }));
                expect(bridge.eventBuffer).toBe('');
            });
            
             it('should handle partial lines correctly', () => {
                 bridge._handleEventData(Buffer.from('lighting ramp 254/56/12 1')); // No newline, level 128
                 expect(mqttAddSpy).not.toHaveBeenCalled();
                 expect(bridge.eventBuffer).toBe('lighting ramp 254/56/12 1');
                 bridge._handleEventData(Buffer.from('28\n')); // Complete the line
                 expect(mqttAddSpy).toHaveBeenCalledTimes(2);
                 expect(mqttAddSpy).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/12/level', payload: '50' })); // 128->50%
                 expect(bridge.eventBuffer).toBe('');
             });

            it('should parse "lighting on ..." and publish state/level', () => {
                bridge._handleEventData(Buffer.from('lighting on 254/56/13 OID etc\n'));
                expect(mqttAddSpy).toHaveBeenCalledTimes(2);
                expect(mqttAddSpy).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/13/state', payload: 'ON' }));
                expect(mqttAddSpy).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/13/level', payload: '100' }));
                expect(eventEmitSpy).toHaveBeenCalledWith('level', '254/56/13', 255);
            });
            
             it('should parse "lighting off ..." and publish state/level', () => {
                 bridge._handleEventData(Buffer.from('lighting off 254/56/14\n'));
                 expect(mqttAddSpy).toHaveBeenCalledTimes(2);
                 expect(mqttAddSpy).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/14/state', payload: 'OFF' }));
                 expect(mqttAddSpy).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/14/level', payload: '0' }));
                 expect(eventEmitSpy).toHaveBeenCalledWith('level', '254/56/14', 0);
             });
             
              it('should parse "lighting ramp ... X" and publish state/level', () => {
                  bridge._handleEventData(Buffer.from('lighting ramp 254/56/15 76\n')); // ~30%
                  expect(mqttAddSpy).toHaveBeenCalledTimes(2);
                  expect(mqttAddSpy).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/15/state', payload: 'ON' }));
                  expect(mqttAddSpy).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/15/level', payload: '30' }));
                  expect(eventEmitSpy).toHaveBeenCalledWith('level', '254/56/15', 76);
              });

            it('should ignore comment lines', () => {
                bridge._handleEventData(Buffer.from('# This is a comment\nlighting on 254/56/16\n'));
                expect(mqttAddSpy).toHaveBeenCalledTimes(2); // Only for the lighting event
                expect(mqttAddSpy).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/16/state', payload: 'ON' }));
            });

            it('should warn on invalid event line', () => {
                bridge._handleEventData(Buffer.from('invalid data\n'));
                expect(mqttAddSpy).not.toHaveBeenCalled();
                expect(eventEmitSpy).not.toHaveBeenCalled();
                expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Could not parse event line'));
            });
            
            it('should ignore empty lines', () => {
                bridge._handleEventData(Buffer.from('\nlighting off 254/56/17\n\n'));
                expect(mqttAddSpy).toHaveBeenCalledTimes(2);
            });
        });
    });

});