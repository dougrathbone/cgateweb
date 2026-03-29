/**
 * Tracks active cover ramp operations and publishes interpolated position
 * estimates during the ramp duration.
 *
 * When a ramp command is sent to a cover group, C-Gate does not publish
 * intermediate position values until the ramp completes. This tracker fires
 * a callback every 500 ms with an estimated position so Home Assistant can
 * show smooth progress rather than snapping directly to the final value.
 *
 * @example
 * const tracker = new CoverRampTracker();
 * tracker.startRamp('254/203/5', 0, 255, 10000, (level) => {
 *   const pct = Math.round(level / 255 * 100);
 *   mqttClient.publish(`cbus/read/254/203/5/position`, String(pct));
 * });
 * // Later, when the real event arrives:
 * tracker.cancelRamp('254/203/5');
 */
class CoverRampTracker {
    constructor() {
        /** @type {Map<string, {handle: NodeJS.Timeout, startLevel: number, targetLevel: number, durationMs: number, startTime: number}>} */
        this._ramps = new Map();
    }

    /**
     * Starts interpolated position updates for a cover ramp.
     *
     * Fires `onPosition` every 500 ms with the estimated current level
     * (0–255). When the ramp duration elapses the tracker fires the target
     * level once and then cancels itself automatically.
     *
     * If a ramp is already active for `key` it is cancelled before the new
     * one starts.
     *
     * @param {string}   key        - Unique address key, e.g. "network/app/group"
     * @param {number}   startLevel - Starting C-Bus level (0–255)
     * @param {number}   targetLevel - Target C-Bus level (0–255)
     * @param {number}   durationMs  - Total ramp duration in milliseconds
     * @param {Function} onPosition  - Callback invoked with estimated level (0–255)
     */
    startRamp(key, startLevel, targetLevel, durationMs, onPosition) {
        // Cancel any existing ramp for this key before starting a new one
        this.cancelRamp(key);

        const startTime = Date.now();

        const handle = setInterval(() => {
            const elapsed = Date.now() - startTime;

            if (elapsed >= durationMs) {
                this.cancelRamp(key);
                onPosition(targetLevel);
                return;
            }

            const progress = elapsed / durationMs;
            const currentLevel = Math.round(startLevel + (targetLevel - startLevel) * progress);
            onPosition(currentLevel);
        }, 500);

        // Allow the Node.js process to exit even if this timer is still running
        if (handle.unref) {
            handle.unref();
        }

        this._ramps.set(key, { handle, startLevel, targetLevel, durationMs, startTime });
    }

    /**
     * Cancels an active ramp for the given key.
     * No-op if no ramp is active.
     *
     * @param {string} key - Address key to cancel
     */
    cancelRamp(key) {
        const ramp = this._ramps.get(key);
        if (ramp) {
            clearInterval(ramp.handle);
            this._ramps.delete(key);
        }
    }

    /**
     * Cancels all active ramps (e.g. on bridge shutdown).
     */
    cancelAll() {
        for (const key of this._ramps.keys()) {
            this.cancelRamp(key);
        }
    }

    /**
     * Returns true if a ramp is currently active for the given key.
     *
     * @param {string} key - Address key to check
     * @returns {boolean}
     */
    isRamping(key) {
        return this._ramps.has(key);
    }

    /**
     * Returns the number of currently active ramps.
     * @returns {number}
     */
    get size() {
        return this._ramps.size;
    }
}

module.exports = CoverRampTracker;
