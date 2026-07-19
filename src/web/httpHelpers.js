// @ts-check
/**
 * Shared HTTP helpers for the web server: JSON responses, security/CORS
 * headers, and plain-object sanitization for untrusted request bodies.
 */

/**
 * Send a JSON response with the given status code.
 * @param {import('http').ServerResponse} res
 * @param {number} statusCode
 * @param {Object} data
 */
function sendJSON(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
}

/**
 * Apply the baseline security headers sent with every response.
 * Don't leak the addon's URL (which includes the HA Ingress token in the
 * path) to any external resource the UI fetches. The CSP is defence-in-depth:
 * the bundled UI uses inline <script>/<style> so we keep 'unsafe-inline' for
 * those - but everything else is locked to same-origin, which kills the most
 * common XSS payloads (loading attacker-controlled JS from a third-party
 * host). frame-ancestors is intentionally omitted because HA Ingress embeds
 * the addon from a different host.
 * @param {import('http').ServerResponse} res
 */
function setSecurityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; " +
        "connect-src 'self'; " +
        "object-src 'none'; " +
        "base-uri 'self'"
    );
}

/**
 * Apply CORS headers based on the allowlist. If the request origin is not in
 * the allowlist, the Allow-Origin header is omitted entirely — the browser
 * will block the cross-origin request.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string[]|null} allowedOrigins
 */
function setCorsHeaders(req, res, allowedOrigins) {
    const requestOrigin = req.headers.origin;
    if (allowedOrigins && allowedOrigins.length > 0) {
        res.setHeader('Vary', 'Origin');
        if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
            res.setHeader('Access-Control-Allow-Origin', requestOrigin);
        }
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, PATCH, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
}

/**
 * Keys that must never be written from untrusted input (prototype pollution).
 * @param {string} key
 * @returns {boolean}
 */
function isUnsafeObjectKey(key) {
    return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

/**
 * Shallow-copy a plain object, dropping prototype-polluting keys.
 * @param {Object} obj
 * @returns {Object}
 */
function sanitizePlainObject(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
        if (isUnsafeObjectKey(key)) continue;
        out[key] = value;
    }
    return out;
}

module.exports = {
    sendJSON,
    setSecurityHeaders,
    setCorsHeaders,
    isUnsafeObjectKey,
    sanitizePlainObject
};
