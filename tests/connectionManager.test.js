const { EventEmitter } = require('events');
const ConnectionManager = require('../src/connectionManager');

describe('ConnectionManager', () => {
    let connectionManager;
    let mockConnections;
    let mockSettings;

    beforeEach(() => {
        // Mock MQTT manager
        const mockMqttManager = new EventEmitter();
        mockMqttManager.connected = false;
        mockMqttManager.connect = jest.fn(() => {
            mockMqttManager.connected = true;
            process.nextTick(() => mockMqttManager.emit('connect'));
        });
        mockMqttManager.disconnect = jest.fn(() => {
            mockMqttManager.connected = false;
            process.nextTick(() => mockMqttManager.emit('close'));
        });

        // Mock command connection pool
        const mockCommandConnectionPool = new EventEmitter();
        mockCommandConnectionPool.isStarted = false;
        mockCommandConnectionPool.healthyConnections = new Set();
        mockCommandConnectionPool.start = jest.fn(async () => {
            mockCommandConnectionPool.isStarted = true;
            mockCommandConnectionPool.healthyConnections.add('connection1');
            process.nextTick(() => mockCommandConnectionPool.emit('started'));
        });
        mockCommandConnectionPool.stop = jest.fn(async () => {
            mockCommandConnectionPool.isStarted = false;
            mockCommandConnectionPool.healthyConnections.clear();
        });

        // Mock event connection
        const mockEventConnection = new EventEmitter();
        mockEventConnection.connected = false;
        mockEventConnection.connect = jest.fn(() => {
            mockEventConnection.connected = true;
            process.nextTick(() => mockEventConnection.emit('connect'));
        });
        mockEventConnection.disconnect = jest.fn(() => {
            mockEventConnection.connected = false;
            process.nextTick(() => mockEventConnection.emit('close'));
        });

        mockConnections = {
            mqttManager: mockMqttManager,
            commandConnectionPool: mockCommandConnectionPool,
            eventConnection: mockEventConnection
        };

        mockSettings = {
            mqtt: 'mqtt://localhost:1883',
            cbusip: '192.168.1.100',
            cbuscommandport: 20023,
            cbuseventport: 20024,
            logging: false
        };

        connectionManager = new ConnectionManager(mockConnections, mockSettings);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('constructor', () => {
        it('should initialize with provided connections and settings', () => {
            expect(connectionManager.mqttManager).toBe(mockConnections.mqttManager);
            expect(connectionManager.commandConnectionPool).toBe(mockConnections.commandConnectionPool);
            expect(connectionManager.eventConnection).toBe(mockConnections.eventConnection);
            expect(connectionManager.settings).toBe(mockSettings);
            expect(connectionManager.allConnected).toBe(false);
        });

        it('should set up event handlers for all connections', () => {
            expect(mockConnections.mqttManager.listenerCount('connect')).toBe(1);
            expect(mockConnections.mqttManager.listenerCount('close')).toBe(1);
            expect(mockConnections.commandConnectionPool.listenerCount('started')).toBe(1);
            expect(mockConnections.commandConnectionPool.listenerCount('allConnectionsUnhealthy')).toBe(1);
            expect(mockConnections.eventConnection.listenerCount('connect')).toBe(1);
            expect(mockConnections.eventConnection.listenerCount('close')).toBe(1);
        });
    });

    describe('start', () => {
        it('should start all connections', async () => {
            await connectionManager.start();

            expect(mockConnections.mqttManager.connect).toHaveBeenCalledTimes(1);
            expect(mockConnections.commandConnectionPool.start).toHaveBeenCalledTimes(1);
            expect(mockConnections.eventConnection.connect).toHaveBeenCalledTimes(1);
        });

        it('should emit allConnected when all connections are ready', async () => {
            const allConnectedSpy = jest.fn();
            connectionManager.on('allConnected', allConnectedSpy);

            await connectionManager.start();

            // Wait for all events to fire
            await new Promise(resolve => process.nextTick(resolve));

            expect(allConnectedSpy).toHaveBeenCalledTimes(1);
            expect(connectionManager.isAllConnected).toBe(true);
        });
    });

    describe('stop', () => {
        it('should stop all connections', async () => {
            await connectionManager.start();
            await connectionManager.stop();

            expect(mockConnections.mqttManager.disconnect).toHaveBeenCalledTimes(1);
            expect(mockConnections.commandConnectionPool.stop).toHaveBeenCalledTimes(1);
            expect(mockConnections.eventConnection.disconnect).toHaveBeenCalledTimes(1);
            expect(connectionManager.allConnected).toBe(false);
        });
    });

    describe('connection state management', () => {
        it('should not emit allConnected if MQTT is not connected', async () => {
            const allConnectedSpy = jest.fn();
            connectionManager.on('allConnected', allConnectedSpy);

            // Start command pool and event connection only
            await mockConnections.commandConnectionPool.start();
            mockConnections.eventConnection.connect();

            expect(allConnectedSpy).not.toHaveBeenCalled();
            expect(connectionManager.isAllConnected).toBe(false);
        });

        it('should not emit allConnected if command pool is not healthy', async () => {
            const allConnectedSpy = jest.fn();
            connectionManager.on('allConnected', allConnectedSpy);

            // Connect MQTT and event, but don't start command pool
            mockConnections.mqttManager.connect();
            mockConnections.eventConnection.connect();

            expect(allConnectedSpy).not.toHaveBeenCalled();
            expect(connectionManager.isAllConnected).toBe(false);
        });

        it('should not emit allConnected if event connection is not connected', async () => {
            const allConnectedSpy = jest.fn();
            connectionManager.on('allConnected', allConnectedSpy);

            // Connect MQTT and start command pool, but don't connect event
            mockConnections.mqttManager.connect();
            await mockConnections.commandConnectionPool.start();

            expect(allConnectedSpy).not.toHaveBeenCalled();
            expect(connectionManager.isAllConnected).toBe(false);
        });

        it('should set allConnected to false when MQTT disconnects', async () => {
            await connectionManager.start();
            await new Promise(resolve => process.nextTick(resolve));
            expect(connectionManager.isAllConnected).toBe(true);

            mockConnections.mqttManager.disconnect();
            await new Promise(resolve => process.nextTick(resolve));

            expect(connectionManager.allConnected).toBe(false);
        });

        it('should set allConnected to false when event connection disconnects', async () => {
            await connectionManager.start();
            await new Promise(resolve => process.nextTick(resolve));
            expect(connectionManager.isAllConnected).toBe(true);

            mockConnections.eventConnection.disconnect();
            await new Promise(resolve => process.nextTick(resolve));

            expect(connectionManager.allConnected).toBe(false);
        });

        it('should set allConnected to false when all command connections become unhealthy', async () => {
            await connectionManager.start();
            await new Promise(resolve => process.nextTick(resolve));
            expect(connectionManager.isAllConnected).toBe(true);

            mockConnections.commandConnectionPool.emit('allConnectionsUnhealthy');

            expect(connectionManager.allConnected).toBe(false);
        });

        it('should not emit allConnected multiple times when already connected', async () => {
            const allConnectedSpy = jest.fn();
            connectionManager.on('allConnected', allConnectedSpy);

            await connectionManager.start();
            await new Promise(resolve => process.nextTick(resolve));
            expect(allConnectedSpy).toHaveBeenCalledTimes(1);

            // Trigger connection events again
            mockConnections.mqttManager.emit('connect');
            mockConnections.commandConnectionPool.emit('started');
            mockConnections.eventConnection.emit('connect');

            // Should still only be called once
            expect(allConnectedSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('isAllConnected getter', () => {
        it('should return current connection state', async () => {
            expect(connectionManager.isAllConnected).toBe(false);

            await connectionManager.start();
            await new Promise(resolve => process.nextTick(resolve));
            expect(connectionManager.isAllConnected).toBe(true);

            await connectionManager.stop();
            expect(connectionManager.isAllConnected).toBe(false);
        });
    });
});
