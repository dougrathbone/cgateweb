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

    // --- full object equality for canonical fixture ---
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
            celsius: 17.3,
            unit: 'C',
            verb: 'zone_temperature'
        });
    });

    it('decodes a line without trailing metadata identically', () => {
        expect(decodeLine(LINE_WITHOUT_METADATA)).toEqual({
            kind: 'temperature',
            network: '254',
            application: '172',
            zoneGroup: '1',
            zones: '0,1,2,3,4',
            celsius: 17.3,
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

describe('airconDecoder — null returns for other verbs and non-aircon lines', () => {
    it('returns null for aircon set_zone_hvac_mode (unverified encoding)', () => {
        const line = 'aircon set_zone_hvac_mode //THEGAFF/254/172 1 0,1,2,3,4 0 0 0 0 1 255 0 0 #sourceunit=250 OID=07ffed40-b5bd-103e-83ab-af3ab5084337';
        expect(decodeLine(line)).toBeNull();
    });

    it('returns null for aircon set_ward_off', () => {
        const line = 'aircon set_ward_off //THEGAFF/254/172 1 #sourceunit=250 OID=07ffed40-b5bd-103e-83ab-af3ab5084337';
        expect(decodeLine(line)).toBeNull();
    });

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
