// tests/cgateWebBridge.test.js - Tests for CgateWebBridge constructor and validation

const CgateWebBridge = require('../src/cgateWebBridge');
const { defaultSettings } = require('../index.js');
const EventEmitter = require('events');

// --- Mock CgateConnectionPool ---
// One emitter shared by every test in this file, because jest.mock hands the
// same instance to every `new CgateConnectionPool(...)`. The afterEach below
// detaches its listeners; without that, each bridge built in beforeEach leaves
// its subscriptions attached and events fired by a later test also run every
// earlier test's handlers against a half-torn-down bridge.
const mockConnectionPool = new EventEmitter();

function setPoolHealthyCount(count) {
    const connections = [];
    const healthy = new Set();
    for (let i = 0; i < count; i++) {
        const conn = { poolIndex: i };
        connections.push(conn);
        healthy.add(conn);
    }
    mockConnectionPool.connections = connections;
    mockConnectionPool.healthyConnections = healthy;
}

mockConnectionPool.start = jest.fn().mockImplementation(async () => {
    mockConnectionPool.isStarted = true;
    setPoolHealthyCount(3);
    setImmediate(() => mockConnectionPool.emit('started', { healthy: 3, total: 3 }));
});
mockConnectionPool.stop = jest.fn().mockImplementation(async () => {
    mockConnectionPool.isStarted = false;
    setPoolHealthyCount(0);
    setImmediate(() => mockConnectionPool.emit('stopped'));
});
mockConnectionPool.execute = jest.fn().mockImplementation(async () => true);
mockConnectionPool.getStats = jest.fn(() => ({
    poolSize: 3,
    totalConnections: mockConnectionPool.connections.length,
    healthyConnections: mockConnectionPool.healthyConnections.size,
    writableConnections: mockConnectionPool.healthyConnections.size,
    isStarted: mockConnectionPool.isStarted || false,
    isShuttingDown: false
}));
mockConnectionPool.isStarted = false;
setPoolHealthyCount(0);

jest.mock('../src/cgateConnectionPool', () => {
    return jest.fn().mockImplementation(() => mockConnectionPool);
});

// --- Mock mqtt Module ---
const mockMqttClient = new EventEmitter(); 
mockMqttClient.connect = jest.fn(); 
mockMqttClient.subscribe = jest.fn((topic, options, callback) => callback ? callback(null) : null);
mockMqttClient.publish = jest.fn();
mockMqttClient.end = jest.fn();
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
        setPoolHealthyCount(0);
        
        // Reset MQTT mocks. Leave EventEmitter.on intact so MqttManager.connect()
        // actually wires client events; clear listeners so they do not leak
        // across tests that share this module-scoped client.
        mockMqttClient.removeAllListeners();
        mockMqttClient.subscribe.mockClear();
        mockMqttClient.publish.mockClear();
        mockMqttClient.end.mockClear();
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

        // The pool mock is module-scoped and outlives every bridge, so its
        // listeners have to be dropped explicitly (bridge.stop() would do it,
        // but the teardown above deliberately stops short of a full stop()).
        mockConnectionPool.removeAllListeners();
        mockMqttClient.removeAllListeners();

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

        it('routes interface transitions to serial device recovery (issue #28)', () => {
            // The wiring, not the recovery logic: without it the whole
            // renumber-recovery feature is unreachable from a live bridge.
            const downSpy = jest.spyOn(bridge.serialDeviceRecovery, 'handleInterfaceDown');
            const upSpy = jest.spyOn(bridge.serialDeviceRecovery, 'handleInterfaceUp');

            bridge._handleNetworkInterfaceReading('254', { interfaceState: 'closed' });
            expect(downSpy).toHaveBeenCalledWith('254');
            bridge._handleNetworkInterfaceReading('254', { interfaceState: 'running' });
            expect(upSpy).toHaveBeenCalledWith('254');

            downSpy.mockRestore();
            upSpy.mockRestore();
        });

        it('is inert without a configured serial device', () => {
            // Every CNI install: no cgate_serial_device, so a genuine network
            // dropout must never reach the recovery script.
            expect(bridge.settings.cgate_serial_device).toBeFalsy();
            const result = bridge.serialDeviceRecovery.handleInterfaceDown('254');
            expect(result.action).toBe('ignored');
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

            it('wires MQTT client events through to the manager', async () => {
                await bridge.start();

                const connected = new Promise((resolve) => {
                    bridge.mqttManager.once('connect', resolve);
                });
                mockMqttClient.emit('connect');
                await connected;

                expect(bridge.mqttManager.connected).toBe(true);
                expect(mockMqttClient.subscribe).toHaveBeenCalled();
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

                // Startup passes no queue options, so this getall keeps default
                // (normal) priority; the resync path is the one that uses 'bulk'.
                expect(addSpy).toHaveBeenCalledWith(
                    expect.stringContaining('GET //TestProject/254/56/* level'), {}
                );
            });

            it('should set up periodic getall when enabled', () => {
                jest.useFakeTimers();
                bridge.settings.getallnetapp = '254/56';
                bridge.settings.getallperiod = 5; // 5 seconds (not milliseconds)
                bridge.mqttManager.connected = true;
                bridge.commandConnectionPool.isStarted = true;
                setPoolHealthyCount(3);
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
                setPoolHealthyCount(3);
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

        it('marks bridge not ready when the pool emits allConnectionsUnhealthy', async () => {
            await bridge.start();
            // Flush the pool mock's setImmediate('started') so start() teardown
            // and later emits do not race with a stale started handler.
            await new Promise(resolve => setImmediate(resolve));

            bridge.mqttManager.connected = true;
            bridge.eventConnection.connected = true;
            mockConnectionPool.getStats.mockReturnValue({
                poolSize: 3,
                totalConnections: 3,
                healthyConnections: 3,
                pendingReconnects: 0,
                retryCounts: [0, 0, 0],
                isStarted: true,
                isShuttingDown: false
            });
            bridge._updateBridgeReadiness('all-connected');
            expect(bridge._getBridgeStatus().ready).toBe(true);
            expect(bridge._getBridgeStatus().lifecycle.state).toBe('ready');

            const updateSpy = jest.spyOn(bridge, '_updateBridgeReadiness');
            mockConnectionPool.getStats.mockReturnValue({
                poolSize: 3,
                totalConnections: 3,
                healthyConnections: 0,
                pendingReconnects: 0,
                retryCounts: [1, 1, 1],
                isStarted: true,
                isShuttingDown: false
            });
            setPoolHealthyCount(0);

            mockConnectionPool.emit('allConnectionsUnhealthy');

            expect(updateSpy).toHaveBeenCalledWith('command-pool-unhealthy');
            const status = bridge._getBridgeStatus();
            expect(status.ready).toBe(false);
            expect(status.connections.commandPool.healthyConnections).toBe(0);
            expect(status.lifecycle.state).toBe('degraded');
            expect(status.lifecycle.reason).toBe('command-pool-unhealthy');
            expect(bridge.bridgeReadiness.getLifecycleSnapshot().reason).toBe('command-pool-unhealthy');

            updateSpy.mockRestore();
        });

        it('marks the bridge not ready when a command pool connection is lost', async () => {
            await new Promise(resolve => setImmediate(resolve));
            bridge.mqttManager.connected = true;
            bridge.eventConnection.connected = true;
            mockConnectionPool.getStats.mockReturnValue({
                poolSize: 3,
                totalConnections: 3,
                healthyConnections: 2,
                pendingReconnects: 0,
                retryCounts: [0, 0, 0],
                isStarted: true,
                isShuttingDown: false
            });
            bridge._updateBridgeReadiness('all-connected');
            const updateSpy = jest.spyOn(bridge, '_updateBridgeReadiness');

            mockConnectionPool.emit('connectionLost');

            expect(updateSpy).toHaveBeenCalledWith('command-pool-connection-lost');
            updateSpy.mockRestore();
        });

        it('routes pool data events through _handleCommandData', async () => {
            await new Promise(resolve => setImmediate(resolve));
            const handleSpy = jest.spyOn(bridge, '_handleCommandData');
            const conn = { poolIndex: 0 };
            const data = Buffer.from('200-OK\n');

            mockConnectionPool.emit('data', data, conn);

            expect(handleSpy).toHaveBeenCalledWith(data, conn);
            handleSpy.mockRestore();
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

            it('redacts keypad echoes when command-line processing throws', () => {
                const errorSpy = jest.spyOn(bridge, 'error');
                jest.spyOn(bridge.commandResponseProcessor, 'processLine').mockImplementation(() => {
                    throw new Error('boom');
                });
                const line = '200-OK security emulate_keypad //P/254/208 7';

                bridge._handleCommandData(Buffer.from(`${line}\n`), { poolIndex: 0 });

                expect(errorSpy).toHaveBeenCalledWith(
                    'Error processing command data line: boom',
                    expect.objectContaining({ line: expect.stringContaining('***') })
                );
                expect(errorSpy.mock.calls[0][1].line).not.toMatch(/emulate_keypad \S+\s+7\b/i);
                errorSpy.mockRestore();
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

            it('redacts keypad echoes in failed event-parse warnings', () => {
                const warnSpy = jest.spyOn(bridge, 'warn');
                const line = 'not-an-event security emulate_keypad //P/254/208 7';

                bridge._processEventLine(line);

                expect(warnSpy).toHaveBeenCalledTimes(1);
                const message = warnSpy.mock.calls[0][0];
                expect(message).toContain('Could not parse event line:');
                expect(message).toContain('***');
                expect(message).not.toMatch(/emulate_keypad \S+\s+7\b/i);
                warnSpy.mockRestore();
            });

            it('redacts keypad echoes in unparsed measurement debug logs', () => {
                const debugSpy = jest.spyOn(bridge.logger, 'debug');
                const line = 'measurement not_a_real_verb //P/254/228/1/0 security emulate_keypad //P/254/208 7';
                bridge.settings.cbus_measurement_app_id = '228';

                bridge._processEventLine(line);

                const messages = debugSpy.mock.calls.map((c) => String(c[0]));
                expect(messages.some((m) => m.includes('Unparsed measurement line'))).toBe(true);
                expect(messages.join('\n')).toContain('***');
                expect(messages.join('\n')).not.toMatch(/emulate_keypad \S+\s+7\b/i);
                debugSpy.mockRestore();
            });

            it('redacts keypad echoes when processing an event line throws', () => {
                const errorSpy = jest.spyOn(bridge, 'error');
                const line = 'lighting on 254/56/1 security emulate_keypad //P/254/208 7';
                jest.spyOn(bridge.deviceStateManager, 'updateLevelFromEvent').mockImplementation(() => {
                    throw new Error('boom');
                });

                bridge._processEventLine(line);

                expect(errorSpy).toHaveBeenCalledWith(
                    'Error processing event data line: boom',
                    expect.objectContaining({
                        line: expect.stringContaining('***')
                    })
                );
                const logged = errorSpy.mock.calls[0][1].line;
                expect(logged).not.toMatch(/emulate_keypad \S+\s+7\b/i);
                errorSpy.mockRestore();
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
                // The fall-through guard only scans when the app is configured.
                bridge.settings.cbus_aircon_app_id = '172';

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

            it('requests a debounced level resync on a 762 event line', () => {
                // The tree is only fully populated after sync-ok, so any
                // startup getall that ran before it missed state (issue #44).
                const resyncSpy = jest.spyOn(bridge.stateResyncCoordinator, 'requestResync');
                bridge.haDiscovery = { handleNetworkSyncComplete: jest.fn() };

                bridge._processEventLine('20260718-123456.789 762 //TestProject/254 Network sync ok');

                expect(resyncSpy).toHaveBeenCalledWith('network-sync');
                resyncSpy.mockRestore();
            });

            it('runs all post-sync effects on the event-port 762 path', () => {
                const resyncSpy = jest.spyOn(bridge.stateResyncCoordinator, 'requestResync');
                const securitySpy = jest.spyOn(bridge.securityEventHandler, 'requestStatusSync');
                bridge.haDiscovery = { handleNetworkSyncComplete: jest.fn() };

                bridge._processEventLine('20260718-123456.789 762 //TestProject/254 Network sync ok');

                expect(bridge.haDiscovery.handleNetworkSyncComplete).toHaveBeenCalledWith('254');
                expect(securitySpy).toHaveBeenCalledWith('254', 'sync');
                expect(resyncSpy).toHaveBeenCalledWith('network-sync');

                resyncSpy.mockRestore();
                securitySpy.mockRestore();
            });

            it('runs all post-sync effects on the command-port 762 path', () => {
                // Command-port async event: CommandResponseProcessor invokes the
                // wired onNetworkSyncComplete callback with the network id; it
                // must produce the same three effects as the event-port path.
                const resyncSpy = jest.spyOn(bridge.stateResyncCoordinator, 'requestResync');
                const securitySpy = jest.spyOn(bridge.securityEventHandler, 'requestStatusSync');
                bridge.haDiscovery = { handleNetworkSyncComplete: jest.fn() };

                bridge.commandResponseProcessor.onNetworkSyncComplete('254');

                expect(bridge.haDiscovery.handleNetworkSyncComplete).toHaveBeenCalledWith('254');
                expect(securitySpy).toHaveBeenCalledWith('254', 'sync');
                expect(resyncSpy).toHaveBeenCalledWith('network-sync');

                resyncSpy.mockRestore();
                securitySpy.mockRestore();
            });

            // Regression for the 1.33.0 field report: a network whose CNI kept
            // dropping re-synced every few seconds, and every pooled command
            // connection reported each sync, so the post-sync refresh (tree
            // re-fetch, level getall, security status_request pair, clock
            // refresh) ran continuously and C-Gate answered 408 to everything
            // — including the user's own switch commands.
            describe('post-sync refresh rate limiting', () => {
                function postSyncSpies() {
                    // syncUnlistedGroupDiscovery is reached when the resync
                    // debounce fires under fake timers.
                    bridge.haDiscovery = {
                        handleNetworkSyncComplete: jest.fn(),
                        syncUnlistedGroupDiscovery: jest.fn(),
                        republishDiscoveryConfigs: jest.fn(() => 0),
                        stop: jest.fn()
                    };
                    return {
                        discovery: bridge.haDiscovery.handleNetworkSyncComplete,
                        resync: jest.spyOn(bridge.stateResyncCoordinator, 'requestResync'),
                        security: jest.spyOn(bridge.securityEventHandler, 'requestStatusSync')
                    };
                }

                it('treats copies of one sync arriving on each pooled connection as one sync', () => {
                    const spies = postSyncSpies();

                    // Pool size 3 plus the event port: four notifications, one sync.
                    for (let i = 0; i < 3; i++) bridge.commandResponseProcessor.onNetworkSyncComplete('254');
                    bridge._processEventLine('762 //TestProject/254 Network sync ok');

                    expect(spies.discovery).toHaveBeenCalledTimes(1);
                    expect(spies.resync).toHaveBeenCalledTimes(1);
                    expect(spies.security).toHaveBeenCalledTimes(1);
                });

                it('defers a later sync inside the minimum interval into a single refresh', () => {
                    jest.useFakeTimers();
                    try {
                        const spies = postSyncSpies();

                        bridge.commandResponseProcessor.onNetworkSyncComplete('254');
                        expect(spies.discovery).toHaveBeenCalledTimes(1);

                        // Past the coalesce window, so these are genuinely new
                        // syncs — a flapping interface, not pool fan-out.
                        jest.advanceTimersByTime(5000);
                        bridge.commandResponseProcessor.onNetworkSyncComplete('254');
                        jest.advanceTimersByTime(5000);
                        bridge.commandResponseProcessor.onNetworkSyncComplete('254');
                        expect(spies.discovery).toHaveBeenCalledTimes(1);

                        // Both collapse into one refresh at the interval boundary.
                        jest.advanceTimersByTime(60000);
                        expect(spies.discovery).toHaveBeenCalledTimes(2);
                        expect(spies.resync).toHaveBeenCalledTimes(2);
                    } finally {
                        jest.useRealTimers();
                    }
                });

                it('keeps refreshing at the interval while a network reports faster than the coalesce window', () => {
                    // The pathological case: an interface flapping so fast that
                    // every sync looks like a duplicate of the last. It must
                    // still get one refresh per minimum interval rather than
                    // being starved of them for ever.
                    jest.useFakeTimers();
                    try {
                        const spies = postSyncSpies();

                        for (let elapsed = 0; elapsed <= 125000; elapsed += 1000) {
                            bridge.commandResponseProcessor.onNetworkSyncComplete('254');
                            jest.advanceTimersByTime(1000);
                        }

                        // ~2 minutes of continuous syncs: the initial refresh
                        // plus one per 60s interval, not one per sync.
                        expect(spies.discovery.mock.calls.length).toBe(3);
                    } finally {
                        jest.useRealTimers();
                    }
                });

                it('warns that the interface is unstable when it starts deferring', () => {
                    jest.useFakeTimers();
                    try {
                        const warnSpy = jest.spyOn(bridge, 'warn');
                        postSyncSpies();

                        bridge.commandResponseProcessor.onNetworkSyncComplete('254');
                        jest.advanceTimersByTime(5000);
                        bridge.commandResponseProcessor.onNetworkSyncComplete('254');

                        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('reported sync complete'));
                        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('CNI/PCI'));
                        warnSpy.mockRestore();
                    } finally {
                        jest.useRealTimers();
                    }
                });

                it('rate-limits each network independently', () => {
                    const spies = postSyncSpies();

                    bridge.commandResponseProcessor.onNetworkSyncComplete('254');
                    bridge.commandResponseProcessor.onNetworkSyncComplete('253');

                    expect(spies.discovery).toHaveBeenCalledWith('254');
                    expect(spies.discovery).toHaveBeenCalledWith('253');
                    expect(spies.discovery).toHaveBeenCalledTimes(2);
                });

                it('cancels a deferred refresh on shutdown', async () => {
                    jest.useFakeTimers();
                    try {
                        const spies = postSyncSpies();
                        bridge.commandResponseProcessor.onNetworkSyncComplete('254');
                        jest.advanceTimersByTime(5000);
                        bridge.commandResponseProcessor.onNetworkSyncComplete('254');

                        await bridge.stop();
                        jest.advanceTimersByTime(120000);

                        expect(spies.discovery).toHaveBeenCalledTimes(1);
                    } finally {
                        jest.useRealTimers();
                    }
                });
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

            it('triggers temperature sensor auto-discovery for an app 25 temperature event', () => {
                bridge.haDiscovery = { ensureTemperatureDiscovery: jest.fn() };
                bridge.settings.ha_discovery_enabled = true;

                // Temperature Broadcast (app 25) arrives as a lighting-style ramp
                // line; the app-25 decoder attaches the temperature reading.
                bridge._processEventLine('lighting ramp 254/25/3 86');

                expect(bridge.haDiscovery.ensureTemperatureDiscovery).toHaveBeenCalledWith('254', '25', '3');
            });

            it('asks HA discovery about an unlisted lighting group on a live event', () => {
                bridge.haDiscovery = {
                    ensureTemperatureDiscovery: jest.fn(),
                    ensureUnlistedGroupDiscovery: jest.fn()
                };

                bridge._processEventLine('lighting on 254/56/251');

                expect(bridge.haDiscovery.ensureUnlistedGroupDiscovery)
                    .toHaveBeenCalledWith('254', '56', '251');
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

    describe('Security (208) event routing via _handleSecurityLine', () => {
        // Verbatim live captures from GitHub issue #42 (64-zone Cytech panel).
        const ZONE_UNSEALED_LINE = '# security zone_unsealed //TestProject/254/208/58  #sourceunit=18 OID=';
        const ZONE_SEALED_LINE = '# security zone_sealed //TestProject/254/208/58  #sourceunit=18 OID=';
        const STATUS_REPORT_1_LINE = '# security status_report_1 //TestProject/254/208 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 1 0 0 0 0 #sourceunit=18 OID=';

        describe('with cbus_security_app_id set', () => {
            beforeEach(() => {
                bridge.settings.cbus_security_app_id = '208';
            });

            it('publishes ON for an unsealed zone and OFF for a sealed one', () => {
                const publishSpy = jest.spyOn(bridge.mqttManager, 'publish');

                bridge._processEventLine(ZONE_UNSEALED_LINE);
                bridge._processEventLine(ZONE_SEALED_LINE);

                const statePublishes = publishSpy.mock.calls.filter(call =>
                    call[0] === 'cbus/read/254/208/58/state'
                );
                expect(statePublishes.map(c => c[1])).toEqual(['ON', 'OFF']);
                // Raw 2-bit state rides the attributes topic.
                const attrPublishes = publishSpy.mock.calls.filter(call =>
                    call[0] === 'cbus/read/254/208/58/attributes'
                );
                expect(attrPublishes.map(c => JSON.parse(c[1]))).toEqual([
                    { zone_state: 'unsealed' },
                    { zone_state: 'sealed' }
                ]);

                publishSpy.mockRestore();
            });

            it('regression: zone events no longer publish a bogus OFF via the generic parser', () => {
                // Pre-change, `security zone_unsealed //…` ran through CBusEvent,
                // which knew neither verb and published a misleading OFF.
                const publishEventSpy = jest.spyOn(bridge.eventPublisher, 'publishEvent');
                const warnSpy = jest.spyOn(bridge, 'warn');

                bridge._processEventLine(ZONE_UNSEALED_LINE);

                expect(publishEventSpy).not.toHaveBeenCalled();
                expect(warnSpy).not.toHaveBeenCalledWith(
                    expect.stringContaining('Could not parse event line')
                );

                publishEventSpy.mockRestore();
                warnSpy.mockRestore();
            });

            it('regression: status reports no longer spam "Could not parse event line" warnings', () => {
                const warnSpy = jest.spyOn(bridge, 'warn');
                const publishSpy = jest.spyOn(bridge.mqttManager, 'publish');

                bridge._processEventLine(STATUS_REPORT_1_LINE);

                expect(warnSpy).not.toHaveBeenCalledWith(
                    expect.stringContaining('Could not parse event line')
                );
                // …and all 32 zones get their state published instead
                const zoneStates = publishSpy.mock.calls.filter(call =>
                    /cbus\/read\/254\/208\/\d+\/state/.test(call[0])
                );
                expect(zoneStates).toHaveLength(32);
                const z27 = publishSpy.mock.calls.find(call => call[0] === 'cbus/read/254/208/27/state');
                expect(z27[1]).toBe('ON');

                warnSpy.mockRestore();
                publishSpy.mockRestore();
            });

            it('captures an unconsumed security line but does not warn-parse it as a standard event', () => {
                const rawCaptureSpy = jest.spyOn(bridge, '_publishRawEventCapture');
                const warnSpy = jest.spyOn(bridge, 'warn');
                const publishEventSpy = jest.spyOn(bridge.eventPublisher, 'publishEvent');

                // A security-format line that the handler doesn't consume
                // (unsupported verb). It must still reach raw capture, but must
                // NOT be run through CBusEvent.
                bridge._processEventLine('security some_unknown_verb //TestProject/254/208 1');

                expect(rawCaptureSpy).toHaveBeenCalled();
                expect(publishEventSpy).not.toHaveBeenCalled();
                expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Could not parse event line'));

                rawCaptureSpy.mockRestore();
                warnSpy.mockRestore();
                publishEventSpy.mockRestore();
            });

            it('triggers security zone discovery for zones seen', () => {
                bridge.haDiscovery = { ensureSecurityZoneDiscovery: jest.fn() };

                bridge._processEventLine(ZONE_UNSEALED_LINE);

                expect(bridge.haDiscovery.ensureSecurityZoneDiscovery).toHaveBeenCalledWith('254', '208', '58');
            });

            it('requests the status sync once per network on first security traffic', () => {
                const queueSpy = jest.spyOn(bridge.cgateCommandQueue, 'add');

                bridge._processEventLine(ZONE_UNSEALED_LINE);
                bridge._processEventLine(ZONE_SEALED_LINE); // same network — no repeat

                const syncCommands = queueSpy.mock.calls
                    .map(c => c[0])
                    .filter(cmd => typeof cmd === 'string' && cmd.startsWith('security status_request'));
                expect(syncCommands).toEqual([
                    'security status_request //TestProject/254/208 1\n',
                    'security status_request //TestProject/254/208 2\n'
                ]);

                queueSpy.mockRestore();
            });

            it('sends at most one early pair (connect/traffic) plus one post-762 pair per network', () => {
                const queueSpy = jest.spyOn(bridge.cgateCommandQueue, 'add');

                // Connect trigger (via the init service's entry point into the handler)
                bridge.securityEventHandler.requestStatusSync('254', 'connect');
                // First traffic — deduped against the connect send
                bridge._processEventLine(ZONE_UNSEALED_LINE);
                // 762 sync-ok — allowed once as the post-sync refresh
                bridge._processEventLine('762 //TestProject/254 Network sync ok');
                // Further 762s and traffic — all deduped
                bridge._processEventLine('762 //TestProject/254 Network sync ok');
                bridge._processEventLine(ZONE_SEALED_LINE);

                const syncCommands = queueSpy.mock.calls
                    .map(c => c[0])
                    .filter(cmd => typeof cmd === 'string' && cmd.startsWith('security status_request'));
                expect(syncCommands).toEqual([
                    'security status_request //TestProject/254/208 1\n',
                    'security status_request //TestProject/254/208 2\n',
                    'security status_request //TestProject/254/208 1\n',
                    'security status_request //TestProject/254/208 2\n'
                ]);

                queueSpy.mockRestore();
            });

            it('consumes our own status_request echoes without warning or re-syncing', () => {
                const warnSpy = jest.spyOn(bridge, 'warn');
                const publishEventSpy = jest.spyOn(bridge.eventPublisher, 'publishEvent');
                const queueSpy = jest.spyOn(bridge.cgateCommandQueue, 'add');

                bridge._processEventLine('security status_request //TestProject/254/208 1 #sourceunit=0 OID= sessionId=cmd6 commandId={none}');

                expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Could not parse event line'));
                expect(publishEventSpy).not.toHaveBeenCalled();
                // The echo must not count as first traffic and trigger a sync
                const syncCommands = queueSpy.mock.calls
                    .map(c => c[0])
                    .filter(cmd => typeof cmd === 'string' && cmd.startsWith('security status_request'));
                expect(syncCommands).toEqual([]);

                warnSpy.mockRestore();
                publishEventSpy.mockRestore();
                queueSpy.mockRestore();
            });

            it('feeds zone events to the Live Events stream', () => {
                const entries = [];
                const unsubscribe = (entry) => entries.push(entry);
                bridge.eventStream.subscribe(unsubscribe);

                bridge._processEventLine(ZONE_UNSEALED_LINE);

                bridge.eventStream.unsubscribe(unsubscribe);
                const zoneEntry = entries.find(e => e.app === '208' && e.group === '58');
                expect(zoneEntry).toBeDefined();
                expect(zoneEntry).toMatchObject({ network: '254', level: 255, type: 'on' });
            });
        });

        describe('with cbus_security_app_id disabled', () => {
            it('falls through to the comment path without publishing zone state', () => {
                bridge.settings.cbus_security_app_id = '0';
                const publishSpy = jest.spyOn(bridge.mqttManager, 'publish');
                const publishEventSpy = jest.spyOn(bridge.eventPublisher, 'publishEvent');

                bridge._processEventLine(ZONE_UNSEALED_LINE);

                const zonePublish = publishSpy.mock.calls.find(call =>
                    call[0] === 'cbus/read/254/208/58/state'
                );
                expect(zonePublish).toBeUndefined();
                expect(publishEventSpy).not.toHaveBeenCalled();

                publishSpy.mockRestore();
                publishEventSpy.mockRestore();
            });
        });
    });

    describe('MQTT reconnect replay', () => {
        it('republishes diagnostics and stale-device discovery configs on broker reconnect', () => {
            const diagnosticsSpy = jest.spyOn(bridge.haBridgeDiagnostics, 'republishDiscovery');
            const staleSpy = jest.spyOn(bridge.staleDeviceDetector, 'republishDiscovery');
            const resyncSpy = jest.spyOn(bridge.stateResyncCoordinator, 'requestResync');

            bridge.mqttManager.emit('reconnect');

            expect(resyncSpy).toHaveBeenCalledWith('mqtt-reconnect');
            expect(diagnosticsSpy).toHaveBeenCalled();
            expect(staleSpy).toHaveBeenCalled();

            diagnosticsSpy.mockRestore();
            staleSpy.mockRestore();
            resyncSpy.mockRestore();
        });
    });

    describe('Live Events ring buffer', () => {
        it('keeps the most recent entries in order after wrapping', () => {
            const small = new CgateWebBridge(
                { ...mockSettings, eventLogMaxEntries: 10 },
                null,
                mockCmdSocketFactory,
                mockEvtSocketFactory
            );

            for (let i = 1; i <= 25; i++) {
                small._onEventLog({ ts: i, network: '254', app: '56', group: String(i), level: 255, type: 'on' });
            }

            const recent = small.eventStream.getRecent();
            expect(recent).toHaveLength(10);
            expect(recent.map(e => e.group)).toEqual(['16', '17', '18', '19', '20', '21', '22', '23', '24', '25']);
        });

        it('returns the partial contents in order before the buffer first fills', () => {
            const small = new CgateWebBridge(
                { ...mockSettings, eventLogMaxEntries: 10 },
                null,
                mockCmdSocketFactory,
                mockEvtSocketFactory
            );

            small._onEventLog({ ts: 1, network: '254', app: '56', group: '1', level: 255, type: 'on' });
            small._onEventLog({ ts: 2, network: '254', app: '56', group: '2', level: 0, type: 'off' });

            expect(small.eventStream.getRecent().map(e => e.group)).toEqual(['1', '2']);
            // …and getRecent materializes a fresh array each call
            small.eventStream.getRecent().push({ group: 'bogus' });
            expect(small.eventStream.getRecent()).toHaveLength(2);
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

            it('_getAdaptiveQueueIntervalMs honours messageIntervalMinMs and commandMinIntervalFloorMs', () => {
                bridge.settings.messageinterval = 1;
                bridge.settings.messageIntervalMinMs = 40;
                bridge.settings.commandMinIntervalMs = 1;
                bridge.settings.commandMinIntervalFloorMs = 20;
                bridge.commandConnectionPool.getStats = jest.fn(() => ({
                    isStarted: true,
                    isShuttingDown: false,
                    healthyConnections: 1,
                    writableConnections: 1
                }));
                Object.defineProperty(bridge.cgateCommandQueue, 'length', { get: () => 0, configurable: true });
                expect(bridge._getAdaptiveQueueIntervalMs()).toBe(40);
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

            it('_getAdaptiveQueueIntervalMs halves when queue depth exceeds writableConnections * 20', () => {
                bridge.settings.messageinterval = 200;
                bridge.settings.messageIntervalMinMs = 1;
                bridge.settings.commandMinIntervalMs = 1;
                bridge.settings.commandMinIntervalFloorMs = 1;
                bridge.commandConnectionPool.getStats = jest.fn(() => ({
                    isStarted: true,
                    isShuttingDown: false,
                    healthyConnections: 2,
                    writableConnections: 2
                }));
                Object.defineProperty(bridge.cgateCommandQueue, 'length', { get: () => 41, configurable: true });
                expect(bridge._getAdaptiveQueueIntervalMs()).toBe(50); // (200 / 2) * 0.5
            });

            it('stalls the real command queue until the mocked pool recovers', async () => {
                jest.useFakeTimers();
                try {
                mockConnectionPool.isStarted = true;
                setPoolHealthyCount(3);
                mockConnectionPool.getStats.mockImplementation(() => ({
                    isStarted: mockConnectionPool.isStarted,
                    isShuttingDown: false,
                    healthyConnections: mockConnectionPool.healthyConnections.size,
                    writableConnections: mockConnectionPool.healthyConnections.size
                }));
                mockConnectionPool.execute.mockImplementation(async () => true);

                bridge.settings.messageinterval = 50;
                bridge.settings.maxQueueSize = 3;
                bridge.settings.queueRetryWhenBlockedMinMs = 20;
                bridge.settings.queueRetryWhenBlockedCapMs = 20;
                bridge._buildQueues();

                const publishSpy = jest.spyOn(bridge.mqttManager, 'publish');

                bridge.cgateCommandQueue.add('CMD_A\n');
                await Promise.resolve();
                await Promise.resolve();
                expect(mockConnectionPool.execute).toHaveBeenCalledWith('CMD_A\n');

                mockConnectionPool.execute.mockClear();
                mockConnectionPool.healthyConnections.clear();

                bridge.cgateCommandQueue.add('CMD_B\n');
                await Promise.resolve();
                jest.advanceTimersByTime(200);
                await Promise.resolve();
                expect(mockConnectionPool.execute).not.toHaveBeenCalled();
                expect(bridge.cgateCommandQueue.length).toBeGreaterThan(0);

                bridge.cgateCommandQueue.add('CMD_C\n');
                bridge.cgateCommandQueue.add('CMD_D\n');
                bridge.cgateCommandQueue.add('CMD_E\n');
                expect(publishSpy).toHaveBeenCalledWith(
                    'hello/cgateweb/warnings',
                    expect.stringContaining('C-Gate command queue full'),
                    { retain: false }
                );

                setPoolHealthyCount(3);
                for (let i = 0; i < 20 && bridge.cgateCommandQueue.length > 0; i++) {
                    jest.advanceTimersByTime(50);
                    await Promise.resolve();
                    await Promise.resolve();
                }

                expect(mockConnectionPool.execute).toHaveBeenCalled();
                expect(bridge.cgateCommandQueue.length).toBe(0);
            } finally {
                jest.useRealTimers();
            }
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

    // Issue #44: neither a Home Assistant restart nor a broker restart restarts
    // the bridge, so these two signals are the only chance to resend state.
    describe('state resync wiring', () => {
        let bridge;
        beforeEach(() => {
            bridge = new CgateWebBridge({ ...defaultSettings, cbusip: '127.0.0.1' });
            bridge._setupEventHandlers();
            jest.spyOn(bridge.stateResyncCoordinator, 'requestResync').mockImplementation(() => true);
        });
        afterEach(() => jest.restoreAllMocks());

        it('resyncs when Home Assistant comes online', () => {
            bridge.mqttManager.emit('haOnline');
            expect(bridge.stateResyncCoordinator.requestResync).toHaveBeenCalledWith('ha-birth');
        });

        it('still routes normal cbus/write commands', () => {
            jest.spyOn(bridge.mqttCommandRouter, 'routeMessage').mockImplementation(() => {});
            bridge.mqttManager.emit('message', 'cbus/write/254/56/4/switch', 'ON');
            expect(bridge.mqttCommandRouter.routeMessage).toHaveBeenCalledWith('cbus/write/254/56/4/switch', 'ON');
        });

        it('resyncs on a broker reconnect', () => {
            bridge.mqttManager.emit('reconnect');
            expect(bridge.stateResyncCoordinator.requestResync).toHaveBeenCalledWith('mqtt-reconnect');
        });
    });

    // The coordinator is built inside _buildSubsystems, before the bridge
    // assigns this.initializationService. Passing the property by value there
    // captured undefined and every resync threw
    // "Cannot read properties of undefined (reading 'sendGetallLevels')",
    // killing the process (issue #44). The wiring tests above all stub
    // requestResync, so nothing exercised the real timer path until now.
    describe('state resync execution against a real bridge', () => {
        let bridge;
        beforeEach(() => {
            jest.useFakeTimers();
            bridge = new CgateWebBridge({ ...defaultSettings, cbusip: '127.0.0.1' });
        });
        afterEach(() => {
            bridge.stateResyncCoordinator.dispose();
            jest.useRealTimers();
            jest.restoreAllMocks();
        });

        it('runs a debounced resync through the bridge initialization service', () => {
            const getall = jest.spyOn(bridge.initializationService, 'sendGetallLevels').mockReturnValue([]);
            const security = jest.spyOn(bridge.initializationService, 'sendSecurityStatusRequests')
                .mockImplementation(() => {});
            const clock = jest.spyOn(bridge.initializationService, 'sendClockRefreshRequests')
                .mockImplementation(() => {});

            bridge.stateResyncCoordinator.requestResync('network-sync');
            expect(() => jest.runOnlyPendingTimers()).not.toThrow();

            expect(getall).toHaveBeenCalledWith(null, { priority: 'bulk' });
            expect(security).toHaveBeenCalledWith('resync');
            expect(clock).toHaveBeenCalledWith({ priority: 'bulk' });
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

    // C-Bus Clock and Timekeeping (app 223). These lines were dropped outright
    // until the decoder landed; the invariant that survives is that they must
    // never reach the standard event parser, whether the feature is on or off.
    describe('clock (app 223) event lines', () => {
        const DATE_LINE = 'clock date //CLIPSAL/254/223 2026-03-02 0 #sourceunit=8 OID=';
        const TIME_LINE = 'clock time //CLIPSAL/254/223 21:13:21 0 #sourceunit=8 OID=';

        const makeBridge = (overrides = {}) => {
            const b = new CgateWebBridge({ ...defaultSettings, cbusip: '127.0.0.1', ...overrides });
            b.eventPublisher.publishReading = jest.fn();
            b.eventPublisher.publishEvent = jest.fn();
            b.haDiscovery = { ensureClockDiscovery: jest.fn() };
            return b;
        };

        describe('with the feature off (the default)', () => {
            it('defaults to off', () => {
                expect(defaultSettings.cbus_clock_enabled).toBe(false);
            });

            it('publishes nothing for a clock date or time line', () => {
                const b = makeBridge();
                b._processEventLine(DATE_LINE);
                b._processEventLine(TIME_LINE);
                expect(b.eventPublisher.publishReading).not.toHaveBeenCalled();
                expect(b.eventPublisher.publishEvent).not.toHaveBeenCalled();
            });

            it('announces no discovery entities', () => {
                const b = makeBridge();
                b._processEventLine(DATE_LINE);
                expect(b.haDiscovery.ensureClockDiscovery).not.toHaveBeenCalled();
            });

            // The original bug: a two-segment address run through the
            // three-segment parser warns on every clock tick.
            it('never reaches the standard event parser, so it cannot warn-spam', () => {
                const b = makeBridge();
                mockConsoleWarn.mockClear();
                b._processEventLine(DATE_LINE);
                b._processEventLine(TIME_LINE);
                expect(mockConsoleWarn).not.toHaveBeenCalled();
            });
        });

        describe('with the feature on', () => {
            it('publishes the decoded date under the clock group', () => {
                const b = makeBridge({ cbus_clock_enabled: true });
                b._processEventLine(DATE_LINE);
                expect(b.eventPublisher.publishReading).toHaveBeenCalledWith(
                    '254', '223', 'clock',
                    { kind: 'clock', network: '254', application: '223', variant: 'date', value: '2026-03-02' }
                );
            });

            it('publishes a #s# channel-prefixed clock line from an alarm-panel broadcast', () => {
                const b = makeBridge({ cbus_clock_enabled: true });
                b._processEventLine('#s# clock time //MIDSTRM/254/223 08:44:00 255 #sourceunit=18 OID=');
                expect(b.eventPublisher.publishReading).toHaveBeenCalledWith(
                    '254', '223', 'clock',
                    { kind: 'clock', network: '254', application: '223', variant: 'time', value: '08:44:00' }
                );
            });

            it('announces the diagnostic sensors for the network', () => {
                const b = makeBridge({ cbus_clock_enabled: true });
                b._processEventLine(DATE_LINE);
                expect(b.haDiscovery.ensureClockDiscovery).toHaveBeenCalledWith('254', '223');
            });

            it('still keeps the line off the standard event parser', () => {
                const b = makeBridge({ cbus_clock_enabled: true });
                mockConsoleWarn.mockClear();
                b._processEventLine(DATE_LINE);
                expect(b.eventPublisher.publishEvent).not.toHaveBeenCalled();
                expect(mockConsoleWarn).not.toHaveBeenCalled();
            });

            it('does not throw when discovery is not wired up yet', () => {
                const b = makeBridge({ cbus_clock_enabled: true });
                b.haDiscovery = null;
                expect(() => b._processEventLine(DATE_LINE)).not.toThrow();
                expect(b.eventPublisher.publishReading).toHaveBeenCalled();
            });

            it('publishes nothing for clock traffic the decoder will not guess at', () => {
                const b = makeBridge({ cbus_clock_enabled: true });
                mockConsoleWarn.mockClear();
                b._processEventLine('clock sync //CLIPSAL/254/223 2026-03-02 0');
                expect(b.eventPublisher.publishReading).not.toHaveBeenCalled();
                expect(b.eventPublisher.publishEvent).not.toHaveBeenCalled();
                expect(mockConsoleWarn).not.toHaveBeenCalled();
            });

            it('consumes a request_refresh echo without logging it as unparsed (#66)', () => {
                const b = makeBridge({ cbus_clock_enabled: true });
                const debug = jest.spyOn(b.logger, 'debug').mockImplementation(() => {});
                b._processEventLine('clock request_refresh //MIDSTRM/254/223  #sourceunit=0 OID= sessionId=cmd5 commandId={none}');
                expect(b.eventPublisher.publishReading).not.toHaveBeenCalled();
                expect(b.eventPublisher.publishEvent).not.toHaveBeenCalled();
                expect(debug.mock.calls.map(c => String(c[0])).join('\n')).not.toMatch(/Unparsed clock line/);
                debug.mockRestore();
            });

            it('publishes nothing for a malformed clock line rather than throwing', () => {
                const b = makeBridge({ cbus_clock_enabled: true });
                for (const line of [
                    'clock date //CLIPSAL/254/223 2026-02-30 0',
                    'clock time //CLIPSAL/254/223 25:00:00 0',
                    'clock date //CLIPSAL/254/223',
                    'clock date //CLIPSAL/abc/223 2026-03-02 0'
                ]) {
                    expect(() => b._processEventLine(line)).not.toThrow();
                }
                expect(b.eventPublisher.publishReading).not.toHaveBeenCalled();
            });

            it('leaves other applications alone', () => {
                const b = makeBridge({ cbus_clock_enabled: true });
                b._processEventLine('lighting on 254/56/4');
                expect(b.eventPublisher.publishReading).not.toHaveBeenCalled();
                expect(b.eventPublisher.publishEvent).toHaveBeenCalled();
            });
        });
    });
});