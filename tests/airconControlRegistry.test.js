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
        zoneGroup: '1', zones: '0,1,2,3,4', mode: 'heat', modeRaw: 1, type: 3, setpointRaw: 5632
    };

    it('captures ward/zones/type/mode/setpoint from a mode reading', () => {
        reg.recordModeReading(heatReading);
        expect(reg.get('254', '201')).toEqual({
            network: '254', application: '172', ward: '1', zones: '0,1,2,3,4',
            type: 3, modeRaw: 1, setpointRaw: 5632
        });
    });

    it('keys by source unit so two thermostats on one ward stay distinct', () => {
        reg.recordModeReading(heatReading);
        reg.recordModeReading({ ...heatReading, sourceUnit: '202', zones: '0' });
        expect(reg.get('254', '201').zones).toBe('0,1,2,3,4');
        expect(reg.get('254', '202').zones).toBe('0');
    });

    it('keeps the running plant type when a later off reading carries a sentinel type', () => {
        reg.recordModeReading(heatReading); // on, type 3
        reg.recordModeReading({ ...heatReading, mode: 'off', modeRaw: 0, type: 255, setpointRaw: 0 });
        // type stays 3 (the running type); modeRaw updates to 0
        const s = reg.get('254', '201');
        expect(s.type).toBe(3);
        expect(s.modeRaw).toBe(0);
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

    it('builds SET_WARD_OFF', () => {
        expect(buildSetWardOff({ cbusname: 'THEGAFF', network: '254', application: '172', ward: '1' }))
            .toBe('AIRCON SET_WARD_OFF //THEGAFF/254/172 1');
    });
});
