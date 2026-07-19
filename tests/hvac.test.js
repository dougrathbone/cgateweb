/**
 * Tests for C-Bus HVAC (Application 201) support.
 *
 * Covers:
 * - ConfigLoader: maps ha_discovery_hvac_app_id and ha_hvac_temperature_unit correctly
 * - EventPublisher: handles HVAC events, publishes to climate MQTT topics
 * - HaDiscovery: publishes climate entity discovery config with required HA fields
 * - MqttCommandRouter: handles setpoint and mode commands
 */

const fs = require('fs');
const CBusEvent = require('../src/cbusEvent');
const EventPublisher = require('../src/eventPublisher');
const HaDiscovery = require('../src/haDiscovery');
const MqttCommandRouter = require('../src/mqttCommandRouter');
const ConfigLoader = require('../src/config/ConfigLoader');
const EnvironmentDetector = require('../src/config/EnvironmentDetector');

jest.mock('fs');
jest.mock('../src/config/EnvironmentDetector');

// ============================================================
// ConfigLoader — HVAC settings mapping
// ============================================================

describe('ConfigLoader — HVAC settings', () => {
    let configLoader;
    let mockEnvironmentDetector;

    beforeEach(() => {
        jest.clearAllMocks();

        mockEnvironmentDetector = {
            detect: jest.fn().mockReturnValue({
                type: 'addon',
                isAddon: true,
                isStandalone: false,
                optionsPath: '/data/options.json',
                dataPath: '/data',
                configPath: '/config'
            }),
            getEnvironmentInfo: jest.fn(),
            reset: jest.fn()
        };

        EnvironmentDetector.mockImplementation(() => mockEnvironmentDetector);
        configLoader = new ConfigLoader();
    });

    test('maps ha_discovery_hvac_app_id to string when set', () => {
        const options = {
            cgate_host: '192.168.1.1',
            ha_discovery_enabled: true,
            ha_discovery_hvac_app_id: 201,
            ha_hvac_temperature_unit: 'C'
        };
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify(options));

        const config = configLoader.load();

        expect(config.ha_discovery_hvac_app_id).toBe('201');
        expect(config.ha_hvac_temperature_unit).toBe('C');
    });

    test('does not set ha_discovery_hvac_app_id when not provided', () => {
        const options = {
            cgate_host: '192.168.1.1',
            ha_discovery_enabled: true
        };
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify(options));

        const config = configLoader.load();

        expect(config.ha_discovery_hvac_app_id).toBeUndefined();
    });

    test('maps Fahrenheit temperature unit', () => {
        const options = {
            cgate_host: '192.168.1.1',
            ha_discovery_enabled: true,
            ha_discovery_hvac_app_id: 201,
            ha_hvac_temperature_unit: 'F'
        };
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(JSON.stringify(options));

        const config = configLoader.load();

        expect(config.ha_hvac_temperature_unit).toBe('F');
    });
});

// ============================================================
// EventPublisher — HVAC event handling
// ============================================================

describe('EventPublisher — HVAC events', () => {
    let publisher;
    let mockPublishFn;
    let mockLogger;

    const HVAC_APP_ID = '201';

    beforeEach(() => {
        mockPublishFn = jest.fn();
        mockLogger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            isLevelEnabled: jest.fn(() => true)
        };

        publisher = new EventPublisher({
            settings: {
                ha_discovery_hvac_app_id: HVAC_APP_ID,
                ha_discovery_pir_app_id: null,
                ha_discovery_cover_app_id: null,
                ha_discovery_trigger_app_id: null,
                logging: false
            },
            publishFn: mockPublishFn,
            mqttOptions: { retain: true, qos: 0 },
            logger: mockLogger
        });
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    test('publishes current_temperature and setpoint for HVAC ramp event with level', () => {
        // level 50 → 50/2 = 25.0°C
        const event = new CBusEvent(`lighting ramp 254/${HVAC_APP_ID}/1 50`);
        publisher.publishEvent(event, '(Test)');

        const calls = mockPublishFn.mock.calls;
        const topics = calls.map(c => c[0]);

        expect(topics).toContain(`cbus/read/254/${HVAC_APP_ID}/1/current_temperature`);
        expect(topics).toContain(`cbus/read/254/${HVAC_APP_ID}/1/setpoint`);
        expect(topics).toContain(`cbus/read/254/${HVAC_APP_ID}/1/mode`);

        const tempCall = calls.find(c => c[0].endsWith('/current_temperature'));
        expect(tempCall[1]).toBe('25.0');

        const setpointCall = calls.find(c => c[0].endsWith('/setpoint'));
        expect(setpointCall[1]).toBe('25.0');
    });

    test('publishes mode=off for HVAC off event', () => {
        const event = new CBusEvent(`lighting off 254/${HVAC_APP_ID}/1`);
        publisher.publishEvent(event, '(Test)');

        const modeCall = mockPublishFn.mock.calls.find(c => c[0].endsWith('/mode'));
        expect(modeCall).toBeDefined();
        expect(modeCall[1]).toBe('off');
    });

    test('publishes mode=auto for HVAC on event (no level)', () => {
        const event = new CBusEvent(`lighting on 254/${HVAC_APP_ID}/1`);
        publisher.publishEvent(event, '(Test)');

        const modeCall = mockPublishFn.mock.calls.find(c => c[0].endsWith('/mode'));
        expect(modeCall).toBeDefined();
        expect(modeCall[1]).toBe('auto');
    });

    test('does NOT publish state/level topics for HVAC events', () => {
        const event = new CBusEvent(`lighting ramp 254/${HVAC_APP_ID}/2 100`);
        publisher.publishEvent(event, '(Test)');

        const topics = mockPublishFn.mock.calls.map(c => c[0]);
        expect(topics.some(t => t.endsWith('/state'))).toBe(false);
        expect(topics.some(t => t.endsWith('/level'))).toBe(false);
    });

    test('temperature encoding: level 0 → 0.0°C', () => {
        const event = new CBusEvent(`lighting ramp 254/${HVAC_APP_ID}/3 0`);
        publisher.publishEvent(event, '(Test)');

        const tempCall = mockPublishFn.mock.calls.find(c => c[0].endsWith('/current_temperature'));
        expect(tempCall[1]).toBe('0.0');
    });

    test('temperature encoding: level 100 → 50.0°C', () => {
        const event = new CBusEvent(`lighting ramp 254/${HVAC_APP_ID}/3 100`);
        publisher.publishEvent(event, '(Test)');

        const tempCall = mockPublishFn.mock.calls.find(c => c[0].endsWith('/current_temperature'));
        expect(tempCall[1]).toBe('50.0');
    });

    test('temperature encoding: level 40 → 20.0°C', () => {
        const event = new CBusEvent(`lighting ramp 254/${HVAC_APP_ID}/4 40`);
        publisher.publishEvent(event, '(Test)');

        const tempCall = mockPublishFn.mock.calls.find(c => c[0].endsWith('/current_temperature'));
        expect(tempCall[1]).toBe('20.0');
    });

    test('non-HVAC events are unaffected when HVAC app is configured', () => {
        const event = new CBusEvent('lighting on 254/56/10');
        publisher.publishEvent(event, '(Test)');

        const topics = mockPublishFn.mock.calls.map(c => c[0]);
        expect(topics).toContain('cbus/read/254/56/10/state');
        expect(topics).toContain('cbus/read/254/56/10/level');
        expect(topics.some(t => t.includes('/current_temperature'))).toBe(false);
    });

    test('does nothing for HVAC events when ha_discovery_hvac_app_id is not configured', () => {
        const publisherNoHvac = new EventPublisher({
            settings: {
                ha_discovery_hvac_app_id: null,
                ha_discovery_pir_app_id: null,
                ha_discovery_cover_app_id: null,
                ha_discovery_trigger_app_id: null,
                logging: false
            },
            publishFn: mockPublishFn,
            mqttOptions: { retain: true, qos: 0 },
            logger: mockLogger
        });

        const event = new CBusEvent('lighting ramp 254/201/1 50');
        publisherNoHvac.publishEvent(event, '(Test)');

        // Should publish as a regular lighting event (state + level)
        const topics = mockPublishFn.mock.calls.map(c => c[0]);
        expect(topics).toContain('cbus/read/254/201/1/state');
        expect(topics.some(t => t.endsWith('/current_temperature'))).toBe(false);
    });
});

// ============================================================
// HaDiscovery — climate entity discovery config
// ============================================================

describe('HaDiscovery — HVAC climate entity discovery', () => {
    let haDiscovery;
    let mockPublishFn;
    let mockSendCommandFn;

    const MOCK_TREE_WITH_HVAC = {
        Network: {
            Interface: {
                Network: {
                    NetworkNumber: '254',
                    Unit: [
                        {
                            UnitAddress: '100',
                            Application: [
                                {
                                    ApplicationAddress: '201',
                                    Group: [
                                        { GroupAddress: '1', Label: 'Living Room AC' },
                                        { GroupAddress: '2', Label: 'Bedroom AC' }
                                    ]
                                }
                            ]
                        }
                    ]
                }
            }
        }
    };

    beforeEach(() => {
        mockPublishFn = jest.fn();
        mockSendCommandFn = jest.fn();

        haDiscovery = new HaDiscovery(
            {
                ha_discovery_enabled: true,
                ha_discovery_prefix: 'homeassistant',
                ha_discovery_networks: ['254'],
                ha_discovery_hvac_app_id: '201',
                ha_hvac_temperature_unit: 'C',
                ha_discovery_cover_app_id: null,
                ha_discovery_switch_app_id: null,
                ha_discovery_relay_app_id: null,
                ha_discovery_pir_app_id: null,
                ha_discovery_trigger_app_id: null,
                cbusname: 'HOME',
                getallnetapp: null
            },
            mockPublishFn,
            mockSendCommandFn
        );

        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    function runDiscovery(treeData) {
        haDiscovery.handleTreeStart('343');
        haDiscovery.handleTreeEnd('344');
        // Directly call internal method to bypass XML parsing
        haDiscovery._publishDiscoveryFromTree('254', treeData);
    }

    test('publishes a climate entity for each HVAC group', () => {
        runDiscovery(MOCK_TREE_WITH_HVAC);

        const climateCalls = mockPublishFn.mock.calls.filter(c =>
            c[0].includes('/climate/')
        );
        expect(climateCalls).toHaveLength(2);
    });

    test('climate discovery topic uses correct HA prefix and component', () => {
        runDiscovery(MOCK_TREE_WITH_HVAC);

        const topics = mockPublishFn.mock.calls.map(c => c[0]);
        expect(topics).toContain('homeassistant/climate/cgateweb_254_201_1/config');
        expect(topics).toContain('homeassistant/climate/cgateweb_254_201_2/config');
    });

    test('climate config does NOT mark commands as retained (retained commands replay on reconnect)', () => {
        runDiscovery(MOCK_TREE_WITH_HVAC);

        const climateCall = mockPublishFn.mock.calls.find(c =>
            c[0] === 'homeassistant/climate/cgateweb_254_201_1/config'
        );
        expect(climateCall).toBeDefined();
        expect(JSON.parse(climateCall[1]).retain).not.toBe(true);
    });

    test('climate entity payload has required Home Assistant climate fields', () => {
        runDiscovery(MOCK_TREE_WITH_HVAC);

        const climateCall = mockPublishFn.mock.calls.find(c =>
            c[0] === 'homeassistant/climate/cgateweb_254_201_1/config'
        );
        expect(climateCall).toBeDefined();
        const payload = JSON.parse(climateCall[1]);

        // Required HA climate fields
        expect(payload.current_temperature_topic).toBeDefined();
        expect(payload.temperature_command_topic).toBeDefined();
        expect(payload.temperature_state_topic).toBeDefined();
        expect(payload.mode_command_topic).toBeDefined();
        expect(payload.mode_state_topic).toBeDefined();
        expect(payload.modes).toEqual(expect.arrayContaining(['off', 'auto', 'cool', 'heat', 'fan_only']));
        expect(payload.temperature_unit).toBe('C');
        expect(payload.min_temp).toBeDefined();
        expect(payload.max_temp).toBeDefined();
        expect(payload.temp_step).toBeDefined();
    });

    test('climate entity topics use correct MQTT paths', () => {
        runDiscovery(MOCK_TREE_WITH_HVAC);

        const climateCall = mockPublishFn.mock.calls.find(c =>
            c[0] === 'homeassistant/climate/cgateweb_254_201_1/config'
        );
        const payload = JSON.parse(climateCall[1]);

        expect(payload.current_temperature_topic).toBe('cbus/read/254/201/1/current_temperature');
        expect(payload.temperature_state_topic).toBe('cbus/read/254/201/1/setpoint');
        expect(payload.temperature_command_topic).toBe('cbus/write/254/201/1/setpoint');
        expect(payload.mode_state_topic).toBe('cbus/read/254/201/1/mode');
        expect(payload.mode_command_topic).toBe('cbus/write/254/201/1/hvacmode');
    });

    test('climate entity uses label from TREEXML', () => {
        runDiscovery(MOCK_TREE_WITH_HVAC);

        const climateCall = mockPublishFn.mock.calls.find(c =>
            c[0] === 'homeassistant/climate/cgateweb_254_201_1/config'
        );
        const payload = JSON.parse(climateCall[1]);

        expect(payload.device.name).toBe('Living Room AC');
    });

    test('climate entity has unique_id and device fields', () => {
        runDiscovery(MOCK_TREE_WITH_HVAC);

        const climateCall = mockPublishFn.mock.calls.find(c =>
            c[0] === 'homeassistant/climate/cgateweb_254_201_1/config'
        );
        const payload = JSON.parse(climateCall[1]);

        expect(payload.unique_id).toBe('cgateweb_254_201_1');
        expect(payload.device).toBeDefined();
        expect(payload.device.identifiers).toContain('cgateweb_254_201_1');
        expect(payload.origin).toBeDefined();
    });

    test('uses Fahrenheit unit when configured', () => {
        haDiscovery.settings.ha_hvac_temperature_unit = 'F';
        runDiscovery(MOCK_TREE_WITH_HVAC);

        const climateCall = mockPublishFn.mock.calls.find(c =>
            c[0].includes('/climate/cgateweb_254_201_1/config')
        );
        const payload = JSON.parse(climateCall[1]);

        expect(payload.temperature_unit).toBe('F');
    });

    test('no HVAC entities published when ha_discovery_hvac_app_id not set', () => {
        haDiscovery.settings.ha_discovery_hvac_app_id = null;
        runDiscovery(MOCK_TREE_WITH_HVAC);

        const climateCalls = mockPublishFn.mock.calls.filter(c =>
            c[0].includes('/climate/')
        );
        expect(climateCalls).toHaveLength(0);
    });
});

// ============================================================
// HaDiscovery — native Air Conditioning (172) event-driven discovery
// ============================================================

describe('HaDiscovery — native Air Conditioning (172) event-driven discovery', () => {
    let haDiscovery;
    let mockPublishFn;

    beforeEach(() => {
        mockPublishFn = jest.fn();
        haDiscovery = new HaDiscovery(
            {
                ha_discovery_enabled: true,
                ha_discovery_prefix: 'homeassistant',
                ha_hvac_temperature_unit: 'C'
            },
            mockPublishFn,
            jest.fn(),
            {
                labels: new Map([['254/172/202', 'Master Bedroom AC']]),
                exclude: new Set(['254/172/250'])
            }
        );
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => jest.restoreAllMocks());

    test('publishes a climate entity the first time a thermostat unit is seen, keyed by source unit', () => {
        const published = haDiscovery.ensureNativeAirconDiscovery('254', '172', '201');
        expect(published).toBe(true);

        const call = mockPublishFn.mock.calls.find(c => c[0] === 'homeassistant/climate/cgateweb_254_172_201/config');
        expect(call).toBeDefined();
        const payload = JSON.parse(call[1]);
        expect(payload.current_temperature_topic).toBe('cbus/read/254/172/201/current_temperature');
        expect(payload.temperature_state_topic).toBe('cbus/read/254/172/201/setpoint');
        expect(payload.mode_state_topic).toBe('cbus/read/254/172/201/mode');
        expect(payload.action_topic).toBe('cbus/read/254/172/201/action');
        expect(payload.fan_mode_state_topic).toBe('cbus/read/254/172/201/fan_mode');
        expect(payload.fan_modes).toEqual(['automatic', 'continuous']);
        expect(payload.modes).toEqual(['off', 'heat', 'cool', 'auto', 'fan_only']);
        expect(payload.temperature_unit).toBe('C');
    });

    test('is read-only (no command topics) when control is not enabled', () => {
        haDiscovery.ensureNativeAirconDiscovery('254', '172', '201');
        const call = mockPublishFn.mock.calls.find(c => c[0].includes('/climate/'));
        const payload = JSON.parse(call[1]);
        expect(payload.temperature_command_topic).toBeUndefined();
        expect(payload.mode_command_topic).toBeUndefined();
        // Fan mode stays read-only even with control enabled: the control path
        // does not write the Aux Level.
        expect(payload.fan_mode_command_topic).toBeUndefined();
    });

    test('adds command topics when cbus_aircon_control_enabled is set', () => {
        const controlDiscovery = new HaDiscovery(
            { ha_discovery_enabled: true, ha_discovery_prefix: 'homeassistant', ha_hvac_temperature_unit: 'C', cbus_aircon_control_enabled: true },
            mockPublishFn,
            jest.fn()
        );
        controlDiscovery.ensureNativeAirconDiscovery('254', '172', '201');
        const call = mockPublishFn.mock.calls.find(c => c[0] === 'homeassistant/climate/cgateweb_254_172_201/config');
        const payload = JSON.parse(call[1]);
        expect(payload.temperature_command_topic).toBe('cbus/write/254/172/201/setpoint');
        expect(payload.mode_command_topic).toBe('cbus/write/254/172/201/hvacmode');
    });

    test('publishes only once per unit (idempotent across repeated events)', () => {
        expect(haDiscovery.ensureNativeAirconDiscovery('254', '172', '201')).toBe(true);
        expect(haDiscovery.ensureNativeAirconDiscovery('254', '172', '201')).toBe(false);
        const climateCalls = mockPublishFn.mock.calls.filter(c => c[0].includes('/climate/'));
        expect(climateCalls).toHaveLength(1);
    });

    test('creates distinct entities for two thermostats sharing a zone group', () => {
        haDiscovery.ensureNativeAirconDiscovery('254', '172', '201');
        haDiscovery.ensureNativeAirconDiscovery('254', '172', '202');
        const topics = mockPublishFn.mock.calls.map(c => c[0]);
        expect(topics).toContain('homeassistant/climate/cgateweb_254_172_201/config');
        expect(topics).toContain('homeassistant/climate/cgateweb_254_172_202/config');
    });

    test('uses a custom label for the device name when one is configured', () => {
        haDiscovery.ensureNativeAirconDiscovery('254', '172', '202');
        const call = mockPublishFn.mock.calls.find(c => c[0].includes('cgateweb_254_172_202'));
        expect(JSON.parse(call[1]).device.name).toBe('Master Bedroom AC');
    });

    test('respects the exclude list and clears any previously-published entity', () => {
        expect(haDiscovery.ensureNativeAirconDiscovery('254', '172', '250')).toBe(false);
        // No entity config is created — but a blank payload is published to the
        // config topic so a stale entity (e.g. a mirroring PAC) disappears from HA.
        const call = mockPublishFn.mock.calls.find(c => c[0] === 'homeassistant/climate/cgateweb_254_172_250/config');
        expect(call).toBeDefined();
        expect(call[1]).toBe('');
    });

    test('bounds the climate entity to the C-Bus thermostat range (10–32°C)', () => {
        haDiscovery.ensureNativeAirconDiscovery('254', '172', '201');
        const call = mockPublishFn.mock.calls.find(c => c[0] === 'homeassistant/climate/cgateweb_254_172_201/config');
        const payload = JSON.parse(call[1]);
        expect(payload.min_temp).toBe(10);
        expect(payload.max_temp).toBe(32);
    });

    test('does nothing when ha_discovery_enabled is false', () => {
        haDiscovery.settings.ha_discovery_enabled = false;
        expect(haDiscovery.ensureNativeAirconDiscovery('254', '172', '201')).toBe(false);
        expect(mockPublishFn).not.toHaveBeenCalled();
    });
});

// ============================================================
// MqttCommandRouter — HVAC command routing
// ============================================================

describe('MqttCommandRouter — HVAC commands', () => {
    let router;
    let mockQueue;

    beforeEach(() => {
        mockQueue = { add: jest.fn() };
        const mockEmitter = { on: jest.fn(), removeListener: jest.fn() };

        router = new MqttCommandRouter({
            cbusname: 'HOME',
            ha_discovery_enabled: true,
            internalEventEmitter: mockEmitter,
            cgateCommandQueue: mockQueue
        });

        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('setpoint commands', () => {
        test('sends RAMP command with correct address and level', () => {
            router.routeMessage('cbus/write/254/201/1/setpoint', '25');

            expect(mockQueue.add).toHaveBeenCalledTimes(1);
            const cmd = mockQueue.add.mock.calls[0][0];
            expect(cmd).toContain('RAMP');
            expect(cmd).toContain('//HOME/254/201/1');
            expect(cmd).toContain(' 50');
        });

        test.each([
            ['25', ' 50'], ['20', ' 40'], ['0', ' 0'], ['50', ' 100'],
            ['99', ' 100'], ['-5', ' 0'],
        ])('maps %s°C to correct C-Bus level', (temp, expectedLevel) => {
            router.routeMessage('cbus/write/254/201/1/setpoint', temp);
            expect(mockQueue.add.mock.calls[0][0]).toContain(expectedLevel);
        });

        test('ignores invalid setpoint payload', () => {
            router.routeMessage('cbus/write/254/201/1/setpoint', 'notanumber');
            expect(mockQueue.add).not.toHaveBeenCalled();
        });
    });

    describe('mode commands', () => {
        test('off mode sends C-Gate OFF command to correct address', () => {
            router.routeMessage('cbus/write/254/201/1/hvacmode', 'off');

            const cmd = mockQueue.add.mock.calls[0][0];
            expect(cmd).toMatch(/^OFF /);
            expect(cmd).toContain('//HOME/254/201/1');
        });

        test.each(['auto', 'cool', 'heat', 'fan_only'])(
            '%s mode sends C-Gate ON command', (mode) => {
                router.routeMessage('cbus/write/254/201/1/hvacmode', mode);
                expect(mockQueue.add.mock.calls[0][0]).toMatch(/^ON /);
            }
        );

        test('unknown mode sends no command and logs a warning', () => {
            router.routeMessage('cbus/write/254/201/1/hvacmode', 'turbo');
            expect(mockQueue.add).not.toHaveBeenCalled();
        });
    });
});
