const registry = require('../../src/applicationDecoders');

describe('ApplicationDecoderRegistry', () => {
    it('returns the temperature decoder for app 25', () => {
        expect(registry.getDecoder('25')).toBeDefined();
        expect(registry.getDecoder('25').appId).toBe('25');
    });
    it('returns the temperature decoder when given a numeric app id', () => {
        expect(registry.getDecoder(25)).toBeDefined();
        expect(registry.getDecoder(25).appId).toBe('25');
    });
    it('returns undefined for lighting (56) — handled by the fast path', () => {
        expect(registry.getDecoder('56')).toBeUndefined();
    });
});
