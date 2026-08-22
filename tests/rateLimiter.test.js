const RateLimiter = require('../src/web/rateLimiter');

describe('RateLimiter', () => {
    it('defaults the window, request cap, and tracked-source cap', () => {
        const limiter = new RateLimiter();
        expect(limiter.windowMs).toBe(60000);
        expect(limiter.maxRequests).toBe(120);
        expect(limiter.maxTrackedSources).toBe(5000);
    });

    it('keys missing sockets as unknown rather than throwing', () => {
        const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 2 });
        expect(limiter.isLimited({})).toBe(false);
        expect(limiter.isLimited({ socket: {} })).toBe(false);
        expect(limiter.isLimited({ socket: { remoteAddress: undefined } })).toBe(true);
        expect(limiter._requestLog.has('unknown')).toBe(true);
    });

    it('does not evict the caller when it is the oldest tracked source', () => {
        // The LRU walk would otherwise delete the key we just recorded once
        // the map is over cap and that key sits at the front of iteration
        // order (the break at oldest === source).
        const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 100, maxTrackedSources: 5 });
        limiter.maxTrackedSources = 0;
        expect(limiter.isLimitedByKey('only-source')).toBe(false);
        expect(limiter._requestLog.has('only-source')).toBe(true);
        expect(limiter._requestLog.size).toBe(1);
    });
});
