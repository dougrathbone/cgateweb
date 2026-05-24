const { backoffDelay } = require('../src/backoff');

describe('backoffDelay', () => {
    describe('without jitter', () => {
        it('returns initialMs at retryNumber 0', () => {
            expect(backoffDelay(0, { initialMs: 1000, maxMs: 60000, jitter: false })).toBe(1000);
        });

        it('doubles for each retry', () => {
            expect(backoffDelay(1, { initialMs: 1000, maxMs: 60000, jitter: false })).toBe(2000);
            expect(backoffDelay(2, { initialMs: 1000, maxMs: 60000, jitter: false })).toBe(4000);
            expect(backoffDelay(3, { initialMs: 1000, maxMs: 60000, jitter: false })).toBe(8000);
        });

        it('caps at maxMs', () => {
            expect(backoffDelay(20, { initialMs: 1000, maxMs: 60000, jitter: false })).toBe(60000);
            expect(backoffDelay(5, { initialMs: 2000, maxMs: 10000, jitter: false })).toBe(10000);
        });

        it('honors custom initialMs', () => {
            expect(backoffDelay(0, { initialMs: 500, maxMs: 60000, jitter: false })).toBe(500);
            expect(backoffDelay(2, { initialMs: 500, maxMs: 60000, jitter: false })).toBe(2000);
        });
    });

    describe('with jitter (default)', () => {
        // Jitter multiplier is 0.5..1.5; delay should land in [0.5*base, 1.5*base].
        it('produces a delay within the jitter window of the base value', () => {
            const initialMs = 1000;
            for (let attempt = 0; attempt < 8; attempt++) {
                const base = Math.min(initialMs * Math.pow(2, attempt), 60000);
                for (let i = 0; i < 50; i++) {
                    const d = backoffDelay(attempt, { initialMs, maxMs: 60000 });
                    expect(d).toBeGreaterThanOrEqual(Math.round(base * 0.5));
                    expect(d).toBeLessThanOrEqual(Math.round(base * 1.5));
                }
            }
        });
    });

    describe('edge cases', () => {
        it('treats negative retryNumber as 0', () => {
            expect(backoffDelay(-5, { initialMs: 1000, maxMs: 60000, jitter: false })).toBe(1000);
        });

        it('uses 1000ms/60000ms defaults when options omitted', () => {
            expect(backoffDelay(0, { jitter: false })).toBe(1000);
            expect(backoffDelay(10, { jitter: false })).toBe(60000);
        });
    });
});
