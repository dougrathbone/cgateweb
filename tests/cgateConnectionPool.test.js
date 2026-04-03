// tests/cgateConnectionPool.test.js - Tests for CgateConnectionPool class

const EventEmitter = require('events');
const CgateConnectionPool = require('../src/cgateConnectionPool');
const CgateConnection = require('../src/cgateConnection');

// Mock CgateConnection
jest.mock('../src/cgateConnection');

// Mock net module to prevent actual connections
jest.mock('net', () => ({
    createConnection: jest.fn()
}));

// Mock timers
jest.useFakeTimers();

/**
 * Creates a mock CgateConnection that emits 'connect' asynchronously.
 * Pass { failConnect: true } to emit 'error' instead.
 */
function makeMockConnection({ failConnect = false } = {}) {
    const conn = new EventEmitter();
    conn.connect = jest.fn(() => {
        if (failConnect) {
            conn.emit('error', new Error('ECONNREFUSED'));
            conn.emit('close', true);
        } else {
            conn.connected = true;
            conn.emit('connect');
        }
    });
    conn.disconnect = jest.fn(() => {
        conn.connected = false;
        conn.isDestroyed = true;
        conn.emit('close', false);
    });
    conn.send = jest.fn().mockReturnValue(true);
    conn.sendWithBackpressure = jest.fn().mockResolvedValue(true);
    conn.connected = false;
    conn.isDestroyed = false;
    conn.isWritable = true;
    conn.poolIndex = -1;
    conn.lastActivity = Date.now();
    return conn;
}

describe('CgateConnectionPool', () => {
    let pool;
    let mockSettings;
    let randomSpy;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.clearAllTimers();
        randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
        
        mockSettings = {
            connectionPoolSize: 3,
            healthCheckInterval: 30000,
            keepAliveInterval: 60000,
            connectionTimeout: 5000,
            maxRetries: 3
        };

        // Simple mock for constructor tests
        CgateConnection.mockImplementation(() => ({
            connect: jest.fn(),
            disconnect: jest.fn(),
            send: jest.fn().mockReturnValue(true),
            connected: false,
            isDestroyed: false,
            poolIndex: -1,
            lastActivity: Date.now()
        }));

        pool = new CgateConnectionPool('command', '192.168.1.100', 20023, mockSettings);
    });

    afterEach(async () => {
        randomSpy.mockRestore();
        if (pool.isStarted) {
            await pool.stop();
        }
    });

    describe('Constructor', () => {
        it('should initialize with correct settings', () => {
            expect(pool.type).toBe('command');
            expect(pool.host).toBe('192.168.1.100');
            expect(pool.port).toBe(20023);
            expect(pool.poolSize).toBe(3);
            expect(pool.healthCheckInterval).toBe(30000);
            expect(pool.keepAliveInterval).toBe(60000);
        });

        it('should throw error for non-command type', () => {
            expect(() => {
                new CgateConnectionPool('event', '192.168.1.100', 20023, mockSettings);
            }).toThrow('Connection pool only supports command connections');
        });

        it('should apply minimums to configuration values', () => {
            const badSettings = {
                connectionPoolSize: 0,
                healthCheckInterval: 1000,
                keepAliveInterval: 5000,
                connectionTimeout: 500,
                maxRetries: 0
            };
            const poolBad = new CgateConnectionPool('command', '192.168.1.100', 20023, badSettings);
            
            expect(poolBad.poolSize).toBe(1); // Math.max(1, 0) = 1
            expect(poolBad.healthCheckInterval).toBe(5000); // Math.max(5000, 1000) = 5000
            expect(poolBad.keepAliveInterval).toBe(10000); // Math.max(10000, 5000) = 10000
            expect(poolBad.connectionTimeout).toBe(1000); // Math.max(1000, 500) = 1000  
            expect(poolBad.maxRetries).toBe(1); // Math.max(1, 0) = 1
        });
    });

    describe('getStats()', () => {
        it('should return correct statistics', () => {
            const stats = pool.getStats();
            expect(stats).toEqual({
                poolSize: 3,
                totalConnections: 0,
                healthyConnections: 0,
                pendingReconnects: 0,
                writableConnections: 0,
                retryCounts: [0, 0, 0],
                isStarted: false,
                isShuttingDown: false
            });
        });
    });

    describe('Healthy connection caching', () => {
        it('should cache healthy array and prefer stable writable least-loaded connection selection', () => {
            pool.isStarted = true;
            const conn0 = { poolIndex: 0, connected: true, send: jest.fn().mockReturnValue(true) };
            const conn1 = { poolIndex: 1, connected: true, send: jest.fn().mockReturnValue(true) };
            pool._addHealthy(conn0);
            pool._addHealthy(conn1);

            const first = pool._getHealthyConnection();
            const second = pool._getHealthyConnection();
            expect([conn0, conn1]).toContain(first);
            expect([conn0, conn1]).toContain(second);
            expect(first.poolIndex).toBe(0);
        });

        it('should invalidate cache when a connection is added', () => {
            const conn0 = { poolIndex: 0 };
            pool._addHealthy(conn0);
            pool._getHealthyConnection(); // populates cache
            expect(pool._healthyArray).not.toBeNull();

            const conn1 = { poolIndex: 1 };
            pool._addHealthy(conn1);
            expect(pool._healthyArray).toBeNull();
        });

        it('should invalidate cache when a connection is removed', () => {
            const conn0 = { poolIndex: 0 };
            pool._addHealthy(conn0);
            pool._getHealthyConnection(); // populates cache
            expect(pool._healthyArray).not.toBeNull();

            pool._removeHealthy(conn0);
            expect(pool._healthyArray).toBeNull();
        });

        it('should return null when no healthy connections exist', () => {
            expect(pool._getHealthyConnection()).toBeNull();
        });

        it('should clear cache on stop', async () => {
            const conn0 = { poolIndex: 0 };
            pool._addHealthy(conn0);
            pool._getHealthyConnection();
            expect(pool._healthyArray).not.toBeNull();

            pool.isStarted = true;
            await pool.stop();
            expect(pool._healthyArray).toBeNull();
        });
    });

    describe('Exponential backoff', () => {
        it('should increment pool-level retry count on each reconnection schedule', () => {
            pool.isStarted = true;
            const conn = { poolIndex: 0 };
            pool.connections[0] = conn;

            pool._scheduleReconnection(conn, 0);
            expect(pool.retryCounts[0]).toBe(1);

            pool.pendingReconnects.delete(0);
            pool._scheduleReconnection(conn, 0);
            expect(pool.retryCounts[0]).toBe(2);

            pool.pendingReconnects.delete(0);
            pool._scheduleReconnection(conn, 0);
            expect(pool.retryCounts[0]).toBe(3);
        });

        it('should compute exponentially increasing delays from pool-level retry counts', () => {
            pool.isStarted = true;
            const conn = { poolIndex: 0 };
            pool.connections[0] = conn;
            const spy = jest.spyOn(global, 'setTimeout');

            // retryCount 0 -> 1: delay = 1000 * 2^0 = 1000ms
            pool._scheduleReconnection(conn, 0);
            expect(spy).toHaveBeenLastCalledWith(expect.any(Function), 1000);

            // retryCount 1 -> 2: delay = 1000 * 2^1 = 2000ms
            pool.pendingReconnects.delete(0);
            pool._scheduleReconnection(conn, 0);
            expect(spy).toHaveBeenLastCalledWith(expect.any(Function), 2000);

            // retryCount 2 -> 3: delay = 1000 * 2^2 = 4000ms
            pool.pendingReconnects.delete(0);
            pool._scheduleReconnection(conn, 0);
            expect(spy).toHaveBeenLastCalledWith(expect.any(Function), 4000);

            // retryCount 3 -> 4: delay = 1000 * 2^3 = 8000ms
            pool.pendingReconnects.delete(0);
            pool._scheduleReconnection(conn, 0);
            expect(spy).toHaveBeenLastCalledWith(expect.any(Function), 8000);

            spy.mockRestore();
        });

        it('should cap backoff delay at 60 seconds', () => {
            pool.isStarted = true;
            pool.retryCounts[0] = 10;

            const conn = { poolIndex: 0 };
            pool.connections[0] = conn;

            const spy = jest.spyOn(global, 'setTimeout');
            pool._scheduleReconnection(conn, 0);

            // 1000 * 2^10 = 1024000, capped to 60000
            expect(spy).toHaveBeenLastCalledWith(expect.any(Function), 60000);
            expect(pool.retryCounts[0]).toBe(11);

            spy.mockRestore();
        });

        it('should reset retry counts when pool is stopped', async () => {
            pool.isStarted = true;
            pool.retryCounts[0] = 5;
            pool.retryCounts[1] = 3;
            pool.retryCounts[2] = 7;

            await pool.stop();

            expect(pool.retryCounts).toEqual([0, 0, 0]);
        });

        it('should use independent retry counts per connection index', () => {
            pool.isStarted = true;

            const conn0 = { poolIndex: 0 };
            const conn1 = { poolIndex: 1 };
            pool.connections[0] = conn0;
            pool.connections[1] = conn1;

            pool._scheduleReconnection(conn0, 0);
            pool.pendingReconnects.delete(0);
            pool._scheduleReconnection(conn0, 0);
            pool._scheduleReconnection(conn1, 1);

            expect(pool.retryCounts[0]).toBe(2);
            expect(pool.retryCounts[1]).toBe(1);
            expect(pool.retryCounts[2]).toBe(0);
        });

        it('should not schedule reconnection when pool is shutting down', () => {
            pool.isStarted = true;
            pool.isShuttingDown = true;

            const conn = { poolIndex: 0 };
            pool.connections[0] = conn;

            const spy = jest.spyOn(global, 'setTimeout');
            pool._scheduleReconnection(conn, 0);

            expect(pool.retryCounts[0]).toBe(0);
            expect(spy).not.toHaveBeenCalledWith(expect.any(Function), expect.any(Number));

            spy.mockRestore();
        });

        it('should reset retry count on successful reconnection', async () => {
            pool.isStarted = true;
            pool.retryCounts[0] = 5;

            const failedConn = { poolIndex: 0 };
            pool.connections[0] = failedConn;

            const mockNewConn = { poolIndex: 0 };
            jest.spyOn(pool, '_createConnection').mockResolvedValue(mockNewConn);

            pool._scheduleReconnection(failedConn, 0);
            expect(pool.retryCounts[0]).toBe(6);

            // Advance past the backoff delay: min(1000 * 2^5, 60000) = 32000ms
            jest.advanceTimersByTime(32000);
            // Flush the async promise resolution
            await Promise.resolve();
            await Promise.resolve();

            expect(pool.retryCounts[0]).toBe(0);

            pool._createConnection.mockRestore();
        });
    });

    // Helper: configure mock to capture connections and start the pool
    async function startWithConnections() {
        const connections = [];
        CgateConnection.mockImplementation(() => {
            const c = makeMockConnection();
            connections.push(c);
            return c;
        });
        await pool.start();
        return connections;
    }

    describe('start()', () => {
        beforeEach(() => {
            CgateConnection.mockImplementation(() => makeMockConnection());
        });

        it('starts pool and emits started event when connections succeed', async () => {
            const startedSpy = jest.fn();
            pool.on('started', startedSpy);
            await pool.start();
            expect(pool.isStarted).toBe(true);
            expect(pool.healthyConnections.size).toBe(3);
            expect(startedSpy).toHaveBeenCalledWith({ healthy: 3, total: 3 });
        });

        it('marks itself started even when all connections fail', async () => {
            CgateConnection.mockImplementation(() => makeMockConnection({ failConnect: true }));
            const startedSpy = jest.fn();
            pool.on('started', startedSpy);
            const startPromise = pool.start();
            jest.advanceTimersByTime(pool.connectionTimeout + 100);
            await startPromise;
            expect(pool.isStarted).toBe(true);
            expect(pool.healthyConnections.size).toBe(0);
            expect(startedSpy).toHaveBeenCalledWith({ healthy: 0, total: 3 });
        });

        it('does nothing when already started', async () => {
            await pool.start();
            const createSpy = jest.spyOn(pool, '_createConnection');
            await pool.start();
            expect(createSpy).not.toHaveBeenCalled();
        });

        it('starts health monitoring and keep-alive timers', async () => {
            await pool.start();
            expect(pool.healthCheckTimer).not.toBeNull();
            expect(pool.keepAliveTimer).not.toBeNull();
        });

        it('sets poolIndex on each connection', async () => {
            const connections = await startWithConnections();
            expect(connections[0].poolIndex).toBe(0);
            expect(connections[1].poolIndex).toBe(1);
            expect(connections[2].poolIndex).toBe(2);
        });

        it('emits connectionAdded for each successful connection', async () => {
            const addedSpy = jest.fn();
            pool.on('connectionAdded', addedSpy);
            await pool.start();
            expect(addedSpy).toHaveBeenCalledTimes(3);
        });

        it('forwards data events from connections', async () => {
            const connections = await startWithConnections();
            const dataSpy = jest.fn();
            pool.on('data', dataSpy);
            connections[0].emit('data', Buffer.from('hello'));
            expect(dataSpy).toHaveBeenCalledWith(Buffer.from('hello'), connections[0]);
        });

        it('schedules reconnect when a connection closes after start', async () => {
            const connections = await startWithConnections();
            const scheduleSpy = jest.spyOn(pool, '_scheduleReconnection');
            connections[0].emit('close', false);
            expect(scheduleSpy).toHaveBeenCalledWith(connections[0], 0);
        });
    });

    describe('stop()', () => {
        beforeEach(() => {
            CgateConnection.mockImplementation(() => makeMockConnection());
        });

        it('stops pool, clears timers, and emits stopped', async () => {
            await pool.start();
            const stoppedSpy = jest.fn();
            pool.on('stopped', stoppedSpy);
            const stopPromise = pool.stop();
            jest.runAllTimers();
            await stopPromise;
            expect(pool.isStarted).toBe(false);
            expect(pool.healthyConnections.size).toBe(0);
            expect(pool.healthCheckTimer).toBeNull();
            expect(pool.keepAliveTimer).toBeNull();
            expect(stoppedSpy).toHaveBeenCalled();
        });

        it('does nothing when pool is not started', async () => {
            const stoppedSpy = jest.fn();
            pool.on('stopped', stoppedSpy);
            await pool.stop();
            expect(stoppedSpy).not.toHaveBeenCalled();
        });

        it('does nothing when pool is already shutting down', async () => {
            await pool.start();
            pool.isShuttingDown = true;
            const stoppedSpy = jest.fn();
            pool.on('stopped', stoppedSpy);
            await pool.stop();
            expect(stoppedSpy).not.toHaveBeenCalled();
        });
    });

    describe('execute()', () => {
        beforeEach(() => {
            CgateConnection.mockImplementation(() => makeMockConnection());
        });

        it('throws when pool is not started', async () => {
            await expect(pool.execute('GET //HOME/254/56/* level\n')).rejects.toThrow('not started');
        });

        it('throws when shutting down', async () => {
            await pool.start();
            pool.isShuttingDown = true;
            await expect(pool.execute('cmd\n')).rejects.toThrow('not started');
        });

        it('sends command via a healthy connection and returns true', async () => {
            const connections = await startWithConnections();
            const result = await pool.execute('GET //HOME/254/56/* level\n');
            expect(result).toBe(true);
            expect(connections.some(c => c.sendWithBackpressure.mock.calls.length > 0)).toBe(true);
        });

        it('throws when no healthy connections are available', async () => {
            await pool.start();
            pool.healthyConnections.clear();
            pool._healthyArray = null;
            await expect(pool.execute('cmd\n')).rejects.toThrow('No healthy connections');
        });

        it('cleans up in-flight count after successful send', async () => {
            const connections = await startWithConnections();
            await pool.execute('cmd\n');
            for (const c of connections) {
                expect(pool.connectionInFlight.get(c) || 0).toBe(0);
            }
        });

        it('marks connection unhealthy and tries next when send fails', async () => {
            const connections = await startWithConnections();
            for (const c of connections) {
                c.sendWithBackpressure = jest.fn().mockResolvedValue(false);
            }
            const markSpy = jest.spyOn(pool, '_markConnectionUnhealthy');
            await expect(pool.execute('cmd\n')).rejects.toThrow();
            expect(markSpy).toHaveBeenCalled();
        });
    });

    describe('Health monitoring', () => {
        beforeEach(() => {
            CgateConnection.mockImplementation(() => makeMockConnection());
        });

        it('_performHealthCheck emits allConnectionsUnhealthy when no healthy connections', async () => {
            await pool.start();
            pool.healthyConnections.clear();
            pool._healthyArray = null;
            const spy = jest.fn();
            pool.on('allConnectionsUnhealthy', spy);
            pool._performHealthCheck();
            expect(spy).toHaveBeenCalled();
        });

        it('_performHealthCheck emits healthCheck event with stats', async () => {
            await pool.start();
            const spy = jest.fn();
            pool.on('healthCheck', spy);
            pool._performHealthCheck();
            expect(spy).toHaveBeenCalledWith(expect.objectContaining({ healthyConnections: 3 }));
        });

        it('_checkConnectionHealth removes destroyed connections from healthy set', async () => {
            await pool.start();
            const [conn] = pool.connections;
            conn.isDestroyed = true;
            pool._checkConnectionHealth(conn);
            expect(pool.healthyConnections.has(conn)).toBe(false);
        });

        it('_checkConnectionHealth removes disconnected connections from healthy set', async () => {
            await pool.start();
            const [conn] = pool.connections;
            conn.connected = false;
            pool._checkConnectionHealth(conn);
            expect(pool.healthyConnections.has(conn)).toBe(false);
        });

        it('fires health check on interval', async () => {
            await pool.start();
            const spy = jest.spyOn(pool, '_performHealthCheck');
            jest.advanceTimersByTime(pool.healthCheckInterval);
            expect(spy).toHaveBeenCalled();
        });

        it('_markConnectionUnhealthy schedules a deferred health check', async () => {
            await pool.start();
            const [conn] = pool.connections;
            const healthSpy = jest.spyOn(pool, '_checkConnectionHealth');
            pool._markConnectionUnhealthy(conn);
            jest.advanceTimersByTime(1000);
            expect(healthSpy).toHaveBeenCalledWith(conn);
        });
    });

    describe('Keep-alive', () => {
        beforeEach(() => {
            CgateConnection.mockImplementation(() => makeMockConnection());
        });

        it('sends keep-alive pings to healthy connections on interval', async () => {
            const connections = await startWithConnections();
            jest.advanceTimersByTime(pool.keepAliveInterval);
            for (const c of connections) {
                expect(c.send).toHaveBeenCalledWith(expect.stringContaining('Keep-alive'));
            }
        });

        it('does not ping when shutting down', async () => {
            const connections = await startWithConnections();
            pool.isShuttingDown = true;
            pool._sendKeepAlive();
            for (const c of connections) {
                expect(c.send).not.toHaveBeenCalled();
            }
        });

        it('removes connection from healthy set when keep-alive send throws', async () => {
            const connections = await startWithConnections();
            connections[0].send = jest.fn().mockImplementation(() => { throw new Error('write failed'); });
            pool._sendKeepAlive();
            expect(pool.healthyConnections.has(connections[0])).toBe(false);
        });
    });
});