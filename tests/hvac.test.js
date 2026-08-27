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
        expect(payload.modes).toEqual(['off', 'auto']);
        expect(payload.temperature_unit).toBe('C');
        expect(payload.min_temp).toBeDefined();
        expect(payload.max_temp).toBeDefined();
        expect(payload.temp_step).toBeDefined();
    });

    test('advertises only off and auto — a lighting group cannot carry a real mode', () => {
        runDiscovery(MOCK_TREE_WITH_HVAC);

        const climateCall = mockPublishFn.mock.calls.find(c =>
            c[0] === 'homeassistant/climate/cgateweb_254_201_1/config'
        );
        const payload = JSON.parse(climateCall[1]);

        expect(payload.modes).toEqual(['off', 'auto']);
        expect(payload.modes).not.toContain('heat');
        expect(payload.modes).not.toContain('cool');
        expect(payload.modes).not.toContain('fan_only');
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
        expect(payload.current_humidity_topic).toBe('cbus/read/254/172/201/current_humidity');
        expect(payload.target_humidity_state_topic).toBeUndefined();
        expect(payload.target_humidity_command_topic).toBeUndefined();
        expect(payload.modes).toEqual(['off', 'heat', 'cool', 'auto', 'fan_only']);
        expect(payload.temperature_unit).toBe('C');
    });

    test('is read-only (no command topics) when control is not enabled', () => {
        haDiscovery.ensureNativeAirconDiscovery('254', '172', '201');
        const call = mockPublishFn.mock.calls.find(c => c[0].includes('/climate/'));
        const payload = JSON.parse(call[1]);
        expect(payload.temperature_command_topic).toBeUndefined();
        expect(payload.mode_command_topic).toBeUndefined();
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
        expect(payload.fan_mode_command_topic).toBe('cbus/write/254/172/201/fanmode');
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
        // …and every companion entity is retracted too, or an excluded
        // thermostat would leave orphans retained in the broker forever.
        const retracted = [
            ...['problem', 'sensor_problem', 'damper', 'busy']
                .map(s => `homeassistant/binary_sensor/cgateweb_254_172_250_${s}/config`),
            ...['plant_type', 'error', 'sensor_status', 'fan_speed', 'fan_speed_pct', 'comfort_level', 'humidity_mode', 'humidity_setpoint', 'humidity_action']
                .map(s => `homeassistant/sensor/cgateweb_254_172_250_${s}/config`)
        ];
        for (const topic of retracted) {
            const sensorCall = mockPublishFn.mock.calls.find(c => c[0] === topic);
            expect(sensorCall).toBeDefined();
            expect(sensorCall[1]).toBe('');
        }
    });

    test('retracts exactly the set of entities it publishes', () => {
        // The publish list and the retract list are derived from the same
        // tables; this is the assertion that keeps them that way.
        haDiscovery.ensureNativeAirconDiscovery('254', '172', '201');
        const published = mockPublishFn.mock.calls
            .filter(c => c[0].includes('cgateweb_254_172_201'))
            .map(c => c[0])
            .sort();

        mockPublishFn.mockClear();
        haDiscovery.ensureNativeAirconDiscovery('254', '172', '250'); // excluded
        const cleared = mockPublishFn.mock.calls
            .filter(c => c[1] === '')
            .map(c => c[0].replace('_250', '_201'))
            .sort();

        expect(cleared).toEqual(published);
    });

    test('publishes plant and sensor problem binary_sensors attached to the thermostat device', () => {
        haDiscovery.ensureNativeAirconDiscovery('254', '172', '201');

        const plantCall = mockPublishFn.mock.calls.find(c => c[0] === 'homeassistant/binary_sensor/cgateweb_254_172_201_problem/config');
        expect(plantCall).toBeDefined();
        const plant = JSON.parse(plantCall[1]);
        expect(plant.device_class).toBe('problem');
        expect(plant.state_topic).toBe('cbus/read/254/172/201/problem');
        expect(plant.payload_on).toBe('ON');
        expect(plant.payload_off).toBe('OFF');
        expect(plant.device.identifiers).toEqual(['cgateweb_254_172_201']);

        const sensorCall = mockPublishFn.mock.calls.find(c => c[0] === 'homeassistant/binary_sensor/cgateweb_254_172_201_sensor_problem/config');
        expect(sensorCall).toBeDefined();
        const sensor = JSON.parse(sensorCall[1]);
        expect(sensor.device_class).toBe('problem');
        expect(sensor.state_topic).toBe('cbus/read/254/172/201/sensor_problem');
        expect(sensor.device.identifiers).toEqual(['cgateweb_254_172_201']);
    });

    test('leaves the two original problem sensors out of the diagnostic category', () => {
        // They shipped without entity_category. Adding one now would move them
        // out of any dashboard a user has already built around them.
        haDiscovery.ensureNativeAirconDiscovery('254', '172', '201');
        for (const suffix of ['problem', 'sensor_problem']) {
            const call = mockPublishFn.mock.calls.find(c => c[0] === `homeassistant/binary_sensor/cgateweb_254_172_201_${suffix}/config`);
            expect(JSON.parse(call[1]).entity_category).toBeUndefined();
        }
    });

    // --- companion entities for the fields the decoder was already producing ---

    const companionPayload = (calls, component, suffix) => {
        const call = calls.find(c => c[0] === `homeassistant/${component}/cgateweb_254_172_201_${suffix}/config`);
        expect(call).toBeDefined();
        return JSON.parse(call[1]);
    };

    test('publishes damper and busy binary_sensors for the remaining §25.6.6 status bits', () => {
        haDiscovery.ensureNativeAirconDiscovery('254', '172', '201');

        const damper = companionPayload(mockPublishFn.mock.calls, 'binary_sensor', 'damper');
        expect(damper.state_topic).toBe('cbus/read/254/172/201/damper');
        expect(damper.payload_on).toBe('ON');
        expect(damper.payload_off).toBe('OFF');
        // §25.6.6 bit 3 is defined as Closed/Open, which is what 'opening' means.
        expect(damper.device_class).toBe('opening');
        expect(damper.entity_category).toBe('diagnostic');

        const busy = companionPayload(mockPublishFn.mock.calls, 'binary_sensor', 'busy');
        expect(busy.state_topic).toBe('cbus/read/254/172/201/busy');
        expect(busy.entity_category).toBe('diagnostic');
        // No device_class: 'running' would contradict hvac_action, and nothing
        // else in HA means "busy". Omitting beats guessing.
        expect(busy.device_class).toBeUndefined();
    });

    test('publishes no entity for the expansion bit, which has no defined meaning to show', () => {
        haDiscovery.ensureNativeAirconDiscovery('254', '172', '201');
        const topics = mockPublishFn.mock.calls.map(c => c[0]);
        expect(topics.some(t => t.includes('expansion'))).toBe(false);
    });

    test.each([
        ['plant_type', 'plant_type_description', 'Plant type'],
        ['error', 'error_description', 'Plant error'],
        ['sensor_status', 'sensor_status', 'Temperature sensor status'],
        ['fan_speed', 'fan_speed', 'Fan speed setting'],
        ['fan_speed_pct', 'fan_speed_pct', 'Fan output'],
        ['comfort_level', 'comfort_level', 'Comfort level'],
        ['humidity_mode', 'humidity_mode', 'Humidity mode'],
        ['humidity_setpoint', 'humidity_setpoint', 'Humidity setpoint'],
        ['humidity_action', 'humidity_action', 'Humidity action']
    ])('publishes a diagnostic sensor "%s" reading cbus/read/254/172/201/%s', (suffix, topicSuffix, name) => {
        haDiscovery.ensureNativeAirconDiscovery('254', '172', '201');

        const payload = companionPayload(mockPublishFn.mock.calls, 'sensor', suffix);
        expect(payload.name).toBe(name);
        expect(payload.unique_id).toBe(`cgateweb_254_172_201_${suffix}`);
        expect(payload.state_topic).toBe(`cbus/read/254/172/201/${topicSuffix}`);
        expect(payload.entity_category).toBe('diagnostic');
        // All of these are readouts; none gets a command topic.
        expect(payload.command_topic).toBeUndefined();
    });

    test('gives fan output a percent unit but no device_class', () => {
        haDiscovery.ensureNativeAirconDiscovery('254', '172', '201');
        const payload = companionPayload(mockPublishFn.mock.calls, 'sensor', 'fan_speed_pct');
        expect(payload.unit_of_measurement).toBe('%');
        expect(payload.state_class).toBe('measurement');
        // Same reasoning as measurementDecoder's unit $1A: a percentage is not
        // a humidity, and HA has no "percent of capacity" class.
        expect(payload.device_class).toBeUndefined();
    });

    test('gives the humidity setpoint a percent unit', () => {
        haDiscovery.ensureNativeAirconDiscovery('254', '172', '201');
        const payload = companionPayload(mockPublishFn.mock.calls, 'sensor', 'humidity_setpoint');
        expect(payload.unit_of_measurement).toBe('%');
        expect(payload.state_class).toBe('measurement');
    });

    test('leaves the plant-dependent sensors unitless rather than inventing one', () => {
        haDiscovery.ensureNativeAirconDiscovery('254', '172', '201');
        for (const suffix of ['plant_type', 'error', 'sensor_status', 'fan_speed', 'comfort_level', 'humidity_mode', 'humidity_action']) {
            const payload = companionPayload(mockPublishFn.mock.calls, 'sensor', suffix);
            expect(payload.unit_of_measurement).toBeUndefined();
            expect(payload.device_class).toBeUndefined();
        }
    });

    test('attaches every companion entity to the thermostat device, not a new one', () => {
        haDiscovery.ensureNativeAirconDiscovery('254', '172', '202'); // has a custom label

        const climate = JSON.parse(mockPublishFn.mock.calls
            .find(c => c[0] === 'homeassistant/climate/cgateweb_254_172_202/config')[1]);

        const companions = mockPublishFn.mock.calls
            .filter(c => /\/(sensor|binary_sensor)\/cgateweb_254_172_202_/.test(c[0]))
            .map(c => JSON.parse(c[1]));

        expect(companions).toHaveLength(13); // 4 binary_sensors + 9 sensors
        for (const payload of companions) {
            expect(payload.device.identifiers).toEqual(climate.device.identifiers);
            expect(payload.device.name).toBe('Master Bedroom AC');
            expect(payload.device.model).toBe('C-Bus Air Conditioning Thermostat');
        }
    });

    test('publishes the companion entities even when control is disabled', () => {
        // They are readouts; none of them depends on cbus_aircon_control_enabled.
        expect(haDiscovery.settings.cbus_aircon_control_enabled).toBeUndefined();
        haDiscovery.ensureNativeAirconDiscovery('254', '172', '201');
        const companions = mockPublishFn.mock.calls
            .filter(c => /\/(sensor|binary_sensor)\/cgateweb_254_172_201_/.test(c[0]));
        expect(companions).toHaveLength(13);
    });

    test('does not change the climate entity while adding companions', () => {
        // An additive change that quietly rewired the climate entity would be
        // invisible in the tests above, so pin its whole shape here.
        haDiscovery.ensureNativeAirconDiscovery('254', '172', '201');
        const payload = JSON.parse(mockPublishFn.mock.calls
            .find(c => c[0] === 'homeassistant/climate/cgateweb_254_172_201/config')[1]);

        expect(payload.action_topic).toBe('cbus/read/254/172/201/action');
        expect(payload.current_temperature_topic).toBe('cbus/read/254/172/201/current_temperature');
        expect(payload.temperature_state_topic).toBe('cbus/read/254/172/201/setpoint');
        expect(payload.mode_state_topic).toBe('cbus/read/254/172/201/mode');
        expect(payload.fan_mode_state_topic).toBe('cbus/read/254/172/201/fan_mode');
        expect(payload.fan_modes).toEqual(['automatic', 'continuous']);
        expect(payload.modes).toEqual(['off', 'heat', 'cool', 'auto', 'fan_only']);
        expect(payload.current_humidity_topic).toBe('cbus/read/254/172/201/current_humidity');
        expect(payload.target_humidity_state_topic).toBeUndefined();
        expect(payload.min_temp).toBe(10);
        expect(payload.max_temp).toBe(32);
        expect(payload.temp_step).toBe(0.5);
        // The new readouts stay off the climate entity entirely.
        expect(payload.entity_category).toBeUndefined();
        for (const key of ['damper', 'busy', 'plant_type', 'fan_speed', 'comfort_level']) {
            expect(JSON.stringify(payload)).not.toContain(`/${key}`);
        }
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
            ['25', ' 50'], ['20', ' 40'], ['10', ' 20'], ['32', ' 64'],
            ['0', ' 20'], ['50', ' 64'], ['99', ' 64'], ['-5', ' 20'],
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

        test('auto mode sends C-Gate ON command to correct address', () => {
            router.routeMessage('cbus/write/254/201/1/hvacmode', 'auto');

            const cmd = mockQueue.add.mock.calls[0][0];
            expect(cmd).toMatch(/^ON /);
            expect(cmd).toContain('//HOME/254/201/1');
        });

        test.each(['heat', 'cool', 'heat_cool', 'dry', 'fan_only'])(
            '%s mode sends nothing and explains why', (mode) => {
                router.routeMessage('cbus/write/254/201/1/hvacmode', mode);

                expect(mockQueue.add).not.toHaveBeenCalled();
                expect(console.warn).toHaveBeenCalledWith(
                    expect.stringContaining('ha_discovery_hvac_app_id')
                );
                expect(console.warn).toHaveBeenCalledWith(
                    expect.stringContaining('cbus_aircon_app_id')
                );
            }
        );

        test('unknown mode sends no command and logs a warning', () => {
            router.routeMessage('cbus/write/254/201/1/hvacmode', 'turbo');

            expect(mockQueue.add).not.toHaveBeenCalled();
            expect(console.warn).toHaveBeenCalledWith(
                expect.stringContaining('Unknown HVAC mode')
            );
        });
    });
});
