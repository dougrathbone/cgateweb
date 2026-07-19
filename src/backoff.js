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

module.exports = { backoffDelay };
