// tests/cgateConnectionPool.test.js - Tests for CgateConnectionPool class

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
                isStarted: false,
                isShuttingDown: false
            });
        });
    });

    describe('Healthy connection caching', () => {
        it('should cache healthy array and return consistent connections via round-robin', () => {
            pool.isStarted = true;
            const conn0 = { poolIndex: 0, connected: true, send: jest.fn().mockReturnValue(true) };
            const conn1 = { poolIndex: 1, connected: true, send: jest.fn().mockReturnValue(true) };
            pool._addHealthy(conn0);
            pool._addHealthy(conn1);

            const first = pool._getHealthyConnection();
            const second = pool._getHealthyConnection();
            expect([conn0, conn1]).toContain(first);
            expect([conn0, conn1]).toContain(second);
            expect(first).not.toBe(second);
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
        it('should track retry counts at the pool level, not on connection objects', () => {
            expect(pool.retryCounts).toEqual([0, 0, 0]);
        });

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
});