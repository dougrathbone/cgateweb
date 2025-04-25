// tests/cgateWebBridge.test.js

// Import necessary classes/functions
const { CgateWebBridge, ThrottledQueue, settings: defaultSettings } = require('../index.js');
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
        let mockClientStop, mockCommandSocketStop, mockEventSocketStop; // Use different names to avoid scope clash
        let mqttQueueClearSpy, cgateQueueClearSpy, emitterRemoveSpy;

        beforeEach(() => {
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
        });

        afterEach(() => {
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
            bridge.client = mockClientStop;
            bridge.commandSocket = mockCommandSocketStop;
            bridge.eventSocket = mockEventSocketStop;
            bridge.clientConnected = true;
            bridge.commandConnected = true;
            bridge.eventConnected = true;
            bridge.commandReconnectTimeout = setTimeout(() => { }, 1000);
            bridge.eventReconnectTimeout = setTimeout(() => { }, 1000);
            bridge.periodicGetAllInterval = setInterval(() => { }, 1000);
            const cmdTimeoutId = bridge.commandReconnectTimeout;
            const evtTimeoutId = bridge.eventReconnectTimeout;
            const getAllIntervalId = bridge.periodicGetAllInterval;

            bridge.stop();

            expect(clearTimeoutSpy).toHaveBeenCalledWith(cmdTimeoutId);
            expect(clearTimeoutSpy).toHaveBeenCalledWith(evtTimeoutId);
            expect(clearIntervalSpy).toHaveBeenCalledWith(getAllIntervalId);
            expect(mqttQueueClearSpy).toHaveBeenCalledTimes(1);
            expect(cgateQueueClearSpy).toHaveBeenCalledTimes(1);
            expect(mockClientStop.end).toHaveBeenCalledWith(true);
            expect(mockCommandSocketStop.destroy).toHaveBeenCalledTimes(1);
            expect(mockEventSocketStop.destroy).toHaveBeenCalledTimes(1);
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
             bridge.client = null;
             bridge.commandSocket = null;
             bridge.eventSocket = null;
             bridge.commandReconnectTimeout = null;
             bridge.eventReconnectTimeout = null;
             bridge.periodicGetAllInterval = null;
             bridge.clientConnected = false;
 
             expect(() => bridge.stop()).not.toThrow();
 
             expect(clearTimeoutSpy).not.toHaveBeenCalled();
             expect(clearIntervalSpy).not.toHaveBeenCalled();
             expect(mqttQueueClearSpy).toHaveBeenCalledTimes(1);
             expect(cgateQueueClearSpy).toHaveBeenCalledTimes(1);
             expect(emitterRemoveSpy).toHaveBeenCalledTimes(1);
         });

    });

    describe('Connection Handlers', () => {
        let mockClientHandler, mockCommandSocketHandler, mockEventHandler; // Use different names
        let mqttAddSpy, checkAllSpy, clearTimeoutSpy;
        let cmdWriteSpy; 

        beforeEach(() => {
            mockClientHandler = { 
                subscribe: jest.fn((topic, cb) => cb(null)), 
                publish: jest.fn(),
                removeAllListeners: jest.fn(), 
                on: jest.fn() 
            };
            mockCommandSocketHandler = { 
                write: jest.fn(), 
                removeAllListeners: jest.fn(), 
                on: jest.fn(), 
                connect: jest.fn(), 
                destroy: jest.fn() 
            };
            mockEventHandler = { 
                removeAllListeners: jest.fn(), 
                on: jest.fn(), 
                connect: jest.fn(), 
                destroy: jest.fn() 
            };

            bridge.client = mockClientHandler;
            bridge.commandSocket = mockCommandSocketHandler;
            bridge.eventSocket = mockEventHandler;

            mqttAddSpy = jest.spyOn(bridge.mqttPublishQueue, 'add');
            checkAllSpy = jest.spyOn(bridge, '_checkAllConnected').mockImplementation(() => { });
            clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
            cmdWriteSpy = jest.spyOn(bridge.commandSocket, 'write');
        });

        afterEach(() => {
            mqttAddSpy.mockRestore();
            checkAllSpy.mockRestore();
            clearTimeoutSpy.mockRestore();
            cmdWriteSpy.mockRestore();
            mockClientHandler.subscribe.mockClear();
            mockCommandSocketHandler.write.mockClear();
        });

        it('_handleMqttConnect should set flag, subscribe, publish online, and check all connected', () => {
            bridge.clientConnected = false; 
            bridge._handleMqttConnect();
            expect(bridge.clientConnected).toBe(true);
            expect(mockClientHandler.subscribe).toHaveBeenCalledWith('cbus/write/#', expect.any(Function));
            expect(mqttAddSpy).toHaveBeenCalledWith({ topic: 'hello/cgateweb', payload: 'Online', options: { retain: false } });
            expect(checkAllSpy).toHaveBeenCalledTimes(1);
        });

        it('_handleCommandConnect should set flag, reset attempts, clear timeout, send EVENT ON, and check all connected', () => {
            bridge.commandConnected = false;
            bridge.commandReconnectAttempts = 5;
            bridge.commandReconnectTimeout = setTimeout(() => { }, 5000); 
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
             bridge.eventReconnectTimeout = setTimeout(() => { }, 5000); 
             const timeoutId = bridge.eventReconnectTimeout;
             bridge._handleEventConnect();
             expect(bridge.eventConnected).toBe(true);
             expect(bridge.eventReconnectAttempts).toBe(0);
             expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutId);
             expect(bridge.eventReconnectTimeout).toBeNull();
             expect(checkAllSpy).toHaveBeenCalledTimes(1);
        });

    });

    describe('Disconnection and Error Handlers', () => {
        let mockClientDisconn, mockCommandSocketDisconn, mockEventSocketDisconn; // Use different names
        let scheduleReconnectSpy, consoleWarnSpyDisconn, consoleErrorSpyDisconn, processExitSpy;
        let clientRemoveListenersSpy, cmdRemoveListenersSpy, evtRemoveListenersSpy;
        let cmdDestroySpy, evtDestroySpy;

        beforeEach(() => {
            consoleWarnSpyDisconn = jest.spyOn(console, 'warn').mockImplementation(() => { });
            consoleErrorSpyDisconn = jest.spyOn(console, 'error').mockImplementation(() => { });
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
            consoleWarnSpyDisconn.mockRestore();
            consoleErrorSpyDisconn.mockRestore();
            processExitSpy.mockRestore();
            scheduleReconnectSpy.mockRestore();
        });

        it('_handleMqttClose should reset flag, null client, remove listeners and warn', () => {
            bridge._handleMqttClose();
            expect(bridge.clientConnected).toBe(false);
            expect(bridge.client).toBeNull();
            expect(clientRemoveListenersSpy).toHaveBeenCalledTimes(1);
            expect(consoleWarnSpyDisconn).toHaveBeenCalledWith(expect.stringContaining('MQTT Client Closed'));
            expect(scheduleReconnectSpy).not.toHaveBeenCalled();
        });

        it('_handleCommandClose should reset flag, null socket, remove listeners, warn and schedule reconnect', () => {
            bridge._handleCommandClose(false);
            expect(bridge.commandConnected).toBe(false);
            expect(bridge.commandSocket).toBeNull();
            expect(cmdRemoveListenersSpy).toHaveBeenCalledTimes(1);
            expect(consoleWarnSpyDisconn).toHaveBeenCalledWith(expect.stringContaining('COMMAND PORT DISCONNECTED'));
            expect(consoleWarnSpyDisconn).not.toHaveBeenCalledWith(expect.stringContaining('with error'));
            expect(scheduleReconnectSpy).toHaveBeenCalledWith('command');
        });

        it('_handleCommandClose(hadError=true) should log warning with error', () => {
            bridge._handleCommandClose(true);
            expect(consoleWarnSpyDisconn).toHaveBeenCalledWith(expect.stringContaining('COMMAND PORT DISCONNECTED with error'));
            expect(scheduleReconnectSpy).toHaveBeenCalledWith('command');
        });

        it('_handleEventClose should reset flag, null socket, remove listeners, warn and schedule reconnect', () => {
            bridge._handleEventClose(false);
            expect(bridge.eventConnected).toBe(false);
            expect(bridge.eventSocket).toBeNull();
            expect(evtRemoveListenersSpy).toHaveBeenCalledTimes(1);
            expect(consoleWarnSpyDisconn).toHaveBeenCalledWith(expect.stringContaining('EVENT PORT DISCONNECTED'));
             expect(consoleWarnSpyDisconn).not.toHaveBeenCalledWith(expect.stringContaining('with error'));
            expect(scheduleReconnectSpy).toHaveBeenCalledWith('event');
        });
        
         it('_handleEventClose(hadError=true) should log warning with error', () => {
             bridge._handleEventClose(true);
             expect(consoleWarnSpyDisconn).toHaveBeenCalledWith(expect.stringContaining('EVENT PORT DISCONNECTED with error'));
             expect(scheduleReconnectSpy).toHaveBeenCalledWith('event');
         });

        it('_handleMqttError (Auth Error code 5) should log specific error and exit', () => {
            const authError = new Error('Auth failed');
            authError.code = 5;
            expect(() => {
                bridge._handleMqttError(authError);
            }).toThrow('process.exit called');
            expect(consoleErrorSpyDisconn).toHaveBeenCalledWith(expect.stringContaining('MQTT Connection Error: Authentication failed'));
            expect(consoleErrorSpyDisconn).toHaveBeenCalledWith(expect.stringContaining('Exiting due to fatal MQTT authentication error.'));
            expect(processExitSpy).toHaveBeenCalledWith(1);
            expect(bridge.clientConnected).toBe(true);
            expect(bridge.client).toBeNull();
            expect(clientRemoveListenersSpy).toHaveBeenCalledTimes(1);
        });

        it('_handleMqttError (Generic Error) should log, reset flag, null client, remove listeners', () => {
            const genericError = new Error('Some MQTT error');
            bridge._handleMqttError(genericError);
            expect(consoleErrorSpyDisconn).toHaveBeenCalledWith(expect.stringContaining('MQTT Client Error:'), genericError);
            expect(bridge.clientConnected).toBe(false);
            expect(bridge.client).toBeNull();
            expect(clientRemoveListenersSpy).toHaveBeenCalledTimes(1);
            expect(processExitSpy).not.toHaveBeenCalled();
            expect(scheduleReconnectSpy).not.toHaveBeenCalled();
        });

        it('_handleCommandError should log error, reset flag, destroy socket, and null socket', () => {
            const cmdError = new Error('Command socket failed');
            bridge._handleCommandError(cmdError);
            expect(consoleErrorSpyDisconn).toHaveBeenCalledWith(expect.stringContaining('C-Gate Command Socket Error:'), cmdError);
            expect(bridge.commandConnected).toBe(false);
            expect(cmdDestroySpy).toHaveBeenCalledTimes(1);
            expect(bridge.commandSocket).toBeNull();
            expect(scheduleReconnectSpy).not.toHaveBeenCalled();
        });
        
         it('_handleCommandError should not destroy already destroyed socket', () => {
             mockCommandSocketDisconn.destroyed = true;
             const cmdError = new Error('Command socket failed again');
             bridge._handleCommandError(cmdError);
             expect(consoleErrorSpyDisconn).toHaveBeenCalledWith(expect.stringContaining('C-Gate Command Socket Error:'), cmdError);
             expect(bridge.commandConnected).toBe(false);
             expect(cmdDestroySpy).not.toHaveBeenCalled();
             expect(bridge.commandSocket).toBeNull();
         });

        it('_handleEventError should log error, reset flag, destroy socket, and null socket', () => {
            const evtError = new Error('Event socket failed');
            bridge._handleEventError(evtError);
            expect(consoleErrorSpyDisconn).toHaveBeenCalledWith(expect.stringContaining('C-Gate Event Socket Error:'), evtError);
            expect(bridge.eventConnected).toBe(false);
            expect(evtDestroySpy).toHaveBeenCalledTimes(1);
            expect(bridge.eventSocket).toBeNull();
            expect(scheduleReconnectSpy).not.toHaveBeenCalled();
        });
        
         it('_handleEventError should not destroy already destroyed socket', () => {
             mockEventSocketDisconn.destroyed = true;
             const evtError = new Error('Event socket failed again');
             bridge._handleEventError(evtError);
             expect(consoleErrorSpyDisconn).toHaveBeenCalledWith(expect.stringContaining('C-Gate Event Socket Error:'), evtError);
             expect(bridge.eventConnected).toBe(false);
             expect(evtDestroySpy).not.toHaveBeenCalled();
             expect(bridge.eventSocket).toBeNull();
         });

    });

    describe('Data Handlers', () => {

        describe('_handleMqttMessage', () => {
            let cgateQueueAddSpy, emitterOnceSpy, consoleWarnSpyData;
            beforeEach(() => {
                cgateQueueAddSpy = jest.spyOn(bridge.cgateCommandQueue, 'add');
                emitterOnceSpy = jest.spyOn(bridge.internalEventEmitter, 'once');
                consoleWarnSpyData = jest.spyOn(console, 'warn').mockImplementation(() => { });
                bridge.settings.cbusname = 'TestProject';
            });
            afterEach(() => {
                cgateQueueAddSpy.mockRestore();
                emitterOnceSpy.mockRestore();
                consoleWarnSpyData.mockRestore();
            });

            it('should queue ON command for switch ON message', () => {
                const topic = 'cbus/write/254/56/10/switch';
                const message = Buffer.from('ON');
                bridge._handleMqttMessage(topic, message);
                expect(cgateQueueAddSpy).toHaveBeenCalledWith('ON //TestProject/254/56/10\n');
            });
            // ... many more _handleMqttMessage tests ...
             it('should warn and ignore invalid topic', () => {
                 const topic = 'cbus/write/invalid';
                 const message = Buffer.from('ON');
                 bridge._handleMqttMessage(topic, message);
                 expect(cgateQueueAddSpy).not.toHaveBeenCalled();
                 expect(consoleWarnSpyData).toHaveBeenCalledWith(expect.stringContaining('Ignoring invalid MQTT command'));
             });
        });

        describe('_handleCommandData', () => {
            let mqttAddSpyCmd, eventEmitSpyCmd, consoleErrorSpyCmd, consoleWarnSpyCmd;
            let parseStringResolver;
            beforeEach(() => {
                mqttAddSpyCmd = jest.spyOn(bridge.mqttPublishQueue, 'add');
                eventEmitSpyCmd = jest.spyOn(bridge.internalEventEmitter, 'emit');
                consoleErrorSpyCmd = jest.spyOn(console, 'error').mockImplementation(() => { });
                consoleWarnSpyCmd = jest.spyOn(console, 'warn').mockImplementation(() => { });
                mockParseStringFn.mockImplementation((xml, options, callback) => {
                    callback(null, { mockParsedXml: true });
                    if (parseStringResolver) {
                        parseStringResolver();
                        parseStringResolver = null;
                    }
                });
                bridge.commandBuffer = ""; 
                bridge.settings.cbusname = 'TestProject';
            });
            afterEach(() => {
                mqttAddSpyCmd.mockRestore();
                eventEmitSpyCmd.mockRestore();
                if (consoleErrorSpyCmd) consoleErrorSpyCmd.mockRestore();
                consoleWarnSpyCmd.mockRestore();
                mockParseStringFn.mockClear();
            });

            it('should process buffered data correctly', () => {
                bridge._handleCommandData(Buffer.from('300 //TestProject/254/56/1 level=128\n300 //TestProj'));
                bridge._handleCommandData(Buffer.from('ect/254/56/2 level=0\n'));
                expect(mqttAddSpyCmd).toHaveBeenCalledTimes(4);
                expect(mqttAddSpyCmd).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/1/state', payload: 'ON' }));
                expect(mqttAddSpyCmd).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/2/state', payload: 'OFF' }));
                expect(bridge.commandBuffer).toBe('');
            });
            // ... many more _handleCommandData tests ...
             it('should ignore empty lines', () => {
                bridge._handleCommandData(Buffer.from('\n300 //TestProject/254/56/8 level=0\n\n'));
                expect(mqttAddSpyCmd).toHaveBeenCalledTimes(2);
            });
        });

        describe('_handleEventData', () => {
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
                expect(mqttAddSpyEvt).toHaveBeenCalledWith(expect.objectContaining({ topic: 'cbus/read/254/56/11/state', payload: 'OFF' }));
                expect(bridge.eventBuffer).toBe('');
            });
            // ... many more _handleEventData tests ...
             it('should ignore empty lines', () => {
                bridge._handleEventData(Buffer.from('\nlighting off 254/56/17\n\n'));
                expect(mqttAddSpyEvt).toHaveBeenCalledTimes(2);
            });
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
            });
        });

        describe('_connectEventSocket', () => {
            it('should call event socket factory', () => {
                bridge._connectEventSocket();
                expect(mockEvtSocketFactory).toHaveBeenCalledTimes(1);
            });
            // ... more _connectEventSocket tests ...
             it('should handle socket.connect error', () => {
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