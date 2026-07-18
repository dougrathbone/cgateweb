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
            // Network auto-discovery defaults to true (documented behavior). These
            // unit tests drive _handleAllConnected directly and assert the
            // getall/HA-discovery path, so opt out to avoid the async tree-request
            // handshake (mirrors bridgeInitializationService.test.js).
            autoDiscoverNetworks: false,
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
                bridge.haBridgeDiagnostics?.stop?.();
                bridge.eventConnection?.disconnect?.();
                await bridge.commandConnectionPool?.stop?.();
                // Close the web server that bridge.start() launches
                // fire-and-forget; a listening HTTP server otherwise keeps
                // the jest worker alive after the run.
                await bridge.webServer?.close?.();
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

        it('should initialize command queue', () => {
            expect(bridge.cgateCommandQueue).toBeDefined();
            expect(bridge.cgateCommandQueue.constructor.name).toBe('ThrottledQueue');
        });

        it('should initialize lifecycle state as booting', () => {
            const status = bridge._getBridgeStatus();
            expect(status.lifecycle.state).toBe('booting');
            expect(status.lifecycle.transitions).toBe(0);
        });

        it('surfaces C-Bus network interface (CNI) state in the bridge status', () => {
            // Empty until the first poll response arrives.
            expect(bridge._getBridgeStatus().cbusNetworks).toEqual([]);
            // A network-state response flows through to the monitor and the status.
            bridge.networkInterfaceMonitor.update('254', { interfaceState: 'closed' });
            const net = bridge._getBridgeStatus().cbusNetworks.find(n => n.network === '254');
            expect(net).toMatchObject({ network: '254', interfaceState: 'closed', online: false });
        });

        it('publishes retained CNI connectivity state on a transition', () => {
            const publishSpy = jest.spyOn(bridge.mqttManager, 'publish');
            bridge._handleNetworkInterfaceReading('254', { interfaceState: 'closed' });
            const offCall = publishSpy.mock.calls.find(c => c[0] === 'cbus/read/254/cni/state');
            expect(offCall).toBeDefined();
            expect(offCall[1]).toBe('OFF');
            expect(offCall[2].retain).toBe(true);

            bridge._handleNetworkInterfaceReading('254', { interfaceState: 'running' });
            const onCall = publishSpy.mock.calls.reverse().find(c => c[0] === 'cbus/read/254/cni/state');
            expect(onCall[1]).toBe('ON');
            publishSpy.mockRestore();
        });

        it('does not throw raising a CNI notification when SUPERVISOR_TOKEN is absent', () => {
            const prev = process.env.SUPERVISOR_TOKEN;
            delete process.env.SUPERVISOR_TOKEN;
            bridge.settings.cni_offline_notification = true;
            expect(() => bridge._handleNetworkInterfaceReading('254', { interfaceState: 'closed' })).not.toThrow();
            if (prev !== undefined) process.env.SUPERVISOR_TOKEN = prev;
        });

        describe('CNI offline notification with token present', () => {
            const haNotifier = require('../src/haNotifier');
            let notifySpy;
            let prevToken;

            beforeEach(() => {
                prevToken = process.env.SUPERVISOR_TOKEN;
                process.env.SUPERVISOR_TOKEN = 'test-token';
                notifySpy = jest.spyOn(haNotifier, 'createPersistentNotification')
                    .mockResolvedValue({ statusCode: 200 });
            });

            afterEach(() => {
                notifySpy.mockRestore();
                if (prevToken === undefined) {
                    delete process.env.SUPERVISOR_TOKEN;
                } else {
                    process.env.SUPERVISOR_TOKEN = prevToken;
                }
            });

            it('raises a single HA notification through the real bridge on an offline reading', () => {
                bridge.settings.cni_offline_notification = true;
                bridge._handleNetworkInterfaceReading('254', { interfaceState: 'closed' });
                expect(notifySpy).toHaveBeenCalledTimes(1);
                const arg = notifySpy.mock.calls[0][0];
                expect(arg.notificationId).toBe('cgateweb_cni_254');
                expect(arg.message).toContain('InterfaceState=');
            });
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
                // The init service owns the periodic-getall interval; bridge.stop()
                // must delegate teardown of that to initializationService.stop().
                const initStopSpy = jest.spyOn(bridge.initializationService, 'stop');

                const mqttDisconnectSpy = jest.spyOn(bridge.mqttManager, 'disconnect');
                const cmdPoolStopSpy = jest.spyOn(bridge.commandConnectionPool, 'stop');
                const evtDisconnectSpy = jest.spyOn(bridge.eventConnection, 'disconnect');
                const clearQueuesSpy = jest.spyOn(bridge.cgateCommandQueue, 'clear');

                await bridge.stop();

                expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Stopping cgateweb bridge'));
                expect(initStopSpy).toHaveBeenCalled();
                expect(bridge.initializationService._periodicGetAllInterval).toBeNull();
                expect(bridge.connectionManager.isAllConnected).toBe(false);
                expect(clearQueuesSpy).toHaveBeenCalled();
                expect(mqttDisconnectSpy).toHaveBeenCalled();
                expect(cmdPoolStopSpy).toHaveBeenCalled();
                expect(evtDisconnectSpy).toHaveBeenCalled();

                initStopSpy.mockRestore();
                mqttDisconnectSpy.mockRestore();
                cmdPoolStopSpy.mockRestore();
                evtDisconnectSpy.mockRestore();
                clearQueuesSpy.mockRestore();
            });

            it('should handle stop when no periodic interval is set', () => {
                bridge.initializationService._periodicGetAllInterval = null;

                expect(() => bridge.stop()).not.toThrow();
                expect(bridge.initializationService._periodicGetAllInterval).toBeNull();
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
                bridge.initializationService._lastInitTime = 0;
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

            it('should set up periodic getall when enabled', () => {
                jest.useFakeTimers();
                bridge.settings.getallnetapp = '254/56';
                bridge.settings.getallperiod = 5; // 5 seconds (not milliseconds)
                bridge.mqttManager.connected = true;
                bridge.commandConnectionPool.isStarted = true;
                bridge.commandConnectionPool.healthyConnections = { size: 3 };
                bridge.eventConnection.connected = true;

                bridge._handleAllConnected();

                expect(bridge.initializationService._perAppTimers.size).toBeGreaterThan(0);

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

    describe('Readiness and Observability', () => {
        it('should expose queue and lifecycle metrics in status', () => {
            const status = bridge._getBridgeStatus();
            expect(status.metrics.commandQueue).toEqual(expect.objectContaining({
                depth: expect.any(Number),
                dropped: expect.any(Number),
                maxSize: expect.any(Number)
            }));
            expect(status.lifecycle).toEqual(expect.objectContaining({
                state: expect.any(String),
                reason: expect.any(String),
                transitions: expect.any(Number)
            }));
        });

        it('should transition to ready when all connections are healthy', () => {
            bridge.mqttManager.connected = true;
            bridge.eventConnection.connected = true;
            bridge.commandConnectionPool.getStats.mockReturnValue({
                poolSize: 3,
                totalConnections: 3,
                healthyConnections: 2,
                pendingReconnects: 0,
                retryCounts: [0, 0, 0],
                isStarted: true,
                isShuttingDown: false
            });

            bridge._updateBridgeReadiness('test-ready');
            expect(bridge._getBridgeStatus().lifecycle.state).toBe('ready');
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
            publishSpy = jest.spyOn(bridge.mqttManager, 'publish');
        });

        afterEach(() => {
            publishSpy.mockRestore();
        });

        describe('_handleCommandData()', () => {

            it('should create per-connection line processor on first data keyed by poolIndex', () => {
                const testData = Buffer.from('200-This is a test response\n201-Another line\n');
                const mockConnection = { id: 'test-conn-1', poolIndex: 0 };
                
                expect(bridge.commandLineProcessors.size).toBe(0);
                bridge._handleCommandData(testData, mockConnection);
                
                expect(bridge.commandLineProcessors.size).toBe(1);
                expect(bridge.commandLineProcessors.has(0)).toBe(true);
            });

            it('should reuse existing line processor for same poolIndex', () => {
                const mockConnection = { id: 'test-conn-2', poolIndex: 1 };
                bridge._handleCommandData(Buffer.from('200-line1\n'), mockConnection);
                bridge._handleCommandData(Buffer.from('201-line2\n'), mockConnection);
                
                expect(bridge.commandLineProcessors.size).toBe(1);
            });

            it('should not leak processors when connection reconnects at same poolIndex', () => {
                const conn1 = { id: 'conn-v1', poolIndex: 0 };
                const conn2 = { id: 'conn-v2', poolIndex: 0 };
                
                bridge._handleCommandData(Buffer.from('200-line1\n'), conn1);
                expect(bridge.commandLineProcessors.size).toBe(1);
                
                bridge._handleCommandData(Buffer.from('200-line2\n'), conn2);
                expect(bridge.commandLineProcessors.size).toBe(1);
            });

            it('should fall back to connection reference when poolIndex is undefined', () => {
                const mockConnection = { id: 'no-pool-index' };
                bridge._handleCommandData(Buffer.from('200-line1\n'), mockConnection);
                
                expect(bridge.commandLineProcessors.has(mockConnection)).toBe(true);
            });

            it('should delegate to CommandResponseProcessor for single line', () => {
                const processSpy = jest.spyOn(bridge.commandResponseProcessor, 'processLine');
                const testData = Buffer.from('300-//PROJECT/254/56/1: level=128\n');
                const mockConn = { id: 'single-line', poolIndex: 0 };
                
                bridge._handleCommandData(testData, mockConn);
                
                expect(processSpy).toHaveBeenCalledWith('300-//PROJECT/254/56/1: level=128');
                processSpy.mockRestore();
            });

            it('should delegate to CommandResponseProcessor for multiple lines', () => {
                const processSpy = jest.spyOn(bridge.commandResponseProcessor, 'processLine');
                const testData = Buffer.from('300-//PROJECT/254/56/1: level=128\n343-Begin tree\n344-End tree\n');
                const mockConn = { id: 'multi-line', poolIndex: 1 };
                
                bridge._handleCommandData(testData, mockConn);
                
                expect(processSpy).toHaveBeenCalledTimes(3);
                expect(processSpy).toHaveBeenCalledWith('300-//PROJECT/254/56/1: level=128');
                expect(processSpy).toHaveBeenCalledWith('343-Begin tree');
                expect(processSpy).toHaveBeenCalledWith('344-End tree');
                processSpy.mockRestore();
            });
        });

        // Command response processing tests are now handled by CommandResponseProcessor tests
        
        describe('LineProcessor cleanup on reconnection', () => {
            it('should reset line processor when connectionAdded event fires', () => {
                const conn = { id: 'conn-1', poolIndex: 0 };
                bridge._handleCommandData(Buffer.from('200-line\n'), conn);
                expect(bridge.commandLineProcessors.has(0)).toBe(true);

                const processor = bridge.commandLineProcessors.get(0);
                const closeSpy = jest.spyOn(processor, 'close');
                
                mockConnectionPool.emit('connectionAdded', { index: 0, connection: { id: 'conn-2', poolIndex: 0 } });
                
                expect(closeSpy).toHaveBeenCalled();
                expect(bridge.commandLineProcessors.has(0)).toBe(false);
            });
        });

    });

    describe('Event Processing', () => {
        let publishSpy;

        beforeEach(() => {
            publishSpy = jest.spyOn(bridge.mqttManager, 'publish');
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

            it('should ignore clock date events without publishing', () => {
                const publishEventSpy = jest.spyOn(bridge.eventPublisher, 'publishEvent');
                
                bridge._processEventLine('clock date //CLIPSAL/254/223 2026-03-02 0 #sourceunit=8 OID=');
                
                expect(publishEventSpy).not.toHaveBeenCalled();
                publishEventSpy.mockRestore();
            });

            it('should ignore clock time events without publishing', () => {
                const publishEventSpy = jest.spyOn(bridge.eventPublisher, 'publishEvent');
                
                bridge._processEventLine('clock time //CLIPSAL/254/223 21:13:21 0 #sourceunit=8 OID=');
                
                expect(publishEventSpy).not.toHaveBeenCalled();
                publishEventSpy.mockRestore();
            });

            it('should ignore comment lines starting with #', () => {
                const publishEventSpy = jest.spyOn(bridge.eventPublisher, 'publishEvent');

                bridge._processEventLine('# C-Gate event server started');

                expect(publishEventSpy).not.toHaveBeenCalled();
                publishEventSpy.mockRestore();
            });

            it('captures an unconsumed aircon line but does not warn-parse it as a standard event', () => {
                const rawCaptureSpy = jest.spyOn(bridge, '_publishRawEventCapture');
                const warnSpy = jest.spyOn(bridge, 'warn');
                const publishEventSpy = jest.spyOn(bridge.eventPublisher, 'publishEvent');

                // An aircon-format line that the handler doesn't consume (unsupported
                // verb). It must still reach raw capture, but must NOT be run through
                // CBusEvent (which would log a spurious "Could not parse" warning).
                bridge._processEventLine('aircon some_unknown_verb //TestProject/254/172 1 0');

                expect(rawCaptureSpy).toHaveBeenCalled();
                expect(publishEventSpy).not.toHaveBeenCalled();
                expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Could not parse event line'));

                rawCaptureSpy.mockRestore();
                warnSpy.mockRestore();
                publishEventSpy.mockRestore();
            });

            it('should call _publishRawEventCapture with the event line', () => {
                const rawCaptureSpy = jest.spyOn(bridge, '_publishRawEventCapture');
                const line = 'lighting on 254/56/1';

                bridge._processEventLine(line);

                expect(rawCaptureSpy).toHaveBeenCalledWith(line);
                rawCaptureSpy.mockRestore();
            });

            it('routes a network sync-complete (762) event line to HA Discovery', () => {
                const publishEventSpy = jest.spyOn(bridge.eventPublisher, 'publishEvent');
                const warnSpy = jest.spyOn(bridge, 'warn');
                bridge.haDiscovery = { handleNetworkSyncComplete: jest.fn() };

                bridge._processEventLine('20260718-123456.789 762 //TestProject/254 Network sync ok');

                expect(bridge.haDiscovery.handleNetworkSyncComplete).toHaveBeenCalledWith('254');
                expect(publishEventSpy).not.toHaveBeenCalled();
                expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Could not parse event line'));

                publishEventSpy.mockRestore();
                warnSpy.mockRestore();
            });

            it('accepts a 762 line without a timestamp prefix', () => {
                bridge.haDiscovery = { handleNetworkSyncComplete: jest.fn() };

                bridge._processEventLine('762 //TestProject/254 Network sync ok');

                expect(bridge.haDiscovery.handleNetworkSyncComplete).toHaveBeenCalledWith('254');
            });

            it('tolerates a 762 line when HA Discovery is not initialized', () => {
                const publishEventSpy = jest.spyOn(bridge.eventPublisher, 'publishEvent');
                bridge.haDiscovery = null;

                expect(() => bridge._processEventLine('20260718-123456.789 762 //TestProject/254 Network sync ok')).not.toThrow();
                expect(publishEventSpy).not.toHaveBeenCalled();

                publishEventSpy.mockRestore();
            });

            it('does not treat other 7xx status events as sync-complete', () => {
                bridge.haDiscovery = { handleNetworkSyncComplete: jest.fn() };

                bridge._processEventLine('20260718-123456.789 740 //TestProject/254 Opened cbus network');

                expect(bridge.haDiscovery.handleNetworkSyncComplete).not.toHaveBeenCalled();
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
                expect(bridge.eventPublisher.publishFn).toBeDefined();
                expect(typeof bridge.eventPublisher.publishFn).toBe('function');
                expect(bridge.eventPublisher.mqttOptions).toEqual(bridge._mqttOptions);
            });
        });

        describe('DeviceStateManager integration', () => {
            it('should use DeviceStateManager for level tracking', () => {
                const updateSpy = jest.spyOn(bridge.deviceStateManager, 'updateLevelFromEvent');
                
                bridge._processEventLine('lighting ramp 254/56/1 75');
                
                expect(updateSpy).toHaveBeenCalledWith(expect.any(Object));
                updateSpy.mockRestore();
            });

            it('should provide event emitter to MQTT command router', () => {
                expect(bridge.mqttCommandRouter.internalEventEmitter).toBe(bridge.deviceStateManager.getEventEmitter());
            });
        });
    });

    describe('Aircon (172) event routing via _handleAirconLine', () => {
        // Existing fixture uses sourceunit=250 — topic now keyed on sourceUnit, not zoneGroup
        const AIRCON_TEMP_LINE = '# aircon zone_temperature //THEGAFF/254/172 1 0,1,2,3,4 4431 0 #sourceunit=250 OID=x';
        // Mode line with mode code 0 (off) — existing fixture, sourceunit=250
        const AIRCON_MODE_LINE = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0,1,2,3,4 0 0 0 0 1 255 0 0 #sourceunit=250 OID=x';
        const LIGHTING_LINE = 'lighting on //TestProject/254/56/1';

        // Real-world fixtures from PICED captures (two thermostats, same zoneGroup=1)
        const REAL_TEMP_201 = '# aircon zone_temperature //THEGAFF/254/172 1 0,1,2,3,4 4467 0 #sourceunit=201 OID=07ffed40-b5bd-103e-83ab-af3ab5084337';
        const REAL_TEMP_202 = '# aircon zone_temperature //THEGAFF/254/172 1 0 4545 0 #sourceunit=202 OID=07ffed40-b5bd-103e-83ab-af3ab5084337';
        const REAL_MODE_202 = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0 1 0 0 0 1 1 5632 0 #sourceunit=202 OID=07ffed40-b5bd-103e-83ab-af3ab5084337';
        // Unknown mode code (99) — not in the 0-4 map, modeRaw=99
        const UNKNOWN_MODE_LINE = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0 99 0 0 0 1 1 5632 0 #sourceunit=201 OID=x';

        describe('with cbus_aircon_app_id set', () => {
            beforeEach(() => {
                bridge.settings.cbus_aircon_app_id = '172';
            });

            it('should publish current_temperature keyed by sourceUnit (not zoneGroup)', () => {
                const publishSpy = jest.spyOn(bridge.mqttManager, 'publish');

                bridge._processEventLine(AIRCON_TEMP_LINE);

                const tempPublish = publishSpy.mock.calls.find(call =>
                    call[0].endsWith('/current_temperature')
                );
                expect(tempPublish).toBeDefined();
                // Topic uses sourceUnit=250, not zoneGroup=1
                expect(tempPublish[0]).toBe('cbus/read/254/172/250/current_temperature');
                expect(tempPublish[1]).toBe('17.3');

                publishSpy.mockRestore();
            });

            it('should publish mode to sourceUnit-keyed topic for a mode line', () => {
                const publishSpy = jest.spyOn(bridge.mqttManager, 'publish');

                expect(() => bridge._processEventLine(AIRCON_MODE_LINE)).not.toThrow();

                const modePublish = publishSpy.mock.calls.find(call =>
                    call[0].endsWith('/mode')
                );
                expect(modePublish).toBeDefined();
                expect(modePublish[0]).toBe('cbus/read/254/172/250/mode');
                expect(modePublish[1]).toBe('off');

                publishSpy.mockRestore();
            });

            it('two thermostats with same zoneGroup produce distinct sourceUnit-keyed topics', () => {
                const publishSpy = jest.spyOn(bridge.mqttManager, 'publish');

                bridge._processEventLine(REAL_TEMP_201);
                bridge._processEventLine(REAL_TEMP_202);

                const allTempTopics = publishSpy.mock.calls
                    .filter(call => call[0].endsWith('/current_temperature'))
                    .map(call => call[0]);

                expect(allTempTopics).toContain('cbus/read/254/172/201/current_temperature');
                expect(allTempTopics).toContain('cbus/read/254/172/202/current_temperature');

                const pub201 = publishSpy.mock.calls.find(call =>
                    call[0] === 'cbus/read/254/172/201/current_temperature'
                );
                const pub202 = publishSpy.mock.calls.find(call =>
                    call[0] === 'cbus/read/254/172/202/current_temperature'
                );
                expect(pub201[1]).toBe('17.4');
                expect(pub202[1]).toBe('17.8');

                publishSpy.mockRestore();
            });

            it('should publish mode and setpoint to sourceUnit-keyed topics for a heat mode line', () => {
                const publishSpy = jest.spyOn(bridge.mqttManager, 'publish');

                bridge._processEventLine(REAL_MODE_202);

                const modePublish = publishSpy.mock.calls.find(call =>
                    call[0] === 'cbus/read/254/172/202/mode'
                );
                const setpointPublish = publishSpy.mock.calls.find(call =>
                    call[0] === 'cbus/read/254/172/202/setpoint'
                );
                expect(modePublish).toBeDefined();
                expect(modePublish[1]).toBe('heat');
                expect(setpointPublish).toBeDefined();
                expect(setpointPublish[1]).toBe('22');

                publishSpy.mockRestore();
            });

            it('should publish hvac_action to a sourceUnit-keyed topic for a zone_hvac_plant_status line', () => {
                // Real capture 2026-06-11: bitmask 14 = heating+fan+damper, not busy → action heating
                const REAL_PLANT_STATUS_201 = '# aircon zone_hvac_plant_status //THEGAFF/254/172 1 0,1,2,3,4 3 14 0 #sourceunit=201 OID=07ffed40-b5bd-103e-83ab-af3ab5084337';
                const publishSpy = jest.spyOn(bridge.mqttManager, 'publish');

                bridge._processEventLine(REAL_PLANT_STATUS_201);

                const actionPublish = publishSpy.mock.calls.find(call =>
                    call[0] === 'cbus/read/254/172/201/action'
                );
                expect(actionPublish).toBeDefined();
                expect(actionPublish[1]).toBe('heating');

                publishSpy.mockRestore();
            });

            it('triggers native HVAC auto-discovery for the thermostat source unit', () => {
                bridge.haDiscovery = { ensureNativeAirconDiscovery: jest.fn() };
                bridge.settings.ha_discovery_enabled = true;

                bridge._processEventLine(AIRCON_TEMP_LINE); // sourceunit=250, net 254, app 172

                expect(bridge.haDiscovery.ensureNativeAirconDiscovery).toHaveBeenCalledWith('254', '172', '250');
            });

            it('should log a warning for unknown mode codes and still consume the line', () => {
                const warnSpy = jest.spyOn(bridge.logger, 'warn');
                const publishSpy = jest.spyOn(bridge.mqttManager, 'publish');

                let result;
                expect(() => { result = bridge._handleAirconLine(UNKNOWN_MODE_LINE); }).not.toThrow();
                expect(result).toBe(true);

                expect(warnSpy).toHaveBeenCalledWith(
                    expect.stringContaining('Unmapped C-Bus HVAC mode code 99')
                );

                publishSpy.mockRestore();
                warnSpy.mockRestore();
            });
        });

        describe('with cbus_aircon_app_id unset (default)', () => {
            it('should NOT publish current_temperature when setting is null', () => {
                bridge.settings.cbus_aircon_app_id = null;
                const publishSpy = jest.spyOn(bridge.mqttManager, 'publish');

                bridge._processEventLine(AIRCON_TEMP_LINE);

                const tempPublish = publishSpy.mock.calls.find(call =>
                    call[0].endsWith('/current_temperature')
                );
                expect(tempPublish).toBeUndefined();

                publishSpy.mockRestore();
            });
        });

        describe('regression: normal lighting events still flow through', () => {
            it('should still publish state/level for non-aircon lighting events', () => {
                bridge.settings.cbus_aircon_app_id = '172';
                const publishSpy = jest.spyOn(bridge.mqttManager, 'publish');

                bridge._processEventLine(LIGHTING_LINE);

                const statePublish = publishSpy.mock.calls.find(call =>
                    call[0].endsWith('/state')
                );
                expect(statePublish).toBeDefined();
                expect(statePublish[0]).toBe('cbus/read/254/56/1/state');

                publishSpy.mockRestore();
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

            it('should publish a warning when pool execute fails', async () => {
                jest.spyOn(bridge.commandConnectionPool, 'execute').mockRejectedValue(
                    new Error('No healthy connections available in pool')
                );
                const publishSpy = jest.spyOn(bridge.mqttManager, 'publish');
                const errorSpy = jest.spyOn(bridge.logger, 'error');

                await bridge._sendCgateCommand('RAMP //HOME/254/56/1 0\n');

                expect(errorSpy).toHaveBeenCalled();
                expect(publishSpy).toHaveBeenCalledWith(
                    'hello/cgateweb/warnings',
                    expect.stringContaining('C-Gate command send failed'),
                    { retain: false }
                );
                expect(publishSpy.mock.calls[0][1]).toContain('No healthy connections');
            });
        });

        describe('command queue gating', () => {
            it('_canProcessCommandQueue is false when the pool has no healthy connections', () => {
                bridge.commandConnectionPool.getStats = jest.fn(() => ({
                    isStarted: true,
                    isShuttingDown: false,
                    healthyConnections: 0,
                    writableConnections: 0
                }));
                expect(bridge._canProcessCommandQueue()).toBe(false);
            });

            it('_canProcessCommandQueue is true when the pool is healthy', () => {
                bridge.commandConnectionPool.getStats = jest.fn(() => ({
                    isStarted: true,
                    isShuttingDown: false,
                    healthyConnections: 3,
                    writableConnections: 3
                }));
                expect(bridge._canProcessCommandQueue()).toBe(true);
            });

            it('_getAdaptiveQueueIntervalMs shrinks with more writable connections', () => {
                bridge.settings.messageinterval = 200;
                bridge.settings.commandMinIntervalMs = 10;
                bridge.commandConnectionPool.getStats = jest.fn(() => ({
                    isStarted: true,
                    isShuttingDown: false,
                    healthyConnections: 4,
                    writableConnections: 4
                }));
                Object.defineProperty(bridge.cgateCommandQueue, 'length', { get: () => 0, configurable: true });
                expect(bridge._getAdaptiveQueueIntervalMs()).toBe(50); // 200 / 4
            });

            it('publishes a warning when the command queue drops items', () => {
                const publishSpy = jest.spyOn(bridge.mqttManager, 'publish');
                // Rebuild queues with a tiny max so onDrop fires immediately.
                bridge.settings.maxQueueSize = 1;
                bridge._buildQueues();
                bridge.commandConnectionPool.getStats = jest.fn(() => ({
                    isStarted: true,
                    isShuttingDown: false,
                    healthyConnections: 0,
                    writableConnections: 0
                }));
                // First add starts processing but canProcess blocks; items pile up.
                bridge.cgateCommandQueue.add('cmd1');
                bridge.cgateCommandQueue.add('cmd2');
                bridge.cgateCommandQueue.add('cmd3');
                expect(publishSpy).toHaveBeenCalledWith(
                    'hello/cgateweb/warnings',
                    expect.stringContaining('C-Gate command queue full'),
                    { retain: false }
                );
            });
        });

        describe('EventPublisher direct publish', () => {
            it('should publish directly to MQTT manager without throttle queue', () => {
                const publishSpy = jest.spyOn(bridge.mqttManager, 'publish');
                const mockEvent = {
                    isValid: () => true,
                    getNetwork: () => '254',
                    getApplication: () => '56',
                    getGroup: () => '1',
                    getAction: () => 'on',
                    getLevel: () => null
                };

                bridge.eventPublisher.publishEvent(mockEvent);

                expect(publishSpy).toHaveBeenCalledWith(
                    'cbus/read/254/56/1/state', 'ON', expect.any(Object)
                );
                expect(publishSpy).toHaveBeenCalledWith(
                    'cbus/read/254/56/1/level', '100', expect.any(Object)
                );
                publishSpy.mockRestore();
            });
        });
    });

    describe('reloadSettings()', () => {
        let bridge;
        beforeEach(() => {
            bridge = new CgateWebBridge({ ...defaultSettings, cbusip: '127.0.0.1' });
        });

        it('updates reloadable settings on the bridge', () => {
            bridge.reloadSettings({ ...defaultSettings, log_level: 'debug', messageinterval: 500 });
            expect(bridge.settings.log_level).toBe('debug');
            expect(bridge.settings.messageinterval).toBe(500);
        });

        it('applies new log level to main bridge logger', () => {
            const spy = jest.spyOn(bridge.logger, 'setLevel');
            bridge.reloadSettings({ ...defaultSettings, log_level: 'debug' });
            expect(spy).toHaveBeenCalledWith('debug');
        });

        it('applies new log level to all known sub-loggers', () => {
            const spies = [
                bridge.mqttManager?.logger,
                bridge.eventConnection?.logger,
                bridge.commandResponseProcessor?.logger,
                bridge.initializationService?.logger,
                bridge.connectionManager?.logger,
            ].filter(Boolean).map(l => jest.spyOn(l, 'setLevel'));

            bridge.reloadSettings({ ...defaultSettings, log_level: 'warn' });

            for (const spy of spies) {
                expect(spy).toHaveBeenCalledWith('warn');
            }
        });

        it('reschedules getall timers when getallperiod and networks are set', () => {
            bridge.settings.getall_networks = [254];
            const rescheduleSpy = jest.spyOn(bridge.initializationService, '_scheduleAllGetalls');
            bridge.reloadSettings({ ...defaultSettings, getallperiod: 300, getall_networks: [254] });
            expect(rescheduleSpy).toHaveBeenCalled();
        });

        it('forces label reload', () => {
            const loadSpy = jest.spyOn(bridge.labelLoader, 'load');
            bridge.reloadSettings({ ...defaultSettings });
            expect(loadSpy).toHaveBeenCalled();
        });

        it('does not throw when called with minimal settings', () => {
            expect(() => bridge.reloadSettings({ ...defaultSettings })).not.toThrow();
        });

        it('does not throw when optional sub-loggers are missing', () => {
            bridge.mqttCommandRouter = null;
            bridge.eventPublisher = null;
            expect(() => bridge.reloadSettings({ ...defaultSettings, log_level: 'debug' })).not.toThrow();
        });
    });
});