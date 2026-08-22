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

        it('should publish the origin unit to source_unit when present (issue #35)', () => {
            const event = new CBusEvent('lighting off //HOME/254/56/10  #sourceunit=18 OID=abc');
            eventPublisher.publishEvent(event, '(Test)');

            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/56/10/source_unit',
                '18',
                mockMqttOptions
            );
        });

        it('should not publish source_unit when the event has no sourceunit metadata', () => {
            const event = new CBusEvent('lighting on 254/56/4');
            eventPublisher.publishEvent(event, '(Test)');

            expect(mockPublishFn.mock.calls.some(c => c[0].includes('/source_unit'))).toBe(false);
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

        it.each([
            ['lighting on 254/56/16', 'ON', '100', 'ON (100%)'],
            ['lighting off 254/56/16', 'OFF', '0', 'OFF (0%)'],
            ['lighting ramp 254/56/16 128', 'ON', '50', null], // 128/255 → 50%
        ])('should publish %s with state and level', (line, state, level, debugSuffix) => {
            const event = new CBusEvent(line);

            eventPublisher.publishEvent(event, '(Test)');

            expect(mockPublishFn).toHaveBeenCalledTimes(2);
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/56/16/state', state, mockMqttOptions
            );
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/56/16/level', level, mockMqttOptions
            );
            if (debugSuffix) {
                expect(mockLogger.debug).toHaveBeenCalledWith(
                    expect.stringContaining(`C-Bus Status (Test): 254/56/16 ${debugSuffix}`)
                );
            }
        });

        it.each([
            ['on', 'ON'],
            ['off', 'OFF'],
        ])('should publish PIR %s with state only (no level)', (action, state) => {
            const event = new CBusEvent(`security ${action} 254/202/16`);
            eventPublisher.publishEvent(event, '(Test)');

            expect(mockPublishFn).toHaveBeenCalledTimes(1);
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/202/16/state', state, mockMqttOptions
            );
            if (action === 'on') {
                expect(mockLogger.debug).toHaveBeenCalledWith(
                    expect.stringContaining('C-Bus Status (Test): 254/202/16 ON')
                );
                expect(mockLogger.debug).toHaveBeenCalledWith(
                    expect.not.stringContaining('(%)')
                );
            }
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

        it.each([
            [1, '0'],    // 1/255 = 0.39% → 0%
            [2, '1'],    // 2/255 = 0.78% → 1%
            [127, '50'], // 127/255 = 49.8% → 50%
            [128, '50'], // 128/255 = 50.2% → 50%
            [254, '100'],
            [255, '100'],
        ])('should round level %i to %s%%', (level, expectedPercent) => {
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

        it('should publish directly without throttle delay', () => {
            const event = new CBusEvent('lighting on 254/56/16');
            
            eventPublisher.publishEvent(event);

            // All messages published synchronously in a single call
            expect(mockPublishFn).toHaveBeenCalledTimes(2);
        });
    });

    describe('Cover position publishing', () => {
        it.each([
            [128, 'ON', '50', 3],
            [0, 'OFF', '0', 3],
            [255, 'ON', '100', 3],
        ])('cover level=%i → state=%s position=%s (%i publishes)', (rawLevel, state, position, times) => {
            const mockEvent = {
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '203',
                getGroup: () => '1',
                getLevel: () => rawLevel,
                getAction: () => 'ramp'
            };

            eventPublisher.publishEvent(mockEvent, '(Test)');

            expect(mockPublishFn).toHaveBeenCalledTimes(times);
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/203/1/state', state, mockMqttOptions
            );
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/203/1/level', position, mockMqttOptions
            );
            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/203/1/position', position, mockMqttOptions
            );
        });

        it('should not publish position for non-cover devices', () => {
            const mockEvent = {
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '56',
                getGroup: () => '1',
                getLevel: () => 128,
                getAction: () => 'ramp'
            };

            eventPublisher.publishEvent(mockEvent);

            expect(mockPublishFn).toHaveBeenCalledTimes(2);
            expect(mockPublishFn.mock.calls.find(call => call[0].endsWith('/position'))).toBeUndefined();
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

        it('cancels an interpolated cover ramp when a real C-Gate event arrives', () => {
            const coverRampTracker = { cancelRamp: jest.fn() };
            const publisher = new EventPublisher({
                settings: mockSettings,
                publishFn: mockPublishFn,
                mqttOptions: mockMqttOptions,
                logger: mockLogger,
                coverRampTracker
            });

            publisher.publishEvent(new CBusEvent('lighting ramp 254/203/5 128'), '(Evt)');

            expect(coverRampTracker.cancelRamp).toHaveBeenCalledWith('254/203/5');
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

        it.each([
            ['0', 128, 'ON', '50'],
            ['21', 0, 'OFF', '0'],
        ])('should publish position for lighting group %s type-overridden to cover', (group, level, state, percent) => {
            const publisher = new EventPublisher({
                settings: mockSettings,
                publishFn: mockPublishFn,
                mqttOptions: mockMqttOptions,
                labelLoader: mockLabelLoader,
                logger: mockLogger
            });

            publisher.publishEvent({
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '56',
                getGroup: () => group,
                getLevel: () => level,
                getAction: () => 'ramp'
            });

            expect(mockPublishFn).toHaveBeenCalledWith(
                `cbus/read/254/56/${group}/state`, state, mockMqttOptions
            );
            expect(mockPublishFn).toHaveBeenCalledWith(
                `cbus/read/254/56/${group}/level`, percent, mockMqttOptions
            );
            expect(mockPublishFn).toHaveBeenCalledWith(
                `cbus/read/254/56/${group}/position`, percent, mockMqttOptions
            );
        });

        it.each([
            ['16', 'cover-unrelated lighting group'],
            ['6', 'switch type override'],
        ])('should not publish position for group %s (%s)', (group) => {
            const publisher = new EventPublisher({
                settings: mockSettings,
                publishFn: mockPublishFn,
                mqttOptions: mockMqttOptions,
                labelLoader: mockLabelLoader,
                logger: mockLogger
            });

            publisher.publishEvent({
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '56',
                getGroup: () => group,
                getLevel: () => group === '6' ? 255 : 128,
                getAction: () => group === '6' ? 'on' : 'ramp'
            });

            expect(mockPublishFn).toHaveBeenCalledTimes(2);
            expect(mockPublishFn.mock.calls.find(c => c[0].endsWith('/position'))).toBeUndefined();
        });

        it('should fall back to app-ID-only check when labelLoader is null', () => {
            const publisher = new EventPublisher({
                settings: mockSettings,
                publishFn: mockPublishFn,
                mqttOptions: mockMqttOptions,
                logger: mockLogger
            });

            publisher.publishEvent({
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '56',
                getGroup: () => '0',
                getLevel: () => 128,
                getAction: () => 'ramp'
            });

            expect(mockPublishFn).toHaveBeenCalledTimes(2);
            expect(mockPublishFn.mock.calls.find(c => c[0].endsWith('/position'))).toBeUndefined();
        });

        it('should still detect covers by app ID even with labelLoader present', () => {
            const publisher = new EventPublisher({
                settings: mockSettings,
                publishFn: mockPublishFn,
                mqttOptions: mockMqttOptions,
                labelLoader: mockLabelLoader,
                logger: mockLogger
            });

            publisher.publishEvent({
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '203',
                getGroup: () => '5',
                getLevel: () => 128,
                getAction: () => 'ramp'
            });

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

        it('preserves eventPublishDedupWindowMs of 0 (dedup disabled)', () => {
            const publisher = new EventPublisher({
                settings: {
                    ...mockSettings,
                    eventPublishDedupWindowMs: 0
                },
                publishFn: mockPublishFn,
                mqttOptions: mockMqttOptions,
                logger: mockLogger
            });
            expect(publisher.eventPublishDedupWindowMs).toBe(0);
        });

        it('clamps zero eventPublishDedupMaxEntries to the 100-entry floor', () => {
            const publisher = new EventPublisher({
                settings: {
                    ...mockSettings,
                    eventPublishDedupMaxEntries: 0
                },
                publishFn: mockPublishFn,
                mqttOptions: mockMqttOptions,
                logger: mockLogger
            });
            expect(publisher.eventPublishDedupMaxEntries).toBe(100);
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

        it.each([
            [255, JSON.stringify({ event_type: 'trigger', level: 255 }), '1'],
            [null, JSON.stringify({ event_type: 'trigger' }), '2'],
        ])('should publish trigger event (level=%s) to event topic', (level, payload, group) => {
            const mockEvent = {
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '205',
                getGroup: () => group,
                getLevel: () => level,
                getAction: () => 'on'
            };

            triggerPublisher.publishEvent(mockEvent, '(Test)');

            expect(mockPublishFn).toHaveBeenCalledTimes(1);
            expect(mockPublishFn).toHaveBeenCalledWith(
                `cbus/read/254/205/${group}/event`,
                payload,
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

            expect(mockPublishFn).toHaveBeenCalledTimes(1);
            const topic = mockPublishFn.mock.calls[0][0];
            expect(topic).toBe('cbus/read/254/205/3/event');
        });

        it('should not treat non-trigger app events as trigger events', () => {
            const mockEvent = {
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '56',
                getGroup: () => '1',
                getLevel: () => 255,
                getAction: () => 'on'
            };

            triggerPublisher.publishEvent(mockEvent);

            expect(mockPublishFn).toHaveBeenCalledTimes(2);
            expect(mockPublishFn).not.toHaveBeenCalledWith(
                expect.stringContaining('/event'),
                expect.anything(),
                expect.anything()
            );
        });
    });

    describe('publishReading', () => {
        const publish = (group, reading, net = '254', app = '172') => {
            eventPublisher.publishReading(net, app, group, reading);
        };
        const expectCall = (topic, payload) => {
            expect(mockPublishFn).toHaveBeenCalledWith(topic, payload, mockMqttOptions);
        };

        it('should publish to current_temperature topic for temperature reading', () => {
            publish('201', { kind: 'temperature', celsius: 17.4 });
            expect(mockPublishFn).toHaveBeenCalledTimes(1);
            expectCall('cbus/read/254/172/201/current_temperature', '17.4');
        });

        it.each([
            ['0/0', 5042, 'W', 'W'],
            ['1/0', 42, null, '']
        ])('should publish measurement value + unit for group %s (unit → %j)', (group, value, unit, expectedUnit) => {
            publish(group, { kind: 'measurement', value, unit }, '254', '228');
            expectCall(`cbus/read/254/228/${group}/value`, String(value));
            expectCall(`cbus/read/254/228/${group}/unit`, expectedUnit);
            if (unit === 'W') {
                expect(mockPublishFn).toHaveBeenCalledTimes(2);
            }
        });

        it.each([
            ['date', '2026-03-02'],
            ['time', '21:13:21'],
            // The bus reports local wall-clock with no timezone; converting it
            // would mean inventing one. See clockDecoder.js.
            ['time', '00:00:00']
        ])('should publish clock %s=%s verbatim', (variant, value) => {
            publish('clock', {
                kind: 'clock', network: '254', application: '223', variant, value
            }, '254', '223');
            expect(mockPublishFn).toHaveBeenCalledTimes(1);
            expectCall(`cbus/read/254/223/clock/${variant}`, value);
        });

        it.each([
            ['unsealed', 'ON', '{"zone_state":"unsealed"}', 2],
            ['sealed', 'OFF', '{"zone_state":"sealed"}', 2],
            ['open', 'ON', '{"zone_state":"open"}', 2],
            ['short', 'ON', '{"zone_state":"short"}', 2]
        ])('should publish security zone %s as state=%s', (zoneState, state, attrs, times) => {
            publish('58', { kind: 'security_zone', zoneState }, '254', '208');
            expect(mockPublishFn).toHaveBeenCalledTimes(times);
            expectCall('cbus/read/254/208/58/state', state);
            expectCall('cbus/read/254/208/58/attributes', attrs);
        });

        it('should keep the non-isolated attributes payload byte-identical for every zone state', () => {
            // The overwhelmingly common publish. Asserted as exact strings, not
            // parsed objects, so any regression in the pre-rendered payloads —
            // an added "isolated":false, a reordered key — is caught here rather
            // than in a user's template.
            const expected = {
                sealed: '{"zone_state":"sealed"}',
                unsealed: '{"zone_state":"unsealed"}',
                open: '{"zone_state":"open"}',
                short: '{"zone_state":"short"}'
            };
            for (const [zoneState, payload] of Object.entries(expected)) {
                mockPublishFn.mockClear();
                publish('58', { kind: 'security_zone', zoneState }, '254', '208');
                expectCall('cbus/read/254/208/58/attributes', payload);
            }
        });

        it('should add isolated to the attributes while leaving the zone state alone', () => {
            // A bypassed zone that is unsealed is still unsealed: isolation is
            // extra context on the attributes topic, never a new on/off meaning.
            publish('58', { kind: 'security_zone', zoneState: 'unsealed', isolated: true }, '254', '208');
            expect(mockPublishFn).toHaveBeenCalledTimes(2);
            expectCall('cbus/read/254/208/58/state', 'ON');
            expectCall('cbus/read/254/208/58/attributes', '{"zone_state":"unsealed","isolated":true}');
        });

        it.each([
            [true, 'ON'],
            [false, 'OFF']
        ])('should publish security_panel %s as state=%s', (active, state) => {
            publish('panel/mains', { kind: 'security_panel', active }, '254', '208');
            expect(mockPublishFn).toHaveBeenCalledTimes(1);
            expectCall('cbus/read/254/208/panel/mains/state', state);
        });

        it.each([
            // A panel can bypass a zone before the initial status report lands.
            // The isolation is still worth showing, but nothing is known about
            // the zone's state, so the state topic must stay untouched.
            [true, '{"isolated":true}'],
            // The attributes topic is a whole-document replace and is retained,
            // so the only way to retire a stale "isolated" is to publish over it.
            [false, '{}']
        ])('should publish attributes-only when zoneState is unknown (isolated=%s)', (isolated, attrs) => {
            publish('58', {
                kind: 'security_zone',
                zoneState: null,
                ...(isolated ? { isolated: true } : {})
            }, '254', '208');
            expect(mockPublishFn).toHaveBeenCalledTimes(1);
            expectCall('cbus/read/254/208/58/attributes', attrs);
        });

        it('should publish sensor_status and sensor_problem alongside current_temperature when decoded', () => {
            publish('201', { kind: 'temperature', celsius: 17.4, sensorStatus: 0 });
            expect(mockPublishFn).toHaveBeenCalledTimes(3);
            expectCall('cbus/read/254/172/201/current_temperature', '17.4');
            expectCall('cbus/read/254/172/201/sensor_status', '0');
            expectCall('cbus/read/254/172/201/sensor_problem', 'OFF');
        });

        it('should publish sensor fault topics but not the meaningless temperature on sensor failure', () => {
            // Spec §25.8.6: at "Sensor total failure" the temperature is meaningless.
            publish('201', { kind: 'temperature', celsius: null, sensorStatus: 3 });
            expect(mockPublishFn).toHaveBeenCalledTimes(2);
            expectCall('cbus/read/254/172/201/sensor_status', '3');
            expectCall('cbus/read/254/172/201/sensor_problem', 'ON');
        });

        it.each([
            ['ON', true, 4, 'Temperature sensor failure'],
            ['OFF', false, 0, 'No error']
        ])('should publish problem %s from plant action (error=%s code=%s)', (problem, error, errorCode, errorDescription) => {
            publish('201', {
                kind: 'action',
                action: 'heating',
                error,
                errorCode,
                errorDescription
            });
            expectCall('cbus/read/254/172/201/problem', problem);
        });

        it.each([
            [50, '50'],
            [null, null]
        ])('should handle humidity reading humidity=%s', (humidity, expected) => {
            publish('201', { kind: 'humidity', humidity, ...(humidity === null ? { sensorStatus: 3 } : {}) });
            if (expected === null) {
                expect(mockPublishFn).not.toHaveBeenCalled();
            } else {
                expectCall('cbus/read/254/172/201/current_humidity', expected);
            }
        });

        it('should publish humidity mode and setpoint for a humidity_mode reading', () => {
            publish('201', { kind: 'humidity_mode', mode: 'humidify', humiditySetpoint: 45 });
            expectCall('cbus/read/254/172/201/humidity_mode', 'humidify');
            expectCall('cbus/read/254/172/201/humidity_setpoint', '45');
        });

        it('should publish humidity_action for a humidity_action reading', () => {
            publish('201', { kind: 'humidity_action', action: 'dehumidifying' });
            expectCall('cbus/read/254/172/201/humidity_action', 'dehumidifying');
        });

        it.each([
            [{ mode: 'fan_only', fanSpeedPercent: 99 }, 'fan_speed_pct', '99'],
            [{ mode: 'cool', comfortLevel: 13 }, 'comfort_level', '13']
        ])('should publish optional mode field %s', (fields, suffix, payload) => {
            publish('201', { kind: 'mode', ...fields });
            expectCall(`cbus/read/254/172/201/${suffix}`, payload);
        });

        it.each([
            [{ mode: 'heat', setpoint: 22 }, 2, [['mode', 'heat'], ['setpoint', '22']]],
            [{ mode: 'off', setpoint: null }, 1, [['mode', 'off']]],
            [{ mode: null, setpoint: 23 }, 1, [['setpoint', '23']]]
        ])('should publish mode reading fields %#', (reading, times, expected) => {
            publish('202', { kind: 'mode', ...reading });
            expect(mockPublishFn).toHaveBeenCalledTimes(times);
            for (const [suffix, payload] of expected) {
                expectCall(`cbus/read/254/172/202/${suffix}`, payload);
            }
        });

        it.each([
            [true, 'ON'],
            [false, 'OFF']
        ])('should publish state reading on=%s as %s', (on, state) => {
            publish('201', { kind: 'state', on });
            expect(mockPublishFn).toHaveBeenCalledTimes(1);
            expectCall('cbus/read/254/172/201/state', state);
        });

        it('should publish fan_mode and fan_speed for a mode reading with an aux level', () => {
            publish('201', {
                kind: 'mode',
                mode: 'cool',
                setpoint: 15,
                fanSpeed: 3,
                fanMode: 'automatic'
            });
            expect(mockPublishFn).toHaveBeenCalledTimes(4);
            expectCall('cbus/read/254/172/201/fan_mode', 'automatic');
            expectCall('cbus/read/254/172/201/fan_speed', '3');
        });

        it('should publish fan_speed 0 (default speed) but no fan topics when aux fields are null', () => {
            publish('201', {
                kind: 'mode',
                mode: 'off',
                setpoint: null,
                fanSpeed: 0,
                fanMode: 'automatic'
            });
            expectCall('cbus/read/254/172/201/fan_speed', '0');

            mockPublishFn.mockClear();
            publish('201', {
                kind: 'mode',
                mode: 'cool',
                setpoint: 15,
                fanSpeed: null,
                fanMode: null
            });
            expect(mockPublishFn).toHaveBeenCalledTimes(2); // mode + setpoint only
            expect(mockPublishFn.mock.calls.some(c => c[0].includes('/fan_'))).toBe(false);
        });

        it('should publish action plus error, error_description and problem for an action reading with an error code', () => {
            publish('201', {
                kind: 'action',
                action: 'heating',
                errorCode: 4,
                errorDescription: 'Temperature sensor failure'
            });
            expect(mockPublishFn).toHaveBeenCalledTimes(4);
            expectCall('cbus/read/254/172/201/action', 'heating');
            expectCall('cbus/read/254/172/201/error', '4');
            expectCall('cbus/read/254/172/201/error_description', 'Temperature sensor failure');
            expectCall('cbus/read/254/172/201/problem', 'ON');
        });

        it('should publish only the action topic when errorCode is null', () => {
            publish('201', {
                kind: 'action',
                action: 'idle',
                errorCode: null,
                errorDescription: null
            });
            expect(mockPublishFn).toHaveBeenCalledTimes(1);
            expectCall('cbus/read/254/172/201/action', 'idle');
        });

        it('should publish nothing when reading is null', () => {
            publish('1', null);
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

        it.each([
            [128, 'ramp', '50'],
            [255, 'on', '100'],
            [0, 'off', '0'],
            [null, 'on', '100'], // no level + action on → 100%
        ])('level=%j action=%s → tilt=%s', (rawLevel, action, tilt) => {
            const mockEvent = {
                isValid: () => true,
                getNetwork: () => '254',
                getApplication: () => '204',
                getGroup: () => '5',
                getLevel: () => rawLevel,
                getAction: () => action
            };

            tiltPublisher.publishEvent(mockEvent);

            expect(mockPublishFn).toHaveBeenCalledWith(
                'cbus/read/254/204/5/tilt',
                tilt,
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
                getApplication: () => '203',
                getGroup: () => '5',
                getLevel: () => 128,
                getAction: () => 'ramp'
            };

            tiltPublisher.publishEvent(mockEvent);

            expect(mockPublishFn).not.toHaveBeenCalledWith(
                expect.stringContaining('/tilt'),
                expect.anything(),
                expect.anything()
            );
        });
    });

    describe('shutdown', () => {
        it('clears a pending coalesce flush so shutdown does not publish later', () => {
            jest.useFakeTimers();
            const publisher = new EventPublisher({
                settings: { ...mockSettings, eventPublishCoalesce: true },
                publishFn: mockPublishFn,
                mqttOptions: mockMqttOptions,
                logger: mockLogger
            });

            publisher.publishEvent(new CBusEvent('lighting on 254/56/1'));
            expect(publisher.getStats().coalesceBufferSize).toBeGreaterThan(0);
            expect(publisher.getStats().coalesceEnabled).toBe(true);

            publisher.shutdown();

            expect(publisher.getStats().coalesceBufferSize).toBe(0);
            jest.runOnlyPendingTimers();
            expect(mockPublishFn).not.toHaveBeenCalled();
            jest.useRealTimers();
        });
    });
});

// ============================================================
// EventPublisher — native Air Conditioning (172) readings, driven by the decoder
// ============================================================
//
// These tests feed real C-Gate event lines through airconDecoder and hand the
// resulting reading straight to publishReading, rather than hand-building a
// reading object. A hand-built object can agree with the publisher while the
// decoder has drifted away from both; a decoded one cannot.

describe('EventPublisher — native aircon plant status (decoder-driven)', () => {
    const { decodeLine } = require('../src/applicationDecoders/airconDecoder');

    let publisher;
    let publishFn;
    let mqttOptions;

    // Real capture shape (§25.8.4): aircon zone_hvac_plant_status //PROJECT/net/app
    //   <Zone Group> <Zone List> <HVAC Type> <HVAC Status> <HVAC Error Code>
    const plantStatusLine = (hvacType, statusBits, errorCode) =>
        `# aircon zone_hvac_plant_status //THEGAFF/254/172 1 0,1,2,3,4 ${hvacType} ${statusBits} ${errorCode} #sourceunit=201 OID=x`;

    const publishPlantStatus = (hvacType, statusBits, errorCode) => {
        const reading = decodeLine(plantStatusLine(hvacType, statusBits, errorCode));
        expect(reading).not.toBeNull(); // guard: a broken fixture must not pass silently
        publisher.publishReading(reading.network, reading.application, '201', reading);
        return reading;
    };

    const publishedPayload = (topic) => {
        const call = publishFn.mock.calls.find(c => c[0] === topic);
        return call ? call[1] : undefined;
    };

    beforeEach(() => {
        publishFn = jest.fn();
        mqttOptions = { retain: true, qos: 0 };
        publisher = new EventPublisher({
            settings: { logging: false },
            publishFn,
            mqttOptions,
            logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), isLevelEnabled: () => false }
        });
    });

    it('publishes damper, busy and expansion from the §25.6.6 status bits', () => {
        // 46 = 32(busy) + 8(damper) + 4(fan) + 2(heating); expansion clear.
        publishPlantStatus(3, 46, 0);

        expect(publishedPayload('cbus/read/254/172/201/damper')).toBe('ON');
        expect(publishedPayload('cbus/read/254/172/201/busy')).toBe('ON');
        expect(publishedPayload('cbus/read/254/172/201/expansion')).toBe('OFF');
    });

    it('publishes OFF for the flags that are clear, so a closed damper is not left as stale retained ON', () => {
        publishPlantStatus(3, 2, 0); // heating only

        expect(publishedPayload('cbus/read/254/172/201/damper')).toBe('OFF');
        expect(publishedPayload('cbus/read/254/172/201/busy')).toBe('OFF');
        expect(publishedPayload('cbus/read/254/172/201/expansion')).toBe('OFF');
    });

    it('publishes the expansion bit when set (§25.6.6 bit 7)', () => {
        publishPlantStatus(3, 128, 0);

        expect(publishedPayload('cbus/read/254/172/201/expansion')).toBe('ON');
    });

    it('publishes the plant type as both a code and a description (§25.6.4)', () => {
        publishPlantStatus(3, 14, 0);

        expect(publishedPayload('cbus/read/254/172/201/plant_type')).toBe('3');
        expect(publishedPayload('cbus/read/254/172/201/plant_type_description')).toBe('Heat pump - reverse cycle');
    });

    it('publishes the "Any" plant type verbatim rather than suppressing it', () => {
        publishPlantStatus(255, 14, 0);

        expect(publishedPayload('cbus/read/254/172/201/plant_type')).toBe('255');
        expect(publishedPayload('cbus/read/254/172/201/plant_type_description')).toBe('Any');
    });

    it('publishes nothing for plant type when the type field is unparseable', () => {
        const line = '# aircon zone_hvac_plant_status //THEGAFF/254/172 1 0 notatype 14 0 #sourceunit=201 OID=x';
        const reading = decodeLine(line);
        publisher.publishReading(reading.network, reading.application, '201', reading);

        expect(publishedPayload('cbus/read/254/172/201/plant_type')).toBeUndefined();
        expect(publishedPayload('cbus/read/254/172/201/plant_type_description')).toBeUndefined();
        // …but the flags it could decode still went out.
        expect(publishedPayload('cbus/read/254/172/201/damper')).toBe('ON');
    });

    it('publishes no flag topics for a reading kind that carries no status bits', () => {
        // A mode reading has no §25.6.6 bits at all, so publishing ON/OFF for
        // them would assert something we were never told — and it would stick,
        // because the flag topics are retained.
        const reading = decodeLine('# aircon set_zone_hvac_mode //THEGAFF/254/172 1 0,1,2,3,4 1 0 0 0 0 3 5632 0 #sourceunit=201 OID=x');
        expect(reading.kind).toBe('mode');
        publisher.publishReading(reading.network, reading.application, '201', reading);

        for (const suffix of ['damper', 'busy', 'expansion', 'plant_type', 'plant_type_description']) {
            expect(publishedPayload(`cbus/read/254/172/201/${suffix}`)).toBeUndefined();
        }
    });

    it('leaves hvac_action reporting exactly the running state, unaffected by the new fields', () => {
        // Damper open + busy + a plant fault must not change what the climate
        // entity shows as its running action.
        publishPlantStatus(3, 110, 4); // 64(error)+32(busy)+8(damper)+4(fan)+2(heating)

        expect(publishedPayload('cbus/read/254/172/201/action')).toBe('heating');
        expect(publishedPayload('cbus/read/254/172/201/problem')).toBe('ON');
        expect(publishedPayload('cbus/read/254/172/201/error')).toBe('4');
        expect(publishedPayload('cbus/read/254/172/201/error_description')).toBe('Temperature sensor failure');
    });

    it('still derives idle with the damper open, exactly as before', () => {
        publishPlantStatus(3, 8, 0); // damper only

        expect(publishedPayload('cbus/read/254/172/201/action')).toBe('idle');
        expect(publishedPayload('cbus/read/254/172/201/damper')).toBe('ON');
    });

    it('publishes every new flag with the configured mqtt options', () => {
        publishPlantStatus(3, 46, 0);

        for (const suffix of ['damper', 'busy', 'expansion', 'plant_type', 'plant_type_description']) {
            expect(publishFn).toHaveBeenCalledWith(
                `cbus/read/254/172/201/${suffix}`,
                expect.any(String),
                mqttOptions
            );
        }
    });
});
