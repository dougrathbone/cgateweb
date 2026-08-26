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

describe('scheduleReconnect', () => {
    const { scheduleReconnect } = require('../src/backoff');

    beforeEach(() => {
        jest.useFakeTimers();
        jest.spyOn(Math, 'random').mockReturnValue(0.5);
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it('logs info until maxInitialAttempts then warns, and fires onFire after the delay', () => {
        const logger = { info: jest.fn(), warn: jest.fn() };
        const onFire = jest.fn();
        scheduleReconnect({
            logger,
            retryNumber: 0,
            attempt: 1,
            maxInitialAttempts: 2,
            initialMs: 1000,
            maxMs: 60000,
            infoLine: (delay) => `info ${delay}`,
            warnLine: (delay) => `warn ${delay}`,
            onFire
        });
        expect(logger.info).toHaveBeenCalledWith('info 1000');
        expect(logger.warn).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1000);
        expect(onFire).toHaveBeenCalledTimes(1);
    });

    it('warns once the initial retry budget is exceeded', () => {
        const logger = { info: jest.fn(), warn: jest.fn() };
        scheduleReconnect({
            logger,
            retryNumber: 5,
            attempt: 6,
            maxInitialAttempts: 3,
            initialMs: 1000,
            maxMs: 60000,
            infoLine: () => 'info',
            warnLine: (delay) => `warn ${delay}`,
            onFire: () => {}
        });
        expect(logger.warn).toHaveBeenCalledWith('warn 32000');
        expect(logger.info).not.toHaveBeenCalled();
    });
});
