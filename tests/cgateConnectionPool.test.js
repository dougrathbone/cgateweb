// tests/cgateConnectionPool.test.js - Tests for CgateConnectionPool class

const CgateConnectionPool = require('../src/cgateConnectionPool');
const CgateConnection = require('../src/cgateConnection');
const EventEmitter = require('events');

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
    let mockConnections;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.clearAllTimers();
        
        mockSettings = {
            connectionPoolSize: 3,
            healthCheckInterval: 30000,
            keepAliveInterval: 60000,
            connectionTimeout: 5000,
            maxRetries: 3
        };

        // Create mock connections
        mockConnections = [];
        CgateConnection.mockImplementation(() => {
            const mockConnection = new EventEmitter();
            mockConnection.connect = jest.fn().mockImplementation(() => {
                // Don't actually connect, just return the connection
                return mockConnection;
            });
            mockConnection.disconnect = jest.fn();
            mockConnection.send = jest.fn().mockReturnValue(true);
            mockConnection.connected = false;
            mockConnection.isDestroyed = false;
            mockConnection.poolIndex = -1;
            mockConnection.lastActivity = Date.now();
            mockConnection.retryCount = 0;
            
            // Store reference for testing
            mockConnections.push(mockConnection);
            return mockConnection;
        });

        pool = new CgateConnectionPool('command', '192.168.1.100', 20023, mockSettings);
    });

    afterEach(async () => {
        if (pool.isStarted) {
            await pool.stop();
        }
        mockConnections = [];
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

    describe('start()', () => {
        it('should start pool and create connections', async () => {
            const startPromise = pool.start();
            
            // Simulate connections establishing
            mockConnections.forEach((conn, index) => {
                conn.poolIndex = index;
                setImmediate(() => {
                    conn.connected = true;
                    conn.emit('connect');
                });
            });

            await startPromise;
            
            expect(pool.isStarted).toBe(true);
            expect(CgateConnection).toHaveBeenCalledTimes(3);
            expect(pool.healthyConnections.size).toBe(3);
        });

        it('should handle partial connection failures', async () => {
            const startPromise = pool.start();
            
            // Only first two connections succeed
            mockConnections.slice(0, 2).forEach((conn, index) => {
                conn.poolIndex = index;
                setImmediate(() => {
                    conn.connected = true;
                    conn.emit('connect');
                });
            });
            
            // Third connection fails
            setImmediate(() => {
                mockConnections[2].emit('error', new Error('Connection failed'));
            });

            await startPromise;
            
            expect(pool.isStarted).toBe(true);
            expect(pool.healthyConnections.size).toBe(2);
        });

        it('should throw error if no connections establish', async () => {
            const startPromise = pool.start();
            
            // All connections fail
            mockConnections.forEach(conn => {
                setImmediate(() => {
                    conn.emit('error', new Error('Connection failed'));
                });
            });

            await expect(startPromise).rejects.toThrow('Failed to establish any connections in the pool');
        });

        it('should not start twice', async () => {
            const startPromise1 = pool.start();
            mockConnections.forEach((conn, index) => {
                conn.poolIndex = index;
                setImmediate(() => {
                    conn.connected = true;
                    conn.emit('connect');
                });
            });
            await startPromise1;

            const logSpy = jest.spyOn(pool.logger, 'warn');
            await pool.start();
            expect(logSpy).toHaveBeenCalledWith('Connection pool already started');
        });
    });

    describe('execute()', () => {
        beforeEach(async () => {
            const startPromise = pool.start();
            mockConnections.forEach((conn, index) => {
                conn.poolIndex = index;
                setImmediate(() => {
                    conn.connected = true;
                    conn.emit('connect');
                });
            });
            await startPromise;
        });

        it('should execute command on healthy connection', async () => {
            const result = await pool.execute('test command');
            
            expect(result).toBe(true);
            expect(mockConnections[0].send).toHaveBeenCalledWith('test command');
        });

        it('should throw error if pool not started', async () => {
            await pool.stop();
            
            await expect(pool.execute('test command')).rejects.toThrow('Connection pool is not started');
        });

        it('should throw error if no healthy connections', async () => {
            // Make all connections unhealthy
            pool.healthyConnections.clear();
            
            await expect(pool.execute('test command')).rejects.toThrow('No healthy connections available in pool');
        });

        it('should handle send failure', async () => {
            mockConnections[0].send.mockReturnValue(false);
            
            await expect(pool.execute('test command')).rejects.toThrow('Failed to send command through connection');
        });
    });

    describe('stop()', () => {
        beforeEach(async () => {
            const startPromise = pool.start();
            mockConnections.forEach((conn, index) => {
                conn.poolIndex = index;
                setImmediate(() => {
                    conn.connected = true;
                    conn.emit('connect');
                });
            });
            await startPromise;
        });

        it('should stop pool and close all connections', async () => {
            const stopPromise = pool.stop();
            
            // Simulate connections closing
            mockConnections.forEach(conn => {
                setImmediate(() => conn.emit('close'));
            });
            
            await stopPromise;
            
            expect(pool.isStarted).toBe(false);
            expect(pool.connections).toHaveLength(0);
            expect(pool.healthyConnections.size).toBe(0);
            mockConnections.forEach(conn => {
                expect(conn.disconnect).toHaveBeenCalled();
            });
        });

        it('should not stop twice', async () => {
            const stopPromise1 = pool.stop();
            mockConnections.forEach(conn => {
                setImmediate(() => conn.emit('close'));
            });
            await stopPromise1;

            // Second stop should return immediately
            await pool.stop();
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

    describe('health monitoring', () => {
        beforeEach(async () => {
            const startPromise = pool.start();
            mockConnections.forEach((conn, index) => {
                conn.poolIndex = index;
                setImmediate(() => {
                    conn.connected = true;
                    conn.emit('connect');
                });
            });
            await startPromise;
        });

        it('should start health monitoring timers', () => {
            expect(pool.healthCheckTimer).toBeDefined();
            expect(pool.keepAliveTimer).toBeDefined();
        });

        it('should perform health check on interval', () => {
            const healthCheckSpy = jest.spyOn(pool, '_performHealthCheck');
            
            jest.advanceTimersByTime(pool.healthCheckInterval);
            
            expect(healthCheckSpy).toHaveBeenCalled();
        });

        it('should send keep-alive pings', () => {
            jest.advanceTimersByTime(pool.keepAliveInterval);
            
            mockConnections.forEach(conn => {
                expect(conn.send).toHaveBeenCalledWith(expect.stringContaining('# Keep-alive'));
            });
        });
    });
});