const {
    AirconControlRegistry,
    HVAC_CODE_BY_MODE,
    buildSetZoneHvacMode,
    buildSetWardOff
} = require('../src/airconControlRegistry');

describe('AirconControlRegistry', () => {
    let reg;
    beforeEach(() => { reg = new AirconControlRegistry(); });

    const heatReading = {
        kind: 'mode', network: '254', application: '172', sourceUnit: '201',
        zoneGroup: '1', zones: '0,1,2,3,4', mode: 'heat', modeRaw: 1, type: 3, setpointRaw: 5632,
        setbackEnabled: false, guardEnabled: false, auxLevelUsed: true, auxLevel: 0
    };

    it('captures ward/zones/type/mode/setpoint from a mode reading', () => {
        reg.recordModeReading(heatReading);
        expect(reg.get('254', '201')).toEqual({
            network: '254', application: '172', ward: '1', zones: '0,1,2,3,4',
            type: 3, modeRaw: 1, setpointRaw: 5632,
            setbackEnabled: false, guardEnabled: false, auxLevelUsed: true, auxLevel: 0
        });
    });

    it('keys by source unit so two thermostats on one ward stay distinct', () => {
        reg.recordModeReading(heatReading);
        reg.recordModeReading({ ...heatReading, sourceUnit: '202', zones: '0' });
        expect(reg.get('254', '201').zones).toBe('0,1,2,3,4');
        expect(reg.get('254', '202').zones).toBe('0');
    });

    it('keeps the running plant type and last setpoint when a later off reading carries sentinels', () => {
        reg.recordModeReading(heatReading); // on, type 3
        reg.recordModeReading({ ...heatReading, mode: 'off', modeRaw: 0, type: 255, setpointRaw: 0 });
        // type and setpoint stay from the last on reading; modeRaw updates to 0
        const s = reg.get('254', '201');
        expect(s.type).toBe(3);
        expect(s.modeRaw).toBe(0);
        expect(s.setpointRaw).toBe(5632);
    });

    it('learns the Mode & Flags + aux level, and keeps them when a later reading omits them', () => {
        reg.recordModeReading({
            ...heatReading,
            setbackEnabled: true, guardEnabled: true, auxLevelUsed: true, auxLevel: 64
        });
        reg.recordModeReading({ kind: 'mode', network: '254', application: '172', sourceUnit: '201', zoneGroup: '1', zones: '0,1,2,3,4', modeRaw: 1, type: 3, setpointRaw: 5632 });
        const s = reg.get('254', '201');
        expect(s.setbackEnabled).toBe(true);
        expect(s.guardEnabled).toBe(true);
        expect(s.auxLevelUsed).toBe(true);
        expect(s.auxLevel).toBe(64);
    });

    it('ignores non-mode readings and returns null for unknown units', () => {
        reg.recordModeReading({ kind: 'temperature', network: '254', sourceUnit: '201' });
        expect(reg.get('254', '201')).toBeNull();
        expect(reg.get('254', '999')).toBeNull();
    });

    it('reverse mode map covers the verified codes', () => {
        expect(HVAC_CODE_BY_MODE).toEqual({ off: 0, heat: 1, cool: 2, auto: 3, fan_only: 4 });
    });
});

describe('aircon command builders', () => {
    it('builds SET_ZONE_HVAC_MODE matching the broadcast field order', () => {
        const cmd = buildSetZoneHvacMode({
            cbusname: 'THEGAFF', network: '254', application: '172',
            ward: '1', zones: '0,1,2,3,4', modeRaw: 1, rawlevel: 0, type: 3, level: 5632
        });
        // <app> <ward> <zones> <mode> <rawlevel> <setback> <guard> <useaux> <type> <level> <aux>
        expect(cmd).toBe('AIRCON SET_ZONE_HVAC_MODE //THEGAFF/254/172 1 0,1,2,3,4 1 0 0 0 1 3 5632 0');
    });

    it('builds SET_ZONE_HVAC_MODE with explicit flags and aux level', () => {
        const cmd = buildSetZoneHvacMode({
            cbusname: 'THEGAFF', network: '254', application: '172',
            ward: '1', zones: '0', modeRaw: 2, rawlevel: 0,
            setback: 1, guard: 1, useaux: 0, type: 3, level: 5632, aux: 67
        });
        expect(cmd).toBe('AIRCON SET_ZONE_HVAC_MODE //THEGAFF/254/172 1 0 2 0 1 1 0 3 5632 67');
    });

    it('builds SET_WARD_OFF', () => {
        expect(buildSetWardOff({ cbusname: 'THEGAFF', network: '254', application: '172', ward: '1' }))
            .toBe('AIRCON SET_WARD_OFF //THEGAFF/254/172 1');
    });
});
