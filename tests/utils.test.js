const { clampSetting, evictOldestFifo, temperatureToCbusLevel, redactCgateLine, redactMqttPayload } = require('../src/utils');

describe('clampSetting', () => {
    it('uses default when value is undefined', () => {
        expect(clampSetting(undefined, 100, 5000)).toBe(5000);
    });

    it('uses default when value is 0 (treated as "not configured")', () => {
        expect(clampSetting(0, 100, 5000)).toBe(5000);
    });

    it('uses default when value is NaN', () => {
        expect(clampSetting(NaN, 100, 5000)).toBe(5000);
    });

    it('returns configured value when above floor', () => {
        expect(clampSetting(2000, 100, 5000)).toBe(2000);
    });

    it('clamps to floor when configured value is below it', () => {
        expect(clampSetting(50, 100, 5000)).toBe(100);
    });

    it('coerces string values via Number()', () => {
        expect(clampSetting('3000', 100, 5000)).toBe(3000);
    });

    it('clamps to floor when default is below floor', () => {
        expect(clampSetting(undefined, 100, 0)).toBe(100);
    });
});

describe('evictOldestFifo', () => {
    it('removes and returns the oldest inserted key', () => {
        const m = new Map([['a', 1], ['b', 2], ['c', 3]]);
        expect(evictOldestFifo(m)).toBe('a');
        expect([...m.keys()]).toEqual(['b', 'c']);
    });

    it('returns undefined for an empty map (no-op)', () => {
        const m = new Map();
        expect(evictOldestFifo(m)).toBeUndefined();
        expect(m.size).toBe(0);
    });

    it('FIFO order matches insertion order even after updates', () => {
        const m = new Map();
        m.set('a', 1);
        m.set('b', 2);
        m.set('a', 99); // update in place; does NOT move to end
        expect(evictOldestFifo(m)).toBe('a');
    });
});

describe('temperatureToCbusLevel', () => {
    it('encodes at 0.5°C resolution (level = temp * 2)', () => {
        expect(temperatureToCbusLevel(0)).toBe(0);
        expect(temperatureToCbusLevel(21)).toBe(42);
        expect(temperatureToCbusLevel(21.5)).toBe(43);
    });

    it('rounds to the nearest level', () => {
        expect(temperatureToCbusLevel(21.2)).toBe(42); // 42.4 -> 42
        expect(temperatureToCbusLevel(21.3)).toBe(43); // 42.6 -> 43
    });

    it('clamps to the valid 0-255 range', () => {
        expect(temperatureToCbusLevel(-5)).toBe(0);
        expect(temperatureToCbusLevel(200)).toBe(255);
    });
});

// #51: disarming types the PIN one keypress per command, and C-Gate echoes each
// command back on both ports where raw lines are logged at debug level. A debug
// log captured during a disarm therefore held the whole PIN, one digit per line.
describe('redactCgateLine', () => {
    it('hides the key on a keypad command echo', () => {
        expect(redactCgateLine('security emulate_keypad //MIDSTRM/254/208 $31'))
            .toBe('security emulate_keypad //MIDSTRM/254/208 ***');
    });

    it('keeps the address and trailing metadata readable', () => {
        // Losing the address or session id would make the redaction useless for
        // debugging the very feature it protects.
        const line = 'security emulate_keypad //MIDSTRM/254/208 $31 #sourceunit=0 OID= sessionId=cmd9 commandId={none}';
        expect(redactCgateLine(line))
            .toBe('security emulate_keypad //MIDSTRM/254/208 *** #sourceunit=0 OID= sessionId=cmd9 commandId={none}');
    });

    it('hides a decimal key too, not just the hex form', () => {
        expect(redactCgateLine('security emulate_keypad //P/254/208 49')).toBe('security emulate_keypad //P/254/208 ***');
    });

    it('redacts every occurrence if several share a line', () => {
        const out = redactCgateLine('security emulate_keypad //P/254/208 $31 | security emulate_keypad //P/254/208 $32');
        expect(out).not.toContain('$31');
        expect(out).not.toContain('$32');
    });

    it('leaves other security traffic untouched', () => {
        // Arm mode and zone state are not secrets and are needed in logs.
        for (const line of [
            'security arm //MIDSTRM/254/208 day',
            '# security zone_sealed //MIDSTRM/254/208/1 #sourceunit=18',
            'security status_request //MIDSTRM/254/208 1'
        ]) {
            expect(redactCgateLine(line)).toBe(line);
        }
    });

    it('passes through ordinary lines and non-strings unchanged', () => {
        expect(redactCgateLine('300 //P/254/56/1: level=255')).toBe('300 //P/254/56/1: level=255');
        expect(redactCgateLine('')).toBe('');
        expect(redactCgateLine(undefined)).toBeUndefined();
        expect(redactCgateLine(null)).toBeNull();
    });

    it('is case-insensitive, since C-Gate echoes verbs as sent', () => {
        expect(redactCgateLine('SECURITY EMULATE_KEYPAD //P/254/208 $31')).toContain('***');
    });
});

// #51 follow-up: 1.24.3 closed the C-Gate echo paths but left the payload Home
// Assistant sends us. The "Invalid MQTT command" warning is the worst of these
// because it fires at the default log level.
describe('redactMqttPayload', () => {
    it('hides the code in an alarm command payload', () => {
        expect(redactMqttPayload('{"action":"DISARM","code":"1234"}'))
            .toBe('{"action":"DISARM","code":"***"}');
    });

    it('keeps the action readable, which is why the payload is logged at all', () => {
        expect(redactMqttPayload('{"action":"DISARM","code":"1234"}')).toContain('DISARM');
    });

    it('handles pin as well as code, for hand-rolled panels', () => {
        expect(redactMqttPayload('{"pin":"9999"}')).toBe('{"pin":"***"}');
    });

    it('copes with whitespace and key order from a Jinja template', () => {
        const out = redactMqttPayload('{ "code" : "4321", "action": "DISARM" }');
        expect(out).not.toContain('4321');
        expect(out).toContain('DISARM');
    });

    it('redacts a code containing an escaped quote', () => {
        expect(redactMqttPayload('{"code":"12\\"34"}')).not.toContain('34');
    });

    it('leaves ordinary payloads alone', () => {
        for (const p of ['ON', 'OFF', '50,4s', 'ARM_AWAY', '{"action":"ARM_AWAY","code":""}']) {
            expect(redactMqttPayload(p)).toBe(p);
        }
    });

    it('passes through non-strings unchanged', () => {
        expect(redactMqttPayload('')).toBe('');
        expect(redactMqttPayload(undefined)).toBeUndefined();
        expect(redactMqttPayload(null)).toBeNull();
    });
});
