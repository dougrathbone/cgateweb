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

    it('trips once a source exceeds maxRequests inside the window', () => {
        const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 3, maxTrackedSources: 10 });
        expect(limiter.isLimitedByKey('a')).toBe(false);
        expect(limiter.isLimitedByKey('a')).toBe(false);
        expect(limiter.isLimitedByKey('a')).toBe(false);
        expect(limiter.isLimitedByKey('a')).toBe(true);
    });

    it('evicts least-recently-used sources when over the tracked-source cap', () => {
        const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 100, maxTrackedSources: 2 });
        expect(limiter.isLimitedByKey('old')).toBe(false);
        expect(limiter.isLimitedByKey('mid')).toBe(false);
        expect(limiter.isLimitedByKey('new')).toBe(false);

        expect(limiter._requestLog.has('old')).toBe(false);
        expect(limiter._requestLog.has('mid')).toBe(true);
        expect(limiter._requestLog.has('new')).toBe(true);
    });

    it('refreshes LRU order so a re-seen source is not the next eviction', () => {
        const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 100, maxTrackedSources: 2 });
        expect(limiter.isLimitedByKey('a')).toBe(false);
        expect(limiter.isLimitedByKey('b')).toBe(false);
        // Touch a again so it is no longer the oldest.
        expect(limiter.isLimitedByKey('a')).toBe(false);
        expect(limiter.isLimitedByKey('c')).toBe(false);

        expect(limiter._requestLog.has('b')).toBe(false);
        expect(limiter._requestLog.has('a')).toBe(true);
        expect(limiter._requestLog.has('c')).toBe(true);
    });

    it('caps the per-source timestamp array near twice maxRequests', () => {
        const limiter = new RateLimiter({ windowMs: 60000, maxRequests: 5, maxTrackedSources: 10 });
        for (let i = 0; i < 50; i += 1) {
            limiter.isLimitedByKey('flood');
        }
        expect(limiter._requestLog.get('flood').length).toBeLessThanOrEqual(5 * 2 + 1);
    });

    describe('with fake timers', () => {
        // Scoped to this nested suite so other files in the same worker never
        // inherit a frozen Date from a leaked beforeEach (see labelLoader flake).
        beforeEach(() => {
            jest.useFakeTimers();
            jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        it('forgets requests that fall outside the sliding window', () => {
            const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 2, maxTrackedSources: 10 });
            expect(limiter.isLimitedByKey('a')).toBe(false);
            expect(limiter.isLimitedByKey('a')).toBe(false);
            expect(limiter.isLimitedByKey('a')).toBe(true);

            jest.advanceTimersByTime(1001);
            expect(limiter.isLimitedByKey('a')).toBe(false);
            expect(limiter.isLimitedByKey('a')).toBe(false);
            expect(limiter.isLimitedByKey('a')).toBe(true);
        });

        it('sweeps quiet sources at most once per window via _sweepIfDue', () => {
            const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 10, maxTrackedSources: 10 });
            expect(limiter.isLimitedByKey('quiet')).toBe(false);
            expect(limiter._requestLog.has('quiet')).toBe(true);

            jest.advanceTimersByTime(1001);
            // First call after the window is due for a sweep; quiet entry expires.
            expect(limiter.isLimitedByKey('other')).toBe(false);
            expect(limiter._requestLog.has('quiet')).toBe(false);

            const lastSweep = limiter._lastSweep;
            expect(limiter.isLimitedByKey('other')).toBe(false);
            expect(limiter._lastSweep).toBe(lastSweep);
        });

        it('_prune removes empty entries after dropping expired timestamps', () => {
            const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 10, maxTrackedSources: 10 });
            expect(limiter.isLimitedByKey('gone')).toBe(false);
            jest.advanceTimersByTime(1001);
            limiter._prune(Date.now() - limiter.windowMs);
            expect(limiter._requestLog.has('gone')).toBe(false);
        });
    });
});
