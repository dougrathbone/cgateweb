const fs = require('fs');
const path = require('path');
const ConfigLoader = require('../../src/config/ConfigLoader');
const EnvironmentDetector = require('../../src/config/EnvironmentDetector');

jest.mock('fs');
jest.mock('../../src/config/EnvironmentDetector');

describe('ConfigLoader', () => {
    let configLoader;
    let mockEnvironmentDetector;

    beforeEach(() => {
        jest.clearAllMocks();
        
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
            cgate_mode: 'remote',
            cgate_host: '192.168.1.100',
            cgate_port: 20023,
            cgate_event_port: 20025,
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

            expect(config.cgate_mode).toBe('remote');
            expect(config.cbusip).toBe('192.168.1.100');
            expect(config.cbuscommandport).toBe(20023);
            expect(config.cbuseventport).toBe(20025);
            expect(config.cbusname).toBe('MyHome');
            expect(config.mqtt).toBe('192.168.1.50:1883');
            expect(config.mqttusername).toBe('testuser');
            expect(config.mqttpassword).toBe('testpass');
            expect(config.getallnetapp).toBe('254/56');
            expect(config.getallonstart).toBe(true);
            expect(config.getallperiod).toBe(3600);
            expect(config.retainreads).toBe(true);
            expect(config.messageinterval).toBe(150);
            expect(config.log_level).toBe('debug');
            expect(config.logging).toBe(true);
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
            expect(config.cbuscommandport).toBe(20023);
            expect(config.cbuseventport).toBe(20025);
            expect(config.cbusname).toBe('HOME');
            expect(config.mqtt).toBe('127.0.0.1:1883');
            expect(config.messageinterval).toBe(200);
            expect(config.log_level).toBe('info');
            expect(config.logging).toBe(true);
            expect(config.cgate_mode).toBe('remote');
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

        test('should force cbusip to 127.0.0.1 in managed mode', () => {
            const managedOptions = {
                ...mockAddonOptions,
                cgate_mode: 'managed',
                cgate_host: '192.168.1.100'
            };

            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify(managedOptions));

            const config = configLoader.load();

            expect(config.cgate_mode).toBe('managed');
            expect(config.cbusip).toBe('127.0.0.1');
            expect(config.cgate_install_source).toBe('download');
        });

        test('should include managed mode settings when mode is managed', () => {
            const managedOptions = {
                ...mockAddonOptions,
                cgate_mode: 'managed',
                cgate_install_source: 'upload',
                cgate_download_url: 'https://example.com/cgate.zip'
            };

            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify(managedOptions));

            const config = configLoader.load();

            expect(config.cgate_mode).toBe('managed');
            expect(config.cgate_install_source).toBe('upload');
            expect(config.cgate_download_url).toBe('https://example.com/cgate.zip');
        });

        test('should not include managed mode settings when mode is remote', () => {
            const remoteOptions = {
                ...mockAddonOptions,
                cgate_mode: 'remote'
            };

            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify(remoteOptions));

            const config = configLoader.load();

            expect(config.cgate_mode).toBe('remote');
            expect(config.cgate_install_source).toBeUndefined();
            expect(config.cgate_download_url).toBeUndefined();
        });

        test('should enable logging when log_level is info', () => {
            const infoLevelOptions = {
                ...mockAddonOptions,
                log_level: 'info'
            };

            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify(infoLevelOptions));

            const config = configLoader.load();

            expect(config.log_level).toBe('info');
            expect(config.logging).toBe(true);
        });

        test('should disable logging when log_level is warn', () => {
            const warnLevelOptions = {
                ...mockAddonOptions,
                log_level: 'warn'
            };

            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify(warnLevelOptions));

            const config = configLoader.load();

            expect(config.log_level).toBe('warn');
            expect(config.logging).toBe(false);
        });

        test('should pass through log_level to config for all valid levels', () => {
            const levels = ['error', 'warn', 'info', 'debug', 'trace'];
            const expectedLogging = { error: false, warn: false, info: true, debug: true, trace: true };

            for (const level of levels) {
                const opts = { ...mockAddonOptions, log_level: level };
                fs.existsSync.mockReturnValue(true);
                fs.readFileSync.mockReturnValue(JSON.stringify(opts));

                configLoader._cachedConfig = null;
                const config = configLoader.load();

                expect(config.log_level).toBe(level);
                expect(config.logging).toBe(expectedLogging[level]);
            }
        });

        test('should default log_level to info for invalid values', () => {
            const opts = { ...mockAddonOptions, log_level: 'invalid' };
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify(opts));

            const config = configLoader.load();

            expect(config.log_level).toBe('info');
            expect(config.logging).toBe(true);
        });

        test('should set cbusip to empty string when cgate_host is empty in remote mode', () => {
            const optionsWithEmptyHost = {
                cgate_mode: 'remote',
                cgate_host: '',
                mqtt_host: '127.0.0.1'
            };

            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify(optionsWithEmptyHost));

            const config = configLoader.load();

            expect(config.cbusip).toBe('');
        });

        test('should set cbusip to empty string when cgate_host is missing in remote mode', () => {
            const optionsNoHost = {
                cgate_mode: 'remote',
                mqtt_host: '127.0.0.1'
            };

            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify(optionsNoHost));

            const config = configLoader.load();

            expect(config.cbusip).toBe('');
        });

        test('should use core-mosquitto as default MQTT host for addon', () => {
            const optionsNoMqtt = {
                cgate_host: '192.168.1.100'
            };

            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify(optionsNoMqtt));

            const config = configLoader.load();

            expect(config.mqtt).toBe('core-mosquitto:1883');
        });
    });

    describe('load() - Standalone Configuration', () => {
        const mockSettingsPath = path.join(process.cwd(), 'settings.js');
        const mockSettings = {
            cbusip: '10.0.0.1',
            cbuscommandport: 20023,
            cbuseventport: 20025,
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
            
            const mockResolve = jest.fn().mockReturnValue(mockSettingsPath);
            require.resolve = mockResolve;
            require.cache = { [mockSettingsPath]: { exports: mockSettings } };
            
            jest.doMock(mockSettingsPath, () => mockSettings, { virtual: true });

            const config = configLoader.load();

            expect(config.cbusip).toBe('10.0.0.1');
            expect(config.cbuscommandport).toBe(20023);
            expect(config.cbuseventport).toBe(20025);
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
            expect(config.cbuscommandport).toBe(20023);
            expect(config.cbuseventport).toBe(20025);
            expect(config.cbusname).toBe('HOME');
            expect(config.mqtt).toBe('127.0.0.1:1883');
            expect(config.messageinterval).toBe(200);
            expect(config.logging).toBe(false);
            expect(config._environment.type).toBe('default');
        });

        test('should handle module load errors gracefully', () => {
            fs.existsSync.mockReturnValue(true);
            
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

        test('should reject placeholder cbusip values', () => {
            const placeholders = ['your-cgate-ip', 'your.cgate.ip', 'x.x.x.x'];

            for (const placeholder of placeholders) {
                const config = {
                    cbusip: placeholder,
                    mqtt: '127.0.0.1:1883'
                };

                expect(() => configLoader.validate(config)).toThrow('C-Gate IP address (cbusip) is required');
            }
        });

        test('should validate command port range', () => {
            const configWithInvalidPort = {
                cbusip: '127.0.0.1',
                mqtt: '127.0.0.1:1883',
                cbuscommandport: 70000
            };

            expect(() => configLoader.validate(configWithInvalidPort)).toThrow('C-Gate command port must be between 1 and 65535');
        });

        test('should validate event port range', () => {
            const configWithInvalidPort = {
                cbusip: '127.0.0.1',
                mqtt: '127.0.0.1:1883',
                cbuseventport: 70000
            };

            expect(() => configLoader.validate(configWithInvalidPort)).toThrow('C-Gate event port must be between 1 and 65535');
        });

        test('should pass validation for valid configuration', () => {
            const validConfig = {
                cbusip: '127.0.0.1',
                cbuscommandport: 20023,
                cbuseventport: 20025,
                mqtt: '127.0.0.1:1883'
            };

            expect(() => configLoader.validate(validConfig)).not.toThrow();
        });

        test('should validate external config object', () => {
            const externalConfig = {
                cbusip: '127.0.0.1',
                mqtt: '127.0.0.1:1883'
            };

            expect(() => configLoader.validate(externalConfig)).not.toThrow();
        });

        test('should warn about missing upload zip in managed mode', () => {
            fs.existsSync.mockImplementation((p) => p === '/share/cgate');
            fs.readdirSync.mockReturnValue([]);

            const managedConfig = {
                cbusip: '127.0.0.1',
                mqtt: '127.0.0.1:1883',
                cgate_mode: 'managed',
                cgate_install_source: 'upload'
            };

            expect(() => configLoader.validate(managedConfig)).not.toThrow();
        });
    });

    describe('detectMqttConfig', () => {
        test('should return null when no SUPERVISOR_TOKEN is set', async () => {
            delete process.env.SUPERVISOR_TOKEN;
            const result = await configLoader.detectMqttConfig();
            expect(result).toBeNull();
        });

        test('should return MQTT config from Supervisor API', async () => {
            process.env.SUPERVISOR_TOKEN = 'test-token';

            const mockResponse = {
                on: jest.fn(),
                statusCode: 200
            };
            
            const mockReq = {
                on: jest.fn(),
                setTimeout: jest.fn()
            };

            const mockHttp = {
                get: jest.fn((url, options, callback) => {
                    const res = {
                        statusCode: 200,
                        on: jest.fn((event, handler) => {
                            if (event === 'data') {
                                handler(JSON.stringify({
                                    data: {
                                        host: 'core-mosquitto',
                                        port: 1883,
                                        username: 'mqtt_user',
                                        password: 'mqtt_pass',
                                        ssl: false
                                    }
                                }));
                            }
                            if (event === 'end') {
                                handler();
                            }
                        })
                    };
                    callback(res);
                    return mockReq;
                })
            };

            const loader = new ConfigLoader({ httpGet: mockHttp });
            EnvironmentDetector.mockImplementation(() => mockEnvironmentDetector);

            const result = await loader.detectMqttConfig();

            expect(result).toEqual({
                host: 'core-mosquitto',
                port: 1883,
                username: 'mqtt_user',
                password: 'mqtt_pass',
                ssl: false
            });

            delete process.env.SUPERVISOR_TOKEN;
        });

        test('should return null on API error', async () => {
            process.env.SUPERVISOR_TOKEN = 'test-token';

            const mockReq = {
                on: jest.fn((event, handler) => {
                    if (event === 'error') {
                        handler(new Error('Connection refused'));
                    }
                }),
                setTimeout: jest.fn()
            };

            const mockHttp = {
                get: jest.fn(() => mockReq)
            };

            const loader = new ConfigLoader({ httpGet: mockHttp });
            EnvironmentDetector.mockImplementation(() => mockEnvironmentDetector);

            const result = await loader.detectMqttConfig();
            expect(result).toBeNull();

            delete process.env.SUPERVISOR_TOKEN;
        });
    });

    describe('applyMqttAutoDetection', () => {
        function createLoaderWithMockApi(apiResponse) {
            const mockReq = { on: jest.fn(), setTimeout: jest.fn() };
            const mockHttp = {
                get: jest.fn((url, options, callback) => {
                    const res = {
                        statusCode: 200,
                        on: jest.fn((event, handler) => {
                            if (event === 'data') handler(JSON.stringify(apiResponse));
                            if (event === 'end') handler();
                        })
                    };
                    callback(res);
                    return mockReq;
                })
            };
            return new ConfigLoader({ httpGet: mockHttp });
        }

        beforeEach(() => {
            process.env.SUPERVISOR_TOKEN = 'test-token';
        });

        afterEach(() => {
            delete process.env.SUPERVISOR_TOKEN;
        });

        test('should fill in missing username and password', async () => {
            const loader = createLoaderWithMockApi({
                data: { host: 'core-mosquitto', port: 1883, username: 'mqtt_user', password: 'mqtt_pass', ssl: false }
            });
            EnvironmentDetector.mockImplementation(() => mockEnvironmentDetector);

            const settings = { mqtt: 'core-mosquitto:1883' };
            await loader.applyMqttAutoDetection(settings);

            expect(settings.mqttusername).toBe('mqtt_user');
            expect(settings.mqttpassword).toBe('mqtt_pass');
        });

        test('should not overwrite explicitly configured credentials', async () => {
            const loader = createLoaderWithMockApi({
                data: { host: 'core-mosquitto', port: 1883, username: 'auto_user', password: 'auto_pass', ssl: false }
            });
            EnvironmentDetector.mockImplementation(() => mockEnvironmentDetector);

            const settings = { mqtt: 'core-mosquitto:1883', mqttusername: 'manual_user', mqttpassword: 'manual_pass' };
            await loader.applyMqttAutoDetection(settings);

            expect(settings.mqttusername).toBe('manual_user');
            expect(settings.mqttpassword).toBe('manual_pass');
        });

        test('should update mqtt host when set to default', async () => {
            const loader = createLoaderWithMockApi({
                data: { host: '10.0.0.5', port: 1884, username: 'u', password: 'p', ssl: false }
            });
            EnvironmentDetector.mockImplementation(() => mockEnvironmentDetector);

            const settings = { mqtt: 'core-mosquitto:1883' };
            await loader.applyMqttAutoDetection(settings);

            expect(settings.mqtt).toBe('10.0.0.5:1884');
        });

        test('should not change mqtt host when explicitly configured', async () => {
            const loader = createLoaderWithMockApi({
                data: { host: 'core-mosquitto', port: 1883, username: 'u', password: 'p', ssl: false }
            });
            EnvironmentDetector.mockImplementation(() => mockEnvironmentDetector);

            const settings = { mqtt: 'my-broker.local:1883' };
            await loader.applyMqttAutoDetection(settings);

            expect(settings.mqtt).toBe('my-broker.local:1883');
        });

        test('should apply mqtt broker when settings.mqtt is undefined', async () => {
            const loader = createLoaderWithMockApi({
                data: { host: 'core-mosquitto', port: 1883, username: 'u', password: 'p', ssl: false }
            });
            EnvironmentDetector.mockImplementation(() => mockEnvironmentDetector);

            const settings = {};
            await loader.applyMqttAutoDetection(settings);

            expect(settings.mqtt).toBe('core-mosquitto:1883');
            expect(settings.mqttusername).toBe('u');
            expect(settings.mqttpassword).toBe('p');
        });

        test('should apply mqtt broker when settings.mqtt is empty string', async () => {
            const loader = createLoaderWithMockApi({
                data: { host: 'core-mosquitto', port: 1883, username: 'u', password: 'p', ssl: false }
            });
            EnvironmentDetector.mockImplementation(() => mockEnvironmentDetector);

            const settings = { mqtt: '' };
            await loader.applyMqttAutoDetection(settings);

            expect(settings.mqtt).toBe('core-mosquitto:1883');
        });

        test('should return settings unchanged when no SUPERVISOR_TOKEN', async () => {
            delete process.env.SUPERVISOR_TOKEN;
            const loader = new ConfigLoader();
            EnvironmentDetector.mockImplementation(() => mockEnvironmentDetector);

            const settings = { mqtt: '127.0.0.1:1883' };
            const result = await loader.applyMqttAutoDetection(settings);

            expect(result).toBe(settings);
            expect(settings.mqttusername).toBeUndefined();
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

            expect(config1).toBe(config2);
            expect(fs.readFileSync).toHaveBeenCalledTimes(1);
        });

        test('should reload configuration when forced', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify({ cgate_host: '127.0.0.1', mqtt_host: '127.0.0.1' }));

            configLoader.load();
            configLoader.load(true);

            expect(fs.readFileSync).toHaveBeenCalledTimes(2);
        });

        test('reload() should clear cache and reload', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify({ cgate_host: '127.0.0.1', mqtt_host: '127.0.0.1' }));

            configLoader.load();
            configLoader.reload();

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
            expect(config.cbuscommandport).toBe(20023);
            expect(config.cbuseventport).toBe(20025);
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
