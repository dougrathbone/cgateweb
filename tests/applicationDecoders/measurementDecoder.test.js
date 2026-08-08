const { appId, isMeasurementLine, decodeLine, decodeChannelData, UNIT_TABLE } = require('../../src/applicationDecoders/measurementDecoder');

describe('measurementDecoder — appId', () => {
    it('declares the Measurement application id ($E4 / 228)', () => {
        expect(appId).toBe('228');
    });
});

describe('measurementDecoder — isMeasurementLine', () => {
    it('recognises a bare "measurement data ..." line', () => {
        expect(isMeasurementLine('measurement data //HOME/254/228/0/0 5042 0 38')).toBe(true);
    });

    it('recognises a #-comment-prefixed line', () => {
        expect(isMeasurementLine('# measurement data //HOME/254/228/0/0 5042 0 38')).toBe(true);
    });

    it('rejects lines from other applications', () => {
        expect(isMeasurementLine('lighting on 254/56/4')).toBe(false);
        expect(isMeasurementLine('aircon zone_temperature //THEGAFF/254/172 1 0 4431 0')).toBe(false);
    });
});

describe('measurementDecoder — decodeLine', () => {
    // Ground-truth fixtures captured live from a real C-Gate instance (project
    // HOME) during end-to-end testing: a solar-inverter power channel
    // (device 0/channel 0, units 38 = Watts) and a 4-channel temperature
    // sensor (device 1/channels 0-3, units 0 = °C), both injected via the
    // MEASUREMENT DATA write path and captured back off the real event port.
    // Confirmed end-to-end against physical DLT input units. Real C-Gate
    // appends trailing metadata C-Gate also uses for aircon/security
    // (#sourceunit=... OID=... sessionId=... commandId=...) which
    // normalizeAppEventLine must strip before the address/value regex runs.
    const REAL_FIXTURE = 'measurement data //HOME/254/228/0/0 1234 -1 38 #sourceunit=0 OID= sessionId=cmd54 commandId={none}';
    const REAL_FIXTURE_NO_METADATA = 'measurement data //HOME/254/228/0/0 1234 -1 38';

    it('decodes the confirmed real-world fixture (with real trailing metadata)', () => {
        expect(decodeLine(REAL_FIXTURE)).toEqual({
            kind: 'measurement',
            network: '254',
            application: '228',
            device: '0',
            channel: '0',
            value: 123.4,
            unit: 'W',
            unitCode: 38,
            deviceClass: 'power'
        });
    });

    it('decodes identically without the trailing metadata', () => {
        expect(decodeLine(REAL_FIXTURE_NO_METADATA)).toEqual(decodeLine(REAL_FIXTURE));
    });

    it('decodes identically with a leading # comment marker', () => {
        expect(decodeLine(`# ${REAL_FIXTURE}`)).toEqual(decodeLine(REAL_FIXTURE));
    });

    it('decodes the real 4-channel temperature fixture (device 1, channels 0-3)', () => {
        const cases = [
            ['measurement data //HOME/254/228/1/0 125 -1 0 #sourceunit=0 OID= sessionId=cmd54 commandId={none}', '0', 12.5],
            ['measurement data //HOME/254/228/1/1 189 -1 0 #sourceunit=0 OID= sessionId=cmd54 commandId={none}', '1', 18.9],
            ['measurement data //HOME/254/228/1/2 242 -1 0 #sourceunit=0 OID= sessionId=cmd54 commandId={none}', '2', 24.2],
            ['measurement data //HOME/254/228/1/3 189 -1 0 #sourceunit=0 OID= sessionId=cmd54 commandId={none}', '3', 18.9]
        ];
        for (const [line, channel, celsius] of cases) {
            const reading = decodeLine(line);
            expect(reading.device).toBe('1');
            expect(reading.channel).toBe(channel);
            expect(reading.value).toBe(celsius);
            expect(reading.unit).toBe('°C');
            expect(reading.deviceClass).toBe('temperature');
        }
    });

    it('decodes a negative multiplier as a fractional value (temperature, one decimal place)', () => {
        // 215 x 10^-1 = 21.5°C
        const line = 'measurement data //HOME/254/228/1/0 215 -1 0';
        expect(decodeLine(line)).toEqual({
            kind: 'measurement',
            network: '254',
            application: '228',
            device: '1',
            channel: '0',
            value: 21.5,
            unit: '°C',
            unitCode: 0,
            deviceClass: 'temperature'
        });
    });

    it('decodes a negative raw value (sub-zero temperature)', () => {
        // -55 x 10^-1 = -5.5°C
        const line = 'measurement data //HOME/254/228/1/0 -55 -1 0';
        expect(decodeLine(line).value).toBe(-5.5);
    });

    it('returns null for lines from a different application', () => {
        expect(decodeLine('lighting on 254/56/4')).toBeNull();
    });

    it('returns null for a malformed measurement line (missing trailing args)', () => {
        expect(decodeLine('measurement data //HOME/254/228/0/0 5042')).toBeNull();
    });

    it('returns null for a non-string input', () => {
        expect(decodeLine(null)).toBeNull();
        expect(decodeLine(undefined)).toBeNull();
    });
});

describe('measurementDecoder — decodeChannelData (pure)', () => {
    it('implements the spec worked example (157 = $9D)', () => {
        // CBUS-APP/28 §28.3 worked example: 157 decimal = $9D. Sanity-check our
        // decimal-in/decimal-out path reproduces the documented number directly
        // (multiplier 0, no scaling).
        const reading = decodeChannelData({ device: 1, channel: 0, value: 157, multiplier: 0, unitsCode: 24 });
        expect(reading.value).toBe(157);
        expect(reading.unit).toBe('Ω');
    });

    it('applies a positive multiplier (power of ten scale-up)', () => {
        const reading = decodeChannelData({ device: 0, channel: 0, value: 12, multiplier: 3, unitsCode: 37 });
        expect(reading.value).toBe(12000);
        expect(reading.unit).toBe('Wh');
        expect(reading.deviceClass).toBe('energy');
    });

    it('covers every documented unit code without throwing', () => {
        for (const code of Object.keys(UNIT_TABLE)) {
            const reading = decodeChannelData({ device: 0, channel: 0, value: 1, multiplier: 0, unitsCode: Number(code) });
            expect(reading).not.toBeNull();
            expect(reading.unitCode).toBe(Number(code));
        }
    });

    it('returns a plain sensor (no deviceClass) for unmapped unit codes', () => {
        expect(decodeChannelData({ device: 0, channel: 0, value: 1, multiplier: 0, unitsCode: 254 }).deviceClass).toBeNull();
        expect(decodeChannelData({ device: 0, channel: 0, value: 1, multiplier: 0, unitsCode: 255 }).deviceClass).toBeNull();
        expect(decodeChannelData({ device: 0, channel: 0, value: 1, multiplier: 0, unitsCode: 9 }).deviceClass).toBeNull();
    });

    it('coerces numeric device/channel to strings', () => {
        const reading = decodeChannelData({ device: 3, channel: 7, value: 1, multiplier: 0, unitsCode: 0 });
        expect(reading.device).toBe('3');
        expect(reading.channel).toBe('7');
    });

    it('returns null for an out-of-table units code', () => {
        expect(decodeChannelData({ device: 0, channel: 0, value: 1, multiplier: 0, unitsCode: 100 })).toBeNull();
    });

    it('returns null for a value outside signed 16-bit range', () => {
        expect(decodeChannelData({ device: 0, channel: 0, value: 32768, multiplier: 0, unitsCode: 0 })).toBeNull();
        expect(decodeChannelData({ device: 0, channel: 0, value: -32769, multiplier: 0, unitsCode: 0 })).toBeNull();
    });

    it('returns null for a multiplier outside signed 8-bit range', () => {
        expect(decodeChannelData({ device: 0, channel: 0, value: 1, multiplier: 128, unitsCode: 0 })).toBeNull();
        expect(decodeChannelData({ device: 0, channel: 0, value: 1, multiplier: -129, unitsCode: 0 })).toBeNull();
    });

    it('returns null for non-integer value/multiplier', () => {
        expect(decodeChannelData({ device: 0, channel: 0, value: 1.5, multiplier: 0, unitsCode: 0 })).toBeNull();
        expect(decodeChannelData({ device: 0, channel: 0, value: 1, multiplier: 1.5, unitsCode: 0 })).toBeNull();
    });
});
