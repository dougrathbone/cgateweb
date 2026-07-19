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
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            isLevelEnabled: jest.fn(() => true)
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

        it('should publish current_temperature for a Temperature Broadcast (app 25) event', () => {
            // App 25 has a specialised decoder that attaches a structured reading
            // (byte / 4 = °C). publishEvent must route it to current_temperature
            // and skip the lighting state/level path.
            const event = new CBusEvent('lighting ramp 254/25/3 86');
            expect(event.isValid()).toBe(true);
            expect(event.getReading()).toEqual({ kind: 'temperature', group: '3', celsius: 21.5, unit: 'C' });

            eventPublisher.publishEvent(event, '(Test)');

            expect(mockPublishFn).toHaveBeenCalledTimes(1);
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/25/3/current_temperature',
                '21.5',
                mockMqttOptions
            );
            expect(mockPublishFn).not.toHaveBeenCalledWith(
                'cbus/read/254/25/3/state',
                expect.anything(),
                expect.anything()
            );
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

            expect(mockLogger.debug).toHaveBeenCalledWith(
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

            expect(mockLogger.debug).toHaveBeenCalledWith(
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

            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.stringContaining('C-Bus Status (Test): 254/202/16 ON')
            );
            expect(mockLogger.debug).toHaveBeenCalledWith(
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

            expect(mockLogger.debug).toHaveBeenCalledWith(
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

    describe('Cover getall response parsing (regression)', () => {
        test.each([
            [0,   'OFF', '0'],
            [128, 'ON',  '50'],
            [255, 'ON',  '100'],
        ])('level=%i → state=%s, position=%s', (rawLevel, expectedState, expectedPosition) => {
            const event = new CBusEvent(`//HOME/254/203/5: level=${rawLevel}`, { statusDataOnly: true });
            expect(event.isValid()).toBe(true);

            eventPublisher.publishEvent(event, '(Cmd)');

            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/203/5/state',
                expectedState,
                mockMqttOptions
            );
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/203/5/position',
                expectedPosition,
                mockMqttOptions
            );
        });

        it('should publish cover position for a ramp event from the event connection', () => {
            // Simulates: event connection delivers "lighting ramp 254/203/5 128"
            const event = new CBusEvent('lighting ramp 254/203/5 128');
            expect(event.isValid()).toBe(true);

            eventPublisher.publishEvent(event, '(Evt)');

            expect(mockPublishFn).toHaveBeenCalledTimes(3);

            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/203/5/state',
                'ON',
                mockMqttOptions
            );
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/203/5/position',
                '50',
                mockMqttOptions
            );
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

    describe('publish deduplication', () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        it('should suppress unchanged payloads within dedup window', () => {
            const publisher = new EventPublisher({
                settings: {
                    ...mockSettings,
                    eventPublishDedupWindowMs: 200
                },
                publishFn: mockPublishFn,
                mqttOptions: mockMqttOptions,
                logger: mockLogger
            });

            const event = new CBusEvent('lighting on 254/56/16');
            publisher.publishEvent(event);
            publisher.publishEvent(event);

            // first call publishes state+level, second is deduplicated
            expect(mockPublishFn).toHaveBeenCalledTimes(2);
        });

        it('should allow unchanged payloads after dedup window expires', () => {
            const publisher = new EventPublisher({
                settings: {
                    ...mockSettings,
                    eventPublishDedupWindowMs: 200
                },
                publishFn: mockPublishFn,
                mqttOptions: mockMqttOptions,
                logger: mockLogger
            });

            const event = new CBusEvent('lighting on 254/56/16');
            publisher.publishEvent(event);
            jest.advanceTimersByTime(250);
            publisher.publishEvent(event);

            expect(mockPublishFn).toHaveBeenCalledTimes(4);
        });

        it('should expose publish stats including dedup counters', () => {
            const publisher = new EventPublisher({
                settings: {
                    ...mockSettings,
                    eventPublishDedupWindowMs: 200
                },
                publishFn: mockPublishFn,
                mqttOptions: mockMqttOptions,
                logger: mockLogger
            });

            const event = new CBusEvent('lighting on 254/56/16');
            publisher.publishEvent(event);
            publisher.publishEvent(event);

            const stats = publisher.getStats();
            expect(stats.publishAttempts).toBe(4);
            expect(stats.published).toBe(2);
            expect(stats.dedupDropped).toBe(2);
        });
    });

    describe('topic cache', () => {
        it('should reuse cached topics for repeated addresses', () => {
            const publisher = new EventPublisher({
                settings: {
                    ...mockSettings,
                    topicCacheMaxEntries: 10
                },
                publishFn: mockPublishFn,
                mqttOptions: mockMqttOptions,
                logger: mockLogger
            });

            const event = new CBusEvent('lighting on 254/56/16');
            publisher.publishEvent(event);
            publisher.publishEvent(event);

            const stats = publisher.getStats();
            expect(stats.topicCacheMiss).toBeGreaterThan(0);
            expect(stats.topicCacheHit).toBeGreaterThan(0);
            expect(stats.topicCacheSize).toBe(1);
        });
    });

    describe('publish coalescing', () => {
        it('should coalesce same-tick updates when enabled', async () => {
            const publisher = new EventPublisher({
                settings: {
                    ...mockSettings,
                    eventPublishCoalesce: true
                },
                publishFn: mockPublishFn,
                mqttOptions: mockMqttOptions,
                logger: mockLogger
            });

            const eventA = new CBusEvent('lighting on 254/56/16');
            const eventB = new CBusEvent('lighting off 254/56/16');
            publisher.publishEvent(eventA);
            publisher.publishEvent(eventB);

            await new Promise(resolve => setImmediate(resolve));

            // State and level should each be emitted once with latest payload.
            expect(mockPublishFn).toHaveBeenCalledTimes(2);
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

            const stats = publisher.getStats();
            expect(stats.coalesced).toBeGreaterThan(0);
        });

        it('should handle _flushCoalesceBuffer with empty buffer gracefully', () => {
            const publisher = new EventPublisher({
                settings: {
                    ...mockSettings,
                    eventPublishCoalesce: true
                },
                publishFn: mockPublishFn,
                mqttOptions: mockMqttOptions,
                logger: mockLogger
            });

            // Calling flush on an empty buffer should not publish anything
            publisher._flushCoalesceBuffer();
            expect(mockPublishFn).not.toHaveBeenCalled();
        });
    });

    describe('topic cache eviction', () => {
        it('should evict oldest entry when topic cache is full', () => {
            // topicCacheMaxEntries has a minimum of 100 in the constructor
            const maxEntries = 100;
            const publisher = new EventPublisher({
                settings: {
                    ...mockSettings,
                    topicCacheMaxEntries: maxEntries
                },
                publishFn: mockPublishFn,
                mqttOptions: mockMqttOptions,
                logger: mockLogger
            });

            // Fill the cache to its limit
            for (let i = 0; i < maxEntries; i++) {
                publisher._getTopicsForAddress('254', '56', String(i));
            }

            let stats = publisher.getStats();
            expect(stats.topicCacheSize).toBe(maxEntries);
            expect(stats.topicCacheMiss).toBe(maxEntries);

            // Adding one more entry should evict the oldest and keep size at max
            publisher._getTopicsForAddress('254', '56', String(maxEntries));

            stats = publisher.getStats();
            expect(stats.topicCacheSize).toBe(maxEntries);
            expect(stats.topicCacheMiss).toBe(maxEntries + 1);
        });
    });

    describe('dedup cache pruning', () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        it('should prune expired entries when cache exceeds max size', () => {
            const publisher = new EventPublisher({
                settings: {
                    ...mockSettings,
                    eventPublishDedupWindowMs: 100,
                    eventPublishDedupMaxEntries: 100
                },
                publishFn: mockPublishFn,
                mqttOptions: mockMqttOptions,
                logger: mockLogger
            });

            // Publish 100 unique entries to fill the cache
            for (let i = 0; i < 100; i++) {
                const mockEvent = {
                    isValid: () => true,
                    getNetwork: () => '254',
                    getApplication: () => '56',
                    getGroup: () => String(i),
                    getLevel: () => 128,
                    getAction: () => 'ramp'
                };
                publisher.publishEvent(mockEvent);
            }

            // Advance time so existing entries expire
            jest.advanceTimersByTime(200);

            // Publishing one more entry (unique group) triggers pruning of expired entries
            const triggerEvent = {
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '56',
                getGroup: () => '200',
                getLevel: () => 128,
                getAction: () => 'ramp'
            };
            publisher.publishEvent(triggerEvent);

            const stats = publisher.getStats();
            expect(stats.dedupEvicted).toBeGreaterThan(0);
        });

        it('should enforce max size by evicting oldest entries when expiry pass is insufficient', () => {
            const publisher = new EventPublisher({
                settings: {
                    ...mockSettings,
                    eventPublishDedupWindowMs: 60000,
                    eventPublishDedupMaxEntries: 100
                },
                publishFn: mockPublishFn,
                mqttOptions: mockMqttOptions,
                logger: mockLogger
            });

            // Publish 100 unique entries to fill the cache (none expire due to long window)
            for (let i = 0; i < 100; i++) {
                const mockEvent = {
                    isValid: () => true,
                    getNetwork: () => '254',
                    getApplication: () => '56',
                    getGroup: () => String(i),
                    getLevel: () => 128,
                    getAction: () => 'ramp'
                };
                publisher.publishEvent(mockEvent);
            }

            // Publishing one more unique entry triggers the second-pass eviction
            const triggerEvent = {
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '56',
                getGroup: () => '200',
                getLevel: () => 128,
                getAction: () => 'ramp'
            };
            publisher.publishEvent(triggerEvent);

            const stats = publisher.getStats();
            // The second pass (while loop) must have evicted at least one entry
            expect(stats.dedupEvicted).toBeGreaterThan(0);
        });
    });

    describe('Trigger group publishing', () => {
        let triggerPublisher;

        beforeEach(() => {
            const triggerSettings = {
                ...mockSettings,
                ha_discovery_pir_app_id: null,
                ha_discovery_trigger_app_id: '205'
            };
            triggerPublisher = new EventPublisher({
                settings: triggerSettings,
                publishFn: mockPublishFn,
                mqttOptions: mockMqttOptions,
                logger: mockLogger
            });
        });

        it('should publish trigger event with JSON event payload to event topic', () => {
            const mockEvent = {
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '205',
                getGroup: () => '1',
                getLevel: () => 255,
                getAction: () => 'on'
            };

            triggerPublisher.publishEvent(mockEvent, '(Test)');

            expect(mockPublishFn).toHaveBeenCalledTimes(1);
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/205/1/event',
                JSON.stringify({ event_type: 'trigger', level: 255 }),
                { ...mockMqttOptions, retain: false }
            );
        });

        it('should publish trigger event without level when level is null', () => {
            const mockEvent = {
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '205',
                getGroup: () => '2',
                getLevel: () => null,
                getAction: () => 'on'
            };

            triggerPublisher.publishEvent(mockEvent, '(Test)');

            expect(mockPublishFn).toHaveBeenCalledTimes(1);
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/205/2/event',
                JSON.stringify({ event_type: 'trigger' }),
                { ...mockMqttOptions, retain: false }
            );
        });

        it('should not publish state or level topics for trigger events', () => {
            const mockEvent = {
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '205',
                getGroup: () => '3',
                getLevel: () => 128,
                getAction: () => 'on'
            };

            triggerPublisher.publishEvent(mockEvent);

            // Only the event topic - no state, level, or position
            expect(mockPublishFn).toHaveBeenCalledTimes(1);
            const topic = mockPublishFn.mock.calls[0][0];
            expect(topic).toBe('cbus/read/254/205/3/event');
            expect(topic).not.toContain('/state');
            expect(topic).not.toContain('/level');
            expect(topic).not.toContain('/position');
        });

        it('should not treat non-trigger app events as trigger events', () => {
            const mockEvent = {
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '56', // lighting app
                getGroup: () => '1',
                getLevel: () => 255,
                getAction: () => 'on'
            };

            triggerPublisher.publishEvent(mockEvent);

            // Should publish state and level (not event topic)
            expect(mockPublishFn).toHaveBeenCalledTimes(2);
            expect(mockPublishFn).not.toHaveBeenCalledWith(
                expect.stringContaining('/event'),
                expect.anything(),
                expect.anything()
            );
        });
    });

    describe('publishReading', () => {
        it('should publish to current_temperature topic for temperature reading', () => {
            eventPublisher.publishReading('254', '172', '201', {
                kind: 'temperature',
                celsius: 17.4
            });

            expect(mockPublishFn).toHaveBeenCalledTimes(1);
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/172/201/current_temperature',
                '17.4',
                mockMqttOptions
            );
        });

        it('should publish sensor_status alongside current_temperature when decoded', () => {
            eventPublisher.publishReading('254', '172', '201', {
                kind: 'temperature',
                celsius: 17.4,
                sensorStatus: 0
            });

            expect(mockPublishFn).toHaveBeenCalledTimes(2);
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/172/201/current_temperature',
                '17.4',
                mockMqttOptions
            );
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/172/201/sensor_status',
                '0',
                mockMqttOptions
            );
        });

        it('should publish sensor_status but not the meaningless temperature on sensor failure', () => {
            // Spec §25.8.6: at "Sensor total failure" the temperature is meaningless.
            eventPublisher.publishReading('254', '172', '201', {
                kind: 'temperature',
                celsius: null,
                sensorStatus: 3
            });

            expect(mockPublishFn).toHaveBeenCalledTimes(1);
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/172/201/sensor_status',
                '3',
                mockMqttOptions
            );
        });

        it('should publish mode and setpoint for a mode reading with heat + setpoint', () => {
            eventPublisher.publishReading('254', '172', '202', {
                kind: 'mode',
                mode: 'heat',
                setpoint: 22
            });

            expect(mockPublishFn).toHaveBeenCalledTimes(2);
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/172/202/mode',
                'heat',
                mockMqttOptions
            );
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/172/202/setpoint',
                '22',
                mockMqttOptions
            );
        });

        it('should publish mode=off and no setpoint when mode is off and setpoint is null', () => {
            eventPublisher.publishReading('254', '172', '202', {
                kind: 'mode',
                mode: 'off',
                setpoint: null
            });

            expect(mockPublishFn).toHaveBeenCalledTimes(1);
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/172/202/mode',
                'off',
                mockMqttOptions
            );
        });

        it('should publish only setpoint when mode is null (unknown code) but setpoint is present', () => {
            eventPublisher.publishReading('254', '172', '202', {
                kind: 'mode',
                mode: null,
                setpoint: 23
            });

            expect(mockPublishFn).toHaveBeenCalledTimes(1);
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/172/202/setpoint',
                '23',
                mockMqttOptions
            );
        });

        it('should publish ON for a state reading with on=true', () => {
            eventPublisher.publishReading('254', '172', '201', {
                kind: 'state',
                on: true
            });

            expect(mockPublishFn).toHaveBeenCalledTimes(1);
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/172/201/state',
                'ON',
                mockMqttOptions
            );
        });

        it('should publish fan_mode and fan_speed for a mode reading with an aux level', () => {
            eventPublisher.publishReading('254', '172', '201', {
                kind: 'mode',
                mode: 'cool',
                setpoint: 15,
                fanSpeed: 3,
                fanMode: 'automatic'
            });

            expect(mockPublishFn).toHaveBeenCalledTimes(4);
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/172/201/fan_mode',
                'automatic',
                mockMqttOptions
            );
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/172/201/fan_speed',
                '3',
                mockMqttOptions
            );
        });

        it('should publish fan_speed 0 (default speed) but no fan topics when aux fields are null', () => {
            eventPublisher.publishReading('254', '172', '201', {
                kind: 'mode',
                mode: 'off',
                setpoint: null,
                fanSpeed: 0,
                fanMode: 'automatic'
            });
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/172/201/fan_speed',
                '0',
                mockMqttOptions
            );

            mockPublishFn.mockClear();
            eventPublisher.publishReading('254', '172', '201', {
                kind: 'mode',
                mode: 'cool',
                setpoint: 15,
                fanSpeed: null,
                fanMode: null
            });
            expect(mockPublishFn).toHaveBeenCalledTimes(2); // mode + setpoint only
            expect(mockPublishFn.mock.calls.some(c => c[0].includes('/fan_'))).toBe(false);
        });

        it('should publish action plus error and error_description for an action reading with an error code', () => {
            eventPublisher.publishReading('254', '172', '201', {
                kind: 'action',
                action: 'heating',
                errorCode: 4,
                errorDescription: 'Temperature sensor failure'
            });

            expect(mockPublishFn).toHaveBeenCalledTimes(3);
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/172/201/action',
                'heating',
                mockMqttOptions
            );
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/172/201/error',
                '4',
                mockMqttOptions
            );
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/172/201/error_description',
                'Temperature sensor failure',
                mockMqttOptions
            );
        });

        it('should publish only the action topic when errorCode is null', () => {
            eventPublisher.publishReading('254', '172', '201', {
                kind: 'action',
                action: 'idle',
                errorCode: null,
                errorDescription: null
            });

            expect(mockPublishFn).toHaveBeenCalledTimes(1);
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/172/201/action',
                'idle',
                mockMqttOptions
            );
        });

        it('should publish OFF for a state reading with on=false', () => {
            eventPublisher.publishReading('254', '172', '201', {
                kind: 'state',
                on: false
            });

            expect(mockPublishFn).toHaveBeenCalledTimes(1);
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/172/201/state',
                'OFF',
                mockMqttOptions
            );
        });

        it('should publish nothing when reading is null', () => {
            eventPublisher.publishReading('254', '172', '1', null);

            expect(mockPublishFn).not.toHaveBeenCalled();
        });
    });

    describe('Tilt App Events', () => {
        let tiltPublisher;

        beforeEach(() => {
            tiltPublisher = new EventPublisher({
                settings: {
                    ...mockSettings,
                    ha_discovery_cover_tilt_app_id: '204'
                },
                publishFn: mockPublishFn,
                mqttOptions: mockMqttOptions,
                logger: mockLogger
            });
        });

        it('should publish tilt event to the tilt topic with correct 0-100 value', () => {
            const mockEvent = {
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '204',
                getGroup: () => '5',
                getLevel: () => 128,
                getAction: () => 'ramp'
            };

            tiltPublisher.publishEvent(mockEvent);

            // 128 / 255 * 100 = ~50%
            expect(mockPublishFn).toHaveBeenCalledTimes(1);
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/204/5/tilt',
                '50',
                mockMqttOptions
            );
        });

        it('should publish tilt=100 for full-level event', () => {
            const mockEvent = {
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '204',
                getGroup: () => '5',
                getLevel: () => 255,
                getAction: () => 'on'
            };

            tiltPublisher.publishEvent(mockEvent);

            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/204/5/tilt',
                '100',
                mockMqttOptions
            );
        });

        it('should publish tilt=0 for off event', () => {
            const mockEvent = {
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '204',
                getGroup: () => '5',
                getLevel: () => 0,
                getAction: () => 'off'
            };

            tiltPublisher.publishEvent(mockEvent);

            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/204/5/tilt',
                '0',
                mockMqttOptions
            );
        });

        it('should NOT publish state, level, or position topics for tilt app events', () => {
            const mockEvent = {
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '204',
                getGroup: () => '5',
                getLevel: () => 128,
                getAction: () => 'ramp'
            };

            tiltPublisher.publishEvent(mockEvent);

            expect(mockPublishFn).toHaveBeenCalledTimes(1);
            const topic = mockPublishFn.mock.calls[0][0];
            expect(topic).not.toContain('/state');
            expect(topic).not.toContain('/level');
            expect(topic).not.toContain('/position');
        });

        it('should not treat non-tilt-app events as tilt events', () => {
            const mockEvent = {
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '203', // cover app, not tilt app
                getGroup: () => '5',
                getLevel: () => 128,
                getAction: () => 'ramp'
            };

            tiltPublisher.publishEvent(mockEvent);

            // Cover app event — should publish state, level, position (not tilt)
            expect(mockPublishFn).not.toHaveBeenCalledWith(
                expect.stringContaining('/tilt'),
                expect.anything(),
                expect.anything()
            );
        });

        it('should infer 100% tilt when no level and action is on', () => {
            const mockEvent = {
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '204',
                getGroup: () => '5',
                getLevel: () => null,
                getAction: () => 'on'
            };

            tiltPublisher.publishEvent(mockEvent);

            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/204/5/tilt',
                '100',
                mockMqttOptions
            );
        });
    });
});
