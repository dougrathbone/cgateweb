const { clampSetting, evictOldestFifo } = require('../src/utils');

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
