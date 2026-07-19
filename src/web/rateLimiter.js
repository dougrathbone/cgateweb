// @ts-check
/**
 * Sliding-window rate limiter for mutating API requests, keyed by client
 * socket address.
 */
class RateLimiter {
    /**
     * @param {Object} options
     * @param {number} [options.windowMs=60000] - Length of the rate limit window
     * @param {number} [options.maxRequests=120] - Maximum requests per window per client
     */
    constructor({ windowMs = 60000, maxRequests = 120 } = {}) {
        this.windowMs = windowMs;
        this.maxRequests = maxRequests;
        this._requestLog = new Map();
    }

    /**
     * Record a request and report whether the client is over the limit.
     * Uses the socket address for rate limiting — X-Forwarded-For is spoofable
     * and would allow bypass by rotating the header value.
     * @param {import('http').IncomingMessage} req
     * @returns {boolean}
     */
    isLimited(req) {
        const source = String(req.socket?.remoteAddress || 'unknown');
        const now = Date.now();
        const windowStart = now - this.windowMs;
        this._prune(windowStart);
        const inWindow = this._requestLog.get(source) || [];
        // Cap array size to prevent memory exhaustion from rapid requests
        if (inWindow.length <= this.maxRequests * 2) {
            inWindow.push(now);
        }
        this._requestLog.set(source, inWindow);
        return inWindow.length > this.maxRequests;
    }

    /**
     * Evict timestamps older than the window start, deleting empty entries.
     * @param {number} windowStart
     */
    _prune(windowStart) {
        for (const [source, timestamps] of this._requestLog.entries()) {
            const inWindow = timestamps.filter((ts) => ts >= windowStart);
            if (inWindow.length === 0) {
                this._requestLog.delete(source);
                continue;
            }
            if (inWindow.length !== timestamps.length) {
                this._requestLog.set(source, inWindow);
            }
        }
    }
}

module.exports = RateLimiter;
