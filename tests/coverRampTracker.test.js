const CoverRampTracker = require('../src/coverRampTracker');

describe('CoverRampTracker', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('startRamp()', () => {
        it('fires the callback at ~500ms intervals', () => {
            const tracker = new CoverRampTracker();
            const calls = [];
            tracker.startRamp('254/203/1', 0, 255, 5000, (level) => calls.push(level));

            jest.advanceTimersByTime(500);
            expect(calls.length).toBe(1);

            jest.advanceTimersByTime(500);
            expect(calls.length).toBe(2);

            jest.advanceTimersByTime(500);
            expect(calls.length).toBe(3);

            tracker.cancelAll();
        });

        it('interpolates position correctly at 25% progress', () => {
            const tracker = new CoverRampTracker();
            const calls = [];
            // startLevel=0, targetLevel=200, duration=2000ms
            tracker.startRamp('254/203/1', 0, 200, 2000, (level) => calls.push(level));

            // Advance 500ms = 25% of 2000ms → expected level = round(0 + 200*0.25) = 50
            jest.advanceTimersByTime(500);
            expect(calls[0]).toBe(50);

            tracker.cancelAll();
        });

        it('interpolates position correctly at 50% progress', () => {
            const tracker = new CoverRampTracker();
            const calls = [];
            tracker.startRamp('254/203/1', 0, 200, 2000, (level) => calls.push(level));

            jest.advanceTimersByTime(1000); // 50% progress
            // calls[0] is at 500ms (25%), calls[1] is at 1000ms (50%)
            expect(calls[1]).toBe(100);

            tracker.cancelAll();
        });

        it('interpolates position correctly at 75% progress', () => {
            const tracker = new CoverRampTracker();
            const calls = [];
            tracker.startRamp('254/203/1', 0, 200, 2000, (level) => calls.push(level));

            jest.advanceTimersByTime(1500); // 75% progress
            expect(calls[2]).toBe(150);

            tracker.cancelAll();
        });

        it('interpolates from non-zero start level', () => {
            const tracker = new CoverRampTracker();
            const calls = [];
            // start=100, target=200, duration=1000ms → at 500ms (50%) = 150
            tracker.startRamp('254/203/1', 100, 200, 1000, (level) => calls.push(level));

            jest.advanceTimersByTime(500);
            expect(calls[0]).toBe(150);

            tracker.cancelAll();
        });

        it('fires final targetLevel and auto-cancels when duration elapses', () => {
            const tracker = new CoverRampTracker();
            const calls = [];
            tracker.startRamp('254/203/1', 0, 255, 1000, (level) => calls.push(level));

            // Advance well past duration
            jest.advanceTimersByTime(1500);

            const last = calls[calls.length - 1];
            expect(last).toBe(255);
            expect(tracker.isRamping('254/203/1')).toBe(false);
        });

        it('cancels an existing ramp for the same key before starting a new one', () => {
            const tracker = new CoverRampTracker();
            const firstCalls = [];
            const secondCalls = [];

            tracker.startRamp('254/203/1', 0, 255, 4000, (level) => firstCalls.push(level));
            // Advance partway then start a second ramp for the same key
            jest.advanceTimersByTime(500);
            expect(firstCalls.length).toBe(1);

            tracker.startRamp('254/203/1', 128, 0, 4000, (level) => secondCalls.push(level));
            jest.advanceTimersByTime(500);

            // The first ramp must be dead; only second ramp fires
            expect(firstCalls.length).toBe(1); // no more calls from first ramp
            expect(secondCalls.length).toBe(1);

            tracker.cancelAll();
        });

        it('isRamping() returns true while ramp is active', () => {
            const tracker = new CoverRampTracker();
            tracker.startRamp('254/203/5', 0, 255, 5000, () => {});
            expect(tracker.isRamping('254/203/5')).toBe(true);
            tracker.cancelAll();
        });
    });

    describe('cancelRamp()', () => {
        it('stops the timer so no more callbacks fire', () => {
            const tracker = new CoverRampTracker();
            const calls = [];
            tracker.startRamp('254/203/1', 0, 255, 5000, (level) => calls.push(level));

            jest.advanceTimersByTime(500);
            expect(calls.length).toBe(1);

            tracker.cancelRamp('254/203/1');

            jest.advanceTimersByTime(1000);
            expect(calls.length).toBe(1); // no further calls
        });

        it('is a no-op when no ramp is active for the key', () => {
            const tracker = new CoverRampTracker();
            expect(() => tracker.cancelRamp('254/203/99')).not.toThrow();
        });

        it('isRamping() returns false after cancelRamp()', () => {
            const tracker = new CoverRampTracker();
            tracker.startRamp('254/203/5', 0, 255, 5000, () => {});
            tracker.cancelRamp('254/203/5');
            expect(tracker.isRamping('254/203/5')).toBe(false);
        });
    });

    describe('cancelAll()', () => {
        it('stops all active ramps', () => {
            const tracker = new CoverRampTracker();
            const calls1 = [];
            const calls2 = [];

            tracker.startRamp('254/203/1', 0, 255, 5000, (l) => calls1.push(l));
            tracker.startRamp('254/203/2', 0, 128, 5000, (l) => calls2.push(l));

            jest.advanceTimersByTime(500);
            expect(calls1.length).toBe(1);
            expect(calls2.length).toBe(1);

            tracker.cancelAll();

            jest.advanceTimersByTime(1000);
            expect(calls1.length).toBe(1);
            expect(calls2.length).toBe(1);
        });

        it('size property is 0 after cancelAll()', () => {
            const tracker = new CoverRampTracker();
            tracker.startRamp('254/203/1', 0, 255, 5000, () => {});
            tracker.startRamp('254/203/2', 0, 128, 5000, () => {});
            expect(tracker.size).toBe(2);
            tracker.cancelAll();
            expect(tracker.size).toBe(0);
        });
    });

    describe('isRamping()', () => {
        it('returns false for unknown key', () => {
            const tracker = new CoverRampTracker();
            expect(tracker.isRamping('254/203/99')).toBe(false);
        });
    });
});
