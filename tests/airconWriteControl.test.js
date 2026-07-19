const MqttCommandRouter = require('../src/mqttCommandRouter');
const { AirconControlRegistry } = require('../src/airconControlRegistry');

function makeRouter({ control = true, withState = true, retainreads = false } = {}) {
    const queued = [];
    const reg = new AirconControlRegistry();
    if (withState) {
        // Thermostat 202: ward 1, zone 0, running heat (type 3), setpoint 5632 (22°C)
        reg.recordModeReading({
            kind: 'mode', network: '254', application: '172', sourceUnit: '202',
            zoneGroup: '1', zones: '0', modeRaw: 1, type: 3, setpointRaw: 5632
        });
    }
    const published = [];
    const router = new MqttCommandRouter({
        cbusname: 'THEGAFF',
        cgateCommandQueue: { add: (c) => queued.push(c) },
        mqttClient: { publish: (topic, payload, opts) => published.push({ topic, payload, opts }) },
        settings: { cbus_aircon_app_id: '172', cbus_aircon_control_enabled: control, retainreads },
        airconControlRegistry: reg
    });
    jest.spyOn(router.logger, 'warn').mockImplementation(() => {});
    jest.spyOn(router.logger, 'info').mockImplementation(() => {});
    return { router, queued, published };
}

describe('native HVAC write control (AIRCON commands)', () => {
    afterEach(() => jest.restoreAllMocks());

    it('setpoint → AIRCON SET_ZONE_HVAC_MODE keeping current mode, new temperature', () => {
        const { router, queued } = makeRouter();
        router.routeMessage('cbus/write/254/172/202/setpoint', '25');
        expect(queued).toHaveLength(1);
        // mode stays 1 (heat), rawlevel 0, type 3, level = 25*256 = 6400, targeting ward 1 zone 0
        expect(queued[0].trim()).toBe('AIRCON SET_ZONE_HVAC_MODE //THEGAFF/254/172 1 0 1 0 0 0 1 3 6400 0');
    });

    it('mode off → AIRCON SET_WARD_OFF', () => {
        const { router, queued } = makeRouter();
        router.routeMessage('cbus/write/254/172/202/hvacmode', 'off');
        expect(queued[0].trim()).toBe('AIRCON SET_WARD_OFF //THEGAFF/254/172 1');
    });

    it('mode cool → SET_ZONE_HVAC_MODE with code 2, keeping last setpoint', () => {
        const { router, queued } = makeRouter();
        router.routeMessage('cbus/write/254/172/202/hvacmode', 'cool');
        expect(queued[0].trim()).toBe('AIRCON SET_ZONE_HVAC_MODE //THEGAFF/254/172 1 0 2 0 0 0 1 3 5632 0');
    });

    it('mode cool after off broadcast keeps the last active setpoint, not the default', () => {
        const { router, queued } = makeRouter();
        router.airconControlRegistry.recordModeReading({
            kind: 'mode', network: '254', application: '172', sourceUnit: '202',
            zoneGroup: '1', zones: '0', mode: 'off', modeRaw: 0, type: 255, setpointRaw: 0
        });
        router.routeMessage('cbus/write/254/172/202/hvacmode', 'cool');
        expect(queued[0].trim()).toBe('AIRCON SET_ZONE_HVAC_MODE //THEGAFF/254/172 1 0 2 0 0 0 1 3 5632 0');
    });

    it('mode fan_only → raw-level sentinel (rawlevel 1, level 32512)', () => {
        const { router, queued } = makeRouter();
        router.routeMessage('cbus/write/254/172/202/hvacmode', 'fan_only');
        expect(queued[0].trim()).toBe('AIRCON SET_ZONE_HVAC_MODE //THEGAFF/254/172 1 0 4 1 0 0 1 3 32512 0');
    });

    it('targets the right thermostat by its zone-list (201 vs 202 share ward 1)', () => {
        const { router, queued } = makeRouter();
        // add 201 with zones 0,1,2,3,4
        router.airconControlRegistry.recordModeReading({
            kind: 'mode', network: '254', application: '172', sourceUnit: '201',
            zoneGroup: '1', zones: '0,1,2,3,4', modeRaw: 1, type: 3, setpointRaw: 5632
        });
        router.routeMessage('cbus/write/254/172/201/setpoint', '20');
        expect(queued[0].trim()).toBe('AIRCON SET_ZONE_HVAC_MODE //THEGAFF/254/172 1 0,1,2,3,4 1 0 0 0 1 3 5120 0');
    });

    it('does nothing when control is disabled', () => {
        const { router, queued } = makeRouter({ control: false });
        router.routeMessage('cbus/write/254/172/202/setpoint', '25');
        router.routeMessage('cbus/write/254/172/202/hvacmode', 'cool');
        expect(queued).toHaveLength(0);
    });

    it('does nothing until the thermostat has reported (no registry state)', () => {
        const { router, queued } = makeRouter({ withState: false });
        router.routeMessage('cbus/write/254/172/202/setpoint', '25');
        expect(queued).toHaveLength(0);
    });

    it('clamps setpoint to the thermostat range (10–32°C)', () => {
        const { router, queued } = makeRouter();
        router.routeMessage('cbus/write/254/172/202/setpoint', '50'); // → 32°C = 8192
        router.routeMessage('cbus/write/254/172/202/setpoint', '5');  // → 10°C = 2560
        expect(queued[0].trim()).toBe('AIRCON SET_ZONE_HVAC_MODE //THEGAFF/254/172 1 0 1 0 0 0 1 3 8192 0');
        expect(queued[1].trim()).toBe('AIRCON SET_ZONE_HVAC_MODE //THEGAFF/254/172 1 0 1 0 0 0 1 3 2560 0');
    });

    it('echoes the thermostat\'s learned flags and aux level instead of clearing them', () => {
        const { router, queued } = makeRouter();
        // Thermostat reports setback enabled, guard off, aux used with continuous fan
        router.airconControlRegistry.recordModeReading({
            kind: 'mode', network: '254', application: '172', sourceUnit: '202',
            zoneGroup: '1', zones: '0', modeRaw: 1, type: 3, setpointRaw: 5632,
            setbackEnabled: true, guardEnabled: false, auxLevelUsed: true, auxLevel: 64
        });
        router.routeMessage('cbus/write/254/172/202/setpoint', '25');
        expect(queued[0].trim()).toBe('AIRCON SET_ZONE_HVAC_MODE //THEGAFF/254/172 1 0 1 0 1 0 1 3 6400 64');
    });

    it('sends useaux=0 when the thermostat broadcasts aux-unused', () => {
        const { router, queued } = makeRouter();
        router.airconControlRegistry.recordModeReading({
            kind: 'mode', network: '254', application: '172', sourceUnit: '202',
            zoneGroup: '1', zones: '0', modeRaw: 1, type: 3, setpointRaw: 5632,
            setbackEnabled: false, guardEnabled: false, auxLevelUsed: false, auxLevel: 0
        });
        router.routeMessage('cbus/write/254/172/202/setpoint', '25');
        expect(queued[0].trim()).toBe('AIRCON SET_ZONE_HVAC_MODE //THEGAFF/254/172 1 0 1 0 0 0 0 3 6400 0');
    });

    it('optimistically publishes the new state so HA updates instantly', () => {
        const { router, published } = makeRouter();
        router.routeMessage('cbus/write/254/172/202/setpoint', '25');
        router.routeMessage('cbus/write/254/172/202/hvacmode', 'cool');
        router.routeMessage('cbus/write/254/172/202/hvacmode', 'off');
        expect(published).toContainEqual({ topic: 'cbus/read/254/172/202/setpoint', payload: '25', opts: { qos: 0 } });
        expect(published).toContainEqual({ topic: 'cbus/read/254/172/202/mode', payload: 'cool', opts: { qos: 0 } });
        expect(published).toContainEqual({ topic: 'cbus/read/254/172/202/mode', payload: 'off', opts: { qos: 0 } });
    });

    it('retains optimistic HVAC state only when retainreads is enabled', () => {
        const { router, published } = makeRouter({ retainreads: true });
        router.routeMessage('cbus/write/254/172/202/setpoint', '25');
        expect(published).toContainEqual({
            topic: 'cbus/read/254/172/202/setpoint',
            payload: '25',
            opts: { retain: true, qos: 0 }
        });
    });
});
