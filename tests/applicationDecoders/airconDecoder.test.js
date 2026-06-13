const { decodeLine, appId } = require('../../src/applicationDecoders/airconDecoder');

describe('airconDecoder — appId', () => {
    it('declares Air Conditioning app id 172', () => {
        expect(appId).toBe('172');
    });
});

describe('airconDecoder — zone_temperature', () => {
    // Ground-truth fixture from live PICED capture:
    // # aircon zone_temperature //THEGAFF/254/172 1 0,1,2,3,4 4431 0 #sourceunit=250 OID=07ffed40-...
    // PICED decoded raw 4431 as 17°C.  Encoding: °C = raw / 256

    const LINE_WITH_HASH_PREFIX = '# aircon zone_temperature //THEGAFF/254/172 1 0,1,2,3,4 4431 0 #sourceunit=250 OID=07ffed40-b5bd-103e-83ab-af3ab5084337';
    const LINE_WITHOUT_HASH_PREFIX = 'aircon zone_temperature //THEGAFF/254/172 1 0,1,2,3,4 4431 0 #sourceunit=250 OID=07ffed40-b5bd-103e-83ab-af3ab5084337';
    const LINE_WITHOUT_METADATA = 'aircon zone_temperature //THEGAFF/254/172 1 0,1,2,3,4 4431 0';

    // --- full object equality for canonical fixture (includes sourceUnit) ---
    it('decodes a hash-prefixed zone_temperature line to the expected reading', () => {
        // Arrange
        const line = LINE_WITH_HASH_PREFIX;
        // Act
        const result = decodeLine(line);
        // Assert
        expect(result).toEqual({
            kind: 'temperature',
            network: '254',
            application: '172',
            zoneGroup: '1',
            zones: '0,1,2,3,4',
            sourceUnit: '250',
            celsius: 17.3,
            unit: 'C',
            verb: 'zone_temperature'
        });
    });

    it('decodes a bare (no # prefix) zone_temperature line identically', () => {
        expect(decodeLine(LINE_WITHOUT_HASH_PREFIX)).toEqual({
            kind: 'temperature',
            network: '254',
            application: '172',
            zoneGroup: '1',
            zones: '0,1,2,3,4',
            sourceUnit: '250',
            celsius: 17.3,
            unit: 'C',
            verb: 'zone_temperature'
        });
    });

    it('decodes a line without trailing metadata with sourceUnit null', () => {
        expect(decodeLine(LINE_WITHOUT_METADATA)).toEqual({
            kind: 'temperature',
            network: '254',
            application: '172',
            zoneGroup: '1',
            zones: '0,1,2,3,4',
            sourceUnit: null,
            celsius: 17.3,
            unit: 'C',
            verb: 'zone_temperature'
        });
    });

    // --- verbatim PICED capture fixtures (two thermostats) ---
    it('decodes sourceunit=201 multi-zone temperature: celsius 17.4, sourceUnit 201, zoneGroup 1, zones 0,1,2,3,4', () => {
        const line = '# aircon zone_temperature //THEGAFF/254/172 1 0,1,2,3,4 4467 0 #sourceunit=201 OID=07ffed40-b5bd-103e-83ab-af3ab5084337';
        const result = decodeLine(line);
        expect(result).toEqual({
            kind: 'temperature',
            network: '254',
            application: '172',
            zoneGroup: '1',
            zones: '0,1,2,3,4',
            sourceUnit: '201',
            celsius: 17.4,
            unit: 'C',
            verb: 'zone_temperature'
        });
    });

    it('decodes sourceunit=202 single-zone temperature: celsius 17.8, sourceUnit 202, zones 0', () => {
        const line = '# aircon zone_temperature //THEGAFF/254/172 1 0 4545 0 #sourceunit=202 OID=07ffed40-b5bd-103e-83ab-af3ab5084337';
        const result = decodeLine(line);
        expect(result).toEqual({
            kind: 'temperature',
            network: '254',
            application: '172',
            zoneGroup: '1',
            zones: '0',
            sourceUnit: '202',
            celsius: 17.8,
            unit: 'C',
            verb: 'zone_temperature'
        });
    });

    // --- various raw temperature values ---
    it('decodes raw 4480 as celsius 17.5 (4480 / 256 = 17.5)', () => {
        const line = 'aircon zone_temperature //THEGAFF/254/172 1 0,1,2,3,4 4480 0';
        expect(decodeLine(line).celsius).toBe(17.5);
    });

    it('decodes raw 4608 as celsius 18 (4608 / 256 = 18.0)', () => {
        const line = 'aircon zone_temperature //THEGAFF/254/172 1 0,1,2,3,4 4608 0';
        expect(decodeLine(line).celsius).toBe(18);
    });

    it('decodes raw 4412 as celsius 17.2 (4412 / 256 ≈ 17.234 → rounds to 17.2)', () => {
        const line = 'aircon zone_temperature //THEGAFF/254/172 1 0,1,2,3,4 4412 0';
        expect(decodeLine(line).celsius).toBe(17.2);
    });
});

describe('airconDecoder — set_zone_hvac_mode', () => {
    // Verbatim from PICED log:
    // aircon set_zone_hvac_mode //THEGAFF/254/172 1 0,1,2,3,4 0 0 0 0 1 255 0 0 #sourceunit=201 OID=...
    // aircon set_zone_hvac_mode //THEGAFF/254/172 1 0 1 0 0 0 1 1 5632 0 #sourceunit=202 OID=...
    // Params after addr/zoneGroup/zoneList: f0..f7
    //   f0=mode (0=off,1=heat,2=cool,3=auto,4=fan_only), f6=setpoint raw (°C=f6/256)

    it('decodes heat mode (sourceunit=202, setpoint 5632→22°C)', () => {
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0 1 0 0 0 1 1 5632 0 #sourceunit=202 OID=07ffed40-b5bd-103e-83ab-af3ab5084337';
        expect(decodeLine(line)).toEqual({
            kind: 'mode',
            network: '254',
            application: '172',
            zoneGroup: '1',
            zones: '0',
            sourceUnit: '202',
            mode: 'heat',
            modeRaw: 1,
            setpoint: 22,
            verb: 'set_zone_hvac_mode'
        });
    });

    it('decodes off mode (sourceunit=201, setpoint null because f6=0)', () => {
        // Off fixture trailing fields: f0=0(off) f1=0 f2=0 f3=0 f4=1 f5=255 f6=0 f7=0.
        // The 255 sits at f5 (not the setpoint); f6=0 → setpoint null.
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0,1,2,3,4 0 0 0 0 1 255 0 0 #sourceunit=201 OID=07ffed40-b5bd-103e-83ab-af3ab5084337';
        expect(decodeLine(line)).toEqual({
            kind: 'mode',
            network: '254',
            application: '172',
            zoneGroup: '1',
            zones: '0,1,2,3,4',
            sourceUnit: '201',
            mode: 'off',
            modeRaw: 0,
            setpoint: null,
            verb: 'set_zone_hvac_mode'
        });
    });

    it('decodes cool mode (real capture 2026-06-11: f0=2, setpoint 3840→15°C)', () => {
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0,1,2,3,4 2 0 0 0 1 3 3840 0 #sourceunit=201 OID=x';
        const result = decodeLine(line);
        expect(result.mode).toBe('cool');
        expect(result.modeRaw).toBe(2);
        expect(result.setpoint).toBe(15);
    });

    it('decodes auto/heat-cool mode (real capture 2026-06-11: f0=3, setpoint 5632→22°C)', () => {
        // PICED labels code 3 "Heat/Cool (Auto)"; we publish HA mode string "auto".
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0,1,2,3,4 3 0 0 0 1 3 5632 63 #sourceunit=201 OID=x';
        const result = decodeLine(line);
        expect(result.mode).toBe('auto');
        expect(result.modeRaw).toBe(3);
        expect(result.setpoint).toBe(22);
    });

    it('decodes fan_only mode with the 0x7F00 no-setpoint sentinel (real capture 2026-06-11: f6=32512 → setpoint null)', () => {
        // Fan Only has no temperature target; the thermostat sends f6=32512 (0x7F00).
        // Must NOT be decoded as 127°C.
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0,1,2,3,4 4 1 0 0 1 3 32512 0 #sourceunit=201 OID=x';
        const result = decodeLine(line);
        expect(result.mode).toBe('fan_only');
        expect(result.modeRaw).toBe(4);
        expect(result.setpoint).toBeNull();
    });

    it('decodes unknown mode code (f0=7) → mode null, modeRaw 7, setpoint still parsed', () => {
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0 7 0 0 0 1 1 5632 0 #sourceunit=202 OID=x';
        const result = decodeLine(line);
        expect(result.kind).toBe('mode');
        expect(result.mode).toBeNull();
        expect(result.modeRaw).toBe(7);
        expect(result.setpoint).toBe(22);
    });

    it('decodes auto mode (f0=3)', () => {
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0 3 0 0 0 1 1 6144 0 #sourceunit=202 OID=x';
        const result = decodeLine(line);
        expect(result.mode).toBe('auto');
        expect(result.modeRaw).toBe(3);
        expect(result.setpoint).toBe(24);
    });

    it('decodes fan_only mode (f0=4)', () => {
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0 4 0 0 0 1 1 6400 0 #sourceunit=202 OID=x';
        const result = decodeLine(line);
        expect(result.mode).toBe('fan_only');
        expect(result.modeRaw).toBe(4);
        expect(result.setpoint).toBe(25);
    });

    it('returns null when fewer than 7 trailing fields (f0..f6 not all present)', () => {
        // Only 5 fields after zoneGroup/zones → can't read f6
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0 1 0 0 0';
        expect(decodeLine(line)).toBeNull();
    });

    it('returns null when f0 is not a valid integer', () => {
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0 notanumber 0 0 0 1 1 5632 0';
        expect(decodeLine(line)).toBeNull();
    });
});

describe('airconDecoder — set_ward_on / set_ward_off', () => {
    // Verbatim from PICED log:
    // aircon set_ward_on //THEGAFF/254/172 1 #sourceunit=202 OID=...
    // aircon set_ward_off //THEGAFF/254/172 1 #sourceunit=201 OID=...

    it('decodes set_ward_on (sourceunit=202) → kind state, on true', () => {
        const line = 'aircon set_ward_on //THEGAFF/254/172 1 #sourceunit=202 OID=07ffed40-b5bd-103e-83ab-af3ab5084337';
        expect(decodeLine(line)).toEqual({
            kind: 'state',
            network: '254',
            application: '172',
            zoneGroup: '1',
            sourceUnit: '202',
            on: true,
            verb: 'set_ward_on'
        });
    });

    it('decodes set_ward_off (sourceunit=201) → kind state, on false', () => {
        const line = 'aircon set_ward_off //THEGAFF/254/172 1 #sourceunit=201 OID=07ffed40-b5bd-103e-83ab-af3ab5084337';
        expect(decodeLine(line)).toEqual({
            kind: 'state',
            network: '254',
            application: '172',
            zoneGroup: '1',
            sourceUnit: '201',
            on: false,
            verb: 'set_ward_off'
        });
    });

    it('decodes set_ward_on without sourceunit → sourceUnit null', () => {
        const line = 'aircon set_ward_on //THEGAFF/254/172 1';
        const result = decodeLine(line);
        expect(result.kind).toBe('state');
        expect(result.on).toBe(true);
        expect(result.sourceUnit).toBeNull();
    });
});

describe('airconDecoder — zone_hvac_plant_status (running action)', () => {
    // Real captures 2026-06-11. Params after addr: zoneGroup zones <p2> <bitmask> <p4>
    // bitmask bits: 1=cooling, 2=heating, 4=fan, 8=damper, 32=busy
    //   (heating/fan/damper/busy verified against PICED text; cooling=bit0 inferred by
    //    position — Karl's plant never asserted cooling in the capture.)

    it('decodes heating+fan+damper, not busy → action heating (real: bitmask 14)', () => {
        const line = '# aircon zone_hvac_plant_status //THEGAFF/254/172 1 0,1,2,3,4 3 14 0 #sourceunit=201 OID=07ffed40-b5bd-103e-83ab-af3ab5084337';
        expect(decodeLine(line)).toEqual({
            kind: 'action',
            network: '254',
            application: '172',
            zoneGroup: '1',
            zones: '0,1,2,3,4',
            sourceUnit: '201',
            cooling: false,
            heating: true,
            fan: true,
            damper: true,
            busy: false,
            action: 'heating',
            verb: 'zone_hvac_plant_status'
        });
    });

    it('decodes the busy flag (real: bitmask 46 = 14 + 32) → busy true, action heating', () => {
        const line = '# aircon zone_hvac_plant_status //THEGAFF/254/172 1 0,1,2,3,4 3 46 0 #sourceunit=201 OID=x';
        const r = decodeLine(line);
        expect(r.busy).toBe(true);
        expect(r.heating).toBe(true);
        expect(r.action).toBe('heating');
    });

    it('decodes damper-only (real: bitmask 8) → all plant off, action idle', () => {
        const line = '# aircon zone_hvac_plant_status //THEGAFF/254/172 1 0 3 8 0 #sourceunit=201 OID=x';
        const r = decodeLine(line);
        expect(r.heating).toBe(false);
        expect(r.cooling).toBe(false);
        expect(r.fan).toBe(false);
        expect(r.action).toBe('idle');
    });

    it('decodes fan running without heat (real: bitmask 44 = 32+8+4) → action fan', () => {
        const line = '# aircon zone_hvac_plant_status //THEGAFF/254/172 1 0,1,2,3,4 3 44 0 #sourceunit=201 OID=x';
        const r = decodeLine(line);
        expect(r.fan).toBe(true);
        expect(r.heating).toBe(false);
        expect(r.action).toBe('fan');
    });

    it('derives action cooling when the cooling bit is set (synthesised: bit0; cooling bit inferred)', () => {
        const line = '# aircon zone_hvac_plant_status //THEGAFF/254/172 1 0 3 13 0 #sourceunit=202 OID=x';
        const r = decodeLine(line);
        expect(r.cooling).toBe(true);
        expect(r.action).toBe('cooling');
    });
});

describe('airconDecoder — null returns for other verbs and non-aircon lines', () => {
    it('returns null for an unsupported aircon verb (set_plant_hvac_level)', () => {
        const line = '# aircon set_plant_hvac_level //THEGAFF/254/172 1 0,1,2,3,4 1 0 0 0 1 3 127 0 #sourceunit=201 OID=07ffed40-b5bd-103e-83ab-af3ab5084337';
        expect(decodeLine(line)).toBeNull();
    });

    it('returns null for a non-aircon lighting line', () => {
        expect(decodeLine('lighting on 254/56/4')).toBeNull();
    });

    it('returns null for a malformed zone_temperature with non-numeric rawTemp', () => {
        const line = '# aircon zone_temperature //THEGAFF/254/172 1 0,1,2,3,4 notanumber 0';
        expect(decodeLine(line)).toBeNull();
    });

    it('returns null for null input', () => {
        expect(decodeLine(null)).toBeNull();
    });

    it('returns null for empty string', () => {
        expect(decodeLine('')).toBeNull();
    });

    it('returns null for undefined input', () => {
        expect(decodeLine(undefined)).toBeNull();
    });
});
