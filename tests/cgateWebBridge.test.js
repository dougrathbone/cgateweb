// tests/cgateWebBridge.test.js - Tests for CgateWebBridge constructor and validation

const CgateWebBridge = require('../src/cgateWebBridge');
const { defaultSettings } = require('../index.js');
const EventEmitter = require('events');

// --- Mock mqtt Module ---
const mockMqttClient = new EventEmitter(); 
mockMqttClient.connect = jest.fn(); 
mockMqttClient.subscribe = jest.fn((topic, options, callback) => callback ? callback(null) : null);
mockMqttClient.publish = jest.fn();
mockMqttClient.end = jest.fn();
mockMqttClient.removeAllListeners = jest.fn();
mockMqttClient.on = jest.fn(); 
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
    let lastMockCmdSocket, lastMockEvtSocket;
    let exitSpy;

    beforeEach(() => {
        // Reset MQTT mocks
        mockMqttClient.removeAllListeners.mockClear();
        mockMqttClient.subscribe.mockClear();
        mockMqttClient.publish.mockClear();
        mockMqttClient.end.mockClear();
        mockMqttClient.on.mockClear();
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
        lastMockCmdSocket = null;
        lastMockEvtSocket = null;
        mockCmdSocketFactory = jest.fn(() => {
            const socket = new EventEmitter();
            socket.connect = jest.fn();
            socket.write = jest.fn();
            socket.destroy = jest.fn();
            socket.removeAllListeners = jest.fn();
            socket.on = jest.fn(); 
            socket.connecting = false; 
            socket.destroyed = false;  
            lastMockCmdSocket = socket; 
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
            lastMockEvtSocket = socket; 
            return socket;
        });
        
        // Create bridge instance using the mock settings and factories
        bridge = new CgateWebBridge(
            mockSettings,
            null, 
            mockCmdSocketFactory, 
            mockEvtSocketFactory
        );
        
        // Mock process.exit needed for constructor validation test
        exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
            throw new Error(`process.exit called with code ${code}`);
        });
    });

    afterEach(() => {
        jest.clearAllTimers();
        mockConsoleWarn.mockClear();
        mockConsoleError.mockClear();
        if(exitSpy) exitSpy.mockRestore();
    });

    describe('Constructor & Initial State', () => {
        it('should initialize with correct default settings when passed empty object', () => {
            const bridgeWithDefaults = new CgateWebBridge({});
            expect(bridgeWithDefaults.settings.mqtt).toBe(defaultSettings.mqtt);
            expect(bridgeWithDefaults.settings.cbusip).toBe(defaultSettings.cbusip);
            expect(bridgeWithDefaults.settings.messageinterval).toBe(defaultSettings.messageinterval);
            expect(bridgeWithDefaults.settings.retainreads).toBe(defaultSettings.retainreads);
            expect(bridgeWithDefaults.mqttPublishQueue).toBeDefined();
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

        it('should initialize allConnected flag to false', () => {
            expect(bridge.allConnected).toBe(false);
        });

        it('should initialize underlying connection managers properly', () => {
            expect(bridge.mqttManager).toBeDefined();
            expect(bridge.commandConnection).toBeDefined();
            expect(bridge.eventConnection).toBeDefined();
            expect(bridge.mqttManager.connected).toBe(false);
            expect(bridge.commandConnection.connected).toBe(false);
            expect(bridge.eventConnection.connected).toBe(false);
        });


        it('should initialize buffers to empty', () => {
            expect(bridge.commandBufferParser.getBuffer()).toBe('');
            expect(bridge.eventBufferParser.getBuffer()).toBe('');
        });

        it('should initialize haDiscovery with proper state', () => {
            expect(bridge.haDiscovery).toBeDefined();
            expect(bridge.haDiscovery.treeBuffer).toBe('');
            expect(bridge.haDiscovery.treeNetwork).toBeNull();
        });

        it('should initialize queues', () => {
            expect(bridge.cgateCommandQueue).toBeDefined();
            expect(bridge.cgateCommandQueue.constructor.name).toBe('ThrottledQueue');
            expect(bridge.mqttPublishQueue).toBeDefined();
            expect(bridge.mqttPublishQueue.constructor.name).toBe('ThrottledQueue');
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

    describe('_validateSettings', () => {
        let errorSpy;
        let warnSpy;

        beforeEach(() => {
            errorSpy = jest.spyOn(bridge, 'error');
            warnSpy = jest.spyOn(bridge, 'warn');
        });

        afterEach(() => {
            errorSpy.mockRestore();
            warnSpy.mockRestore();
        });

        it('should validate settings successfully with valid default settings', () => {
            const bridgeWithDefaults = new CgateWebBridge({ ...defaultSettings, logging: false });
            expect(bridgeWithDefaults.settingsValidator.validate(bridgeWithDefaults.settings)).toBe(true);
        });

        it('should validate settings successfully with valid user-provided settings', () => {
            expect(bridge.settingsValidator.validate(bridge.settings)).toBe(true);
        });

        it('should handle invalid settings through validator', () => {
            const invalidSettings = { ...bridge.settings, mqtt: null };
            expect(bridge.settingsValidator.validate(invalidSettings)).toBe(false);
        });

        it('constructor should exit if validation fails', () => {
            const invalidSettings = { ...defaultSettings, mqtt: null }; 
            expect(() => {
                new CgateWebBridge(invalidSettings);
            }).toThrow('process.exit called with code 1');
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
    });

    describe('_processCommandErrorResponse', () => {
        let errorSpy;
        beforeEach(() => {
            errorSpy = jest.spyOn(bridge, 'error');
        });
        afterEach(() => {
            errorSpy.mockRestore();
        });

        it('should log specific message for 400 Bad Request', () => {
            bridge._processCommandErrorResponse('400', 'Syntax error near GET');
            expect(errorSpy).toHaveBeenCalledWith('[ERROR] C-Gate Command Error 400: (Bad Request/Syntax Error) - Syntax error near GET');
        });

        it('should log specific message for 401 Unauthorized', () => {
            bridge._processCommandErrorResponse('401', 'Access denied');
            expect(errorSpy).toHaveBeenCalledWith('[ERROR] C-Gate Command Error 401: (Unauthorized - Check Credentials/Permissions) - Access denied');
        });

        it('should log specific message for 404 Not Found', () => {
            bridge._processCommandErrorResponse('404', 'Object not found');
            expect(errorSpy).toHaveBeenCalledWith('[ERROR] C-Gate Command Error 404: (Not Found - Check Object Path) - Object not found');
        });

        it('should log specific message for 406 Not Acceptable', () => {
            bridge._processCommandErrorResponse('406', 'Invalid parameter');
            expect(errorSpy).toHaveBeenCalledWith('[ERROR] C-Gate Command Error 406: (Not Acceptable - Invalid Parameter Value) - Invalid parameter');
        });

        it('should log specific message for 500 Internal Server Error', () => {
            bridge._processCommandErrorResponse('500', 'Server error');
            expect(errorSpy).toHaveBeenCalledWith('[ERROR] C-Gate Command Error 500: (Internal Server Error) - Server error');
        });

        it('should log specific message for 503 Service Unavailable', () => {
            bridge._processCommandErrorResponse('503', 'Service not available');
            expect(errorSpy).toHaveBeenCalledWith('[ERROR] C-Gate Command Error 503: (Service Unavailable) - Service not available');
        });

        it('should log generic message for other 4xx errors', () => {
            bridge._processCommandErrorResponse('498', 'Custom client error');
            expect(errorSpy).toHaveBeenCalledWith('[ERROR] C-Gate Command Error 498: - Custom client error');
        });

        it('should log generic message for other 5xx errors', () => {
            bridge._processCommandErrorResponse('598', 'Custom server error');
            expect(errorSpy).toHaveBeenCalledWith('[ERROR] C-Gate Command Error 598: - Custom server error');
        });

        it('should handle missing statusData correctly for specific codes', () => {
            bridge._processCommandErrorResponse('404', '');
            expect(errorSpy).toHaveBeenCalledWith('[ERROR] C-Gate Command Error 404: (Not Found - Check Object Path) - No details provided');
        });

        it('should handle missing statusData correctly for generic codes', () => {
            bridge._processCommandErrorResponse('498', null);
            expect(errorSpy).toHaveBeenCalledWith('[ERROR] C-Gate Command Error 498: - No details provided');
        });
    });
});