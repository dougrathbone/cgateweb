// @ts-check
const http = require('http');
const { createLogger } = require('./logger');
const ApiAuth = require('./web/apiAuth');
const RateLimiter = require('./web/rateLimiter');
const LabelRoutes = require('./web/labelRoutes');
const StatusRoutes = require('./web/statusRoutes');
const SseHandler = require('./web/sseHandler');
const StaticFileServer = require('./web/staticFiles');
const { DEFAULT_MAX_BODY_SIZE } = require('./web/bodyReader');
const { sendJSON, setSecurityHeaders, setCorsHeaders } = require('./web/httpHelpers');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * True when the web server is bound only to loopback, including IPv4-mapped IPv6.
 * @param {string} host
 * @returns {boolean}
 */
function isLoopbackBindHost(host) {
    if (!host) return false;
    const h = String(host).toLowerCase();
    if (LOOPBACK_HOSTS.has(h)) return true;
    return h === '::ffff:127.0.0.1' || h.startsWith('::ffff:127.');
}

// Exact "METHOD path" to handler. A table rather than a ladder of
// `if (urlPath === x && req.method === y)`: the routes are all exact matches
// with no ordering between them, so the ladder was thirty lines expressing a
// lookup. Anything not listed here falls through to the static file server.
//
// Note these run AFTER the auth and rate-limit checks in _handleRequest, which
// decide what needs a key from the path themselves (see ApiAuth) - adding a
// route here does not by itself make it authenticated.
//
// A Map rather than a plain object because the lookup key is built from the
// request. Every key here contains a space, so no crafted method/path could
// reach an inherited property like `constructor` anyway - but that is a
// property of the key format, not something the lookup enforces, and a Map has
// no prototype chain to reason about in the first place.
const ROUTES = new Map([
    ['GET /api/labels', (server, req, res) => server._labelRoutes.handleGetLabels(req, res)],
    ['PUT /api/labels', (server, req, res) => server._labelRoutes.handlePutLabels(req, res)],
    ['PATCH /api/labels', (server, req, res) => server._labelRoutes.handlePatchLabels(req, res)],
    ['POST /api/labels/import', (server, req, res) => server._labelRoutes.handleImportLabels(req, res)],
    ['GET /api/labels/export.xml', (server, req, res) => server._labelRoutes.handleExportLabelsXml(req, res)],
    ['GET /api/status', (server, req, res) => server._statusRoutes.handleGetStatus(req, res)],
    ['GET /api/dashboard', (server, req, res) => server._statusRoutes.handleGetDashboard(req, res)],
    ['GET /api/areas', (server, req, res) => server._statusRoutes.handleGetAreas(req, res)],
    ['GET /healthz', (server, req, res) => server._statusRoutes.handleHealth(req, res)],
    ['GET /readyz', (server, req, res) => server._statusRoutes.handleReady(req, res)],
    ['GET /api/events/stream', (server, req, res) => server._sseHandler.handle(req, res)],
]);

/**
 * Coerce a numeric option to a positive finite number, falling back to the
 * default for anything else (absent, null, a string, NaN, zero, negative).
 *
 * These arrive from a user-edited settings file or the add-on options, so
 * "0" or a typo has to land on the default rather than on a zero-length rate
 * limit window or a zero-byte body cap.
 *
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function listenPort(value, fallback) {
    if (value === 0) return 0; // ephemeral, used by tests and some standalone installs
    return Number.isFinite(value) && value > 0 && value <= 65535 ? value : fallback;
}

/**
 * Coerce a numeric option to a positive finite number, falling back to the
 * default for anything else (absent, null, a string, NaN, zero, negative).
 *
 * These arrive from a user-edited settings file or the add-on options, so
 * "0" or a typo has to land on the default rather than on a zero-length rate
 * limit window or a zero-byte body cap.
 *
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveNumber(value, fallback) {
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Same, but for the two request-count limits, which clamp to 1 instead of
 * falling back. The distinction is deliberate and not interchangeable with
 * positiveNumber: a configured 0 here means the operator wanted the tightest
 * limit they could express, so it becomes 1 request per window. Treating it as
 * "unset" and restoring the 120/minute default would quietly loosen a limit
 * someone had tried to tighten to nothing.
 *
 * @param {*} value
 * @param {number} fallback - Used only when the value is not a finite number.
 * @returns {number}
 */
function atLeastOne(value, fallback) {
    return Math.max(1, Number.isFinite(value) ? value : fallback);
}

class WebServer {
    /**
     * @param {Object} options
     * @param {number} [options.port] - Port to listen on (default 8080)
 * @param {string} [options.bindHost] - Host interface to bind to (default 127.0.0.1)
     * @param {string} [options.basePath] - Base path prefix for ingress (e.g., '/api/hassio_ingress/abc'); in add-on mode discovered from the Supervisor API and applied later via setBasePath()
     * @param {import('./labelLoader')} [options.labelLoader] - Label loader instance
     * @param {Function} [options.getStatus] - Function returning bridge status info
 * @param {string|null} [options.apiKey] - API key required for mutating endpoints
 * @param {boolean} [options.allowUnauthenticatedMutations=false] - Allow mutating requests without API key
 * @param {string[]|string|null} [options.allowedOrigins] - CORS allowlist (empty disables cross-origin access)
 * @param {number} [options.maxMutationRequestsPerWindow=120] - Maximum mutating requests per minute per client
 * @param {number} [options.maxReadRequestsPerWindow=300] - Maximum sensitive GET requests per window per client
 * @param {number} [options.maxAuthFailuresPerWindow=20] - Maximum failed auth attempts per minute per client before 429
 * @param {number} [options.rateLimitWindowMs] - Shared rate-limit window in ms (default 60000)
 * @param {number} [options.webRateLimitWindowMs] - Alias for rateLimitWindowMs (bridge settings)
 * @param {string|null} [options.triggerAppId] - C-Bus app ID configured as trigger groups (e.g. '202')
 * @param {Object} [options.deviceStateManager] - DeviceStateManager instance for device status endpoints
 * @param {Object} [options.eventStream] - Event stream interface ({ subscribe, unsubscribe, getRecent }) for the SSE endpoint
 * @param {number} [options.maxBodySizeBytes] - Maximum request body size in bytes
 * @param {number} [options.activeDeviceWindowMs] - Window in ms for considering a device active
 * @param {number} [options.haAreasCacheTtlMs] - Home Assistant areas cache TTL in ms
 * @param {number} [options.haApiTimeoutMs] - Home Assistant API request timeout in ms
 * @param {number} [options.maxSseConnections] - Maximum concurrent SSE connections
 * @param {number} [options._sseKeepaliveMs] - SSE keep-alive interval in ms (internal)
     */
    constructor(options = {}) {
        this.port = listenPort(options.port, 8080);
        this.bindHost = options.bindHost || '127.0.0.1';
        this.basePath = (options.basePath || '').replace(/\/+$/, '');
        this.labelLoader = options.labelLoader;
        this.triggerAppId = options.triggerAppId || null;
        this.eventStream = options.eventStream || null;
        this.getStatus = options.getStatus || (() => ({}));
        this.deviceStateManager = options.deviceStateManager || null;
        this.allowUnauthenticatedMutations = options.allowUnauthenticatedMutations === true;
        this.allowedOrigins = Array.isArray(options.allowedOrigins)
            ? options.allowedOrigins
            : (typeof options.allowedOrigins === 'string' && options.allowedOrigins.trim() !== ''
                ? options.allowedOrigins.split(',').map((origin) => origin.trim()).filter(Boolean)
                : null);
        // Prefer an explicit option; fall back to webRateLimitWindowMs naming used
        // by the bridge without importing schema (circular-dep risk).
        const windowOpt = options.rateLimitWindowMs !== undefined
            ? options.rateLimitWindowMs
            : options.webRateLimitWindowMs;
        this.rateLimitWindowMs = positiveNumber(windowOpt, 60000);
        this.maxMutationRequestsPerWindow = atLeastOne(options.maxMutationRequestsPerWindow, 120);
        this.maxReadRequestsPerWindow = atLeastOne(options.maxReadRequestsPerWindow, 300);
        // Failed authentication attempts get a separate, stricter bucket so an
        // exposed web_api_key can't be brute-forced unthrottled.
        this.maxAuthFailuresPerWindow = atLeastOne(options.maxAuthFailuresPerWindow, 20);
        this.maxBodySizeBytes = positiveNumber(options.maxBodySizeBytes, DEFAULT_MAX_BODY_SIZE);
        this.activeDeviceWindowMs = positiveNumber(options.activeDeviceWindowMs, 86400000);
        this.haAreasCacheTtlMs = positiveNumber(options.haAreasCacheTtlMs, 30000);
        this.haApiTimeoutMs = positiveNumber(options.haApiTimeoutMs, 5000);
        this.logger = createLogger({ component: 'WebServer' });
        this._server = null;

        // Unauthenticated mutations are only safe on loopback. Binding to a
        // public interface with the flag set would expose write APIs to the LAN.
        if (this.allowUnauthenticatedMutations && !isLoopbackBindHost(this.bindHost)) {
            this.logger.error(
                'Refusing allowUnauthenticatedMutations when bindHost is not loopback '
                + `(got "${this.bindHost}"). Set web_api_key, or bind to 127.0.0.1/::1/localhost.`
            );
            this.allowUnauthenticatedMutations = false;
        }

        this._apiAuth = new ApiAuth({
            apiKey: options.apiKey,
            allowUnauthenticatedMutations: this.allowUnauthenticatedMutations,
            getBasePath: () => this.basePath
        });
        this.apiKey = this._apiAuth.apiKey;
        this._rateLimiter = new RateLimiter({
            windowMs: this.rateLimitWindowMs,
            maxRequests: this.maxMutationRequestsPerWindow
        });
        this._readRateLimiter = new RateLimiter({
            windowMs: this.rateLimitWindowMs,
            maxRequests: this.maxReadRequestsPerWindow
        });
        this._authFailureLimiter = new RateLimiter({
            windowMs: this.rateLimitWindowMs,
            maxRequests: this.maxAuthFailuresPerWindow
        });
        this._labelRoutes = new LabelRoutes({
            labelLoader: this.labelLoader,
            triggerAppId: this.triggerAppId,
            maxBodySizeBytes: this.maxBodySizeBytes,
            logger: this.logger
        });
        this._statusRoutes = new StatusRoutes({
            getStatus: this.getStatus,
            labelLoader: this.labelLoader,
            deviceStateManager: this.deviceStateManager,
            eventStream: this.eventStream,
            activeDeviceWindowMs: this.activeDeviceWindowMs,
            haAreasCacheTtlMs: this.haAreasCacheTtlMs,
            haApiTimeoutMs: this.haApiTimeoutMs,
            logger: this.logger
        });
        this._sseHandler = new SseHandler({
            eventStream: this.eventStream,
            keepaliveMs: options._sseKeepaliveMs || 15000,
            maxConnections: Number.isFinite(options.maxSseConnections) && options.maxSseConnections > 0
                ? options.maxSseConnections
                : 32
        });
        this._staticFiles = new StaticFileServer({ logger: this.logger });

        if (typeof options.apiKey === 'string' && this.apiKey === null) {
            // Constructor-once: add-on password fields often submit "" or spaces.
            this.logger.warn(
                'Web API key is empty after trimming; treating as unset. '
                + 'Mutating routes require Home Assistant Ingress or loopback '
                + '(with web_allow_unauthenticated_mutations).'
            );
        } else if (!this.apiKey && this.allowUnauthenticatedMutations) {
            this.logger.warn('Web API key not configured; mutating endpoints are unauthenticated due to explicit override.');
        } else if (!this.apiKey) {
            this.logger.info('Web API key not configured; mutating endpoints require explicit unsafe override.');
        }
    }

    start() {
        this._startPromise = new Promise((resolve, reject) => {
            this._server = http.createServer((req, res) => this._handleRequest(req, res));

            this._server.on('error', (err) => {
                this.logger.error(`Web server error: ${err.message}`);
                reject(err);
            });

            this._server.listen(this.port, this.bindHost, () => {
                this.logger.info(
                    `Web server listening on ${this.bindHost}:${this.port}${this.basePath ? ` (base path: ${this.basePath})` : ''}`
                );
                resolve(undefined);
            });
        });
        return this._startPromise;
    }

    close() {
        // Wait for any in-flight start() to finish binding first: calling
        // server.close() while listen() is still pending errors with
        // ERR_SERVER_NOT_RUNNING and the server would keep listening.
        const started = this._startPromise || Promise.resolve();
        return started
            .catch(() => {
                // A failed start leaves nothing to close.
            })
            .then(() => new Promise((resolve) => {
                if (this._server) {
                    // An SSE response never ends on its own, so server.close()
                    // would wait for it forever: release the SSE listeners and
                    // sever live connections first (closeAllConnections is
                    // available on the ^20.19.0 engines floor).
                    this._sseHandler.closeAll();
                    this._server.closeAllConnections();
                    this._server.close(() => {
                        this.logger.info('Web server stopped');
                        resolve(undefined);
                    });
                } else {
                    resolve(undefined);
                }
            }));
    }

    /**
     * Update the ingress base path after the server has started. Used in add-on
     * mode, where the path is discovered asynchronously from the Supervisor API
     * (GitHub #33). The path embeds the HA ingress session token, so it is
     * never logged.
     * @param {string} basePath
     */
    setBasePath(basePath) {
        this.basePath = (basePath || '').replace(/\/+$/, '');
        if (this.basePath) {
            this.logger.info('HA ingress path applied; requests authenticated by Home Assistant ingress are now trusted.');
        }
    }

    async _handleRequest(req, res) {
        try {
            // Strip ingress base path
            let urlPath = req.url.split('?')[0];
            if (this.basePath && urlPath.startsWith(this.basePath)) {
                urlPath = urlPath.slice(this.basePath.length) || '/';
            }

            setCorsHeaders(req, res, this.allowedOrigins);
            setSecurityHeaders(res);

            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }

            if (this._apiAuth.requiresAuth(urlPath, req.method) && !this._apiAuth.isAuthorized(req)) {
                // Failed auth attempts get their own stricter bucket — an
                // exposed api key must not be brute-forceable unthrottled.
                if (this._authFailureLimiter.isLimited(req)) {
                    return sendJSON(res, 429, { error: 'Too many requests' });
                }
                return sendJSON(res, 401, { error: 'Unauthorized' });
            }

            if (this._apiAuth.isMutatingRoute(urlPath, req.method) && this._rateLimiter.isLimited(req)) {
                return sendJSON(res, 429, { error: 'Too many requests' });
            }

            if (this._apiAuth.isSensitiveReadRoute(urlPath, req.method)
                && this._readRateLimiter.isLimited(req)) {
                return sendJSON(res, 429, { error: 'Too many requests' });
            }

            const route = ROUTES.get(`${req.method} ${urlPath}`);
            if (route) {
                return await route(this, req, res);
            }

            // Static files
            return this._staticFiles.serve(urlPath, res);
        } catch (err) {
            this.logger.error(`Request error: ${err.message}`);
            // A handler that threw after writing the response head (e.g. SSE)
            // must not get a second writeHead — that throws ERR_HTTP_HEADERS_SENT
            // and would take the process down via unhandledRejection.
            if (res.headersSent) {
                res.end();
                return;
            }
            sendJSON(res, 500, { error: 'Internal server error' });
        }
    }
}

module.exports = WebServer;
