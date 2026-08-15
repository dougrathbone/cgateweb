const decoder = require('../../src/applicationDecoders/clockDecoder');
const { isClockLine, decodeLine, decodeValue } = decoder;

// Ground-truth fixtures: the only captured app-223 event-port lines that exist
// anywhere in this repo, committed in 833b60e ("filter out C-Gate
// clock/timekeeping events"). That commit is dated 2026-03-02 21:17:32 +1100,
// so the captured date equals the commit date and the captured time falls four
// minutes before it — they came off a live C-Gate, not from someone's
// imagination. Every format assertion below traces back to these two strings.
const REAL_DATE_LINE = 'clock date //CLIPSAL/254/223 2026-03-02 0 #sourceunit=8 OID=';
const REAL_TIME_LINE = 'clock time //CLIPSAL/254/223 21:13:21 0 #sourceunit=8 OID=';

describe('clockDecoder — appId', () => {
    it('declares the Clock and Timekeeping app id', () => {
        expect(decoder.appId).toBe('223');
    });
});

describe('clockDecoder — isClockLine', () => {
    it('recognises the captured date and time lines', () => {
        expect(isClockLine(REAL_DATE_LINE)).toBe(true);
        expect(isClockLine(REAL_TIME_LINE)).toBe(true);
    });

    it('recognises clock traffic it cannot decode, so callers can still claim it', () => {
        // The whole point of separating recognition from decoding: an unknown
        // sub-verb must be kept out of the standard parser even though the
        // decoder refuses to interpret it.
        expect(isClockLine('clock request_refresh //CLIPSAL/254/223 0')).toBe(true);
        expect(decodeLine('clock request_refresh //CLIPSAL/254/223 0')).toBeNull();
    });

    it('recognises a comment-prefixed clock line', () => {
        expect(isClockLine(`# ${REAL_DATE_LINE}`)).toBe(true);
        expect(isClockLine(`#${REAL_DATE_LINE}`)).toBe(true);
    });

    it('does not claim other applications or a bare "clock" token', () => {
        expect(isClockLine('lighting on 254/56/4')).toBe(false);
        expect(isClockLine('# security zone_unsealed //MIDSTRM/254/208/58')).toBe(false);
        expect(isClockLine('measurement data //HOME/254/228/0/0 1234 -1 38')).toBe(false);
        expect(isClockLine('clockwise 254/56/4')).toBe(false);
        expect(isClockLine('clock')).toBe(false);
    });

    it('returns false rather than throwing for non-strings and empty input', () => {
        expect(isClockLine('')).toBe(false);
        expect(isClockLine(null)).toBe(false);
        expect(isClockLine(undefined)).toBe(false);
        expect(isClockLine(42)).toBe(false);
        expect(isClockLine({})).toBe(false);
    });
});

describe('clockDecoder — decodeLine', () => {
    it('decodes the captured date line', () => {
        expect(decodeLine(REAL_DATE_LINE)).toEqual({
            kind: 'clock',
            network: '254',
            application: '223',
            variant: 'date',
            value: '2026-03-02'
        });
    });

    it('decodes the captured time line', () => {
        expect(decodeLine(REAL_TIME_LINE)).toEqual({
            kind: 'clock',
            network: '254',
            application: '223',
            variant: 'time',
            value: '21:13:21'
        });
    });

    it('decodes identically without the trailing metadata', () => {
        expect(decodeLine('clock date //CLIPSAL/254/223 2026-03-02 0')).toEqual(decodeLine(REAL_DATE_LINE));
    });

    it('decodes identically with a leading # comment marker', () => {
        expect(decodeLine(`# ${REAL_TIME_LINE}`)).toEqual(decodeLine(REAL_TIME_LINE));
        expect(decodeLine(`#${REAL_TIME_LINE}`)).toEqual(decodeLine(REAL_TIME_LINE));
    });

    it('decodes an address without the project prefix', () => {
        expect(decodeLine('clock date 254/223 2026-03-02 0')).toEqual(decodeLine(REAL_DATE_LINE));
    });

    it('reads the network from the address rather than assuming 254', () => {
        const reading = decodeLine('clock time //OTHER/1/223 00:00:00 0');
        expect(reading.network).toBe('1');
        expect(reading.value).toBe('00:00:00');
    });

    it('ignores the undocumented trailing field instead of publishing it', () => {
        // Both captures end in "0" and nothing in the repo says what it means,
        // so a different value must not change the decoded reading.
        expect(decodeLine('clock date //CLIPSAL/254/223 2026-03-02 7'))
            .toEqual(decodeLine(REAL_DATE_LINE));
        const reading = decodeLine(REAL_DATE_LINE);
        expect(Object.keys(reading).sort())
            .toEqual(['application', 'kind', 'network', 'value', 'variant']);
    });

    describe('fails closed', () => {
        it('returns null for a sub-verb it has no capture of', () => {
            expect(decodeLine('clock request_refresh //CLIPSAL/254/223 0 0')).toBeNull();
            expect(decodeLine('clock sync //CLIPSAL/254/223 2026-03-02 0')).toBeNull();
        });

        it('returns null for a three-segment address (not the clock shape)', () => {
            expect(decodeLine('clock date //CLIPSAL/254/223/1 2026-03-02 0')).toBeNull();
        });

        it('returns null for a non-numeric address', () => {
            expect(decodeLine('clock date //CLIPSAL/abc/223 2026-03-02 0')).toBeNull();
        });

        it('returns null for a truncated line with no value', () => {
            expect(decodeLine('clock date //CLIPSAL/254/223')).toBeNull();
            expect(decodeLine('clock date')).toBeNull();
            expect(decodeLine('clock')).toBeNull();
        });

        it('returns null for a malformed date', () => {
            expect(decodeLine('clock date //CLIPSAL/254/223 02-03-2026 0')).toBeNull();
            expect(decodeLine('clock date //CLIPSAL/254/223 2026-3-2 0')).toBeNull();
            expect(decodeLine('clock date //CLIPSAL/254/223 notadate 0')).toBeNull();
        });

        it('returns null for a date that does not exist on a calendar', () => {
            expect(decodeLine('clock date //CLIPSAL/254/223 2026-02-30 0')).toBeNull();
            expect(decodeLine('clock date //CLIPSAL/254/223 2026-13-01 0')).toBeNull();
            expect(decodeLine('clock date //CLIPSAL/254/223 2026-00-10 0')).toBeNull();
            expect(decodeLine('clock date //CLIPSAL/254/223 2026-04-31 0')).toBeNull();
        });

        it('accepts a real leap day', () => {
            expect(decodeLine('clock date //CLIPSAL/254/223 2024-02-29 0').value).toBe('2024-02-29');
        });

        it('returns null for a malformed or out-of-range time', () => {
            expect(decodeLine('clock time //CLIPSAL/254/223 21:13 0')).toBeNull();
            expect(decodeLine('clock time //CLIPSAL/254/223 9:13:21 0')).toBeNull();
            expect(decodeLine('clock time //CLIPSAL/254/223 24:00:00 0')).toBeNull();
            expect(decodeLine('clock time //CLIPSAL/254/223 21:60:00 0')).toBeNull();
            expect(decodeLine('clock time //CLIPSAL/254/223 21:13:60 0')).toBeNull();
        });

        it('does not accept a date in a time line, or the reverse', () => {
            expect(decodeLine('clock time //CLIPSAL/254/223 2026-03-02 0')).toBeNull();
            expect(decodeLine('clock date //CLIPSAL/254/223 21:13:21 0')).toBeNull();
        });

        it('returns null rather than throwing for non-strings and other applications', () => {
            expect(decodeLine(null)).toBeNull();
            expect(decodeLine(undefined)).toBeNull();
            expect(decodeLine(42)).toBeNull();
            expect(decodeLine({})).toBeNull();
            expect(decodeLine('')).toBeNull();
            expect(decodeLine('lighting on 254/56/4 128')).toBeNull();
        });
    });
});

describe('clockDecoder — registry contract', () => {
    it('returns null from decodeValue, so a stray 3-segment app-223 line invents nothing', () => {
        expect(decodeValue({ group: '1', rawByte: 0 })).toBeNull();
    });

    it('is registered in the decoder registry under app 223', () => {
        const { getDecoder } = require('../../src/applicationDecoders');
        expect(getDecoder('223')).toBe(decoder);
        expect(getDecoder(223)).toBe(decoder);
    });

    it('survives CBusEvent applying it to a three-segment app-223 line', () => {
        // Registering a line-oriented decoder in a value-oriented registry is
        // only safe because decodeValue exists; without it _applyDecoder would
        // throw on this line. Guards that.
        const CBusEvent = require('../../src/cbusEvent');
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const event = new CBusEvent(Buffer.from('lighting on 254/223/1 128'));
        expect(() => event.isValid()).not.toThrow();
        expect(event.getReading()).toBeNull();
        jest.restoreAllMocks();
    });
});
