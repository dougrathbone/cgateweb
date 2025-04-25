// tests/cgateWebBridge.test.js

// Import necessary classes/functions
const { 
    CgateWebBridge, 
    ThrottledQueue, 
    settings: defaultSettings
    // Remove constant imports - they don\'t work well with Jest module mocks here
    // MQTT_TOPIC_PREFIX_WRITE, 
    // MQTT_TOPIC_STATUS, 
    // MQTT_PAYLOAD_STATUS_ONLINE, 
    // CGATE_CMD_EVENT_ON, 
    // NEWLINE 
} = require('../index.js');
const EventEmitter = require('events'); // Needed for mocking event emitters
const xml2js = require('xml2js'); // Keep require for type info if needed, but mock it below

// --- Mock xml2js Module --- 
let mockParseStringFn = jest.fn();
jest.mock('xml2js', () => ({
    parseString: (...args) => mockParseStringFn(...args) 
}));

// --- Mock mqtt Module ---
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

// Mock console methods globally for all tests unless overridden
const mockConsoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => { });
const mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => { });

// Restore console mocks after all tests in this file
afterAll(() => {
    mockConsoleWarn.mockRestore();
    mockConsoleError.mockRestore();
});

// --- CgateWebBridge Tests ---
describe('CgateWebBridge', () => {
    let bridge;
    let mockSettings;
    let mockCmdSocketFactory, mockEvtSocketFactory;
    let lastMockCmdSocket, lastMockEvtSocket;

    beforeEach(() => {
        // Reset MQTT mocks
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

        // Create mock socket factories
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
            null, // Use default MQTT factory relying on jest.mock('mqtt')
            mockCmdSocketFactory, 
            mockEvtSocketFactory
        );
    });

     afterEach(() => {
         jest.clearAllTimers();
         mockConsoleWarn.mockClear();
         mockConsoleError.mockClear();
         // Clear mock function calls specifically for xml2js mock
         mockParseStringFn.mockClear(); 
     });


    describe('Constructor & Initial State', () => {
        it('should initialize with correct default settings when passed empty object', () => {
            const bridgeWithDefaults = new CgateWebBridge({});
            expect(bridgeWithDefaults.settings.mqtt).toBe(defaultSettings.mqtt);
            expect(bridgeWithDefaults.settings.cbusip).toBe(defaultSettings.cbusip);
            expect(bridgeWithDefaults.settings.messageinterval).toBe(defaultSettings.messageinterval);
            expect(bridgeWithDefaults.settings.retainreads).toBe(defaultSettings.retainreads);
            expect(bridgeWithDefaults.mqttPublishQueue).toBeDefined();
            expect(bridgeWithDefaults.cgateCommandQueue).toBeDefined();
        });

        it('should correctly merge provided settings over defaults', () => {
            const userSettings = {
                mqtt: 'mqtt.example.com:1884', 
                logging: true,                 
                messageinterval: 50,          
            };
            const mergedBridge = new CgateWebBridge(userSettings);
            expect(mergedBridge.settings.mqtt).toBe('mqtt.example.com:1884');
            expect(mergedBridge.settings.logging).toBe(true);
            expect(mergedBridge.settings.messageinterval).toBe(50);
            expect(mergedBridge.settings.cbusip).toBe(defaultSettings.cbusip); 
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
             expect(bridgeNoRetain._mqttOptions.retain).toBeUndefined(); 
         });

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

    describe('Start/Stop Methods', () => {
        let connectMqttSpy, connectCommandSpy, connectEventSpy;
        let clearTimeoutSpy, clearIntervalSpy;
        let mockClientStop, mockCommandSocketStop, mockEventSocketStop;
        let mqttQueueClearSpy, cgateQueueClearSpy, emitterRemoveSpy;
        // Remove mqtt require - not needed for revised test
        // const mqtt = require('mqtt'); 

        beforeEach(() => {
            bridge.client = null; 
            bridge.commandSocket = null;
            bridge.eventSocket = null;
            
            connectMqttSpy = jest.spyOn(bridge, '_connectMqtt').mockImplementation(() => { });
            connectCommandSpy = jest.spyOn(bridge, '_connectCommandSocket').mockImplementation(() => { });
            connectEventSpy = jest.spyOn(bridge, '_connectEventSocket').mockImplementation(() => { });
            clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
            clearIntervalSpy = jest.spyOn(global, 'clearInterval');
            mockClientStop = { end: jest.fn(), removeAllListeners: jest.fn() };
            mockCommandSocketStop = { destroy: jest.fn(), removeAllListeners: jest.fn() };
            mockEventSocketStop = { destroy: jest.fn(), removeAllListeners: jest.fn() };
            mqttQueueClearSpy = jest.spyOn(bridge.mqttPublishQueue, 'clear');
            cgateQueueClearSpy = jest.spyOn(bridge.cgateCommandQueue, 'clear');
            emitterRemoveSpy = jest.spyOn(bridge.internalEventEmitter, 'removeAllListeners');
            // Remove mqtt.connect clear - not needed
            // mqtt.connect.mockClear(); 
             mockCmdSocketFactory.mockClear();
             mockEvtSocketFactory.mockClear();
             // Remove socket creation/clearing here - not needed for revised test
        });

        afterEach(() => {
           // ... spy restores ...
        });

        it('start() should attempt to connect MQTT, Command, and Event sockets', () => {
             // Reset spies specifically for this test
             connectMqttSpy.mockClear();
             connectCommandSpy.mockClear();
             connectEventSpy.mockClear();
             bridge.client = null; 
             bridge.commandSocket = null; 
             bridge.eventSocket = null;

            bridge.start();
            // Check that the internal connect methods were called
            expect(connectMqttSpy).toHaveBeenCalledTimes(1);
            expect(connectCommandSpy).toHaveBeenCalledTimes(1);
            expect(connectEventSpy).toHaveBeenCalledTimes(1);

            // Remove checks for underlying library calls
            // expect(mqtt.connect).toHaveBeenCalledTimes(1); 
            // expect(mockCmdSocketFactory).toHaveBeenCalledTimes(1);
            // expect(mockEvtSocketFactory).toHaveBeenCalledTimes(1);
        });

       // ... rest of Start/Stop tests ...
    });

    describe('Connection Handlers & _checkAllConnected', () => {
        let mqttAddSpy, checkAllSpy, clearTimeoutSpy, setIntervalSpy, clearIntervalSpy;
        let cmdWriteSpy, getTreeSpy;
        let triggerHaSpy; // Add spy for HA discovery trigger

        beforeEach(() => {
            // Use the globally mocked client/sockets
            bridge.client = mockMqttClient;
            bridge.commandSocket = bridge.commandSocketFactory(); // Get fresh mock socket
            bridge.eventSocket = bridge.eventSocketFactory(); // Get fresh mock socket

            mqttAddSpy = jest.spyOn(bridge.mqttPublishQueue, 'add');
            checkAllSpy = jest.spyOn(bridge, '_checkAllConnected'); // Spy on the real implementation
            clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
            setIntervalSpy = jest.spyOn(global, 'setInterval');
            clearIntervalSpy = jest.spyOn(global, 'clearInterval');
            cmdWriteSpy = jest.spyOn(bridge.commandSocket, 'write');
            getTreeSpy = jest.spyOn(bridge.cgateCommandQueue, 'add'); // Use this for GETALL / TREEXML checks
            triggerHaSpy = jest.spyOn(bridge, '_triggerHaDiscovery').mockImplementation(() => {}); // Mock HA trigger implementation
            
            // Reset flags and spies
            bridge.clientConnected = false;
            bridge.commandConnected = false;
            bridge.eventConnected = false;
            bridge.commandReconnectAttempts = 5;
            bridge.eventReconnectAttempts = 3;
            bridge.commandReconnectTimeout = setTimeout(() => {}, 5000);
            bridge.eventReconnectTimeout = setTimeout(() => {}, 5000);
            bridge.periodicGetAllInterval = null;
            checkAllSpy.mockClear();
            clearTimeoutSpy.mockClear();
            setIntervalSpy.mockClear();
            clearIntervalSpy.mockClear();
            cmdWriteSpy.mockClear();
            mqttAddSpy.mockClear();
            getTreeSpy.mockClear();
            triggerHaSpy.mockClear();
            mockMqttClient.subscribe.mockClear();
        });

        afterEach(() => {
             mqttAddSpy.mockRestore();
             checkAllSpy.mockRestore();
             clearTimeoutSpy.mockRestore();
             setIntervalSpy.mockRestore();
             clearIntervalSpy.mockRestore();
             // cmdWriteSpy restored automatically if on mock socket created in beforeEach
             getTreeSpy.mockRestore();
             triggerHaSpy.mockRestore();
        });

        it('_handleMqttConnect should set flag, subscribe, publish online, and check all connected', () => {
            bridge._handleMqttConnect();
            expect(bridge.clientConnected).toBe(true);
            // Use literal string instead of imported constant
            expect(mockMqttClient.subscribe).toHaveBeenCalledWith('cbus/write/#', expect.any(Function));
            // Use literal strings instead of imported constants
            expect(mqttAddSpy).toHaveBeenCalledWith({ topic: 'hello/cgateweb', payload: 'Online', options: { retain: false } });
            expect(checkAllSpy).toHaveBeenCalledTimes(1);
        });

        it('_handleCommandConnect should set flag, reset attempts, clear timeout, send EVENT ON, and check all connected', () => {
            const timeoutId = bridge.commandReconnectTimeout;
            bridge._handleCommandConnect();
            expect(bridge.commandConnected).toBe(true);
            expect(bridge.commandReconnectAttempts).toBe(0);
            expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutId);
            expect(bridge.commandReconnectTimeout).toBeNull();
            // Use literal strings instead of imported constants
            expect(cmdWriteSpy).toHaveBeenCalledWith('EVENT ON\n'); 
            expect(checkAllSpy).toHaveBeenCalledTimes(1);
        });

        it('_handleEventConnect should set flag, reset attempts, clear timeout, and check all connected', () => {
             const timeoutId = bridge.eventReconnectTimeout;
             bridge._handleEventConnect();
             expect(bridge.eventConnected).toBe(true);
             expect(bridge.eventReconnectAttempts).toBe(0);
             expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutId);
             expect(bridge.eventReconnectTimeout).toBeNull();
             expect(checkAllSpy).toHaveBeenCalledTimes(1);
        });

        it('_checkAllConnected should do nothing if not all connected', () => {
            bridge.clientConnected = true;
            bridge.commandConnected = false; // Not connected
            bridge.eventConnected = true;
            bridge._checkAllConnected();
            expect(getTreeSpy).not.toHaveBeenCalled();
            expect(setIntervalSpy).not.toHaveBeenCalled();
            expect(triggerHaSpy).not.toHaveBeenCalled();
        });

        it('_checkAllConnected should trigger initial getall if configured', () => {
            bridge.settings.getallnetapp = '254/56';
            bridge.settings.getallonstart = true;
            bridge.clientConnected = true;
            bridge.commandConnected = true;
            bridge.eventConnected = true;
            bridge._checkAllConnected();
            expect(getTreeSpy).toHaveBeenCalledWith(`GET //${bridge.settings.cbusname}/254/56/* level\n`);
        });

        it('_checkAllConnected should NOT trigger initial getall if not configured', () => {
            bridge.settings.getallnetapp = '254/56';
            bridge.settings.getallonstart = false;
            bridge.clientConnected = true;
            bridge.commandConnected = true;
            bridge.eventConnected = true;
            bridge._checkAllConnected();
            expect(getTreeSpy).not.toHaveBeenCalledWith(expect.stringContaining('GET //'));
        });

        it('_checkAllConnected should trigger periodic getall if configured', () => {
             bridge.settings.getallnetapp = '254/56';
             bridge.settings.getallperiod = 60; 
             bridge.clientConnected = true;
             bridge.commandConnected = true;
             bridge.eventConnected = true;
             bridge._checkAllConnected();
             expect(setIntervalSpy).toHaveBeenCalledTimes(1);
             expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60000);
             // Check if the function passed to setInterval queues the GET command
             const intervalFn = setIntervalSpy.mock.calls[0][0];
             intervalFn(); 
             expect(getTreeSpy).toHaveBeenCalledWith(`GET //${bridge.settings.cbusname}/254/56/* level\n`);
         });
         
         it('_checkAllConnected should clear existing periodic getall interval', () => {
             bridge.settings.getallnetapp = '254/56';
             bridge.settings.getallperiod = 60;
             const fakeIntervalId = 12345;
             bridge.periodicGetAllInterval = fakeIntervalId;
             bridge.clientConnected = true;
             bridge.commandConnected = true;
             bridge.eventConnected = true;
             bridge._checkAllConnected();
             expect(clearIntervalSpy).toHaveBeenCalledWith(fakeIntervalId);
             expect(setIntervalSpy).toHaveBeenCalledTimes(1);
         });

         it('_checkAllConnected should NOT trigger periodic getall if not configured', () => {
             bridge.settings.getallnetapp = '254/56';
             bridge.settings.getallperiod = null; // Not configured
             bridge.clientConnected = true;
             bridge.commandConnected = true;
             bridge.eventConnected = true;
             bridge._checkAllConnected();
             expect(setIntervalSpy).not.toHaveBeenCalled();
         });

         it('_checkAllConnected should trigger HA Discovery if enabled', () => {
             bridge.settings.ha_discovery_enabled = true;
             bridge.clientConnected = true;
             bridge.commandConnected = true;
             bridge.eventConnected = true;
             bridge._checkAllConnected();
             expect(triggerHaSpy).toHaveBeenCalledTimes(1);
         });

         it('_checkAllConnected should NOT trigger HA Discovery if disabled', () => {
             bridge.settings.ha_discovery_enabled = false;
             bridge.clientConnected = true;
             bridge.commandConnected = true;
             bridge.eventConnected = true;
             bridge._checkAllConnected();
             expect(triggerHaSpy).not.toHaveBeenCalled();
         });

    });

    describe('Disconnection and Error Handlers', () => {
        // Rely on global console mocks defined at the top level
        let mockClientDisconn, mockCommandSocketDisconn, mockEventSocketDisconn;
        let scheduleReconnectSpy, processExitSpy; // Removed console spies specific to this block
        let clientRemoveListenersSpy, cmdRemoveListenersSpy, evtRemoveListenersSpy;
        let cmdDestroySpy, evtDestroySpy;

        beforeEach(() => {
            // Remove console spy setup from here
            // consoleWarnSpyDisconn = jest.spyOn(console, 'warn').mockImplementation(() => { });
            // consoleErrorSpyDisconn = jest.spyOn(console, 'error').mockImplementation(() => { });
            processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit called'); });
            mockClientDisconn = { removeAllListeners: jest.fn() };
            mockCommandSocketDisconn = { removeAllListeners: jest.fn(), destroy: jest.fn(), destroyed: false };
            mockEventSocketDisconn = { removeAllListeners: jest.fn(), destroy: jest.fn(), destroyed: false };
            bridge.client = mockClientDisconn;
            bridge.commandSocket = mockCommandSocketDisconn;
            bridge.eventSocket = mockEventSocketDisconn;
            scheduleReconnectSpy = jest.spyOn(bridge, '_scheduleReconnect').mockImplementation(() => { });
            clientRemoveListenersSpy = jest.spyOn(mockClientDisconn, 'removeAllListeners');
            cmdRemoveListenersSpy = jest.spyOn(mockCommandSocketDisconn, 'removeAllListeners');
            evtRemoveListenersSpy = jest.spyOn(mockEventSocketDisconn, 'removeAllListeners');
            cmdDestroySpy = jest.spyOn(mockCommandSocketDisconn, 'destroy');
            evtDestroySpy = jest.spyOn(mockEventSocketDisconn, 'destroy');
            bridge.clientConnected = true;
            bridge.commandConnected = true;
            bridge.eventConnected = true;
        });

        afterEach(() => {
            // Remove console spy restores from here
            // consoleWarnSpyDisconn.mockRestore();
            // consoleErrorSpyDisconn.mockRestore();
            processExitSpy.mockRestore();
            scheduleReconnectSpy.mockRestore();
            // Need to manually restore spies on the mock objects from beforeEach
            clientRemoveListenersSpy.mockRestore();
            cmdRemoveListenersSpy.mockRestore();
            evtRemoveListenersSpy.mockRestore();
            cmdDestroySpy.mockRestore();
            evtDestroySpy.mockRestore();
        });

        // --- Close Handlers ---
        it('_handleMqttClose should reset flag, null client, remove listeners and warn', () => {
            bridge._handleMqttClose();
            expect(bridge.clientConnected).toBe(false);
            expect(bridge.client).toBeNull();
            expect(clientRemoveListenersSpy).toHaveBeenCalledTimes(1);
            expect(mockConsoleWarn).toHaveBeenCalledWith(expect.stringContaining('MQTT Client Closed')); // Use global mock
            expect(scheduleReconnectSpy).not.toHaveBeenCalled();
        });

        it('_handleCommandClose should reset flag, null socket, remove listeners, warn and schedule reconnect', () => {
            bridge._handleCommandClose(false);
            expect(bridge.commandConnected).toBe(false);
            expect(bridge.commandSocket).toBeNull();
            expect(cmdRemoveListenersSpy).toHaveBeenCalledTimes(1);
            expect(mockConsoleWarn).toHaveBeenCalledWith(expect.stringContaining('COMMAND PORT DISCONNECTED')); // Use global mock
            expect(mockConsoleWarn).not.toHaveBeenCalledWith(expect.stringContaining('with error'));
            expect(scheduleReconnectSpy).toHaveBeenCalledWith('command');
        });

        it('_handleCommandClose(hadError=true) should log warning with error', () => {
            bridge._handleCommandClose(true);
            expect(mockConsoleWarn).toHaveBeenCalledWith(expect.stringContaining('COMMAND PORT DISCONNECTED with error')); // Use global mock
            expect(scheduleReconnectSpy).toHaveBeenCalledWith('command');
        });

        it('_handleEventClose should reset flag, null socket, remove listeners, warn and schedule reconnect', () => {
            bridge._handleEventClose(false);
            expect(bridge.eventConnected).toBe(false);
            expect(bridge.eventSocket).toBeNull();
            expect(evtRemoveListenersSpy).toHaveBeenCalledTimes(1);
            expect(mockConsoleWarn).toHaveBeenCalledWith(expect.stringContaining('EVENT PORT DISCONNECTED')); // Use global mock
             expect(mockConsoleWarn).not.toHaveBeenCalledWith(expect.stringContaining('with error'));
            expect(scheduleReconnectSpy).toHaveBeenCalledWith('event');
        });
        
         it('_handleEventClose(hadError=true) should log warning with error', () => {
             bridge._handleEventClose(true);
             expect(mockConsoleWarn).toHaveBeenCalledWith(expect.stringContaining('EVENT PORT DISCONNECTED with error')); // Use global mock
             expect(scheduleReconnectSpy).toHaveBeenCalledWith('event');
         });

        // --- Error Handlers ---
        it('_handleMqttError (Auth Error code 5) should log specific error and exit', () => {
            const authError = new Error('Auth failed');
            authError.code = 5;
            expect(() => {
                bridge._handleMqttError(authError);
            }).toThrow('process.exit called');
            expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('MQTT Connection Error: Authentication failed')); // Use global mock
            expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('Exiting due to fatal MQTT authentication error.')); // Use global mock
            expect(processExitSpy).toHaveBeenCalledWith(1);
            expect(bridge.clientConnected).toBe(true);
            expect(bridge.client).toBeNull();
            expect(clientRemoveListenersSpy).toHaveBeenCalledTimes(1);
        });

        it('_handleMqttError (Generic Error) should log, reset flag, null client, remove listeners', () => {
            const genericError = new Error('Some MQTT error');
            bridge._handleMqttError(genericError);
            expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('MQTT Client Error:'), genericError); // Use global mock
            expect(bridge.clientConnected).toBe(false);
            expect(bridge.client).toBeNull();
            expect(clientRemoveListenersSpy).toHaveBeenCalledTimes(1);
            expect(processExitSpy).not.toHaveBeenCalled();
            expect(scheduleReconnectSpy).not.toHaveBeenCalled();
        });

        it('_handleCommandError should log error, reset flag, destroy socket, and null socket', () => {
            const cmdError = new Error('Command socket failed');
            bridge._handleCommandError(cmdError);
            expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('C-Gate Command Socket Error:'), cmdError); // Use global mock
            expect(bridge.commandConnected).toBe(false);
            expect(cmdDestroySpy).toHaveBeenCalledTimes(1);
            expect(bridge.commandSocket).toBeNull();
            expect(scheduleReconnectSpy).not.toHaveBeenCalled();
        });
        
         it('_handleCommandError should not destroy already destroyed socket', () => {
             mockCommandSocketDisconn.destroyed = true;
             const cmdError = new Error('Command socket failed again');
             bridge._handleCommandError(cmdError);
             expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('C-Gate Command Socket Error:'), cmdError); // Use global mock
             expect(bridge.commandConnected).toBe(false);
             expect(cmdDestroySpy).not.toHaveBeenCalled();
             expect(bridge.commandSocket).toBeNull();
         });

        it('_handleEventError should log error, reset flag, destroy socket, and null socket', () => {
            const evtError = new Error('Event socket failed');
            bridge._handleEventError(evtError);
            expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('C-Gate Event Socket Error:'), evtError); // Use global mock
            expect(bridge.eventConnected).toBe(false);
            expect(evtDestroySpy).toHaveBeenCalledTimes(1);
            expect(bridge.eventSocket).toBeNull();
            expect(scheduleReconnectSpy).not.toHaveBeenCalled();
        });
        
         it('_handleEventError should not destroy already destroyed socket', () => {
             mockEventSocketDisconn.destroyed = true;
             const evtError = new Error('Event socket failed again');
             bridge._handleEventError(evtError);
             expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('C-Gate Event Socket Error:'), evtError); // Use global mock
             expect(bridge.eventConnected).toBe(false);
             expect(evtDestroySpy).not.toHaveBeenCalled();
             expect(bridge.eventSocket).toBeNull();
         });

    });

    describe('Data Handlers: MQTT Message Processing', () => {
        let cgateQueueAddSpy;
        let emitterOnceSpy; // For ramp increase/decrease
        let triggerHaSpy;
        let consoleWarnSpyData;

        beforeEach(() => {
            cgateQueueAddSpy = jest.spyOn(bridge.cgateCommandQueue, 'add');
            emitterOnceSpy = jest.spyOn(bridge.internalEventEmitter, 'once');
            triggerHaSpy = jest.spyOn(bridge, '_triggerHaDiscovery').mockImplementation(() => {});
            consoleWarnSpyData = jest.spyOn(console, 'warn').mockImplementation(() => { });
            bridge.settings.cbusname = 'TestProject';
        });

        afterEach(() => {
            cgateQueueAddSpy.mockRestore();
            emitterOnceSpy.mockRestore();
            triggerHaSpy.mockRestore();
            consoleWarnSpyData.mockRestore();
        });

        it('should queue ON command for switch ON message', () => {
            const topic = 'cbus/write/254/56/10/switch';
            const message = Buffer.from('ON');
            bridge._handleMqttMessage(topic, message);
            expect(cgateQueueAddSpy).toHaveBeenCalledWith('ON //TestProject/254/56/10\n');
        });

        it('should queue OFF command for switch OFF message', () => {
            const topic = 'cbus/write/254/56/11/switch';
            const message = Buffer.from('OFF');
            bridge._handleMqttMessage(topic, message);
            expect(cgateQueueAddSpy).toHaveBeenCalledWith('OFF //TestProject/254/56/11\n');
        });

        it('should warn on invalid switch payload', () => {
            const topic = 'cbus/write/254/56/12/switch';
            const message = Buffer.from('INVALID');
            bridge._handleMqttMessage(topic, message);
            expect(cgateQueueAddSpy).not.toHaveBeenCalled();
            expect(consoleWarnSpyData).toHaveBeenCalledWith(expect.stringContaining('Invalid payload for switch command: INVALID'));
        });

        it('should queue RAMP command for ramp level message', () => {
            const topic = 'cbus/write/254/56/13/ramp';
            const message = Buffer.from('75');
            bridge._handleMqttMessage(topic, message);
            const expectedLevel = Math.round(75 * 255 / 100);
            expect(cgateQueueAddSpy).toHaveBeenCalledWith(`RAMP //TestProject/254/56/13 ${expectedLevel}\n`);
        });

        it('should queue RAMP command for ramp level,time message', () => {
            const topic = 'cbus/write/254/56/14/ramp';
            const message = Buffer.from('50,5s');
            bridge._handleMqttMessage(topic, message);
            const expectedLevel = Math.round(50 * 255 / 100);
            expect(cgateQueueAddSpy).toHaveBeenCalledWith(`RAMP //TestProject/254/56/14 ${expectedLevel} 5s\n`);
        });

        it('should queue ON command for ramp ON message', () => {
            const topic = 'cbus/write/254/56/15/ramp';
            const message = Buffer.from('ON');
            bridge._handleMqttMessage(topic, message);
            expect(cgateQueueAddSpy).toHaveBeenCalledWith('ON //TestProject/254/56/15\n');
        });

        it('should queue OFF command for ramp OFF message', () => {
            const topic = 'cbus/write/254/56/16/ramp';
            const message = Buffer.from('OFF');
            bridge._handleMqttMessage(topic, message);
            expect(cgateQueueAddSpy).toHaveBeenCalledWith('OFF //TestProject/254/56/16\n');
        });

        it('should queue GET then RAMP for ramp INCREASE message', () => {
            const topic = 'cbus/write/254/56/17/ramp';
            const message = Buffer.from('INCREASE');
            const currentLevel = 100; // Simulate current level
            const expectedNewLevel = Math.min(255, currentLevel + 26); // 26 is RAMP_STEP
            
            bridge._handleMqttMessage(topic, message);
            
            // Check that GET was queued
            expect(cgateQueueAddSpy).toHaveBeenCalledWith('GET //TestProject/254/56/17 level\n');
            // Check that emitter.once was set up
            expect(emitterOnceSpy).toHaveBeenCalledWith('level', expect.any(Function));
            
            // Simulate the level event being emitted after GET
            const levelCallback = emitterOnceSpy.mock.calls[0][1];
            levelCallback('254/56/17', currentLevel);
            
            // Check that RAMP was queued with the new level
            expect(cgateQueueAddSpy).toHaveBeenCalledWith(`RAMP //TestProject/254/56/17 ${expectedNewLevel}\n`);
        });
        
         it('should queue GET then RAMP for ramp DECREASE message', () => {
            const topic = 'cbus/write/254/56/18/ramp';
            const message = Buffer.from('DECREASE');
            const currentLevel = 150; // Simulate current level
            const expectedNewLevel = Math.max(0, currentLevel - 26); // 26 is RAMP_STEP
            
            bridge._handleMqttMessage(topic, message);
            
            expect(cgateQueueAddSpy).toHaveBeenCalledWith('GET //TestProject/254/56/18 level\n');
            expect(emitterOnceSpy).toHaveBeenCalledWith('level', expect.any(Function));
            
            const levelCallback = emitterOnceSpy.mock.calls[0][1];
            levelCallback('254/56/18', currentLevel);
            
            expect(cgateQueueAddSpy).toHaveBeenCalledWith(`RAMP //TestProject/254/56/18 ${expectedNewLevel}\n`);
        });
        
        it('should warn on invalid ramp payload', () => {
            const topic = 'cbus/write/254/56/19/ramp';
            const message = Buffer.from('INVALID');
            bridge._handleMqttMessage(topic, message);
            expect(cgateQueueAddSpy).not.toHaveBeenCalled();
            expect(consoleWarnSpyData).toHaveBeenCalledWith(expect.stringContaining('Invalid payload for ramp command: INVALID'));
        });

        it('should warn if ramp command used without device ID', () => {
             const topic = 'cbus/write/254/56//ramp'; // Missing device
             const message = Buffer.from('50');
             bridge._handleMqttMessage(topic, message);
             expect(cgateQueueAddSpy).not.toHaveBeenCalled();
             // Warning comes from _buildCbusPath originally
             expect(consoleWarnSpyData).toHaveBeenCalledWith(expect.stringContaining('requires device ID but none found'));
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
            expect(cgateQueueAddSpy).toHaveBeenCalledWith('TREEXML 254\n');
            expect(bridge.treeNetwork).toBe('254'); // Check network context is stored
        });
        
         it('should call _triggerHaDiscovery for manual trigger topic if enabled', () => {
             bridge.settings.ha_discovery_enabled = true;
             const topic = 'cbus/write/bridge/announce';
             const message = Buffer.from('');
             bridge._handleMqttMessage(topic, message);
             expect(triggerHaSpy).toHaveBeenCalledTimes(1);
             expect(cgateQueueAddSpy).not.toHaveBeenCalled(); // Should not queue other commands
         });
         
          it('should warn for manual trigger topic if HA discovery disabled', () => {
             bridge.settings.ha_discovery_enabled = false;
             const topic = 'cbus/write/bridge/announce';
             const message = Buffer.from('');
             bridge._handleMqttMessage(topic, message);
             expect(triggerHaSpy).not.toHaveBeenCalled();
             expect(consoleWarnSpyData).toHaveBeenCalledWith(expect.stringContaining('Manual HA Discovery trigger received, but feature is disabled'));
             expect(cgateQueueAddSpy).not.toHaveBeenCalled();
         });

         it('should warn and ignore unknown command type', () => {
             const topic = 'cbus/write/254/56/20/unknowncmd';
             const message = Buffer.from('data');
             bridge._handleMqttMessage(topic, message);
             expect(cgateQueueAddSpy).not.toHaveBeenCalled();
             expect(consoleWarnSpyData).toHaveBeenCalledWith(expect.stringContaining('Unknown MQTT command type received: unknowncmd'));
         });

         it('should warn and ignore invalid topic format', () => {
             const topic = 'cbus/write/invalid';
             const message = Buffer.from('ON');
             bridge._handleMqttMessage(topic, message);
             expect(cgateQueueAddSpy).not.toHaveBeenCalled();
             expect(consoleWarnSpyData).toHaveBeenCalledWith(expect.stringContaining('Ignoring invalid MQTT command'));
         });
    });

    describe('Data Handlers: C-Gate Command Port Processing', () => {
        let mqttAddSpyCmd, eventEmitSpyCmd, consoleErrorSpyCmd, consoleWarnSpyCmd;
        let parseStringResolver; // To wait for async parseString
        let publishHaSpy; // Spy on _publishHaDiscoveryFromTree

        beforeEach(() => {
            mqttAddSpyCmd = jest.spyOn(bridge.mqttPublishQueue, 'add');
            eventEmitSpyCmd = jest.spyOn(bridge.internalEventEmitter, 'emit');
            consoleErrorSpyCmd = jest.spyOn(console, 'error').mockImplementation(() => { });
            consoleWarnSpyCmd = jest.spyOn(console, 'warn').mockImplementation(() => { });
            publishHaSpy = jest.spyOn(bridge, '_publishHaDiscoveryFromTree').mockImplementation(() => {});

            // Setup mock parseString for TREE commands
            mockParseStringFn.mockImplementation((xml, options, callback) => {
                // Simulate successful parsing for most tests
                callback(null, { mockParsedXml: true }); 
                if (parseStringResolver) {
                    parseStringResolver(); // Resolve promise to allow test to continue
                    parseStringResolver = null;
                }
            });

            bridge.commandBuffer = ""; 
            bridge.treeBuffer = "";
            bridge.treeNetwork = null;
            bridge.settings.cbusname = 'TestProject';
            bridge.settings.ha_discovery_enabled = false; // Disable HA by default for these tests
            bridge.settings.ha_discovery_networks = [];
        });

        afterEach(() => {
            mqttAddSpyCmd.mockRestore();
            eventEmitSpyCmd.mockRestore();
            consoleErrorSpyCmd.mockRestore();
            consoleWarnSpyCmd.mockRestore();
            publishHaSpy.mockRestore();
            mockParseStringFn.mockClear();
            parseStringResolver = null;
        });

        it('should process buffered data with multiple lines', () => {
            bridge._handleCommandData(Buffer.from('300 //TestProject/254/56/1 level=128\n300 //TestProj'));
            bridge._handleCommandData(Buffer.from('ect/254/56/2 level=0\n'));
            expect(mqttAddSpyCmd).toHaveBeenCalledTimes(4); // state + level for each
            expect(mqttAddSpyCmd).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/1/state', payload: 'ON' }));
            expect(mqttAddSpyCmd).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/1/level', payload: '50' })); // 128/255
            expect(mqttAddSpyCmd).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/2/state', payload: 'OFF' }));
            expect(mqttAddSpyCmd).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/2/level', payload: '0' }));
            expect(eventEmitSpyCmd).toHaveBeenCalledWith('level', '254/56/1', 128);
            expect(eventEmitSpyCmd).toHaveBeenCalledWith('level', '254/56/2', 0);
            expect(bridge.commandBuffer).toBe('');
        });

        it('should handle 300 status for level=0', () => {
             bridge._handleCommandData(Buffer.from('300 //TestProject/254/56/5 level=0\n'));
             expect(mqttAddSpyCmd).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/5/state', payload: 'OFF' }));
             expect(mqttAddSpyCmd).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/5/level', payload: '0' }));
             expect(eventEmitSpyCmd).toHaveBeenCalledWith('level', '254/56/5', 0);
        });
        
        it('should handle 300 status for level=255', () => {
             bridge._handleCommandData(Buffer.from('300 //TestProject/254/56/6 level=255\n'));
             expect(mqttAddSpyCmd).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/6/state', payload: 'ON' }));
             expect(mqttAddSpyCmd).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/6/level', payload: '100' }));
             expect(eventEmitSpyCmd).toHaveBeenCalledWith('level', '254/56/6', 255);
        });
        
         it('should handle 300 status that looks like an event', () => {
             bridge._handleCommandData(Buffer.from('300-lighting on 254/56/7\n'));
             expect(mqttAddSpyCmd).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/7/state', payload: 'ON' }));
             expect(mqttAddSpyCmd).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/7/level', payload: '100' }));
             expect(eventEmitSpyCmd).toHaveBeenCalledWith('level', '254/56/7', 255); // Emits raw level for ON
         });
         
          it('should handle unhandled 300 status gracefully', () => {
             bridge._handleCommandData(Buffer.from('300 Some other status\n'));
             expect(mqttAddSpyCmd).not.toHaveBeenCalled();
             expect(eventEmitSpyCmd).not.toHaveBeenCalled();
             // CBusEvent constructor *will* warn when parsing fails
             expect(consoleWarnSpyCmd).toHaveBeenCalledWith(expect.stringContaining('Malformed C-Bus Event data:'), 'Some other status');
         });

         it('should handle TREE commands correctly', async () => {
            bridge.settings.ha_discovery_enabled = true; // Enable for this test
            bridge.settings.ha_discovery_networks = ['254'];
            
            let promise = new Promise(resolve => { parseStringResolver = resolve; });

            bridge._handleCommandData(Buffer.from('343-254\n')); // Tree start
            expect(bridge.treeNetwork).toBe('254');
            expect(bridge.treeBuffer).toBe('');

            bridge._handleCommandData(Buffer.from('347-<Network>Data</Network>\n')); // Tree data
            expect(bridge.treeBuffer).toBe('<Network>Data</Network>\n');

            bridge._handleCommandData(Buffer.from('344-254\n')); // Tree end
            
            // Wait for async parseString to complete
            await promise;

            expect(bridge.treeNetwork).toBeNull(); // Should be cleared
            expect(bridge.treeBuffer).toBe(''); // Should be cleared
            expect(mockParseStringFn).toHaveBeenCalledWith('<Network>Data</Network>\n', { explicitArray: false }, expect.any(Function));
            // Check standard tree published
            expect(mqttAddSpyCmd).toHaveBeenCalledWith(expect.objectContaining({ 
                topic: 'cbus/read/254///tree',
                payload: JSON.stringify({ mockParsedXml: true })
            }));
            // Check HA discovery triggered
            expect(publishHaSpy).toHaveBeenCalledWith('254', { mockParsedXml: true });
         });
         
         it('should handle TREE commands when HA discovery is disabled', async () => {
            bridge.settings.ha_discovery_enabled = false;
            let promise = new Promise(resolve => { parseStringResolver = resolve; });

            bridge._handleCommandData(Buffer.from('343-254\n'));
            bridge._handleCommandData(Buffer.from('347-<Data>stuff</Data>\n'));
            bridge._handleCommandData(Buffer.from('344-254\n'));
            
            await promise;

            expect(mqttAddSpyCmd).toHaveBeenCalledWith(expect.objectContaining({ 
                topic: 'cbus/read/254///tree',
                payload: JSON.stringify({ mockParsedXml: true })
            }));
            expect(publishHaSpy).not.toHaveBeenCalled(); // Should not be called
         });
         
          it('should handle TREE end without start/data gracefully', () => {
              bridge._handleCommandData(Buffer.from('344-254\n'));
              expect(mockParseStringFn).not.toHaveBeenCalled();
              expect(mqttAddSpyCmd).not.toHaveBeenCalled();
              expect(publishHaSpy).not.toHaveBeenCalled();
              expect(consoleWarnSpyCmd).toHaveBeenCalledWith(expect.stringContaining('Received TreeXML end (344) but no buffer or network context'));
          });

         it('should handle parseString error during TREE processing', async () => {
             const parseError = new Error('XML Badness');
             mockParseStringFn.mockImplementationOnce((xml, options, callback) => {
                callback(parseError, null);
                 if (parseStringResolver) {
                     parseStringResolver();
                     parseStringResolver = null;
                 }
            });
            let promise = new Promise(resolve => { parseStringResolver = resolve; });

            bridge._handleCommandData(Buffer.from('343-254\n'));
            bridge._handleCommandData(Buffer.from('347-<Data>stuff</Data>\n'));
            bridge._handleCommandData(Buffer.from('344-254\n'));
            
            await promise;

            expect(consoleErrorSpyCmd).toHaveBeenCalledWith(expect.stringContaining('Error parsing TreeXML for network 254:'), parseError);
            expect(mqttAddSpyCmd).not.toHaveBeenCalled();
            expect(publishHaSpy).not.toHaveBeenCalled();
         });

         it('should log 4xx/5xx command errors', () => {
             bridge._handleCommandData(Buffer.from('401 Unauthorized\n'));
             bridge._handleCommandData(Buffer.from('500 Server Error\n'));
             expect(consoleErrorSpyCmd).toHaveBeenCalledWith(expect.stringContaining('C-Gate Command Error Response: 401 Unauthorized'));
             expect(consoleErrorSpyCmd).toHaveBeenCalledWith(expect.stringContaining('C-Gate Command Error Response: 500 Server Error'));
         });

         it('should ignore invalid response code format', () => {
             bridge._handleCommandData(Buffer.from('InvalidResponse Code\n'));
             expect(mqttAddSpyCmd).not.toHaveBeenCalled();
             expect(eventEmitSpyCmd).not.toHaveBeenCalled();
             // Check for specific log message? Depends on implementation
         });
         
          it('should ignore empty lines', () => {
             bridge._handleCommandData(Buffer.from('\n300 //TestProject/254/56/8 level=0\n\n'));
             expect(mqttAddSpyCmd).toHaveBeenCalledTimes(2); // State and Level for the valid line
         });
    });

    describe('Data Handlers: C-Gate Event Port Processing', () => {
        let mqttAddSpyEvt, eventEmitSpyEvt, consoleWarnSpyEvt;
        beforeEach(() => {
            mqttAddSpyEvt = jest.spyOn(bridge.mqttPublishQueue, 'add');
            eventEmitSpyEvt = jest.spyOn(bridge.internalEventEmitter, 'emit');
            consoleWarnSpyEvt = jest.spyOn(console, 'warn').mockImplementation(() => { });
            bridge.eventBuffer = ""; 
        });
        afterEach(() => {
            mqttAddSpyEvt.mockRestore();
            eventEmitSpyEvt.mockRestore();
            consoleWarnSpyEvt.mockRestore();
        });
        
        it('should process buffered data correctly', () => {
            bridge._handleEventData(Buffer.from('lighting on 254/56/10\nlighti'));
            bridge._handleEventData(Buffer.from('ng off 254/56/11\n'));
            expect(mqttAddSpyEvt).toHaveBeenCalledTimes(4);
            expect(mqttAddSpyEvt).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/10/state', payload: 'ON' }));
            expect(mqttAddSpyEvt).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/10/level', payload: '100' }));
            expect(mqttAddSpyEvt).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/11/state', payload: 'OFF' }));
            expect(mqttAddSpyEvt).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/11/level', payload: '0' }));
            expect(eventEmitSpyEvt).toHaveBeenCalledWith('level', '254/56/10', 255);
            expect(eventEmitSpyEvt).toHaveBeenCalledWith('level', '254/56/11', 0);
            expect(bridge.eventBuffer).toBe('');
        });

        it('should process ramp event with level', () => {
             bridge._handleEventData(Buffer.from('lighting ramp 254/56/12 64\n')); // 64 = ~25%
             expect(mqttAddSpyEvt).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/12/state', payload: 'ON' }));
             expect(mqttAddSpyEvt).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/12/level', payload: '25' }));
             expect(eventEmitSpyEvt).toHaveBeenCalledWith('level', '254/56/12', 64);
        });

        it('should ignore comments', () => {
            bridge._handleEventData(Buffer.from('# This is a comment\nlighting on 254/56/15\n'));
            expect(mqttAddSpyEvt).toHaveBeenCalledTimes(2); // Only state/level for the valid line
            expect(mqttAddSpyEvt).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/15/state' }));
        });

        it('should warn on invalid event line', () => {
            bridge._handleEventData(Buffer.from('invalid event data\n'));
            expect(mqttAddSpyEvt).not.toHaveBeenCalled();
            expect(eventEmitSpyEvt).not.toHaveBeenCalled();
            expect(consoleWarnSpyEvt).toHaveBeenCalledWith(expect.stringContaining('Could not parse event line: invalid event data'));
        });
        
        it('should ignore empty lines', () => {
            bridge._handleEventData(Buffer.from('\nlighting off 254/56/17\n\n'));
            expect(mqttAddSpyEvt).toHaveBeenCalledTimes(2);
        });
    });

    describe('Queue Processors', () => {
        jest.useFakeTimers();
        let mockClientQueue, mockCommandSocketQueue; 
        let consoleWarnSpyQueue, consoleErrorSpyQueue;
        let messageInterval; // Define here, assign in beforeEach
        beforeEach(() => {
            // Assign messageInterval here where bridge is defined
            messageInterval = bridge.settings.messageinterval; 
            
            consoleWarnSpyQueue = jest.spyOn(console, 'warn').mockImplementation(() => { });
            consoleErrorSpyQueue = jest.spyOn(console, 'error').mockImplementation(() => { });
            mockClientQueue = { publish: jest.fn() };
            mockCommandSocketQueue = { write: jest.fn() };
            bridge.client = mockClientQueue;
            bridge.commandSocket = mockCommandSocketQueue;
            // Ensure connected flags are managed per test
            bridge.clientConnected = false;
            bridge.commandConnected = false;
        });
        afterEach(() => {
            consoleWarnSpyQueue.mockRestore();
            consoleErrorSpyQueue.mockRestore();
             bridge.client = null;
             bridge.commandSocket = null;
        });

        it('_processMqttPublish should publish message when client connected', () => {
            const msg = { topic: 'test/topic', payload: 'test payload', options: { qos: 1 } };
            bridge.clientConnected = true; // Set connected state for this test
            bridge.mqttPublishQueue.add(msg);
            jest.advanceTimersByTime(messageInterval + 1);
            expect(mockClientQueue.publish).toHaveBeenCalledWith(msg.topic, msg.payload, msg.options);
            expect(consoleErrorSpyQueue).not.toHaveBeenCalled();
        });
       // ... other tests ...
       it('_processCgateCommand should handle write errors', () => {
            const errorMsg = 'Write failed';
            mockCommandSocketQueue.write.mockImplementation(() => {
                throw new Error(errorMsg);
            });
             const cmdString = 'FAIL COMMAND\n';
            bridge.commandConnected = true;
            bridge.cgateCommandQueue.add(cmdString);
            jest.advanceTimersByTime(messageInterval + 1);
            expect(mockCommandSocketQueue.write).toHaveBeenCalledWith(cmdString);
            expect(consoleErrorSpyQueue).toHaveBeenCalledWith(expect.stringContaining('Error writing to C-Gate command socket:'), expect.any(Error), cmdString.trim());
        });
    });

    describe('Reconnection Logic', () => {
        jest.useFakeTimers();
        let setTimeoutSpy, clearTimeoutSpy;
        let connectCmdSpyReconn, connectEvtSpyReconn; // Use different names
        let initialDelay, maxDelay;
        beforeEach(() => {
            initialDelay = bridge.settings.reconnectinitialdelay;
            maxDelay = bridge.settings.reconnectmaxdelay;
            setTimeoutSpy = jest.spyOn(global, 'setTimeout');
            clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
            connectCmdSpyReconn = jest.spyOn(bridge, '_connectCommandSocket').mockImplementation(() => {});
            connectEvtSpyReconn = jest.spyOn(bridge, '_connectEventSocket').mockImplementation(() => {});
            bridge.commandConnected = false;
            bridge.eventConnected = false;
            bridge.commandReconnectAttempts = 0;
            bridge.eventReconnectAttempts = 0;
            bridge.commandReconnectTimeout = null;
            bridge.eventReconnectTimeout = null;
             bridge.commandSocket = null; 
             bridge.eventSocket = null;
        });
        afterEach(() => {
            setTimeoutSpy.mockRestore();
            clearTimeoutSpy.mockRestore();
            connectCmdSpyReconn.mockRestore();
            connectEvtSpyReconn.mockRestore();
            jest.clearAllTimers();
        });

        it(`_scheduleReconnect('command') should schedule with initial delay on first attempt`, () => {
            bridge._scheduleReconnect('command');
            expect(bridge.commandReconnectAttempts).toBe(1);
            expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
            expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), initialDelay);
             expect(bridge.commandReconnectTimeout).toBeDefined();
        });
        // ... more Reconnection Logic tests ...
         it('should execute connect function after timeout (event)', () => {
             bridge._scheduleReconnect('event');
             expect(connectEvtSpyReconn).not.toHaveBeenCalled();
             jest.advanceTimersByTime(initialDelay + 1);
             expect(connectEvtSpyReconn).toHaveBeenCalledTimes(1);
          });
    });

    describe('Connection Methods', () => {
        
        describe('_connectCommandSocket', () => {
            it('should call command socket factory', () => {
                bridge._connectCommandSocket();
                expect(mockCmdSocketFactory).toHaveBeenCalledTimes(1);
            });
            // ... more _connectCommandSocket tests ...
             it('should handle socket.connect error', () => {
                // --- Local console mock for this test --- 
                const consoleErrorSpyLocal = jest.spyOn(console, 'error').mockImplementation(() => {});
                
                const connectError = new Error('Connection failed');
                mockCmdSocketFactory.mockImplementationOnce(() => {
                    const socket = new EventEmitter();
                    socket.connect = jest.fn(() => { throw connectError; });
                    socket.on = jest.fn(); 
                    socket.removeAllListeners = jest.fn();
                    socket.destroy = jest.fn();
                    lastMockCmdSocket = socket;
                    return socket;
                });
                const errorSpy = jest.spyOn(bridge, '_handleCommandError');

                bridge._connectCommandSocket();

                expect(lastMockCmdSocket.connect).toHaveBeenCalled();
                expect(errorSpy).toHaveBeenCalledWith(connectError);
                
                errorSpy.mockRestore();
                // --- Restore local console mock --- 
                consoleErrorSpyLocal.mockRestore(); 
            });
        });

        describe('_connectEventSocket', () => {
            it('should call event socket factory', () => {
                bridge._connectEventSocket();
                expect(mockEvtSocketFactory).toHaveBeenCalledTimes(1);
            });
            // ... more _connectEventSocket tests ...
             it('should handle socket.connect error', () => {
                 // --- Local console mock for this test --- 
                 const consoleErrorSpyLocal = jest.spyOn(console, 'error').mockImplementation(() => {});
                 
                 const connectError = new Error('Event Connection failed');
                 mockEvtSocketFactory.mockImplementationOnce(() => {
                    const socket = new EventEmitter();
                    socket.connect = jest.fn(() => { throw connectError; });
                    socket.on = jest.fn();
                    socket.removeAllListeners = jest.fn();
                    socket.destroy = jest.fn();
                    lastMockEvtSocket = socket;
                    return socket;
                });
                const errorSpy = jest.spyOn(bridge, '_handleEventError');
                bridge._connectEventSocket();
                expect(lastMockEvtSocket.connect).toHaveBeenCalled();
                expect(errorSpy).toHaveBeenCalledWith(connectError);
                errorSpy.mockRestore();
                // --- Restore local console mock --- 
                consoleErrorSpyLocal.mockRestore(); 
             });
        });
        
        describe('_connectMqtt', () => {
             const mqtt = require('mqtt');
             const mqttConnectMock = mqtt.connect;
             beforeEach(() => {
                 bridge.client = null;
                 bridge.clientConnected = false;
                 mqttConnectMock.mockClear();
                 mockMqttClient.on.mockClear();
                 mockMqttClient.removeAllListeners.mockClear();
             });

             it('should call mqtt.connect with correct URL and no auth options by default', () => {
                 bridge._connectMqtt();
                 const expectedUrl = `mqtt://${mockSettings.mqtt}`;
                 expect(mqttConnectMock).toHaveBeenCalledTimes(1);
                 expect(mqttConnectMock).toHaveBeenCalledWith(expectedUrl, {});
                 expect(bridge.client).toBe(mockMqttClient);
             });
             // ... more _connectMqtt tests ...
             it('should not connect if client already exists (and skip cleanup)', () => {
                 bridge.client = mockMqttClient; 
                 mockMqttClient.removeAllListeners.mockClear();
                 mqttConnectMock.mockClear();
                 bridge._connectMqtt();
                 expect(mockMqttClient.removeAllListeners).not.toHaveBeenCalled();
                 expect(mqttConnectMock).not.toHaveBeenCalled();
             });
        });

    });

}); 