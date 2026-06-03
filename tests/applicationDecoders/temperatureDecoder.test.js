const decoder = require('../../src/applicationDecoders/temperatureDecoder');

describe('temperatureDecoder', () => {
    it('declares the Temperature Broadcast app id', () => {
        expect(decoder.appId).toBe('25');
    });

    it('converts a raw byte to °C (byte / 4)', () => {
        // 86 / 4 = 21.5°C
        const reading = decoder.decodeValue({ group: '3', rawByte: 86 });
        expect(reading).toEqual({ kind: 'temperature', group: '3', celsius: 21.5, unit: 'C' });
    });

    it('handles the 0 and max (255 → 63.75) bounds', () => {
        expect(decoder.decodeValue({ group: '1', rawByte: 0 }).celsius).toBe(0);
        expect(decoder.decodeValue({ group: '1', rawByte: 255 }).celsius).toBe(63.75);
    });

    it('coerces a numeric group to a string', () => {
        expect(decoder.decodeValue({ group: 3, rawByte: 86 }).group).toBe('3');
    });

    it('returns null for out-of-range / invalid raw bytes', () => {
        expect(decoder.decodeValue({ group: '1', rawByte: -1 })).toBeNull();
        expect(decoder.decodeValue({ group: '1', rawByte: 256 })).toBeNull();
        expect(decoder.decodeValue({ group: '1', rawByte: NaN })).toBeNull();
        expect(decoder.decodeValue({ group: '1', rawByte: 21.5 })).toBeNull(); // non-integer raw byte
    });
});
