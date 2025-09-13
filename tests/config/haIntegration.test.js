const HAIntegration = require('../../src/config/HAIntegration');
const fs = require('fs');

// Mock fs and environment
jest.mock('fs');
jest.mock('../../src/logger');

describe('HAIntegration', () => {
    let haIntegration;
    let originalEnv;

    beforeEach(() => {
        // Store original environment
        originalEnv = { ...process.env };
        
        // Reset mocks
        jest.clearAllMocks();
        
        // Create fresh instance
        haIntegration = new HAIntegration();
        haIntegration._isAddon = null; // Reset cached value
    });

    afterEach(() => {
        // Restore environment
        process.env = originalEnv;
    });

    describe('isHomeAssistantAddon', () => {
        test('should detect Home Assistant addon environment', () => {
            // Set up HA addon environment
            process.env.SUPERVISOR_TOKEN = 'test-token';
            fs.existsSync.mockImplementation((path) => {
                return path === '/data' || path === '/data/options.json';
            });

            const result = haIntegration.isHomeAssistantAddon();

            expect(result).toBe(true);
            expect(fs.existsSync).toHaveBeenCalledWith('/data');
            expect(fs.existsSync).toHaveBeenCalledWith('/data/options.json');
        });

        test('should detect standalone environment', () => {
            // No HA addon environment variables
            delete process.env.SUPERVISOR_TOKEN;
            fs.existsSync.mockReturnValue(false);

            const result = haIntegration.isHomeAssistantAddon();

            expect(result).toBe(false);
        });

        test('should return cached result on subsequent calls', () => {
            process.env.SUPERVISOR_TOKEN = 'test-token';
            fs.existsSync.mockReturnValue(true);

            // First call
            const result1 = haIntegration.isHomeAssistantAddon();
            // Second call
            const result2 = haIntegration.isHomeAssistantAddon();

            expect(result1).toBe(true);
            expect(result2).toBe(true);
            
            // fs.existsSync should only be called during first detection
            expect(fs.existsSync).toHaveBeenCalledTimes(2); // Once for /data, once for /data/options.json
        });

        test('should require both token and data directory', () => {
            // Token but no data directory
            process.env.SUPERVISOR_TOKEN = 'test-token';
            fs.existsSync.mockReturnValue(false);

            const result = haIntegration.isHomeAssistantAddon();
            expect(result).toBe(false);
        });

        test('should require options.json file', () => {
            process.env.SUPERVISOR_TOKEN = 'test-token';
            fs.existsSync.mockImplementation((path) => {
                return path === '/data'; // /data exists but not /data/options.json
            });

            const result = haIntegration.isHomeAssistantAddon();
            expect(result).toBe(false);
        });
    });

    describe('getHAApiConfig', () => {
        test('should return API config in HA addon environment', () => {
            // Mock HA addon detection
            haIntegration.isHomeAssistantAddon = jest.fn().mockReturnValue(true);
            
            process.env.SUPERVISOR_TOKEN = 'test-token';
            process.env.SUPERVISOR_HOST = 'supervisor:80';
            process.env.INGRESS_URL = '/api/hassio_ingress/test';
            process.env.INGRESS_ENTRY = '/cgateweb';

            const config = haIntegration.getHAApiConfig();

            expect(config).toEqual({
                token: 'test-token',
                baseUrl: 'http://supervisor:80',
                ingressUrl: '/api/hassio_ingress/test',
                ingressEntry: '/cgateweb'
            });
        });

        test('should return null in standalone environment', () => {
            haIntegration.isHomeAssistantAddon = jest.fn().mockReturnValue(false);

            const config = haIntegration.getHAApiConfig();

            expect(config).toBeNull();
        });

        test('should use default supervisor host if not specified', () => {
            haIntegration.isHomeAssistantAddon = jest.fn().mockReturnValue(true);
            process.env.SUPERVISOR_TOKEN = 'test-token';
            delete process.env.SUPERVISOR_HOST;

            const config = haIntegration.getHAApiConfig();

            expect(config.baseUrl).toBe('http://supervisor');
        });
    });

    describe('setupIngress', () => {
        test('should configure ingress when environment variables are present', () => {
            haIntegration.isHomeAssistantAddon = jest.fn().mockReturnValue(true);
            process.env.INGRESS_URL = '/api/hassio_ingress/test';
            process.env.INGRESS_ENTRY = '/cgateweb';

            const ingress = haIntegration.setupIngress();

            expect(ingress).toEqual({
                ingressUrl: '/api/hassio_ingress/test',
                ingressEntry: '/cgateweb',
                basePath: '/cgateweb'
            });
        });

        test('should return null in standalone environment', () => {
            haIntegration.isHomeAssistantAddon = jest.fn().mockReturnValue(false);

            const ingress = haIntegration.setupIngress();

            expect(ingress).toBeNull();
        });

        test('should return null when no ingress variables are set', () => {
            haIntegration.isHomeAssistantAddon = jest.fn().mockReturnValue(true);
            delete process.env.INGRESS_URL;
            delete process.env.INGRESS_ENTRY;

            const ingress = haIntegration.setupIngress();

            expect(ingress).toBeNull();
        });

        test('should use default base path when INGRESS_ENTRY is not set', () => {
            haIntegration.isHomeAssistantAddon = jest.fn().mockReturnValue(true);
            process.env.INGRESS_URL = '/api/hassio_ingress/test';
            delete process.env.INGRESS_ENTRY;

            const ingress = haIntegration.setupIngress();

            expect(ingress).toEqual({
                ingressUrl: '/api/hassio_ingress/test',
                ingressEntry: undefined,
                basePath: '/'
            });
        });
    });

    describe('getAddonHealth', () => {
        test('should return health status in HA addon environment', () => {
            haIntegration.isHomeAssistantAddon = jest.fn().mockReturnValue(true);
            
            // Mock process.uptime()
            const originalUptime = process.uptime;
            process.uptime = jest.fn().mockReturnValue(123.45);

            const health = haIntegration.getAddonHealth();

            expect(health).toEqual(
                expect.objectContaining({
                    status: 'healthy',
                    version: expect.any(String),
                    environment: 'homeassistant-addon',
                    uptime: 123.45,
                    timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
                })
            );

            // Restore
            process.uptime = originalUptime;
        });

        test('should return null in standalone environment', () => {
            haIntegration.isHomeAssistantAddon = jest.fn().mockReturnValue(false);

            const health = haIntegration.getAddonHealth();

            expect(health).toBeNull();
        });
    });

    describe('initialize', () => {
        test('should apply all optimizations in HA addon environment', () => {
            haIntegration.isHomeAssistantAddon = jest.fn().mockReturnValue(true);
            haIntegration.optimizeLogging = jest.fn();
            haIntegration.setupIngress = jest.fn().mockReturnValue({
                ingressUrl: '/test',
                ingressEntry: '/cgateweb',
                basePath: '/cgateweb'
            });
            haIntegration.getHAApiConfig = jest.fn().mockReturnValue({ token: 'test' });
            haIntegration.getAddonHealth = jest.fn().mockReturnValue({ status: 'healthy' });

            const result = haIntegration.initialize();

            expect(result.isAddon).toBe(true);
            expect(result.optimizationsApplied).toContain('logging');
            expect(result.optimizationsApplied).toContain('ingress');
            expect(result.apiConfig).toEqual({ token: 'test' });
            expect(result.ingressConfig).toBeDefined();
            expect(result.health).toEqual({ status: 'healthy' });

            expect(haIntegration.optimizeLogging).toHaveBeenCalled();
            expect(haIntegration.setupIngress).toHaveBeenCalled();
        });

        test('should skip optimizations in standalone environment', () => {
            haIntegration.isHomeAssistantAddon = jest.fn().mockReturnValue(false);
            haIntegration.optimizeLogging = jest.fn();
            haIntegration.setupIngress = jest.fn();

            const result = haIntegration.initialize();

            expect(result.isAddon).toBe(false);
            expect(result.optimizationsApplied).toEqual([]);
            expect(haIntegration.optimizeLogging).not.toHaveBeenCalled();
            expect(haIntegration.setupIngress).not.toHaveBeenCalled();
        });

        test('should handle missing ingress configuration gracefully', () => {
            haIntegration.isHomeAssistantAddon = jest.fn().mockReturnValue(true);
            haIntegration.optimizeLogging = jest.fn();
            haIntegration.setupIngress = jest.fn().mockReturnValue(null); // No ingress
            haIntegration.getHAApiConfig = jest.fn().mockReturnValue({ token: 'test' });
            haIntegration.getAddonHealth = jest.fn().mockReturnValue({ status: 'healthy' });

            const result = haIntegration.initialize();

            expect(result.isAddon).toBe(true);
            expect(result.optimizationsApplied).toEqual(['logging']); // Only logging, no ingress
        });
    });

    describe('optimizeLogging', () => {
        test('should modify console methods in HA addon environment', () => {
            haIntegration.isHomeAssistantAddon = jest.fn().mockReturnValue(true);

            const originalLog = console.log;
            const originalWarn = console.warn;
            const originalError = console.error;
            const originalDebug = console.debug;

            haIntegration.optimizeLogging();

            // Verify console methods were modified
            expect(console.log).not.toBe(originalLog);
            expect(console.warn).not.toBe(originalWarn);
            expect(console.error).not.toBe(originalError);
            expect(console.debug).not.toBe(originalDebug);

            // Test timestamp removal
            const mockLog = jest.fn();
            console.log = jest.fn((msg) => {
                // Simulate the timestamp removal logic
                const cleanMessage = msg.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\s+/, '');
                mockLog(cleanMessage);
            });

            console.log('2023-01-01T12:00:00.000Z INFO [component] Test message');
            expect(mockLog).toHaveBeenCalledWith('INFO [component] Test message');

            // Restore original methods
            console.log = originalLog;
            console.warn = originalWarn;
            console.error = originalError;
            console.debug = originalDebug;
        });

        test('should do nothing in standalone environment', () => {
            haIntegration.isHomeAssistantAddon = jest.fn().mockReturnValue(false);

            const originalLog = console.log;
            haIntegration.optimizeLogging();

            // Console methods should remain unchanged
            expect(console.log).toBe(originalLog);
        });
    });
});
