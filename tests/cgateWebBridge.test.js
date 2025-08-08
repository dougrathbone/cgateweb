// tests/cgateWebBridge.test.js - Tests for CgateWebBridge constructor and validation

const CgateWebBridge = require('../src/cgateWebBridge');
const { defaultSettings } = require('../index.js');
const EventEmitter = require('events');

// --- Mock CgateConnectionPool ---
const mockConnectionPool = new EventEmitter();
mockConnectionPool.setMaxListeners(100); // Prevent memory leak warnings
mockConnectionPool.start = jest.fn().mockImplementation(async () => {
    mockConnectionPool.isStarted = true;
    mockConnectionPool.healthyConnections = { size: 3 };
    mockConnectionPool.connections = [{ poolIndex: 0 }, { poolIndex: 1 }, { poolIndex: 2 }];
    setImmediate(() => mockConnectionPool.emit('started', { healthy: 3, total: 3 }));
});
mockConnectionPool.stop = jest.fn().mockImplementation(async () => {
    mockConnectionPool.isStarted = false;
    mockConnectionPool.healthyConnections = { size: 0 };
    mockConnectionPool.connections = [];
    setImmediate(() => mockConnectionPool.emit('stopped'));
});
mockConnectionPool.execute = jest.fn().mockImplementation(async () => true);
mockConnectionPool.getStats = jest.fn(() => ({
    poolSize: 3,
    totalConnections: 3,
    healthyConnections: 3,
    isStarted: mockConnectionPool.isStarted || false,
    isShuttingDown: false
}));
mockConnectionPool.isStarted = false;
mockConnectionPool.healthyConnections = { size: 0 };
mockConnectionPool.connections = [];

jest.mock('../src/cgateConnectionPool', () => {
    return jest.fn().mockImplementation(() => mockConnectionPool);
});

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

describe('CgateWebBridge', () => {
    let bridge;
    let mockSettings;
    let mockCmdSocketFactory, mockEvtSocketFactory;
    let _lastMockCmdSocket, _lastMockEvtSocket;
    let exitSpy;

    beforeEach(() => {
        // Reset connection pool mock
        mockConnectionPool.start.mockClear();
        mockConnectionPool.stop.mockClear();
        mockConnectionPool.execute.mockClear();
        mockConnectionPool.getStats.mockClear();
        mockConnectionPool.isStarted = false;
        mockConnectionPool.healthyConnections = { size: 0 };
        mockConnectionPool.connections = [];
        
        // Reset MQTT mocks
        mockMqttClient.removeAllListeners.mockClear();
        mockMqttClient.subscribe.mockClear();
        mockMqttClient.publish.mockClear();
        mockMqttClient.end.mockClear();
        mockMqttClient.on.mockClear();
        const mqtt = require('mqtt');
        mqtt.connect.mockClear();

        mockSettings = { 
            mqtt: 'mqtt.example.com:1883',
            cbusip: '192.168.1.100',
            cbusname: 'TestProject',
            cbuscommandport: 20023,
            cbuseventport: 20025,
            messageinterval: 100,
            reconnectinitialdelay: 1000,
            reconnectmaxdelay: 30000,
            retainreads: false,
            logging: false,
            getallnetapp: null,
            getallonstart: false,
            getallperiod: null,
            mqttusername: null,
            mqttpassword: null,
            cgateusername: null,
            cgatepassword: null,
            ha_discovery_enabled: false,
            ha_discovery_prefix: 'homeassistant',
            ha_discovery_networks: [],
            ha_discovery_cover_app_id: '203',
            ha_discovery_switch_app_id: null,
            ha_discovery_relay_app_id: null,
            ha_discovery_pir_app_id: null
        }; 

        // Create mock socket factories
        _lastMockCmdSocket = null;
        _lastMockEvtSocket = null;
        mockCmdSocketFactory = jest.fn(() => {
            const socket = new EventEmitter();
            socket.connect = jest.fn();
            socket.write = jest.fn();
            socket.destroy = jest.fn();
            socket.removeAllListeners = jest.fn();
            socket.on = jest.fn(); 
            socket.connecting = false; 
            socket.destroyed = false;  
            _lastMockCmdSocket = socket; 
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
            _lastMockEvtSocket = socket; 
            return socket;
        });
        
        // Create bridge instance using the mock settings and factories
        bridge = new CgateWebBridge(
            mockSettings,
            null, 
            mockCmdSocketFactory, 
            mockEvtSocketFactory
        );
        
        // Mock process.exit needed for constructor validation test
        exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
            throw new Error(`process.exit called with code ${code}`);
        });
    });

    afterEach(async () => {
        jest.clearAllTimers();
        mockConsoleWarn.mockClear();
        mockConsoleError.mockClear();
        if(exitSpy) exitSpy.mockRestore();
        
        // Cleanup connections to prevent hanging
        if (bridge) {
            try {
                bridge.eventConnection?.disconnect?.();
                await bridge.commandConnectionPool?.stop?.();
            } catch {
                // Ignore cleanup errors
            }
        }
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

        it('should initialize allConnected flag to false', () => {
            expect(bridge.allConnected).toBe(false);
        });

        it('should initialize underlying connection managers properly', () => {
            expect(bridge.mqttManager).toBeDefined();
            expect(bridge.commandConnectionPool).toBeDefined();
            expect(bridge.eventConnection).toBeDefined();
            expect(bridge.mqttManager.connected).toBe(false);
            expect(bridge.commandConnectionPool.isStarted).toBe(false);
            expect(bridge.eventConnection.connected).toBe(false);
        });


        it('should initialize line processors', () => {
            expect(bridge.commandLineProcessor.getBuffer()).toBe('');
            expect(bridge.eventLineProcessor.getBuffer()).toBe('');
        });

        it('should initialize haDiscovery as null initially', () => {
            expect(bridge.haDiscovery).toBeNull();
        });

        it('should initialize queues', () => {
            expect(bridge.cgateCommandQueue).toBeDefined();
            expect(bridge.cgateCommandQueue.constructor.name).toBe('ThrottledQueue');
            expect(bridge.mqttPublishQueue).toBeDefined();
            expect(bridge.mqttPublishQueue.constructor.name).toBe('ThrottledQueue');
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

    describe('_validateSettings', () => {
        let errorSpy;
        let warnSpy;

        beforeEach(() => {
            errorSpy = jest.spyOn(bridge, 'error');
            warnSpy = jest.spyOn(bridge, 'warn');
        });

        afterEach(() => {
            errorSpy.mockRestore();
            warnSpy.mockRestore();
        });

        it('should validate settings successfully with valid default settings', () => {
            const bridgeWithDefaults = new CgateWebBridge({ ...defaultSettings, logging: false });
            expect(bridgeWithDefaults.settingsValidator.validate(bridgeWithDefaults.settings)).toBe(true);
        });

        it('should validate settings successfully with valid user-provided settings', () => {
            expect(bridge.settingsValidator.validate(bridge.settings)).toBe(true);
        });

        it('should handle invalid settings through validator', () => {
            const invalidSettings = { ...bridge.settings, mqtt: null };
            expect(bridge.settingsValidator.validate(invalidSettings)).toBe(false);
        });

        it('constructor should exit if validation fails', () => {
            const invalidSettings = { ...defaultSettings, mqtt: null }; 
            expect(() => {
                new CgateWebBridge(invalidSettings);
            }).toThrow('process.exit called with code 1');
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
    });

    describe('_processCommandErrorResponse', () => {
        let errorSpy;
        beforeEach(() => {
            errorSpy = jest.spyOn(bridge, 'error');
        });
        afterEach(() => {
            errorSpy.mockRestore();
        });

        it('should log specific message for 400 Bad Request', () => {
            bridge._processCommandErrorResponse('400', 'Syntax error near GET');
            expect(errorSpy).toHaveBeenCalledWith('[ERROR] C-Gate Command Error 400: (Bad Request/Syntax Error) - Syntax error near GET');
        });

        it('should log specific message for 401 Unauthorized', () => {
            bridge._processCommandErrorResponse('401', 'Access denied');
            expect(errorSpy).toHaveBeenCalledWith('[ERROR] C-Gate Command Error 401: (Unauthorized - Check Credentials/Permissions) - Access denied');
        });

        it('should log specific message for 404 Not Found', () => {
            bridge._processCommandErrorResponse('404', 'Object not found');
            expect(errorSpy).toHaveBeenCalledWith('[ERROR] C-Gate Command Error 404: (Not Found - Check Object Path) - Object not found');
        });

        it('should log specific message for 406 Not Acceptable', () => {
            bridge._processCommandErrorResponse('406', 'Invalid parameter');
            expect(errorSpy).toHaveBeenCalledWith('[ERROR] C-Gate Command Error 406: (Not Acceptable - Invalid Parameter Value) - Invalid parameter');
        });

        it('should log specific message for 500 Internal Server Error', () => {
            bridge._processCommandErrorResponse('500', 'Server error');
            expect(errorSpy).toHaveBeenCalledWith('[ERROR] C-Gate Command Error 500: (Internal Server Error) - Server error');
        });

        it('should log specific message for 503 Service Unavailable', () => {
            bridge._processCommandErrorResponse('503', 'Service not available');
            expect(errorSpy).toHaveBeenCalledWith('[ERROR] C-Gate Command Error 503: (Service Unavailable) - Service not available');
        });

        it('should log generic message for other 4xx errors', () => {
            bridge._processCommandErrorResponse('498', 'Custom client error');
            expect(errorSpy).toHaveBeenCalledWith('[ERROR] C-Gate Command Error 498: - Custom client error');
        });

        it('should log generic message for other 5xx errors', () => {
            bridge._processCommandErrorResponse('598', 'Custom server error');
            expect(errorSpy).toHaveBeenCalledWith('[ERROR] C-Gate Command Error 598: - Custom server error');
        });

        it('should handle missing statusData correctly for specific codes', () => {
            bridge._processCommandErrorResponse('404', '');
            expect(errorSpy).toHaveBeenCalledWith('[ERROR] C-Gate Command Error 404: (Not Found - Check Object Path) - No details provided');
        });

        it('should handle missing statusData correctly for generic codes', () => {
            bridge._processCommandErrorResponse('498', null);
            expect(errorSpy).toHaveBeenCalledWith('[ERROR] C-Gate Command Error 498: - No details provided');
        });
    });

    describe('Bridge Start/Stop Operations', () => {
        let infoSpy, logSpy;

        beforeEach(() => {
            infoSpy = jest.spyOn(bridge.logger, 'info');
            logSpy = jest.spyOn(bridge, 'log');
        });

        afterEach(() => {
            infoSpy.mockRestore();
            logSpy.mockRestore();
        });

        describe('start()', () => {
            it('should start all connections and log startup message', async () => {
                const mqttConnectSpy = jest.spyOn(bridge.mqttManager, 'connect');
                const cmdPoolStartSpy = jest.spyOn(bridge.commandConnectionPool, 'start');
                const evtConnectSpy = jest.spyOn(bridge.eventConnection, 'connect');

                const result = await bridge.start();

                expect(mqttConnectSpy).toHaveBeenCalled();
                expect(cmdPoolStartSpy).toHaveBeenCalled();
                expect(evtConnectSpy).toHaveBeenCalled();
                expect(result).toBe(bridge); // Method chaining

                mqttConnectSpy.mockRestore();
                cmdPoolStartSpy.mockRestore();
                evtConnectSpy.mockRestore();
            });
        });

        describe('stop()', () => {
            it('should stop all connections and clear resources', async () => {
                // Set up some state to clean up
                const intervalId = setInterval(() => {}, 1000);
                bridge.periodicGetAllInterval = intervalId;

                const mqttDisconnectSpy = jest.spyOn(bridge.mqttManager, 'disconnect');  
                const cmdPoolStopSpy = jest.spyOn(bridge.commandConnectionPool, 'stop');
                const evtDisconnectSpy = jest.spyOn(bridge.eventConnection, 'disconnect');
                const clearQueuesSpy = jest.spyOn(bridge.cgateCommandQueue, 'clear');
                const clearMqttQueueSpy = jest.spyOn(bridge.mqttPublishQueue, 'clear');

                await bridge.stop();

                expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Stopping cgateweb bridge'));
                expect(bridge.periodicGetAllInterval).toBeNull();
                expect(bridge.allConnected).toBe(false);
                expect(clearQueuesSpy).toHaveBeenCalled();
                expect(clearMqttQueueSpy).toHaveBeenCalled();
                expect(mqttDisconnectSpy).toHaveBeenCalled();
                expect(cmdPoolStopSpy).toHaveBeenCalled();
                expect(evtDisconnectSpy).toHaveBeenCalled();

                mqttDisconnectSpy.mockRestore();
                cmdPoolStopSpy.mockRestore();
                evtDisconnectSpy.mockRestore();
                clearQueuesSpy.mockRestore();
                clearMqttQueueSpy.mockRestore();
            });

            it('should handle stop when no periodic interval is set', () => {
                bridge.periodicGetAllInterval = null;
                
                expect(() => bridge.stop()).not.toThrow();
                expect(bridge.periodicGetAllInterval).toBeNull();
            });
        });
    });

    describe('Connection Management', () => {
        let logSpy, infoSpy;

        beforeEach(() => {
            logSpy = jest.spyOn(bridge, 'log');
            infoSpy = jest.spyOn(bridge.logger, 'info');
        });

        afterEach(() => {
            logSpy.mockRestore();
            infoSpy.mockRestore();
        });

        describe('_handleAllConnected()', () => {
            it('should set allConnected to true when all services are connected', () => {
                // Mock all connections as connected
                bridge.mqttManager.connected = true;
                bridge.commandConnectionPool.isStarted = true;
                bridge.commandConnectionPool.healthyConnections = { size: 3 };
                bridge.eventConnection.connected = true;

                bridge._handleAllConnected();

                expect(bridge.allConnected).toBe(true);
            });

            it('should not set allConnected when not all services are connected', () => {
                bridge.mqttManager.connected = true;
                bridge.commandConnectionPool.isStarted = false; // Not connected
                bridge.eventConnection.connected = true;

                bridge._handleAllConnected();

                expect(bridge.allConnected).toBe(false);
            });

            it('should handle getall on start when enabled', () => {
                bridge.settings.getallnetapp = '254/56';
                bridge.settings.getallonstart = true;
                bridge.mqttManager.connected = true;
                bridge.commandConnectionPool.isStarted = true;
                bridge.commandConnectionPool.healthyConnections = { size: 3 };
                bridge.eventConnection.connected = true;

                const queueSpy = jest.spyOn(bridge.cgateCommandQueue, 'add');

                bridge._handleAllConnected();

                expect(queueSpy).toHaveBeenCalledWith('GET //TestProject/254/56/* level\n');
                queueSpy.mockRestore();
            });

            it('should set up periodic getall when enabled', () => {
                jest.useFakeTimers();
                bridge.settings.getallnetapp = '254/56';
                bridge.settings.getallperiod = 5; // 5 seconds (not milliseconds)
                bridge.mqttManager.connected = true;
                bridge.commandConnectionPool.isStarted = true;
                bridge.commandConnectionPool.healthyConnections = { size: 3 };
                bridge.eventConnection.connected = true;

                bridge._handleAllConnected();

                expect(bridge.periodicGetAllInterval).not.toBeNull();
                
                // Test that periodic execution works
                const queueSpy = jest.spyOn(bridge.cgateCommandQueue, 'add');
                jest.advanceTimersByTime(5000);
                expect(queueSpy).toHaveBeenCalledWith('GET //TestProject/254/56/* level\n');

                queueSpy.mockRestore();
                jest.useRealTimers();
            });

            it('should trigger HA discovery when enabled', () => {
                bridge.settings.ha_discovery_enabled = true;
                bridge.mqttManager.connected = true;
                bridge.commandConnectionPool.isStarted = true;
                bridge.commandConnectionPool.healthyConnections = { size: 3 };
                bridge.eventConnection.connected = true;

                // Mock haDiscovery since it gets created in _handleAllConnected
                bridge.haDiscovery = { trigger: jest.fn() };
                const discoverySpy = jest.spyOn(bridge.haDiscovery, 'trigger');

                bridge._handleAllConnected();

                expect(discoverySpy).toHaveBeenCalled();
                discoverySpy.mockRestore();
            });
        });
    });



    describe('Logging Methods', () => {
        let loggerSpy;

        beforeEach(() => {
            loggerSpy = {
                info: jest.spyOn(bridge.logger, 'info'),
                warn: jest.spyOn(bridge.logger, 'warn'),
                error: jest.spyOn(bridge.logger, 'error')
            };
        });

        afterEach(() => {
            Object.values(loggerSpy).forEach(spy => spy.mockRestore());
        });

        it('should log info messages', () => {
            bridge.log('test message', { key: 'value' });
            expect(loggerSpy.info).toHaveBeenCalledWith('test message', { key: 'value' });
        });

        it('should log warning messages', () => {
            bridge.warn('warning message', { key: 'value' });
            expect(loggerSpy.warn).toHaveBeenCalledWith('warning message', { key: 'value' });
        });

        it('should log error messages', () => {
            bridge.error('error message', { key: 'value' });
            expect(loggerSpy.error).toHaveBeenCalledWith('error message', { key: 'value' });
        });
    });

    describe('C-Gate Response Processing', () => {
        let publishSpy;

        beforeEach(() => {
            publishSpy = jest.spyOn(bridge.mqttPublishQueue, 'add');
        });

        afterEach(() => {
            publishSpy.mockRestore();
        });

        describe('_handleCommandData()', () => {
            it('should process command data through line processor', () => {
                const testData = Buffer.from('200-This is a test response\n201-Another line\n');
                const processSpy = jest.spyOn(bridge.commandLineProcessor, 'processData');
                
                bridge._handleCommandData(testData);
                
                expect(processSpy).toHaveBeenCalledWith(testData, expect.any(Function));
                processSpy.mockRestore();
            });
        });

        describe('_parseCommandResponseLine()', () => {
            it('should parse successful responses', () => {
                const result = bridge._parseCommandResponseLine('200-Command successful');
                
                expect(result).toEqual({
                    responseCode: '200',
                    statusData: 'Command successful'
                });
            });

            it('should parse error responses', () => {
                const result = bridge._parseCommandResponseLine('400-Bad request error');
                
                expect(result).toEqual({
                    responseCode: '400',
                    statusData: 'Bad request error'
                });
            });

            it('should handle responses without status data', () => {
                const result = bridge._parseCommandResponseLine('200 ');
                
                expect(result).toEqual({
                    responseCode: '200',
                    statusData: ''
                });
            });

            it('should ignore malformed responses', () => {
                const processSpy = jest.spyOn(bridge, '_processCommandResponse');
                
                bridge._parseCommandResponseLine('Invalid response line');
                
                expect(processSpy).not.toHaveBeenCalled();
                processSpy.mockRestore();
            });
        });

        describe('_processCommandResponse()', () => {
            it('should process object status responses', () => {
                const objectStatusSpy = jest.spyOn(bridge, '_processCommandObjectStatus');
                
                bridge._processCommandResponse('300', 'Object status data');
                
                expect(objectStatusSpy).toHaveBeenCalledWith('Object status data');
                objectStatusSpy.mockRestore();
            });

            it('should process tree start responses', () => {
                // Mock haDiscovery
                bridge.haDiscovery = { handleTreeStart: jest.fn() };
                const treeStartSpy = jest.spyOn(bridge.haDiscovery, 'handleTreeStart');
                
                bridge._processCommandResponse('343', 'Tree start');
                
                expect(treeStartSpy).toHaveBeenCalledWith('Tree start');
                treeStartSpy.mockRestore();
            });

            it('should process tree data responses', () => {
                // Mock haDiscovery
                bridge.haDiscovery = { handleTreeData: jest.fn() };
                const treeDataSpy = jest.spyOn(bridge.haDiscovery, 'handleTreeData');
                
                bridge._processCommandResponse('347', 'Tree data content');
                
                expect(treeDataSpy).toHaveBeenCalledWith('Tree data content');
                treeDataSpy.mockRestore();
            });

            it('should process tree end responses', () => {
                // Mock haDiscovery
                bridge.haDiscovery = { handleTreeEnd: jest.fn() };
                const treeEndSpy = jest.spyOn(bridge.haDiscovery, 'handleTreeEnd');
                
                bridge._processCommandResponse('344', 'Tree end');
                
                expect(treeEndSpy).toHaveBeenCalled();
                treeEndSpy.mockRestore();
            });

            it('should process error responses', () => {
                const errorSpy = jest.spyOn(bridge, '_processCommandErrorResponse');
                
                bridge._processCommandResponse('404', 'Not found error');
                
                expect(errorSpy).toHaveBeenCalledWith('404', 'Not found error');
                errorSpy.mockRestore();
            });
        });

        describe('_processCommandObjectStatus()', () => {
            it('should publish object status to MQTT', () => {
                const statusData = '//TestProject/254/56/1: level=75';
                
                bridge._processCommandObjectStatus(statusData);
                
                // Level 75 out of 255 = 29% (75/255 * 100 = 29.4, rounded to 29)
                expect(publishSpy).toHaveBeenCalledWith({
                    topic: 'cbus/read/254/56/1/level',
                    payload: '29',
                    options: { qos: 0 }
                });
            });
        });
    });

    describe('Event Processing', () => {
        let publishSpy;

        beforeEach(() => {
            publishSpy = jest.spyOn(bridge.mqttPublishQueue, 'add');
        });

        afterEach(() => {
            publishSpy.mockRestore();
        });

        describe('_handleEventData()', () => {
            it('should process event data through line processor', () => {
                const testData = Buffer.from('lighting on //TestProject/254/56/1\n');
                const processSpy = jest.spyOn(bridge.eventLineProcessor, 'processData');
                
                bridge._handleEventData(testData);
                
                expect(processSpy).toHaveBeenCalledWith(testData, expect.any(Function));
                processSpy.mockRestore();
            });
        });

        describe('_processEventLine()', () => {
            it('should process lighting events', () => {
                const publishEventSpy = jest.spyOn(bridge, '_publishEvent');
                
                bridge._processEventLine('lighting on //TestProject/254/56/1');
                
                expect(publishEventSpy).toHaveBeenCalled();
                publishEventSpy.mockRestore();
            });

            it('should ignore invalid event lines', () => {
                const publishEventSpy = jest.spyOn(bridge, '_publishEvent');
                
                bridge._processEventLine('invalid event line');
                
                expect(publishEventSpy).not.toHaveBeenCalled();
                publishEventSpy.mockRestore();
            });
        });

        describe('_publishEvent()', () => {
            it('should publish lighting events to MQTT', () => {
                const mockEvent = {
                    isValid: () => true,
                    getNetwork: () => '254',
                    getApplication: () => '56', 
                    getGroup: () => '1',
                    getAction: () => 'on',
                    getLevel: () => 255
                };
                
                bridge._publishEvent(mockEvent);
                
                expect(publishSpy).toHaveBeenCalledWith({
                    topic: 'cbus/read/254/56/1/state',
                    payload: 'ON',
                    options: { qos: 0 }
                });
            });

            it('should publish PIR sensor events differently', () => {
                const mockEvent = {
                    isValid: () => true,
                    getNetwork: () => '254',
                    getApplication: () => '56',
                    getGroup: () => '1', 
                    getAction: () => 'on',
                    getLevel: () => null
                };
                bridge.settings.ha_discovery_pir_app_id = '56';
                
                bridge._publishEvent(mockEvent);
                
                expect(publishSpy).toHaveBeenCalledWith({
                    topic: 'cbus/read/254/56/1/state',
                    payload: 'ON',
                    options: { qos: 0 }
                });
            });
        });

        describe('_emitLevelFromEvent()', () => {
            it('should emit level events for internal listeners', () => {
                const emitSpy = jest.spyOn(bridge.internalEventEmitter, 'emit');
                const mockEvent = {
                    getNetwork: () => '254',
                    getApplication: () => '56',
                    getGroup: () => '1',
                    getLevel: () => 75
                };
                
                bridge._emitLevelFromEvent(mockEvent);
                
                expect(emitSpy).toHaveBeenCalledWith('level', '254/56/1', 75);
                emitSpy.mockRestore();
            });

            it('should not emit when level is null', () => {
                const emitSpy = jest.spyOn(bridge.internalEventEmitter, 'emit');
                const mockEvent = {
                    getApplication: () => '56',
                    getNetwork: () => '254',
                    getGroup: () => '1',
                    getLevel: () => null,
                    getAction: () => 'some_other_action' // Not 'on' or 'off', so no level implied
                };
                
                bridge._emitLevelFromEvent(mockEvent);
                
                expect(emitSpy).not.toHaveBeenCalled();  
                emitSpy.mockRestore();
            });
        });
    });

    describe('Queue Processing', () => {
        describe('_sendCgateCommand()', () => {
            it('should send commands via connection pool', async () => {
                const executeSpy = jest.spyOn(bridge.commandConnectionPool, 'execute');
                
                await bridge._sendCgateCommand('TEST COMMAND\n');
                
                expect(executeSpy).toHaveBeenCalledWith('TEST COMMAND\n');
                executeSpy.mockRestore();
            });
        });

        describe('_publishMqttMessage()', () => {
            it('should publish messages via MQTT manager', () => {
                const publishSpy = jest.spyOn(bridge.mqttManager, 'publish');
                const message = {
                    topic: 'test/topic',
                    payload: 'test payload',
                    options: { qos: 1 }
                };
                
                bridge._publishMqttMessage(message);
                
                expect(publishSpy).toHaveBeenCalledWith('test/topic', 'test payload', { qos: 1 });
                publishSpy.mockRestore();
            });
        });
    });
});