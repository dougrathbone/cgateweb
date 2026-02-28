const EventPublisher = require('../src/eventPublisher');
const CBusEvent = require('../src/cbusEvent');

describe('EventPublisher', () => {
    let eventPublisher;
    let mockSettings;
    let mockPublishFn;
    let mockMqttOptions;
    let mockLogger;

    beforeEach(() => {
        mockSettings = {
            ha_discovery_pir_app_id: '202', // PIR sensors app ID
            ha_discovery_cover_app_id: '203', // Covers app ID
            logging: false
        };

        mockPublishFn = jest.fn();

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
            publishFn: mockPublishFn,
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
            expect(eventPublisher.publishFn).toBe(mockPublishFn);
            expect(eventPublisher.mqttOptions).toBe(mockMqttOptions);
        });

        it('should create default logger if none provided', () => {
            const publisher = new EventPublisher({
                settings: mockSettings,
                publishFn: mockPublishFn,
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

            expect(mockPublishFn).not.toHaveBeenCalled();
        });

        it('should publish lighting device ON event with state and level', () => {
            const eventData = 'lighting on 254/56/16';
            const event = new CBusEvent(eventData);
            
            eventPublisher.publishEvent(event, '(Test)');

            expect(mockPublishFn).toHaveBeenCalledTimes(2);
            
            // Check state message
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/56/16/state',
                'ON',
                mockMqttOptions
            );
            
            // Check level message (ON events assume 100%)
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/56/16/level',
                '100',
                mockMqttOptions
            );

            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.stringContaining('C-Bus Status (Test): 254/56/16 ON (100%)')
            );
        });

        it('should publish lighting device OFF event with state and level', () => {
            const eventData = 'lighting off 254/56/16';
            const event = new CBusEvent(eventData);
            
            eventPublisher.publishEvent(event, '(Test)');

            expect(mockPublishFn).toHaveBeenCalledTimes(2);
            
            // Check state message
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/56/16/state',
                'OFF',
                mockMqttOptions
            );
            
            // Check level message (OFF events assume 0%)
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/56/16/level',
                '0',
                mockMqttOptions
            );

            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.stringContaining('C-Bus Status (Test): 254/56/16 OFF (0%)')
            );
        });

        it('should publish lighting device ramp event with correct level percentage', () => {
            const eventData = 'lighting ramp 254/56/16 128'; // 128/255 = 50%
            const event = new CBusEvent(eventData);
            
            eventPublisher.publishEvent(event, '(Test)');

            expect(mockPublishFn).toHaveBeenCalledTimes(2);
            
            // Check state message (ON because level > 0)
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/56/16/state',
                'ON',
                mockMqttOptions
            );
            
            // Check level message (50% of 255)
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/56/16/level',
                '50',
                mockMqttOptions
            );
        });

        it('should publish PIR sensor event with state only (no level)', () => {
            // Create PIR sensor event - app 202 (PIR app ID)
            const eventData = 'security on 254/202/16'; // PIR motion detected
            const event = new CBusEvent(eventData);
            
            eventPublisher.publishEvent(event, '(Test)');

            expect(mockPublishFn).toHaveBeenCalledTimes(1);
            
            // Check state message only
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/202/16/state',
                'ON',
                mockMqttOptions
            );

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

            expect(mockPublishFn).toHaveBeenCalledTimes(1);
            
            // Check state message only
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/202/16/state',
                'OFF',
                mockMqttOptions
            );
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
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/56/16/state',
                'OFF',
                mockMqttOptions
            );
            
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/56/16/level',
                '0',
                mockMqttOptions
            );
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
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/56/16/level',
                '100',
                mockMqttOptions
            );
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
                mockPublishFn.mockClear();
                
                const mockEvent = {
                    isValid: () => true,
                    getNetwork: () => '254',
                    getApplication: () => '56',
                    getGroup: () => '16',
                    getLevel: () => level,
                    getAction: () => 'ramp'
                };
                
                eventPublisher.publishEvent(mockEvent);
                
                expect(mockPublishFn).toHaveBeenCalledWith(
                    'cbus/read/254/56/16/level',
                    expectedPercent,
                    mockMqttOptions
                );
            });
        });

        it('should publish directly without throttle delay', () => {
            const event = new CBusEvent('lighting on 254/56/16');
            
            eventPublisher.publishEvent(event);

            // All messages published synchronously in a single call
            expect(mockPublishFn).toHaveBeenCalledTimes(2);
        });
    });

    describe('Cover position publishing', () => {
        it('should publish cover event with state, level, and position', () => {
            const mockEvent = {
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '203', // Cover app ID
                getGroup: () => '1',
                getLevel: () => 128, // 50%
                getAction: () => 'ramp'
            };
            
            eventPublisher.publishEvent(mockEvent, '(Test)');

            // Should publish 3 messages: state, level, and position
            expect(mockPublishFn).toHaveBeenCalledTimes(3);
            
            // Check state message
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/203/1/state',
                'ON',
                mockMqttOptions
            );
            
            // Check level message
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/203/1/level',
                '50',
                mockMqttOptions
            );
            
            // Check position message
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/203/1/position',
                '50',
                mockMqttOptions
            );
        });

        it('should publish cover closed state correctly', () => {
            const mockEvent = {
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '203',
                getGroup: () => '1',
                getLevel: () => 0, // 0% - closed
                getAction: () => 'ramp'
            };
            
            eventPublisher.publishEvent(mockEvent);

            // Check state message - should be OFF (closed)
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/203/1/state',
                'OFF',
                mockMqttOptions
            );
            
            // Check position message
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/203/1/position',
                '0',
                mockMqttOptions
            );
        });

        it('should publish cover fully open state correctly', () => {
            const mockEvent = {
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '203',
                getGroup: () => '1',
                getLevel: () => 255, // 100% - fully open
                getAction: () => 'ramp'
            };
            
            eventPublisher.publishEvent(mockEvent);

            // Check state message - should be ON (open)
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/203/1/state',
                'ON',
                mockMqttOptions
            );
            
            // Check position message
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/203/1/position',
                '100',
                mockMqttOptions
            );
        });

        it('should not publish position for non-cover devices', () => {
            // Regular lighting device (not a cover)
            const mockEvent = {
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '56', // Lighting app, not cover
                getGroup: () => '1',
                getLevel: () => 128,
                getAction: () => 'ramp'
            };
            
            eventPublisher.publishEvent(mockEvent);

            // Should only publish state and level (2 messages), not position
            expect(mockPublishFn).toHaveBeenCalledTimes(2);
            
            // Verify no position topic was published
            const positionCall = mockPublishFn.mock.calls.find(
                call => call[0].endsWith('/position')
            );
            expect(positionCall).toBeUndefined();
        });
    });

    describe('Type override cover publishing', () => {
        let mockLabelLoader;

        beforeEach(() => {
            const typeOverrides = new Map([
                ['254/56/0', 'cover'],
                ['254/56/21', 'cover'],
                ['254/56/6', 'switch']
            ]);
            mockLabelLoader = {
                getTypeOverrides: jest.fn().mockReturnValue(typeOverrides)
            };
        });

        it('should publish position for a lighting group type-overridden to cover', () => {
            const publisher = new EventPublisher({
                settings: mockSettings,
                publishFn: mockPublishFn,
                mqttOptions: mockMqttOptions,
                labelLoader: mockLabelLoader,
                logger: mockLogger
            });

            const mockEvent = {
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '56',
                getGroup: () => '0',
                getLevel: () => 128,
                getAction: () => 'ramp'
            };

            publisher.publishEvent(mockEvent);

            expect(mockPublishFn).toHaveBeenCalledTimes(3);
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/56/0/state', 'ON', mockMqttOptions
            );
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/56/0/level', '50', mockMqttOptions
            );
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/56/0/position', '50', mockMqttOptions
            );
        });

        it('should use cover state logic for type-overridden covers', () => {
            const publisher = new EventPublisher({
                settings: mockSettings,
                publishFn: mockPublishFn,
                mqttOptions: mockMqttOptions,
                labelLoader: mockLabelLoader,
                logger: mockLogger
            });

            const mockEvent = {
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '56',
                getGroup: () => '21',
                getLevel: () => 0,
                getAction: () => 'ramp'
            };

            publisher.publishEvent(mockEvent);

            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/56/21/state', 'OFF', mockMqttOptions
            );
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/56/21/position', '0', mockMqttOptions
            );
        });

        it('should not publish position for a lighting group not overridden to cover', () => {
            const publisher = new EventPublisher({
                settings: mockSettings,
                publishFn: mockPublishFn,
                mqttOptions: mockMqttOptions,
                labelLoader: mockLabelLoader,
                logger: mockLogger
            });

            const mockEvent = {
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '56',
                getGroup: () => '16',
                getLevel: () => 128,
                getAction: () => 'ramp'
            };

            publisher.publishEvent(mockEvent);

            expect(mockPublishFn).toHaveBeenCalledTimes(2);
            const positionCall = mockPublishFn.mock.calls.find(
                call => call[0].endsWith('/position')
            );
            expect(positionCall).toBeUndefined();
        });

        it('should not publish position for a switch type override', () => {
            const publisher = new EventPublisher({
                settings: mockSettings,
                publishFn: mockPublishFn,
                mqttOptions: mockMqttOptions,
                labelLoader: mockLabelLoader,
                logger: mockLogger
            });

            const mockEvent = {
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '56',
                getGroup: () => '6',
                getLevel: () => 255,
                getAction: () => 'on'
            };

            publisher.publishEvent(mockEvent);

            expect(mockPublishFn).toHaveBeenCalledTimes(2);
            const positionCall = mockPublishFn.mock.calls.find(
                call => call[0].endsWith('/position')
            );
            expect(positionCall).toBeUndefined();
        });

        it('should fall back to app-ID-only check when labelLoader is null', () => {
            const publisher = new EventPublisher({
                settings: mockSettings,
                publishFn: mockPublishFn,
                mqttOptions: mockMqttOptions,
                logger: mockLogger
            });

            const mockEvent = {
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '56',
                getGroup: () => '0',
                getLevel: () => 128,
                getAction: () => 'ramp'
            };

            publisher.publishEvent(mockEvent);

            // Without labelLoader, group 0 on app 56 is a regular light (2 messages)
            expect(mockPublishFn).toHaveBeenCalledTimes(2);
            const positionCall = mockPublishFn.mock.calls.find(
                call => call[0].endsWith('/position')
            );
            expect(positionCall).toBeUndefined();
        });

        it('should still detect covers by app ID even with labelLoader present', () => {
            const publisher = new EventPublisher({
                settings: mockSettings,
                publishFn: mockPublishFn,
                mqttOptions: mockMqttOptions,
                labelLoader: mockLabelLoader,
                logger: mockLogger
            });

            const mockEvent = {
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '203',
                getGroup: () => '5',
                getLevel: () => 128,
                getAction: () => 'ramp'
            };

            publisher.publishEvent(mockEvent);

            expect(mockPublishFn).toHaveBeenCalledTimes(3);
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/203/5/position', '50', mockMqttOptions
            );
        });
    });
});
