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

class WebServer {
    /**
     * @param {Object} options
     * @param {number} options.port - Port to listen on (default 8080)
 * @param {string} [options.bindHost] - Host interface to bind to (default 127.0.0.1)
     * @param {string} [options.basePath] - Base path prefix for ingress (e.g., '/api/hassio_ingress/abc'); in add-on mode discovered from the Supervisor API and applied later via setBasePath()
     * @param {import('./labelLoader')} options.labelLoader - Label loader instance
     * @param {Function} [options.getStatus] - Function returning bridge status info
 * @param {string|null} [options.apiKey] - API key required for mutating endpoints
 * @param {boolean} [options.allowUnauthenticatedMutations=false] - Allow mutating requests without API key
 * @param {string[]|string|null} [options.allowedOrigins] - CORS allowlist (empty disables cross-origin access)
 * @param {number} [options.maxMutationRequestsPerWindow=120] - Maximum mutating requests per minute per client
 * @param {string|null} [options.triggerAppId] - C-Bus app ID configured as trigger groups (e.g. '202')
     */
    constructor(options = {}) {
        this.port = (options.port !== null && options.port !== undefined) ? options.port : 8080;
        this.bindHost = options.bindHost || '127.0.0.1';
        this.basePath = (options.basePath || '').replace(/\/+$/, '');
        this.labelLoader = options.labelLoader;
        this.triggerAppId = options.triggerAppId || null;
        this.eventStream = options.eventStream || null;
        this.getStatus = options.getStatus || (() => ({}));
        this.deviceStateManager = options.deviceStateManager || null;
        this.apiKey = options.apiKey || null;
        this.allowUnauthenticatedMutations = options.allowUnauthenticatedMutations === true;
        this.allowedOrigins = Array.isArray(options.allowedOrigins)
            ? options.allowedOrigins
            : (typeof options.allowedOrigins === 'string' && options.allowedOrigins.trim() !== ''
                ? options.allowedOrigins.split(',').map((origin) => origin.trim()).filter(Boolean)
                : null);
        this.rateLimitWindowMs = 60000;
        this.maxMutationRequestsPerWindow = Math.max(
            1,
            Number.isFinite(options.maxMutationRequestsPerWindow)
                ? options.maxMutationRequestsPerWindow
                : 120
        );
        this.maxBodySizeBytes = Number.isFinite(options.maxBodySizeBytes) && options.maxBodySizeBytes > 0
            ? options.maxBodySizeBytes
            : DEFAULT_MAX_BODY_SIZE;
        this.activeDeviceWindowMs = Number.isFinite(options.activeDeviceWindowMs) && options.activeDeviceWindowMs > 0
            ? options.activeDeviceWindowMs
            : 86400000;
        this.haAreasCacheTtlMs = Number.isFinite(options.haAreasCacheTtlMs) && options.haAreasCacheTtlMs > 0
            ? options.haAreasCacheTtlMs
            : 30000;
        this.haApiTimeoutMs = Number.isFinite(options.haApiTimeoutMs) && options.haApiTimeoutMs > 0
            ? options.haApiTimeoutMs
            : 5000;
        this.logger = createLogger({ component: 'WebServer' });
        this._server = null;

        this._apiAuth = new ApiAuth({
            apiKey: this.apiKey,
            allowUnauthenticatedMutations: this.allowUnauthenticatedMutations,
            getBasePath: () => this.basePath
        });
        this._rateLimiter = new RateLimiter({
            windowMs: this.rateLimitWindowMs,
            maxRequests: this.maxMutationRequestsPerWindow
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

        if (!this.apiKey && this.allowUnauthenticatedMutations) {
            this.logger.warn('Web API key not configured; mutating endpoints are unauthenticated due to explicit override.');
        } else if (!this.apiKey) {
            this.logger.info('Web API key not configured; mutating endpoints require explicit unsafe override.');
        }
    }

    start() {
        return new Promise((resolve, reject) => {
            this._server = http.createServer((req, res) => this._handleRequest(req, res));

            this._server.on('error', (err) => {
                this.logger.error(`Web server error: ${err.message}`);
                reject(err);
            });

            this._server.listen(this.port, this.bindHost, () => {
                this.logger.info(
                    `Web server listening on ${this.bindHost}:${this.port}${this.basePath ? ` (base path: ${this.basePath})` : ''}`
                );
                resolve();
            });
        });
    }

    close() {
        return new Promise((resolve) => {
            if (this._server) {
                this._server.close(() => {
                    this.logger.info('Web server stopped');
                    resolve();
                });
            } else {
                resolve();
            }
        });
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
                return sendJSON(res, 401, { error: 'Unauthorized' });
            }

            if (this._apiAuth.isMutatingRoute(urlPath, req.method) && this._rateLimiter.isLimited(req)) {
                return sendJSON(res, 429, { error: 'Too many requests' });
            }

            // API routes
            if (urlPath === '/api/labels' && req.method === 'GET') {
                return this._labelRoutes.handleGetLabels(req, res);
            }
            if (urlPath === '/api/labels' && req.method === 'PUT') {
                return await this._labelRoutes.handlePutLabels(req, res);
            }
            if (urlPath === '/api/labels' && req.method === 'PATCH') {
                return await this._labelRoutes.handlePatchLabels(req, res);
            }
            if (urlPath === '/api/labels/import' && req.method === 'POST') {
                return await this._labelRoutes.handleImportLabels(req, res);
            }
            if (urlPath === '/api/labels/export.xml' && req.method === 'GET') {
                return this._labelRoutes.handleExportLabelsXml(req, res);
            }
            if (urlPath === '/api/status' && req.method === 'GET') {
                return this._statusRoutes.handleGetStatus(req, res);
            }
            if (urlPath === '/api/dashboard' && req.method === 'GET') {
                return this._statusRoutes.handleGetDashboard(req, res);
            }
            if (urlPath === '/api/areas' && req.method === 'GET') {
                return await this._statusRoutes.handleGetAreas(req, res);
            }
            if (urlPath === '/healthz' && req.method === 'GET') {
                return this._statusRoutes.handleHealth(req, res);
            }
            if (urlPath === '/readyz' && req.method === 'GET') {
                return this._statusRoutes.handleReady(req, res);
            }
            if (urlPath === '/api/events/stream' && req.method === 'GET') {
                return this._sseHandler.handle(req, res);
            }

            // Static files
            return this._staticFiles.serve(urlPath, res);
        } catch (err) {
            this.logger.error(`Request error: ${err.message}`);
            sendJSON(res, 500, { error: 'Internal server error' });
        }
    }
}

module.exports = WebServer;
