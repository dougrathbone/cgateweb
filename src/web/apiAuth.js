// @ts-check
const crypto = require('crypto');

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
     */
    constructor({ apiKey, allowUnauthenticatedMutations = false, getBasePath }) {
        this.apiKey = apiKey || null;
        this.allowUnauthenticatedMutations = allowUnauthenticatedMutations === true;
        this.getBasePath = getBasePath;
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
            // URL). The Supervisor injects an X-Ingress-Path header on every such
            // request, which the directly-exposed port never carries. Trusting it
            // lets the bundled label UI import/edit on a default add-on install
            // (no web_api_key) without opening up the raw port. A configured
            // web_api_key still takes precedence below.
            if (this._isIngressRequest(req)) {
                return true;
            }
            return this.allowUnauthenticatedMutations;
        }

        const rawAuth = req.headers.authorization || '';
        const bearer = rawAuth.startsWith('Bearer ') ? rawAuth.slice('Bearer '.length).trim() : null;
        const headerKey = req.headers['x-api-key'];
        const provided = bearer || headerKey || '';

        // Constant-time compare to remove the timing oracle that === would expose.
        // timingSafeEqual requires equal-length buffers, so reject mismatched
        // lengths up-front (also done in constant time relative to the secret).
        const providedBuf = Buffer.from(String(provided));
        const expectedBuf = Buffer.from(this.apiKey);
        if (providedBuf.length !== expectedBuf.length) return false;
        return crypto.timingSafeEqual(providedBuf, expectedBuf);
    }

    /**
     * Only trust ingress markers when the server was started in ingress mode
     * (basePath set — from INGRESS_ENTRY, or discovered from the Supervisor
     * API and applied via setBasePath). Require an exact path match plus HA
     * Core's X-Hass-Source so a casual spoofed X-Ingress-Path on the direct
     * :8080 port cannot authorize mutations.
     * @param {import('http').IncomingMessage} req
     * @returns {boolean}
     */
    _isIngressRequest(req) {
        const basePath = this.getBasePath();
        if (!basePath) return false;
        const ingressPath = req.headers['x-ingress-path'];
        if (typeof ingressPath !== 'string' || ingressPath.length === 0) return false;
        const normalized = ingressPath.replace(/\/+$/, '');
        if (normalized !== basePath) return false;
        return req.headers['x-hass-source'] === 'core.ingress';
    }
}

module.exports = ApiAuth;
