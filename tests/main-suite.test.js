// tests/parser.test.js (Renamed from main-suite.test.js implicitly)

// Import necessary classes/functions
const { CBusEvent, CBusCommand, CgateWebBridge, settings: defaultSettings } = require('../index.js');

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

    // Future tests for other methods (start, stop, handlers, etc.) will go here
    // describe('Connection Methods', () => { ... });
    // describe('Data Handlers', () => { ... });

});