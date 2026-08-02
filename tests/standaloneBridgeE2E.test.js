// In-process end-to-end test for the plain "C-Gate to MQTT bridge" use case:
// no Home Assistant, no discovery, no add-on supervisor.
//
// cgateweb started life as a standalone script and that is still the shipped
// default -- settings.js leaves every ha_discovery_* line commented out and
// defaultSettings.ha_discovery_enabled is false. The HA-oriented features added
// since (discovery, security panels, CNI notifications, restart resync) all hang
// off collaborators that must stay inert in this configuration.
//
// These tests drive a real CgateWebBridge with exactly the settings.js defaults
// and assert the two things a standalone user actually depends on: C-Bus events
// reach cbus/read/... topics, and cbus/write/... commands reach C-Gate. Anything
// HA-specific must neither publish nor throw.

const CgateWebBridge = require('../src/cgateWebBridge');
const { defaultSettings } = require('../src/defaultSettings');

// Mirrors the uncommented half of settings.js -- what a user gets with the
// shipped file untouched apart from host details.
const STANDALONE_SETTINGS = {
    ...defaultSettings,
    cbusip: '127.0.0.1',
    cbusname: 'HOME',
    mqtt: '127.0.0.1:1883',
    messageinterval: 200,
    logging: false,
    log_level: 'warn'
};

function buildStandaloneBridge(overrides = {}) {
    const bridge = new CgateWebBridge({ ...STANDALONE_SETTINGS, ...overrides });

    const publishes = [];
    jest.spyOn(bridge.mqttManager, 'publish').mockImplementation((topic, payload, options) => {
        publishes.push({ topic, payload, options });
    });

    const sentCommands = [];
    jest.spyOn(bridge.cgateCommandQueue, 'add').mockImplementation((command) => {
        sentCommands.push(command);
    });

    bridge._setupEventHandlers();
    return { bridge, publishes, sentCommands };
}

describe('standalone bridge (no Home Assistant)', () => {
    let bridge;
    let publishes;
    let sentCommands;

    beforeEach(() => {
        jest.useFakeTimers();
        ({ bridge, publishes, sentCommands } = buildStandaloneBridge());
    });

    afterEach(() => {
        bridge.stateResyncCoordinator.dispose();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it('ships with Home Assistant discovery off by default', () => {
        expect(defaultSettings.ha_discovery_enabled).toBe(false);
        expect(bridge.haDiscovery).toBeNull();
    });

    describe('C-Bus event to MQTT', () => {
        it('publishes state and level for a lighting on event', () => {
            bridge._processEventLine('lighting on //HOME/254/56/4');

            expect(publishes).toContainEqual(expect.objectContaining({
                topic: 'cbus/read/254/56/4/state',
                payload: 'ON'
            }));
            expect(publishes).toContainEqual(expect.objectContaining({
                topic: 'cbus/read/254/56/4/level'
            }));
        });

        it('publishes OFF for a lighting off event', () => {
            bridge._processEventLine('lighting off //HOME/254/56/4');

            expect(publishes).toContainEqual(expect.objectContaining({
                topic: 'cbus/read/254/56/4/state',
                payload: 'OFF'
            }));
        });

        it('publishes a ramp level without any discovery config topic', () => {
            bridge._processEventLine('lighting ramp //HOME/254/56/4 128');

            expect(publishes).toContainEqual(expect.objectContaining({
                topic: 'cbus/read/254/56/4/level'
            }));
            // No homeassistant/... config should ever appear with discovery off.
            expect(publishes.filter(p => p.topic.startsWith('homeassistant/'))).toHaveLength(0);
        });
    });

    describe('MQTT command to C-Bus', () => {
        it('sends an ON command for cbus/write/.../switch', () => {
            bridge.mqttManager.emit('message', 'cbus/write/254/56/4/switch', 'ON');

            expect(sentCommands.join('')).toContain('//HOME/254/56/4');
            expect(sentCommands.join('')).toMatch(/ON/);
        });

        it('sends a ramp command for cbus/write/.../ramp', () => {
            bridge.mqttManager.emit('message', 'cbus/write/254/56/4/ramp', '50');

            expect(sentCommands.join('')).toContain('//HOME/254/56/4');
            expect(sentCommands.join('')).toMatch(/RAMP/i);
        });
    });

    describe('HA-only machinery stays inert', () => {
        // Regression for issue #44: the resync coordinator captured an
        // undefined initializationService and threw from its timer, which is an
        // uncaught exception -- fatal for a standalone script too, since the
        // 762 trigger fires regardless of whether discovery is enabled.
        it('survives a network sync event and its debounced resync', () => {
            expect(() => bridge._processEventLine('20260718-123456.789 762 //HOME/254 Network sync ok')).not.toThrow();
            expect(() => jest.runOnlyPendingTimers()).not.toThrow();
        });

        it('requests no getall levels when getallnetapp is unset', () => {
            bridge._processEventLine('20260718-123456.789 762 //HOME/254 Network sync ok');
            jest.runOnlyPendingTimers();

            expect(sentCommands.filter(c => /level/i.test(c))).toHaveLength(0);
        });

        it('sends no security status requests without ha_discovery_networks', () => {
            bridge.initializationService.sendSecurityStatusRequests('resync');

            expect(sentCommands.filter(c => /security/i.test(c))).toHaveLength(0);
        });

        it('survives an HA birth message it has no discovery configs for', () => {
            expect(() => bridge.mqttManager.emit('haOnline')).not.toThrow();
            expect(() => jest.runOnlyPendingTimers()).not.toThrow();
            expect(publishes.filter(p => p.topic.startsWith('homeassistant/'))).toHaveLength(0);
        });

        it('survives a broker reconnect with nothing to republish', () => {
            expect(() => bridge.mqttManager.emit('reconnect')).not.toThrow();
            expect(() => jest.runOnlyPendingTimers()).not.toThrow();
        });
    });

    describe('standalone getall', () => {
        it('honours getallnetapp on a resync without HA settings', () => {
            bridge.stateResyncCoordinator.dispose();
            jest.restoreAllMocks();
            ({ bridge, publishes, sentCommands } = buildStandaloneBridge({
                getallnetapp: '254/56',
                getallonstart: true
            }));

            bridge._processEventLine('20260718-123456.789 762 //HOME/254 Network sync ok');
            jest.runOnlyPendingTimers();

            expect(sentCommands.join('')).toContain('//HOME/254/56/* level');
        });
    });
});
