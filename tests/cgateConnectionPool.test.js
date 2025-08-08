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

        // Simple mock for constructor tests
        CgateConnection.mockImplementation(() => ({
            connect: jest.fn(),
            disconnect: jest.fn(),
            send: jest.fn().mockReturnValue(true),
            connected: false,
            isDestroyed: false,
            poolIndex: -1,
            lastActivity: Date.now(),
            retryCount: 0
        }));

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
});