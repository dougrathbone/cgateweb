// @ts-check
/**
 * Compute an exponential-backoff delay with optional full-range jitter.
 *
 * @param {number} retryNumber  0 for the first retry, 1 for the second, etc.
 * @param {object} [options]
 * @param {number} [options.initialMs=1000]  Delay for retryNumber === 0 (pre-jitter).
 * @param {number} [options.maxMs=60000]     Upper cap on the pre-jitter delay.
 * @param {boolean} [options.jitter=true]    Whether to apply 0.5x..1.5x jitter
 *                                           to spread out concurrent retries.
 * @returns {number} delay in milliseconds (rounded when jitter is applied).
 */
function backoffDelay(retryNumber, options = {}) {
    const initialMs = options.initialMs ?? 1000;
    const maxMs = options.maxMs ?? 60000;
    const jitter = options.jitter !== false;
    const safeRetry = Math.max(0, retryNumber);

    const baseDelay = Math.min(initialMs * Math.pow(2, safeRetry), maxMs);
    if (!jitter) return baseDelay;

    const jitterMultiplier = 0.5 + Math.random();
    return Math.round(baseDelay * jitterMultiplier);
}

/**
 * Schedule a C-Gate reconnect after exponential backoff. Shared by the event
 * connection and the command pool so delay math, "never give up" logging, and
 * the unref'd timer stay in one place.
 *
 * `retryNumber` is 0 for the first retry (same as backoffDelay). `attempt` is
 * the 1-based count shown in logs. Callers increment their own counters.
 *
 * @param {object} options
 * @param {{ info: Function, warn: Function }} options.logger
 * @param {number} options.retryNumber
 * @param {number} options.attempt
 * @param {number} options.maxInitialAttempts
 * @param {number} options.initialMs
 * @param {number} options.maxMs
 * @param {() => void} options.onFire
 * @param {(delay: number) => string} options.infoLine
 * @param {(delay: number) => string} options.warnLine
 * @returns {ReturnType<typeof setTimeout>}
 */
function scheduleReconnect(options) {
    const delay = backoffDelay(options.retryNumber, {
        initialMs: options.initialMs,
        maxMs: options.maxMs
    });
    if (options.attempt <= options.maxInitialAttempts) {
        options.logger.info(options.infoLine(delay));
    } else {
        options.logger.warn(options.warnLine(delay));
    }
    const handle = setTimeout(options.onFire, delay);
    if (handle && typeof handle.unref === 'function') {
        handle.unref();
    }
    return handle;
}

module.exports = { backoffDelay, scheduleReconnect };
