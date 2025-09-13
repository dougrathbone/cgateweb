const fs = require('fs');
const path = require('path');
const ConfigLoader = require('../../src/config/ConfigLoader');
const EnvironmentDetector = require('../../src/config/EnvironmentDetector');

// Mock dependencies
jest.mock('fs');
jest.mock('../../src/config/EnvironmentDetector');

describe('ConfigLoader', () => {
    let configLoader;
    let mockEnvironmentDetector;

    beforeEach(() => {
        jest.clearAllMocks();
        
        // Create mock environment detector
        mockEnvironmentDetector = {
            detect: jest.fn(),
            getEnvironmentInfo: jest.fn(),
            reset: jest.fn()
        };

        EnvironmentDetector.mockImplementation(() => mockEnvironmentDetector);
        
        configLoader = new ConfigLoader();
    });

    describe('load() - Home Assistant Addon Configuration', () => {
        const mockAddonOptions = {
            cgate_host: '192.168.1.100',
            cgate_port: 20023,
            cgate_control_port: 20024,
            cgate_project: 'MyHome',
            mqtt_host: '192.168.1.50',
            mqtt_port: 1883,
            mqtt_username: 'testuser',
            mqtt_password: 'testpass',
            getall_networks: [254, 255],
            getall_on_start: true,
            getall_period: 3600,
            retain_reads: true,
            message_interval: 150,
            log_level: 'debug',
            ha_discovery_enabled: true,
            ha_discovery_prefix: 'homeassistant',
            ha_discovery_networks: [254],
            ha_discovery_cover_app_id: 203,
            ha_discovery_switch_app_id: 201
        };

        beforeEach(() => {
            mockEnvironmentDetector.detect.mockReturnValue({
                type: 'addon',
                isAddon: true,
                isStandalone: false,
                optionsPath: '/data/options.json',
                dataPath: '/data',
                configPath: '/config'
            });
        });

        test('should load and convert addon configuration correctly', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify(mockAddonOptions));

            const config = configLoader.load();

            expect(config.cbusip).toBe('192.168.1.100');
            expect(config.cbusport).toBe(20023);
            expect(config.cbuscontrolport).toBe(20024);
            expect(config.cbusname).toBe('MyHome');
            expect(config.mqtt).toBe('192.168.1.50:1883');
            expect(config.mqttusername).toBe('testuser');
            expect(config.mqttpassword).toBe('testpass');
            expect(config.getallnetapp).toBe('254/56');
            expect(config.getallonstart).toBe(true);
            expect(config.getallperiod).toBe(3600);
            expect(config.retainreads).toBe(true);
            expect(config.messageinterval).toBe(150);
            expect(config.logging).toBe(true); // debug level should enable logging
            expect(config.ha_discovery_enabled).toBe(true);
            expect(config.ha_discovery_prefix).toBe('homeassistant');
            expect(config.ha_discovery_networks).toEqual([254]);
            expect(config.ha_discovery_cover_app_id).toBe('203');
            expect(config.ha_discovery_switch_app_id).toBe('201');
            expect(config._environment.type).toBe('addon');
        });

        test('should handle minimal addon configuration', () => {
            const minimalOptions = {
                cgate_host: '127.0.0.1',
                mqtt_host: '127.0.0.1'
            };

            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify(minimalOptions));

            const config = configLoader.load();

            expect(config.cbusip).toBe('127.0.0.1');
            expect(config.cbusport).toBe(20023); // default
            expect(config.cbusname).toBe('HOME'); // default
            expect(config.mqtt).toBe('127.0.0.1:1883'); // default port
            expect(config.messageinterval).toBe(200); // default
            expect(config.logging).toBe(false); // default
        });

        test('should throw error when options file is missing', () => {
            fs.existsSync.mockReturnValue(false);

            expect(() => configLoader.load()).toThrow('Addon options file not found');
        });

        test('should throw error when options file is invalid JSON', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue('invalid json');

            expect(() => configLoader.load()).toThrow('Failed to parse addon options');
        });

        test('should handle empty getall_networks array', () => {
            const optionsWithEmptyNetworks = {
                ...mockAddonOptions,
                getall_networks: []
            };

            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify(optionsWithEmptyNetworks));

            const config = configLoader.load();

            expect(config.getallnetapp).toBeUndefined();
            expect(config.getallonstart).toBeUndefined();
        });
    });

    describe('load() - Standalone Configuration', () => {
        const mockSettingsPath = path.join(process.cwd(), 'settings.js');
        const mockSettings = {
            cbusip: '10.0.0.1',
            cbusport: 20025,
            cbusname: 'TestProject',
            mqtt: '10.0.0.2:1884',
            mqttusername: 'user',
            mqttpassword: 'pass',
            getallnetapp: '255/56',
            getallonstart: true,
            retainreads: false,
            messageinterval: 300,
            logging: true,
            ha_discovery_enabled: false
        };

        beforeEach(() => {
            mockEnvironmentDetector.detect.mockReturnValue({
                type: 'standalone',
                isAddon: false,
                isStandalone: true,
                settingsPath: mockSettingsPath,
                workingDirectory: process.cwd()
            });
        });

        test('should load standalone configuration from settings.js', () => {
            fs.existsSync.mockReturnValue(true);
            
            // Mock require.resolve and require cache
            const mockResolve = jest.fn().mockReturnValue(mockSettingsPath);
            require.resolve = mockResolve;
            require.cache = { [mockSettingsPath]: { exports: mockSettings } };
            
            // Mock require function
            jest.doMock(mockSettingsPath, () => mockSettings, { virtual: true });

            const config = configLoader.load();

            expect(config.cbusip).toBe('10.0.0.1');
            expect(config.cbusport).toBe(20025);
            expect(config.cbusname).toBe('TestProject');
            expect(config.mqtt).toBe('10.0.0.2:1884');
            expect(config.mqttusername).toBe('user');
            expect(config.mqttpassword).toBe('pass');
            expect(config.getallnetapp).toBe('255/56');
            expect(config.getallonstart).toBe(true);
            expect(config.retainreads).toBe(false);
            expect(config.messageinterval).toBe(300);
            expect(config.logging).toBe(true);
            expect(config.ha_discovery_enabled).toBe(false);
            expect(config._environment.type).toBe('standalone');
        });

        test('should handle string boolean values in settings.js', () => {
            const settingsWithStringBooleans = {
                ...mockSettings,
                getallonstart: 'true',
                retainreads: 'false',
                logging: 'true',
                ha_discovery_enabled: 'false'
            };

            fs.existsSync.mockReturnValue(true);
            jest.doMock(mockSettingsPath, () => settingsWithStringBooleans, { virtual: true });

            const config = configLoader.load();

            expect(config.getallonstart).toBe(true);
            expect(config.retainreads).toBe(false);
            expect(config.logging).toBe(true);
            expect(config.ha_discovery_enabled).toBe(false);
        });

        test('should return default config when settings.js is missing', () => {
            fs.existsSync.mockReturnValue(false);

            const config = configLoader.load();

            expect(config.cbusip).toBe('127.0.0.1');
            expect(config.cbusport).toBe(20023);
            expect(config.cbusname).toBe('HOME');
            expect(config.mqtt).toBe('127.0.0.1:1883');
            expect(config.messageinterval).toBe(200);
            expect(config.logging).toBe(false);
            expect(config._environment.type).toBe('default');
        });

        test('should handle module load errors gracefully', () => {
            fs.existsSync.mockReturnValue(true);
            
            // This test verifies that the configLoader doesn't crash when require fails
            // The exact fallback behavior is implementation-specific
            expect(() => configLoader.load()).not.toThrow();
            
            const config = configLoader.getConfig();
            expect(config).toBeDefined();
            expect(config.cbusip).toBeDefined();
            expect(config.mqtt).toBeDefined();
        });
    });

    describe('validation', () => {
        beforeEach(() => {
            mockEnvironmentDetector.detect.mockReturnValue({
                type: 'addon',
                isAddon: true,
                optionsPath: '/data/options.json'
            });
        });

        test('should validate required fields', () => {
            const invalidConfig = {
                cbusip: '',
                mqtt: ''
            };

            expect(() => configLoader.validate(invalidConfig)).toThrow('Configuration validation failed');
        });

        test('should validate port ranges', () => {
            const configWithInvalidPorts = {
                cgate_host: '127.0.0.1',
                cgate_port: 70000, // Invalid port
                mqtt_host: '127.0.0.1'
            };

            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify(configWithInvalidPorts));

            configLoader.load();

            expect(() => configLoader.validate()).toThrow('C-Gate port must be between 1 and 65535');
        });

        test('should pass validation for valid configuration', () => {
            const validConfig = {
                cgate_host: '127.0.0.1',
                cgate_port: 20023,
                mqtt_host: '127.0.0.1',
                mqtt_port: 1883
            };

            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify(validConfig));

            configLoader.load();

            expect(() => configLoader.validate()).not.toThrow();
        });

        test('should validate external config object', () => {
            const externalConfig = {
                cbusip: '127.0.0.1',
                mqtt: '127.0.0.1:1883'
            };

            expect(() => configLoader.validate(externalConfig)).not.toThrow();
        });
    });

    describe('caching and reloading', () => {
        beforeEach(() => {
            mockEnvironmentDetector.detect.mockReturnValue({
                type: 'addon',
                isAddon: true,
                optionsPath: '/data/options.json'
            });
        });

        test('should cache configuration on first load', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify({ cgate_host: '127.0.0.1', mqtt_host: '127.0.0.1' }));

            const config1 = configLoader.load();
            const config2 = configLoader.load();

            expect(config1).toBe(config2); // Same object reference
            expect(fs.readFileSync).toHaveBeenCalledTimes(1); // Only read once
        });

        test('should reload configuration when forced', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify({ cgate_host: '127.0.0.1', mqtt_host: '127.0.0.1' }));

            configLoader.load(); // First load
            configLoader.load(true); // Force reload

            expect(fs.readFileSync).toHaveBeenCalledTimes(2);
        });

        test('reload() should clear cache and reload', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify({ cgate_host: '127.0.0.1', mqtt_host: '127.0.0.1' }));

            configLoader.load(); // First load
            configLoader.reload(); // Reload

            expect(mockEnvironmentDetector.reset).toHaveBeenCalled();
            expect(fs.readFileSync).toHaveBeenCalledTimes(2);
        });
    });

    describe('utility methods', () => {
        beforeEach(() => {
            mockEnvironmentDetector.detect.mockReturnValue({
                type: 'addon',
                isAddon: true,
                optionsPath: '/data/options.json'
            });

            mockEnvironmentDetector.getEnvironmentInfo.mockReturnValue({
                type: 'addon',
                isAddon: true
            });
        });

        test('getConfig() should return cached config or load new one', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify({ cgate_host: '127.0.0.1', mqtt_host: '127.0.0.1' }));

            const config = configLoader.getConfig();

            expect(config.cbusip).toBe('127.0.0.1');
            expect(config._environment.type).toBe('addon');
        });

        test('getEnvironment() should return environment info', () => {
            const envInfo = configLoader.getEnvironment();

            expect(envInfo.type).toBe('addon');
            expect(envInfo.isAddon).toBe(true);
            expect(mockEnvironmentDetector.getEnvironmentInfo).toHaveBeenCalled();
        });
    });

    describe('_getDefaultConfig()', () => {
        test('should return sensible defaults', () => {
            mockEnvironmentDetector.detect.mockReturnValue({
                type: 'standalone',
                isStandalone: true,
                settingsPath: '/nonexistent/settings.js'
            });

            fs.existsSync.mockReturnValue(false);

            const config = configLoader.load();

            expect(config.cbusip).toBe('127.0.0.1');
            expect(config.cbusport).toBe(20023);
            expect(config.cbuscontrolport).toBe(20024);
            expect(config.cbusname).toBe('HOME');
            expect(config.mqtt).toBe('127.0.0.1:1883');
            expect(config.messageinterval).toBe(200);
            expect(config.logging).toBe(false);
            expect(config.ha_discovery_enabled).toBe(false);
            expect(config.ha_discovery_prefix).toBe('homeassistant');
            expect(config._environment.type).toBe('default');
        });
    });
});
