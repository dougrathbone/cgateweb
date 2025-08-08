const EventPublisher = require('../src/eventPublisher');
const CBusEvent = require('../src/cbusEvent');

describe('EventPublisher', () => {
    let eventPublisher;
    let mockSettings;
    let mockMqttPublishQueue;
    let mockMqttOptions;
    let mockLogger;

    beforeEach(() => {
        mockSettings = {
            ha_discovery_pir_app_id: '202', // PIR sensors app ID
            logging: false
        };

        mockMqttPublishQueue = {
            add: jest.fn()
        };

        mockMqttOptions = {
            retain: true,
            qos: 0
        };

        mockLogger = {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        };

        eventPublisher = new EventPublisher({
            settings: mockSettings,
            mqttPublishQueue: mockMqttPublishQueue,
            mqttOptions: mockMqttOptions,
            logger: mockLogger
        });
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('constructor', () => {
        it('should initialize with provided options', () => {
            expect(eventPublisher.settings).toBe(mockSettings);
            expect(eventPublisher.mqttPublishQueue).toBe(mockMqttPublishQueue);
            expect(eventPublisher.mqttOptions).toBe(mockMqttOptions);
        });

        it('should create default logger if none provided', () => {
            const publisher = new EventPublisher({
                settings: mockSettings,
                mqttPublishQueue: mockMqttPublishQueue,
                mqttOptions: mockMqttOptions
            });
            
            expect(publisher.logger).toBeDefined();
        });
    });

    describe('publishEvent', () => {
        it('should not publish invalid events', () => {
            eventPublisher.publishEvent(null);
            eventPublisher.publishEvent(undefined);
            
            const invalidEvent = {
                isValid: () => false
            };
            eventPublisher.publishEvent(invalidEvent);

            expect(mockMqttPublishQueue.add).not.toHaveBeenCalled();
        });

        it('should publish lighting device ON event with state and level', () => {
            const eventData = 'lighting on 254/56/16';
            const event = new CBusEvent(eventData);
            
            eventPublisher.publishEvent(event, '(Test)');

            expect(mockMqttPublishQueue.add).toHaveBeenCalledTimes(2);
            
            // Check state message
            expect(mockMqttPublishQueue.add).toHaveBeenCalledWith({
                topic: 'cbus/read/254/56/16/state',
                payload: 'ON',
                options: mockMqttOptions
            });
            
            // Check level message (ON events assume 100%)
            expect(mockMqttPublishQueue.add).toHaveBeenCalledWith({
                topic: 'cbus/read/254/56/16/level',
                payload: '100',
                options: mockMqttOptions
            });

            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.stringContaining('C-Bus Status (Test): 254/56/16 ON (100%)')
            );
        });

        it('should publish lighting device OFF event with state and level', () => {
            const eventData = 'lighting off 254/56/16';
            const event = new CBusEvent(eventData);
            
            eventPublisher.publishEvent(event, '(Test)');

            expect(mockMqttPublishQueue.add).toHaveBeenCalledTimes(2);
            
            // Check state message
            expect(mockMqttPublishQueue.add).toHaveBeenCalledWith({
                topic: 'cbus/read/254/56/16/state',
                payload: 'OFF',
                options: mockMqttOptions
            });
            
            // Check level message (OFF events assume 0%)
            expect(mockMqttPublishQueue.add).toHaveBeenCalledWith({
                topic: 'cbus/read/254/56/16/level',
                payload: '0',
                options: mockMqttOptions
            });

            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.stringContaining('C-Bus Status (Test): 254/56/16 OFF (0%)')
            );
        });

        it('should publish lighting device ramp event with correct level percentage', () => {
            const eventData = 'lighting ramp 254/56/16 128'; // 128/255 = 50%
            const event = new CBusEvent(eventData);
            
            eventPublisher.publishEvent(event, '(Test)');

            expect(mockMqttPublishQueue.add).toHaveBeenCalledTimes(2);
            
            // Check state message (ON because level > 0)
            expect(mockMqttPublishQueue.add).toHaveBeenCalledWith({
                topic: 'cbus/read/254/56/16/state',
                payload: 'ON',
                options: mockMqttOptions
            });
            
            // Check level message (50% of 255)
            expect(mockMqttPublishQueue.add).toHaveBeenCalledWith({
                topic: 'cbus/read/254/56/16/level',
                payload: '50',
                options: mockMqttOptions
            });
        });

        it('should publish PIR sensor event with state only (no level)', () => {
            // Create PIR sensor event - app 202 (PIR app ID)
            const eventData = 'security on 254/202/16'; // PIR motion detected
            const event = new CBusEvent(eventData);
            
            eventPublisher.publishEvent(event, '(Test)');

            expect(mockMqttPublishQueue.add).toHaveBeenCalledTimes(1);
            
            // Check state message only
            expect(mockMqttPublishQueue.add).toHaveBeenCalledWith({
                topic: 'cbus/read/254/202/16/state',
                payload: 'ON',
                options: mockMqttOptions
            });

            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.stringContaining('C-Bus Status (Test): 254/202/16 ON')
            );
            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.not.stringContaining('(%)')
            );
        });

        it('should publish PIR sensor OFF event correctly', () => {
            // Create PIR sensor OFF event
            const eventData = 'security off 254/202/16'; // PIR motion cleared
            const event = new CBusEvent(eventData);
            
            eventPublisher.publishEvent(event, '(Test)');

            expect(mockMqttPublishQueue.add).toHaveBeenCalledTimes(1);
            
            // Check state message only
            expect(mockMqttPublishQueue.add).toHaveBeenCalledWith({
                topic: 'cbus/read/254/202/16/state',
                payload: 'OFF',
                options: mockMqttOptions
            });
        });

        it('should handle events without source parameter', () => {
            const eventData = 'lighting on 254/56/16';
            const event = new CBusEvent(eventData);
            
            eventPublisher.publishEvent(event);

            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.stringContaining('C-Bus Status : 254/56/16 ON (100%)')
            );
        });

        it('should handle events with zero level correctly', () => {
            const eventData = 'lighting ramp 254/56/16 0'; // Level 0
            const event = new CBusEvent(eventData);
            
            eventPublisher.publishEvent(event);

            // Level 0 should result in OFF state and 0% level
            expect(mockMqttPublishQueue.add).toHaveBeenCalledWith({
                topic: 'cbus/read/254/56/16/state',
                payload: 'OFF',
                options: mockMqttOptions
            });
            
            expect(mockMqttPublishQueue.add).toHaveBeenCalledWith({
                topic: 'cbus/read/254/56/16/level',
                payload: '0',
                options: mockMqttOptions
            });
        });

        it('should handle events with null level', () => {
            // Mock an event that returns null for getLevel()
            const mockEvent = {
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '56',
                getGroup: () => '16',
                getLevel: () => null,
                getAction: () => 'on'
            };
            
            eventPublisher.publishEvent(mockEvent);

            // Null level with "on" action should be treated as 100%
            expect(mockMqttPublishQueue.add).toHaveBeenCalledWith({
                topic: 'cbus/read/254/56/16/level',
                payload: '100',
                options: mockMqttOptions
            });
        });

        it('should round level percentages correctly', () => {
            // Test various level values to ensure proper rounding
            const testCases = [
                { level: 1, expectedPercent: '0' },    // 1/255 = 0.39% -> 0%
                { level: 2, expectedPercent: '1' },    // 2/255 = 0.78% -> 1%
                { level: 127, expectedPercent: '50' }, // 127/255 = 49.8% -> 50%
                { level: 128, expectedPercent: '50' }, // 128/255 = 50.2% -> 50%
                { level: 254, expectedPercent: '100' }, // 254/255 = 99.6% -> 100%
                { level: 255, expectedPercent: '100' }  // 255/255 = 100% -> 100%
            ];

            testCases.forEach(({ level, expectedPercent }) => {
                mockMqttPublishQueue.add.mockClear();
                
                const mockEvent = {
                    isValid: () => true,
                    getNetwork: () => '254',
                    getApplication: () => '56',
                    getGroup: () => '16',
                    getLevel: () => level,
                    getAction: () => 'ramp'
                };
                
                eventPublisher.publishEvent(mockEvent);
                
                expect(mockMqttPublishQueue.add).toHaveBeenCalledWith({
                    topic: 'cbus/read/254/56/16/level',
                    payload: expectedPercent,
                    options: mockMqttOptions
                });
            });
        });
    });
});
