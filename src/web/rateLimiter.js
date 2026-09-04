// @ts-check
const { resolveSetting } = require('../config/schema');

/**
 * Sliding-window rate limiter, keyed by an arbitrary string.
 *
 * Two callers: the web API keys on the client socket address (isLimited), and
 * the security panel keys on network/application to bound PIN-guessing against
 * the alarm (isLimitedByKey). Sharing one implementation is deliberate - the
 * eviction order here is subtle enough that a second copy would eventually get
 * it wrong, and the first attempt at this one already did.
 */

// Upper bound on how many distinct client addresses are tracked at once.
// Without it the map grows with every source seen inside a window, and an
// attacker with an IPv6 /64 - i.e. anyone on a modern LAN - has effectively
// unlimited addresses. Comfortably above any real deployment: a household has
// tens of clients, not thousands.
const DEFAULT_MAX_TRACKED_SOURCES = resolveSetting({}, 'webRateLimitMaxTrackedSources');

class RateLimiter {
    /**
     * @param {Object} options
     * @param {number} [options.windowMs=60000] - Length of the rate limit window
     * @param {number} [options.maxRequests=120] - Maximum requests per window per client
     * @param {number} [options.maxTrackedSources=5000] - Distinct client addresses tracked
     */
    constructor({ windowMs = 60000, maxRequests = 120, maxTrackedSources = DEFAULT_MAX_TRACKED_SOURCES } = {}) {
        this.windowMs = windowMs;
        this.maxRequests = maxRequests;
        this.maxTrackedSources = Math.max(1, maxTrackedSources);
        this._requestLog = new Map();
        // Sweeps at most once per window, so the whole-map walk is amortised
        // rather than paid per request.
        this._lastSweep = 0;
    }

    /**
     * Record a request and report whether the client is over the limit.
     * Uses the socket address for rate limiting — X-Forwarded-For is spoofable
     * and would allow bypass by rotating the header value.
     * @param {import('http').IncomingMessage} req
     * @returns {boolean}
     */
    isLimited(req) {
        return this.isLimitedByKey(String(req.socket?.remoteAddress || 'unknown'));
    }

    /**
     * Record an event against an arbitrary key and report whether that key is
     * over the limit. `isLimited` is the HTTP-shaped wrapper around this.
     *
     * @param {string} source - Anything stable that identifies the actor.
     * @returns {boolean}
     */
    isLimitedByKey(source) {
        const now = Date.now();
        const windowStart = now - this.windowMs;

        // Only this client's entry is pruned on the request path. The previous
        // version walked the entire map and reallocated an array per entry on
        // EVERY call, which is quadratic in the number of distinct sources -
        // measured at 17.5s of blocked event loop for 50k addresses. This
        // process is the C-Bus bridge and is single-threaded, so that stalls
        // lighting and MQTT entirely, and it was reachable unauthenticated
        // because the limiter also meters failed-auth requests.
        const timestamps = this._requestLog.get(source);
        const inWindow = timestamps ? this._dropExpired(timestamps, windowStart) : [];

        // Bounded per source, so one client cannot grow its own array without
        // limit either.
        if (inWindow.length <= this.maxRequests * 2) {
            inWindow.push(now);
        }

        // Delete before set so the key moves to the end of the Map's iteration
        // order. Map keeps a re-set key in its ORIGINAL position, so without
        // this the eviction below is first-inserted rather than
        // least-recently-used - and a flood would evict the very clients being
        // limited, handing them a fresh allowance. That would have made the
        // cap a rate-limit bypass rather than a protection.
        this._requestLog.delete(source);
        this._requestLog.set(source, inWindow);

        // Evict incrementally from the front (least recently seen). O(1)
        // amortised - a full sweep here would reintroduce the whole-map walk
        // this fix exists to remove, since the size check is true on every
        // request once the cap is reached.
        while (this._requestLog.size > this.maxTrackedSources) {
            const oldest = this._requestLog.keys().next().value;
            if (oldest === source) break; // never evict the caller we just recorded
            this._requestLog.delete(oldest);
        }

        this._sweepIfDue(now, windowStart);
        return inWindow.length > this.maxRequests;
    }

    /**
     * Drop expired timestamps in place. Mutating avoids allocating a new array
     * per request; entries are append-ordered, so everything still inside the
     * window is a suffix and one splice is enough.
     *
     * @param {number[]} timestamps
     * @param {number} windowStart
     * @returns {number[]} the same array
     * @private
     */
    _dropExpired(timestamps, windowStart) {
        let firstLive = 0;
        while (firstLive < timestamps.length && timestamps[firstLive] < windowStart) firstLive += 1;
        if (firstLive > 0) timestamps.splice(0, firstLive);
        return timestamps;
    }

    /**
     * Periodic whole-map cleanup, at most once per window.
     *
     * Two jobs: drop sources that have gone quiet, and enforce the tracked-source
     * cap so a flood of one-shot addresses cannot grow the map without bound. The
     * cap evicts oldest-first, which is the right direction here - an address
     * seen once and never again is exactly what a spoofing flood produces, while
     * a real client keeps refreshing its entry.
     *
     * @param {number} now
     * @param {number} windowStart
     * @private
     */
    _sweepIfDue(now, windowStart) {
        // Time-based only. Deliberately NOT also triggered by size: once the
        // map sits at the cap that condition is true on every request, so a
        // size trigger would run a whole-map walk per request - exactly the
        // quadratic behaviour being fixed. Size is handled incrementally in
        // isLimited instead.
        if (now - this._lastSweep < this.windowMs) return;
        this._lastSweep = now;
        this._prune(windowStart);
    }

    /**
     * Evict timestamps older than the window start, deleting empty entries.
     * Retained for tests and for callers that want an explicit sweep.
     * @param {number} windowStart
     */
    _prune(windowStart) {
        for (const [source, timestamps] of this._requestLog) {
            if (this._dropExpired(timestamps, windowStart).length === 0) {
                this._requestLog.delete(source);
            }
        }
    }
}

module.exports = RateLimiter;
