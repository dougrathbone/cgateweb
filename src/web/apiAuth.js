// @ts-check
const crypto = require('crypto');

/**
 * Normalize a configured web API key for auth checks.
 *
 * resolveSetting preserves empty strings (unlike `||`), and the HA add-on
 * default for web_api_key is an empty field because Ingress authenticates.
 * Trimming then treating blank as unset keeps that default from becoming a
 * valid password (timingSafeEqual against an empty provided key) while still
 * accepting keys the operator padded with whitespace.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeApiKey(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
}

/**
 * Compare a presented secret with the configured one without revealing the
 * configured length. timingSafeEqual throws on unequal buffers, and returning
 * before that call is a faster path an attacker can time to learn the length.
 * The compare is always the configured length; a different presented length
 * fails as part of the same result.
 *
 * @param {string|string[]} provided
 * @param {string} expected
 * @returns {boolean}
 */
function secretsMatch(provided, expected) {
    const providedBuf = Buffer.from(String(provided));
    const expectedBuf = Buffer.from(expected);
    const length = expectedBuf.length;
    const padded = Buffer.alloc(length);
    providedBuf.copy(padded, 0, 0, Math.min(providedBuf.length, length));
    const sameLength = providedBuf.length === length;
    const sameBytes = crypto.timingSafeEqual(padded, expectedBuf);
    return sameLength && sameBytes;
}

// The Supervisor's address on the hassio network. Home Assistant's add-on docs
// require Ingress servers to accept only this peer; a host-mapped port reaches
// the container through Docker NAT from a different address.
const SUPERVISOR_INGRESS_ADDRESSES = Object.freeze(['172.30.32.2']);

/**
 * Strip the IPv4-mapped IPv6 prefix a dual-stack socket reports.
 * @param {unknown} address
 * @returns {string}
 */
function normalizePeerAddress(address) {
    if (typeof address !== 'string') return '';
    return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

/**
 * API route classification and authorization: API key / bearer checks and
 * Home Assistant ingress request detection.
 */
class ApiAuth {
    /**
     * @param {Object} options
     * @param {string|null} options.apiKey - API key required for protected endpoints
     * @param {boolean} [options.allowUnauthenticatedMutations=false] - Allow protected requests without API key
     * @param {Function} options.getBasePath - Returns the current ingress base path (may change after startup)
     * @param {readonly string[]} [options.ingressProxyAddresses] - Peer addresses trusted as the Ingress proxy
     */
    constructor({ apiKey, allowUnauthenticatedMutations = false, getBasePath, ingressProxyAddresses = SUPERVISOR_INGRESS_ADDRESSES }) {
        this.apiKey = normalizeApiKey(apiKey);
        this.allowUnauthenticatedMutations = allowUnauthenticatedMutations === true;
        this.getBasePath = getBasePath;
        this.ingressProxyAddresses = new Set(ingressProxyAddresses.map(normalizePeerAddress));
    }

    /**
     * Whether the route mutates state (and is therefore rate limited).
     * @param {string} urlPath
     * @param {string} method
     * @returns {boolean}
     */
    isMutatingRoute(urlPath, method) {
        if (!['PUT', 'PATCH', 'POST', 'DELETE'].includes(method)) return false;
        return urlPath === '/api/labels' || urlPath === '/api/labels/import';
    }

    /**
     * Sensitive API routes that expose labels, device state, or live events.
     * Health probes stay public so Supervisor/Docker can check liveness without
     * credentials. Static UI assets also stay public; the UI's API calls are gated.
     * @param {string} urlPath
     * @param {string} method
     * @returns {boolean}
     */
    isSensitiveReadRoute(urlPath, method) {
        if (method !== 'GET') return false;
        return urlPath === '/api/labels'
            || urlPath === '/api/labels/export.xml'
            || urlPath === '/api/status'
            || urlPath === '/api/dashboard'
            || urlPath === '/api/areas'
            || urlPath === '/api/events/stream';
    }

    /**
     * Whether the route requires API authorization.
     * @param {string} urlPath
     * @param {string} method
     * @returns {boolean}
     */
    requiresAuth(urlPath, method) {
        return this.isMutatingRoute(urlPath, method) || this.isSensitiveReadRoute(urlPath, method);
    }

    /**
     * Whether the request is authorized for protected endpoints.
     * @param {import('http').IncomingMessage} req
     * @returns {boolean}
     */
    isAuthorized(req) {
        if (!this.apiKey) {
            // Requests proxied through Home Assistant Ingress have already been
            // authenticated by HA (only logged-in HA users can reach the ingress
            // URL). Trusting them lets the bundled label UI import/edit on a
            // default add-on install (no web_api_key) without opening up the raw
            // port. A configured web_api_key still takes precedence below.
            if (this._isIngressRequest(req)) {
                return true;
            }
            return this.allowUnauthenticatedMutations;
        }

        const rawAuth = req.headers.authorization || '';
        const bearer = rawAuth.startsWith('Bearer ') ? rawAuth.slice('Bearer '.length).trim() : null;
        const headerKey = req.headers['x-api-key'];
        const provided = bearer || headerKey || '';
        return secretsMatch(provided, this.apiKey);
    }

    /**
     * Only trust ingress markers when the server was started in ingress mode
     * (basePath set — from INGRESS_ENTRY, or discovered from the Supervisor
     * API and applied via setBasePath) and the connection comes from the
     * Supervisor. The headers alone are not enough: anyone who has opened the
     * UI through HA can read the ingress path and send both headers to a
     * host-mapped :8080 from the LAN.
     * @param {import('http').IncomingMessage} req
     * @returns {boolean}
     */
    _isIngressRequest(req) {
        const basePath = this.getBasePath();
        if (!basePath) return false;
        if (!this.ingressProxyAddresses.has(normalizePeerAddress(req.socket?.remoteAddress))) return false;
        const ingressPath = req.headers['x-ingress-path'];
        if (typeof ingressPath !== 'string' || ingressPath.length === 0) return false;
        // Trim trailing slashes without a regex: /\/+$/ on an attacker-controlled
        // header is a polynomial-backtracking (ReDoS) risk on slash-dense input.
        let end = ingressPath.length;
        while (end > 0 && ingressPath.charCodeAt(end - 1) === 47) end -= 1; // 47 = '/'
        const normalized = ingressPath.slice(0, end);
        if (normalized !== basePath) return false;
        return req.headers['x-hass-source'] === 'core.ingress';
    }
}

module.exports = ApiAuth;
