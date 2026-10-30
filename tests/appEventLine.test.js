const { decodeTriggerMinMaxLine } = require('../src/applicationDecoders/appEventLine');

describe('decodeTriggerMinMaxLine', () => {
    it('rewrites a comment-prefixed "trigger max" line to selector 255, keeping the project-prefixed address and metadata', () => {
        const line = '# trigger max //MIDSTRM/254/202/2  #sourceunit=33 OID=f01f5530-6aed-103f-a610-f3e5ffd43e10';

        expect(decodeTriggerMinMaxLine(line)).toBe(
            'trigger event //MIDSTRM/254/202/2 255 #sourceunit=33 OID=f01f5530-6aed-103f-a610-f3e5ffd43e10'
        );
    });

    it('rewrites a comment-prefixed "trigger min" line to selector 0', () => {
        const line = '# trigger min //MIDSTRM/254/202/2 #sourceunit=33 OID=abc';

        expect(decodeTriggerMinMaxLine(line)).toBe('trigger event //MIDSTRM/254/202/2 0 #sourceunit=33 OID=abc');
    });

    it('is case-insensitive on the min/max keyword', () => {
        expect(decodeTriggerMinMaxLine('# trigger MAX //MIDSTRM/254/202/2')).toBe(
            'trigger event //MIDSTRM/254/202/2 255'
        );
        expect(decodeTriggerMinMaxLine('# trigger Min //MIDSTRM/254/202/2')).toBe(
            'trigger event //MIDSTRM/254/202/2 0'
        );
    });

    it('works without a leading "#" comment marker', () => {
        expect(decodeTriggerMinMaxLine('trigger max 254/202/2')).toBe('trigger event 254/202/2 255');
    });

    it('works with a bare network/app/group address (no //PROJECT/ prefix)', () => {
        expect(decodeTriggerMinMaxLine('# trigger min 254/202/2')).toBe('trigger event 254/202/2 0');
    });

    it('returns null for a numeric "trigger event" line (not min/max)', () => {
        expect(decodeTriggerMinMaxLine('trigger event 254/202/17 2')).toBeNull();
        expect(decodeTriggerMinMaxLine('# trigger event //MIDSTRM/254/202/17 2')).toBeNull();
    });

    it('returns null for unrelated comment lines', () => {
        expect(decodeTriggerMinMaxLine('# C-Gate event server started')).toBeNull();
    });

    it('returns null for other applications\' comment-prefixed lines', () => {
        expect(decodeTriggerMinMaxLine('# aircon zone_temperature //MIDSTRM/254/172 1 0')).toBeNull();
    });

    it('returns null for non-string input', () => {
        expect(decodeTriggerMinMaxLine(null)).toBeNull();
        expect(decodeTriggerMinMaxLine(undefined)).toBeNull();
    });

    it('returns null for an empty or whitespace-only line', () => {
        expect(decodeTriggerMinMaxLine('')).toBeNull();
        expect(decodeTriggerMinMaxLine('   ')).toBeNull();
    });

    it('keeps a project name that ends in digits as part of the address, not the selector', () => {
        expect(decodeTriggerMinMaxLine('# trigger max //MIDSTRM2026/254/202/2 #sourceunit=33')).toBe(
            'trigger event //MIDSTRM2026/254/202/2 255 #sourceunit=33'
        );
    });

    it('accepts an EVENT channel prefix and a hash with no following space', () => {
        expect(decodeTriggerMinMaxLine('#e# trigger min //MIDSTRM/254/202/2 #sourceunit=8')).toBe(
            'trigger event //MIDSTRM/254/202/2 0 #sourceunit=8'
        );
        expect(decodeTriggerMinMaxLine('#s# trigger MAX //MIDSTRM/254/202/2')).toBe(
            'trigger event //MIDSTRM/254/202/2 255'
        );
        expect(decodeTriggerMinMaxLine('#c# trigger min 254/202/2')).toBe('trigger event 254/202/2 0');
        expect(decodeTriggerMinMaxLine('#trigger max //MIDSTRM/254/202/2')).toBe(
            'trigger event //MIDSTRM/254/202/2 255'
        );
    });

    it('returns null when min/max has no address, or the word is not exactly min or max', () => {
        expect(decodeTriggerMinMaxLine('# trigger max')).toBeNull();
        expect(decodeTriggerMinMaxLine('# trigger minimum //MIDSTRM/254/202/2')).toBeNull();
        expect(decodeTriggerMinMaxLine('# trigger maximum //MIDSTRM/254/202/2')).toBeNull();
    });
});
