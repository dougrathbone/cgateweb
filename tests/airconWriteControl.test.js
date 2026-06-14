const MqttCommandRouter = require('../src/mqttCommandRouter');
const { AirconControlRegistry } = require('../src/airconControlRegistry');

function makeRouter({ control = true, withState = true } = {}) {
    const queued = [];
    const reg = new AirconControlRegistry();
    if (withState) {
        // Thermostat 202: ward 1, zone 0, running heat (type 3), setpoint 5632 (22°C)
        reg.recordModeReading({
            kind: 'mode', network: '254', application: '172', sourceUnit: '202',
            zoneGroup: '1', zones: '0', modeRaw: 1, type: 3, setpointRaw: 5632
        });
    }
    const router = new MqttCommandRouter({
        cbusname: 'THEGAFF',
        cgateCommandQueue: { add: (c) => queued.push(c) },
        settings: { cbus_aircon_app_id: '172', cbus_aircon_control_enabled: control },
        airconControlRegistry: reg
    });
    jest.spyOn(router.logger, 'warn').mockImplementation(() => {});
    jest.spyOn(router.logger, 'info').mockImplementation(() => {});
    return { router, queued };
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
});
