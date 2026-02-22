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
        
        
    });

    afterEach(async () => {
        // Cleanup connections and queues to prevent hanging
        if (bridge) {
            try {
                // Clear queues first to stop async operations
                bridge.cgateCommandQueue?.clear?.();
                bridge.mqttPublishQueue?.clear?.();
                bridge.eventConnection?.disconnect?.();
                await bridge.commandConnectionPool?.stop?.();
            } catch {
                // Ignore cleanup errors
            }
        }
        
        // Run any pending setImmediate callbacks before clearing
        await new Promise(resolve => setImmediate(resolve));
        
        jest.clearAllTimers();
        mockConsoleWarn.mockClear();
        mockConsoleError.mockClear();
        
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

        it('should initialize connection manager', () => {
            expect(bridge.connectionManager).toBeDefined();
            expect(bridge.connectionManager.isAllConnected).toBe(false);
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
            expect(bridge.commandLineProcessors).toBeInstanceOf(Map);
            expect(bridge.commandLineProcessors.size).toBe(0);
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

    describe('Settings Validation', () => {
        it('should validate settings successfully with valid default settings', () => {
            const { validate } = require('../src/settingsValidator');
            expect(validate({ ...defaultSettings, logging: false })).toBe(true);
        });

        it('should validate settings successfully with valid user-provided settings', () => {
            const { validate } = require('../src/settingsValidator');
            expect(validate(bridge.settings)).toBe(true);
        });

        it('should handle invalid settings through validator', () => {
            const { createValidator } = require('../src/settingsValidator');
            const validator = createValidator({ exitOnError: false });
            const invalidSettings = { ...bridge.settings, mqtt: null };
            expect(validator.validate(invalidSettings)).toBe(false);
        });
    });

    // Error response processing tests are now handled by CommandResponseProcessor tests

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
                expect(bridge.connectionManager.isAllConnected).toBe(false);
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
            beforeEach(() => {
                bridge._lastInitTime = 0;
            });

            it('should initialize services when all connections are ready', () => {
                const logSpy = jest.spyOn(bridge, 'log');
                
                bridge._handleAllConnected();

                expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ALL CONNECTED - Initializing services'));
            });

            it('should skip duplicate initialization within 10 seconds', () => {
                const logSpy = jest.spyOn(bridge, 'log');
                
                bridge._handleAllConnected();
                logSpy.mockClear();
                bridge._handleAllConnected();

                expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('duplicate within 10s'));
                expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Initializing services'));
            });

            it('should trigger initial getall when configured', () => {
                bridge.settings.getallnetapp = '254/56';
                bridge.settings.getallonstart = true;
                const addSpy = jest.spyOn(bridge.cgateCommandQueue, 'add');

                bridge._handleAllConnected();

                expect(addSpy).toHaveBeenCalledWith(expect.stringContaining('GET //TestProject/254/56/* level'));
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
            beforeEach(() => {
                publishSpy = jest.spyOn(bridge.mqttPublishQueue, 'add');
            });

            afterEach(() => {
                publishSpy.mockRestore();
            });

            it('should create per-connection line processor on first data', () => {
                const testData = Buffer.from('200-This is a test response\n201-Another line\n');
                const mockConnection = { id: 'test-conn-1' };
                
                expect(bridge.commandLineProcessors.size).toBe(0);
                bridge._handleCommandData(testData, mockConnection);
                
                expect(bridge.commandLineProcessors.size).toBe(1);
                expect(bridge.commandLineProcessors.has(mockConnection)).toBe(true);
            });

            it('should reuse existing line processor for same connection', () => {
                const mockConnection = { id: 'test-conn-2' };
                bridge._handleCommandData(Buffer.from('200-line1\n'), mockConnection);
                bridge._handleCommandData(Buffer.from('201-line2\n'), mockConnection);
                
                expect(bridge.commandLineProcessors.size).toBe(1);
            });

            it('should delegate to CommandResponseProcessor for single line', () => {
                const processSpy = jest.spyOn(bridge.commandResponseProcessor, 'processLine');
                const testData = Buffer.from('300-//PROJECT/254/56/1: level=128\n');
                const mockConn = { id: 'single-line' };
                
                bridge._handleCommandData(testData, mockConn);
                
                expect(processSpy).toHaveBeenCalledWith('300-//PROJECT/254/56/1: level=128');
                processSpy.mockRestore();
            });

            it('should delegate to CommandResponseProcessor for multiple lines', () => {
                const processSpy = jest.spyOn(bridge.commandResponseProcessor, 'processLine');
                const testData = Buffer.from('300-//PROJECT/254/56/1: level=128\n343-Begin tree\n344-End tree\n');
                const mockConn = { id: 'multi-line' };
                
                bridge._handleCommandData(testData, mockConn);
                
                expect(processSpy).toHaveBeenCalledTimes(3);
                expect(processSpy).toHaveBeenCalledWith('300-//PROJECT/254/56/1: level=128');
                expect(processSpy).toHaveBeenCalledWith('343-Begin tree');
                expect(processSpy).toHaveBeenCalledWith('344-End tree');
                processSpy.mockRestore();
            });
        });

        // Command response processing tests are now handled by CommandResponseProcessor tests
        
        describe('Command data integration with CommandResponseProcessor', () => {
            it('should delegate command processing to CommandResponseProcessor', () => {
                const processSpy = jest.spyOn(bridge.commandResponseProcessor, 'processLine');
                const testData = Buffer.from('300-//TestProject/254/56/1: level=128\n');
                const mockConn = { id: 'integration' };
                
                bridge._handleCommandData(testData, mockConn);
                
                expect(processSpy).toHaveBeenCalledWith('300-//TestProject/254/56/1: level=128');
                processSpy.mockRestore();
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
                const publishEventSpy = jest.spyOn(bridge.eventPublisher, 'publishEvent');
                
                bridge._processEventLine('lighting on //TestProject/254/56/1');
                
                expect(publishEventSpy).toHaveBeenCalled();
                publishEventSpy.mockRestore();
            });

            it('should ignore invalid event lines', () => {
                const publishEventSpy = jest.spyOn(bridge.eventPublisher, 'publishEvent');
                
                bridge._processEventLine('invalid event line');
                
                expect(publishEventSpy).not.toHaveBeenCalled();
                publishEventSpy.mockRestore();
            });
        });

        describe('EventPublisher integration', () => {
            it('should use EventPublisher for publishing events', () => {
                const publishEventSpy = jest.spyOn(bridge.eventPublisher, 'publishEvent');
                const mockEvent = {
                    isValid: () => true,
                    getNetwork: () => '254',
                    getApplication: () => '56', 
                    getGroup: () => '1',
                    getAction: () => 'on',
                    getLevel: () => 255
                };
                
                bridge.eventPublisher.publishEvent(mockEvent, '(Test)');
                
                expect(publishEventSpy).toHaveBeenCalledWith(mockEvent, '(Test)');
                publishEventSpy.mockRestore();
            });

            it('should initialize EventPublisher with correct options', () => {
                expect(bridge.eventPublisher).toBeDefined();
                expect(bridge.eventPublisher.settings).toBe(bridge.settings);
                expect(bridge.eventPublisher.mqttPublishQueue).toBe(bridge.mqttPublishQueue);
                expect(bridge.eventPublisher.mqttOptions).toEqual(bridge._mqttOptions);
            });
        });

        describe('DeviceStateManager integration', () => {
            it('should use DeviceStateManager for level tracking', () => {
                const updateSpy = jest.spyOn(bridge.deviceStateManager, 'updateLevelFromEvent');
                const mockEvent = {
                    getNetwork: () => '254',
                    getApplication: () => '56',
                    getGroup: () => '1',
                    getLevel: () => 75
                };
                
                bridge._processEventLine('lighting ramp 254/56/1 75');
                
                expect(updateSpy).toHaveBeenCalledWith(expect.any(Object));
                updateSpy.mockRestore();
            });

            it('should provide event emitter to MQTT command router', () => {
                expect(bridge.mqttCommandRouter.internalEventEmitter).toBe(bridge.deviceStateManager.getEventEmitter());
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