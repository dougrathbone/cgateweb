const ORIGINAL_ENV = { ...process.env };

function loadIndexWithMocks({
    loadedConfig = { cbusip: '10.0.0.10', mqtt: 'broker:1883', _environment: { type: 'standalone' } },
    loadError = null,
    envInfo = { type: 'standalone', isAddon: false },
    haConfig = { isAddon: false, optimizationsApplied: [], ingressConfig: null },
    autoDetectError = null,
    validateImpl = null
} = {}) {
    let indexModule;
    let bridgeInstance;
    let mockBridgeClass;
    let mockConfigLoaderInstance;

    jest.isolateModules(() => {
        bridgeInstance = {
            start: jest.fn().mockResolvedValue(undefined),
            stop: jest.fn().mockResolvedValue(undefined),
            reloadSettings: jest.fn(),
            _getBridgeStatus: jest.fn(() => ({ lifecycle: { state: 'ready' } }))
        };

        jest.doMock('../src/cgateWebBridge', () => {
            mockBridgeClass = jest.fn(() => bridgeInstance);
            return mockBridgeClass;
        });

        jest.doMock('../src/config/ConfigLoader', () => {
            return jest.fn(() => {
                mockConfigLoaderInstance = {
                    load: jest.fn(() => {
                        if (loadError) throw loadError;
                        return loadedConfig;
                    }),
                    getEnvironment: jest.fn(() => envInfo),
                    applyMqttAutoDetection: jest.fn(async () => {
                        if (autoDetectError) throw autoDetectError;
                    }),
                    validate: validateImpl ? jest.fn(validateImpl) : jest.fn(),
                    getDefaultConfig: jest.fn(() => ({
                        cbusip: '127.0.0.1',
                        cbuscommandport: 20023,
                        cbuseventport: 20025,
                        cbusname: 'HOME',
                        mqtt: '127.0.0.1:1883',
                        messageinterval: 200,
                        logging: false,
                        ha_discovery_enabled: false,
                        ha_discovery_prefix: 'homeassistant',
                        _environment: { type: 'default' }
                    }))
                };
                return mockConfigLoaderInstance;
            });
        });

        jest.doMock('../src/config/HAIntegration', () => {
            return jest.fn(() => ({ initialize: jest.fn(() => haConfig) }));
        });

        indexModule = require('../index.js');
    });

    return {
        indexModule,
        bridgeInstance,
        mockBridgeClass,
        mockConfigLoaderInstance
    };
}

describe('index.js', () => {
    let _exitSpy;
    let logSpy;
    let errorSpy;

    beforeEach(() => {
        jest.resetModules();
        process.env = { ...ORIGINAL_ENV };
        delete process.env.ALLOW_DEFAULT_FALLBACK;
        delete process.env.SUPERVISOR_TOKEN;
        delete process.env.MQTT_HOST;
        delete process.env.CGATE_IP;
        delete process.env.MQTT_USERNAME;
        delete process.env.MQTT_PASSWORD;
        delete process.env.CGATE_USERNAME;
        delete process.env.CGATE_PASSWORD;
        delete process.env.CGATE_PROJECT;

        _exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
            throw new Error(`process.exit:${code}`);
        });
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
        jest.restoreAllMocks();
    });

    it('exports main and default settings', () => {
        const { indexModule } = loadIndexWithMocks();
        expect(typeof indexModule.main).toBe('function');
        expect(indexModule.defaultSettings).toBeDefined();
        expect(indexModule.defaultSettings.mqtt).toBe('localhost:1883');
    });

    it('starts bridge and validates settings in main()', async () => {
        const {
            indexModule,
            bridgeInstance,
            mockBridgeClass,
            mockConfigLoaderInstance
        } = loadIndexWithMocks();

        await indexModule.main();

        expect(mockConfigLoaderInstance.validate).toHaveBeenCalled();
        expect(mockBridgeClass).toHaveBeenCalledTimes(1);
        expect(bridgeInstance.start).toHaveBeenCalledTimes(1);
    });

    it('applies environment overrides to startup settings', async () => {
        process.env.MQTT_HOST = 'env-broker:1883';
        process.env.CGATE_IP = '10.0.0.99';
        process.env.MQTT_USERNAME = 'env-user';
        process.env.MQTT_PASSWORD = 'env-pass';

        const { indexModule, mockBridgeClass } = loadIndexWithMocks();
        await indexModule.main();

        expect(mockBridgeClass).toHaveBeenCalledWith(expect.objectContaining({
            mqtt: 'env-broker:1883',
            cbusip: '10.0.0.99',
            mqttusername: 'env-user',
            mqttpassword: 'env-pass'
        }));
    });

    it('auto-detects MQTT credentials in addon mode', async () => {
        const {
            indexModule,
            mockConfigLoaderInstance
        } = loadIndexWithMocks({
            envInfo: { type: 'addon', isAddon: true },
            haConfig: { isAddon: true, optimizationsApplied: ['ingress'], ingressConfig: null }
        });

        await indexModule.main();
        expect(mockConfigLoaderInstance.applyMqttAutoDetection).toHaveBeenCalledTimes(1);
    });

    it('continues startup when MQTT auto-detection fails', async () => {
        const {
            indexModule,
            bridgeInstance
        } = loadIndexWithMocks({
            envInfo: { type: 'addon', isAddon: true },
            autoDetectError: new Error('supervisor unavailable')
        });

        await indexModule.main();
        expect(bridgeInstance.start).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledWith('[WARN] MQTT auto-detection failed:', 'supervisor unavailable');
    });

    it('exits on standalone config load failure by default', () => {
        expect(() => {
            loadIndexWithMocks({
                loadError: new Error('settings parse error'),
                envInfo: { type: 'standalone', isAddon: false }
            });
        }).toThrow('process.exit:1');

        expect(errorSpy).toHaveBeenCalledWith('[ERROR] Standalone startup aborted due to invalid configuration.');
    });

    it('allows standalone fallback when ALLOW_DEFAULT_FALLBACK is true', async () => {
        process.env.ALLOW_DEFAULT_FALLBACK = 'true';

        const {
            indexModule,
            bridgeInstance
        } = loadIndexWithMocks({
            loadError: new Error('settings parse error'),
            envInfo: { type: 'standalone', isAddon: false }
        });

        await indexModule.main();
        expect(bridgeInstance.start).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledWith('[WARN] ALLOW_DEFAULT_FALLBACK=true set; using safe fallback settings only');
    });

    it('uses safe fallback values before validation when standalone fallback is enabled', async () => {
        process.env.ALLOW_DEFAULT_FALLBACK = 'true';

        const {
            indexModule,
            mockConfigLoaderInstance
        } = loadIndexWithMocks({
            loadError: new Error('settings parse error'),
            envInfo: { type: 'standalone', isAddon: false },
            validateImpl: (config) => {
                if (config.cbusip === 'your-cgate-ip') {
                    throw new Error('Configuration validation failed: C-Gate IP address (cbusip) is required');
                }
            }
        });

        await expect(indexModule.main()).resolves.toBeUndefined();
        expect(mockConfigLoaderInstance.validate).toHaveBeenCalledWith(expect.objectContaining({
            cbusip: '127.0.0.1',
            mqtt: '127.0.0.1:1883'
        }));
    });

    it('exits on addon config load failure', () => {
        process.env.SUPERVISOR_TOKEN = 'token';

        expect(() => {
            loadIndexWithMocks({
                loadError: new Error('addon options missing'),
                envInfo: { type: 'addon', isAddon: true }
            });
        }).toThrow('process.exit:1');

        expect(errorSpy).toHaveBeenCalledWith('[ERROR] Please check the addon configuration and restart.');
    });

    it('registers expected process signal handlers', async () => {
        const processOnSpy = jest.spyOn(process, 'on');
        const { indexModule } = loadIndexWithMocks();

        await indexModule.main();

        expect(processOnSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
        expect(processOnSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
        expect(processOnSpy).toHaveBeenCalledWith('SIGUSR1', expect.any(Function));
        expect(processOnSpy).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
        expect(processOnSpy).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
    });

    it('SIGTERM handler calls bridge.stop and exits', async () => {
        const processOnSpy = jest.spyOn(process, 'on');
        const { indexModule, bridgeInstance } = loadIndexWithMocks();

        await indexModule.main();

        const sigtermHandler = processOnSpy.mock.calls.find(c => c[0] === 'SIGTERM')[1];
        expect(() => sigtermHandler()).toThrow('process.exit:0');
        expect(bridgeInstance.stop).toHaveBeenCalled();
    });

    it('SIGUSR1 handler reloads configuration', async () => {
        const processOnSpy = jest.spyOn(process, 'on');
        const { indexModule } = loadIndexWithMocks();

        await indexModule.main();

        const sigusr1Handler = processOnSpy.mock.calls.find(c => c[0] === 'SIGUSR1')[1];
        sigusr1Handler();
        expect(logSpy).toHaveBeenCalledWith('[INFO] Configuration reloaded successfully');
    });

    it('SIGUSR1 handler logs error on reload failure', async () => {
        const processOnSpy = jest.spyOn(process, 'on');
        const { indexModule, mockConfigLoaderInstance } = loadIndexWithMocks();

        await indexModule.main();

        // Make load throw on second call (reload)
        mockConfigLoaderInstance.load.mockImplementation(() => {
            throw new Error('bad config');
        });

        const sigusr1Handler = processOnSpy.mock.calls.find(c => c[0] === 'SIGUSR1')[1];
        sigusr1Handler();
        expect(errorSpy).toHaveBeenCalledWith('[ERROR] Failed to reload configuration: bad config');
    });

    it('uncaughtException handler stops bridge and exits', async () => {
        const processOnSpy = jest.spyOn(process, 'on');
        const { indexModule, bridgeInstance } = loadIndexWithMocks();

        await indexModule.main();

        const handler = processOnSpy.mock.calls.find(c => c[0] === 'uncaughtException')[1];
        expect(() => handler(new Error('boom'))).toThrow('process.exit:1');
        expect(bridgeInstance.stop).toHaveBeenCalled();
    });

    it('bridge.start failure logs error and exits', async () => {
        const { indexModule, bridgeInstance } = loadIndexWithMocks();
        bridgeInstance.start.mockRejectedValue(new Error('connection refused'));

        await expect(indexModule.main()).rejects.toThrow('process.exit:1');
        expect(errorSpy).toHaveBeenCalledWith('[ERROR] Failed to start bridge:', expect.any(Error));
    });

    it('logs ingress config when running as addon', () => {
        loadIndexWithMocks({
            envInfo: { type: 'addon', isAddon: true },
            haConfig: {
                isAddon: true,
                optimizationsApplied: ['ingress'],
                ingressConfig: { ingressUrl: '/api/hassio_ingress/abc123' }
            }
        });

        expect(logSpy).toHaveBeenCalledWith(
            '[INFO] Ingress configured: /api/hassio_ingress/abc123'
        );
    });

    it('does not auto-start when imported as a module', () => {
        const originalRequireMain = require.main;
        require.main = { filename: '/tmp/another-module.js' };
        loadIndexWithMocks();

        expect(logSpy).not.toHaveBeenCalledWith('[INFO] Starting cgateweb...');
        require.main = originalRequireMain;
    });
});