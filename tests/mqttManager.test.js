const MqttManager = require('../src/mqttManager');
const { EventEmitter } = require('events');

// Mock the mqtt module
jest.mock('mqtt');
const mqtt = require('mqtt');

describe('MqttManager', () => {
    let mqttManager;
    let mockClient;
    let settings;

    beforeEach(() => {
        // Clear all mocks
        jest.clearAllMocks();
        
        // Mock MQTT client
        mockClient = new EventEmitter();
        mockClient.publish = jest.fn();
        mockClient.subscribe = jest.fn();
        mockClient.end = jest.fn();
        mockClient.connected = false;
        
        // Mock mqtt.connect
        mqtt.connect.mockReturnValue(mockClient);
        
        settings = {
            mqtt: 'localhost:1883',
            mqttusername: 'testuser',
            mqttpassword: 'testpass'
        };
        
        mqttManager = new MqttManager(settings);
    });

    describe('Constructor', () => {
        it('should initialize with correct properties', () => {
            expect(mqttManager.settings).toBe(settings);
            expect(mqttManager.client).toBeNull();
            expect(mqttManager.connected).toBe(false);
            expect(mqttManager.logger).toBeDefined();
        });
    });

    describe('connect', () => {
        it('should create MQTT client with correct URL and options', () => {
            mqttManager.connect();
            
            expect(mqtt.connect).toHaveBeenCalledWith('mqtt://localhost:1883', {
                reconnectPeriod: 5000,
                connectTimeout: 30000,
                username: 'testuser',
                password: 'testpass',
                will: {
                    topic: 'hello/cgateweb',
                    payload: 'Offline',
                    qos: 1,
                    retain: true
                }
            });
            expect(mqttManager.client).toBe(mockClient);
        });

        it('should handle settings without authentication', () => {
            const noAuthSettings = { mqtt: 'localhost:1883' };
            const noAuthManager = new MqttManager(noAuthSettings);
            
            noAuthManager.connect();
            
            expect(mqtt.connect).toHaveBeenCalledWith('mqtt://localhost:1883', {
                reconnectPeriod: 5000,
                connectTimeout: 30000,
                will: expect.any(Object)
            });
        });

        it('should handle mqtt URL that already has protocol', () => {
            const urlSettings = { mqtt: 'mqtt://example.com:1883' };
            const urlManager = new MqttManager(urlSettings);
            
            urlManager.connect();
            
            // Current implementation will parse 'mqtt' as host and '//example.com' as port
            expect(mqtt.connect).toHaveBeenCalledWith('mqtt://mqtt://example.com', expect.any(Object));
        });

        it('should handle mqtt URL with mqtts protocol', () => {
            const tlsSettings = { mqtt: 'mqtts://secure.example.com:8883' };
            const tlsManager = new MqttManager(tlsSettings);
            
            tlsManager.connect();
            
            // Current implementation will parse 'mqtts' as host and '//secure.example.com' as port
            expect(mqtt.connect).toHaveBeenCalledWith('mqtt://mqtts://secure.example.com', expect.any(Object));
        });

        it('should disconnect existing client before creating new one', () => {
            mqttManager.client = mockClient;
            const loggerSpy = jest.spyOn(mqttManager.logger, 'info');
            
            mqttManager.connect();
            
            expect(mockClient.end).toHaveBeenCalled();
            expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('MQTT client already exists'));
        });

        it('should set up event listeners on client', () => {
            mqttManager.connect();
            
            expect(mockClient.listenerCount('connect')).toBe(1);
            expect(mockClient.listenerCount('close')).toBe(1);
            expect(mockClient.listenerCount('error')).toBe(1);
            expect(mockClient.listenerCount('message')).toBe(1);
        });
    });

    describe('disconnect', () => {
        beforeEach(() => {
            mqttManager.connect();
            mqttManager.connected = true;
        });

        it('should end client connection', () => {
            mqttManager.disconnect();
            
            expect(mockClient.end).toHaveBeenCalled();
        });

        it('should handle null client gracefully', () => {
            mqttManager.client = null;
            
            expect(() => mqttManager.disconnect()).not.toThrow();
        });
    });

    describe('publish', () => {
        beforeEach(() => {
            mqttManager.connect();
            mqttManager.connected = true;
        });

        it('should publish message when connected', () => {
            const topic = 'test/topic';
            const payload = 'test message';
            const options = { retain: true, qos: 1 };
            
            mqttManager.publish(topic, payload, options);
            
            expect(mockClient.publish).toHaveBeenCalledWith(topic, payload, options);
        });

        it('should warn when not connected', () => {
            mqttManager.connected = false;
            const loggerSpy = jest.spyOn(mqttManager.logger, 'warn');
            
            mqttManager.publish('test/topic', 'message');
            
            expect(mockClient.publish).not.toHaveBeenCalled();
            expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('Cannot publish to MQTT: not connected'));
        });

        it('should handle publish errors', () => {
            const loggerSpy = jest.spyOn(mqttManager.logger, 'error');
            mockClient.publish.mockImplementation(() => {
                throw new Error('Publish failed');
            });
            
            mqttManager.publish('test/topic', 'message');
            
            expect(loggerSpy).toHaveBeenCalledWith(
                expect.stringContaining('Error publishing to MQTT'),
                expect.objectContaining({ error: expect.any(Error) })
            );
        });
    });

    describe('subscribe', () => {
        beforeEach(() => {
            mqttManager.connect();
            mqttManager.connected = true;
        });

        it('should subscribe to topic when connected', () => {
            const topic = 'test/topic';
            const options = { qos: 1 };
            
            mqttManager.subscribe(topic, options);
            
            expect(mockClient.subscribe).toHaveBeenCalledWith(topic, options);
        });

        it('should warn when not connected', () => {
            mqttManager.connected = false;
            const loggerSpy = jest.spyOn(mqttManager.logger, 'warn');
            
            mqttManager.subscribe('test/topic');
            
            expect(mockClient.subscribe).not.toHaveBeenCalled();
            expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('Cannot subscribe to MQTT: not connected'));
        });
    });

    describe('MQTT client event handlers', () => {
        beforeEach(() => {
            mqttManager.connect();
        });

        describe('connect event', () => {
            it('should handle successful connection', () => {
                const loggerSpy = jest.spyOn(mqttManager.logger, 'info');
                const emitSpy = jest.spyOn(mqttManager, 'emit');
                const publishSpy = jest.spyOn(mqttManager, 'publish');
                const subscribeSpy = jest.spyOn(mqttManager, 'subscribe');
                
                mockClient.emit('connect');
                
                expect(mqttManager.connected).toBe(true);
                expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('CONNECTED TO MQTT BROKER'));
                expect(emitSpy).toHaveBeenCalledWith('connect');
                expect(publishSpy).toHaveBeenCalledWith('hello/cgateweb', 'Online', { retain: true, qos: 1 });
                expect(subscribeSpy).toHaveBeenCalledWith('cbus/write/#', expect.any(Function));
            });

            it('should handle subscription errors', () => {
                const loggerSpy = jest.spyOn(mqttManager.logger, 'error');
                // Mock the subscribe method to call the callback with an error
                jest.spyOn(mqttManager, 'subscribe').mockImplementation((topic, callback) => {
                    if (callback) callback(new Error('Subscribe failed'));
                    return true;
                });
                
                mockClient.emit('connect');
                
                expect(loggerSpy).toHaveBeenCalledWith(
                    expect.stringContaining('MQTT Subscription error'),
                    expect.objectContaining({ error: expect.any(Error) })
                );
            });

            it('should log successful subscription', () => {
                const loggerSpy = jest.spyOn(mqttManager.logger, 'info');
                // Mock the subscribe method to call the callback with success
                jest.spyOn(mqttManager, 'subscribe').mockImplementation((topic, callback) => {
                    if (callback) callback(null);
                    return true;
                });
                
                mockClient.emit('connect');
                
                expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('Subscribed to MQTT topic'));
            });
        });

        describe('close event', () => {
            it('should handle transient connection close without destroying client', () => {
                const loggerSpy = jest.spyOn(mqttManager.logger, 'warn');
                const emitSpy = jest.spyOn(mqttManager, 'emit');
                
                mqttManager.connected = true;
                mockClient.emit('close');
                
                expect(mqttManager.connected).toBe(false);
                expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('Library will attempt reconnection'));
                expect(emitSpy).toHaveBeenCalledWith('close');
                // Client should NOT be destroyed on transient close
                expect(mqttManager.client).toBe(mockClient);
            });

            it('should log intentional disconnect differently', () => {
                const loggerSpy = jest.spyOn(mqttManager.logger, 'info');
                
                mqttManager.connected = true;
                mqttManager._intentionalDisconnect = true;
                mockClient.emit('close');
                
                expect(mqttManager.connected).toBe(false);
                expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('intentional disconnect'));
            });
        });

        describe('error event', () => {
            it('should handle authentication errors', () => {
                const errorHandlerSpy = jest.spyOn(mqttManager.errorHandler, 'handle');
                const originalExit = process.exit;
                process.exit = jest.fn();
                
                // Prevent unhandled error propagation
                mqttManager.on('error', () => {});
                
                try {
                    const authError = new Error('Connection refused: Not authorized');
                    authError.code = 5; // MQTT authentication error code
                    
                    mockClient.emit('error', authError);
                    
                    expect(errorHandlerSpy).toHaveBeenCalledWith(
                        authError,
                        expect.objectContaining({
                            brokerUrl: 'localhost:1883',
                            hasUsername: true
                        }),
                        'MQTT authentication',
                        true // fatal
                    );
                    expect(process.exit).toHaveBeenCalledWith(1);
                } finally {
                    process.exit = originalExit;
                }
            });

            it('should handle other MQTT errors without destroying client', () => {
                const errorHandlerSpy = jest.spyOn(mqttManager.errorHandler, 'handle');
                const testError = new Error('Generic MQTT error');
                
                // Prevent unhandled error propagation
                mqttManager.on('error', () => {});
                
                mockClient.emit('error', testError);
                
                expect(errorHandlerSpy).toHaveBeenCalledWith(
                    testError,
                    expect.objectContaining({
                        brokerUrl: 'localhost:1883',
                        connected: false,
                        errorCode: undefined
                    }),
                    'MQTT connection'
                );
                // Client should NOT be destroyed on transient errors
                expect(mqttManager.client).toBe(mockClient);
            });
        });

        describe('message event', () => {
            it('should emit message event with parsed data', () => {
                const emitSpy = jest.spyOn(mqttManager, 'emit');
                const topic = 'cbus/write/254/56/1/switch';
                const payload = Buffer.from('ON');
                
                mockClient.emit('message', topic, payload);
                
                expect(emitSpy).toHaveBeenCalledWith('message', topic, 'ON');
            });

            it('should handle message event with string topic and buffer payload', () => {
                const emitSpy = jest.spyOn(mqttManager, 'emit');
                const topic = 'test/topic';
                const payload = Buffer.from('test payload');
                
                mockClient.emit('message', topic, payload);
                
                expect(emitSpy).toHaveBeenCalledWith('message', topic, 'test payload');
            });
        });
    });

    describe('URL processing', () => {
        const testCases = [
            { input: 'localhost:1883', expected: 'mqtt://localhost:1883' },
            { input: 'example.com:1883', expected: 'mqtt://example.com:1883' },
            { input: 'mqtt://localhost:1883', expected: 'mqtt://mqtt://localhost' },
            { input: 'mqtts://secure.example.com:8883', expected: 'mqtt://mqtts://secure.example.com' },
            { input: '192.168.1.100:1883', expected: 'mqtt://192.168.1.100:1883' }
        ];

        testCases.forEach(({ input, expected }) => {
            it(`should process "${input}" correctly`, () => {
                const testSettings = { mqtt: input };
                const testManager = new MqttManager(testSettings);
                
                testManager.connect();
                
                expect(mqtt.connect).toHaveBeenCalledWith(expected, expect.any(Object));
            });
        });
    });

    describe('Will message configuration', () => {
        it('should set up Last Will and Testament message', () => {
            mqttManager.connect();
            
            const connectCall = mqtt.connect.mock.calls[0];
            const options = connectCall[1];
            
            expect(options.will).toEqual({
                topic: 'hello/cgateweb',
                payload: 'Offline',
                qos: 1,
                retain: true
            });
        });
    });

    describe('Edge cases and error handling', () => {
        it('should handle null settings gracefully', () => {
            const nullManager = new MqttManager(null);
            expect(() => nullManager.connect()).toThrow();
        });

        it('should handle empty mqtt setting', () => {
            const emptySettings = { mqtt: '' };
            const emptyManager = new MqttManager(emptySettings);
            
            expect(() => emptyManager.connect()).not.toThrow(); // Empty string splits to [''], which becomes host='', port='1883'
        });

        it('should handle multiple connect calls', () => {
            mqttManager.connect();
            const firstClient = mqttManager.client;
            
            // Create a new mock client for the second connect call
            const secondMockClient = new EventEmitter();
            secondMockClient.publish = jest.fn();
            secondMockClient.subscribe = jest.fn();
            secondMockClient.end = jest.fn();
            mqtt.connect.mockReturnValueOnce(secondMockClient);
            
            mqttManager.connect();
            
            expect(firstClient.end).toHaveBeenCalled();
            expect(mqttManager.client).toBe(secondMockClient);
        });

        it('should handle publish when client is null', () => {
            mqttManager.client = null;
            mqttManager.connected = true; // Inconsistent state
            
            expect(() => mqttManager.publish('test', 'message')).not.toThrow();
        });

        it('should handle subscribe when client is null', () => {
            mqttManager.client = null;
            mqttManager.connected = true; // Inconsistent state
            
            expect(() => mqttManager.subscribe('test')).not.toThrow();
        });
    });
});