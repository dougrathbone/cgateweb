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

    it('decodes off mode (sourceunit=201, setpoint null because f6=255 sentinel)', () => {
        // Off line: 0 0 0 0 1 255 0 0  → f0=0 (off), f6=255 (no valid setpoint when off)
        // Per spec: setpoint null when f6=0; but here f6=255 which is non-zero.
        // The off fixture has trailing fields: 0 0 0 0 1 255 0 0
        // f0=0, f1=0, f2=0, f3=0, f4=1, f5=255, f6=0, f7=0
        // Wait — re-read spec: "Off line trailing fields: 0 0 0 0 1 255 0 0"
        // That means f0=0 f1=0 f2=0 f3=0 f4=1 f5=255 f6=0 f7=0
        // So f6=0 → setpoint null. Confirmed.
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

    it('decodes cool mode (synthesised: f0=2, setpoint 5632→22°C)', () => {
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0 2 0 0 0 1 1 5632 0 #sourceunit=202 OID=x';
        const result = decodeLine(line);
        expect(result.mode).toBe('cool');
        expect(result.modeRaw).toBe(2);
        expect(result.setpoint).toBe(22);
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

describe('airconDecoder — null returns for other verbs and non-aircon lines', () => {
    it('returns null for # aircon zone_hvac_plant_status', () => {
        const line = '# aircon zone_hvac_plant_status //THEGAFF/254/172 1 0 3 8 0 #sourceunit=250 OID=07ffed40-b5bd-103e-83ab-af3ab5084337';
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
