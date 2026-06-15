const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createLogger } = require('./logger');
const CbusProjectParser = require('./cbusProjectParser');
const { DEFAULT_ADDON_LABEL_FILE } = require('./constants');

const STATIC_DIR = path.join(__dirname, '..', 'public');
const DEFAULT_MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB

const CBUS_APP_NAMES = {
    56: 'Lighting',
    136: 'Heating',
    172: 'Air Conditioning',
    202: 'Trigger Groups',
    203: 'Blinds'
};

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

class WebServer {
    /**
     * @param {Object} options
     * @param {number} options.port - Port to listen on (default 8080)
 * @param {string} [options.bindHost] - Host interface to bind to (default 127.0.0.1)
     * @param {string} [options.basePath] - Base path prefix for ingress (e.g., '/api/hassio_ingress/abc')
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
        this._sseKeepaliveMs = options._sseKeepaliveMs || 15000;
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
        this._mutationRequestLog = new Map();
        this._haAreasCache = null;
        this._haAreasCacheTime = 0;
        this.logger = createLogger({ component: 'WebServer' });
        this._server = null;
        this._parser = new CbusProjectParser();
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

    async _handleRequest(req, res) {
        try {
            // Strip ingress base path
            let urlPath = req.url.split('?')[0];
            if (this.basePath && urlPath.startsWith(this.basePath)) {
                urlPath = urlPath.slice(this.basePath.length) || '/';
            }

            this._setCorsHeaders(req, res);
            res.setHeader('X-Content-Type-Options', 'nosniff');
            // Don't leak the addon's URL (which includes the HA Ingress token
            // in the path) to any external resource the UI fetches.
            res.setHeader('Referrer-Policy', 'no-referrer');
            // Defence-in-depth CSP. The bundled UI uses inline <script>/<style>
            // so we keep 'unsafe-inline' for those - but everything else is
            // locked to same-origin, which kills the most common XSS payloads
            // (loading attacker-controlled JS from a third-party host).
            // frame-ancestors is intentionally omitted because HA Ingress
            // embeds the addon from a different host.
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

            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }

            if (this._isMutatingApiRoute(urlPath, req.method) && !this._isAuthorizedMutation(req)) {
                return this._sendJSON(res, 401, { error: 'Unauthorized' });
            }

            if (this._isMutatingApiRoute(urlPath, req.method) && this._isRateLimited(req)) {
                return this._sendJSON(res, 429, { error: 'Too many requests' });
            }

            // API routes
            if (urlPath === '/api/labels' && req.method === 'GET') {
                return this._handleGetLabels(req, res);
            }
            if (urlPath === '/api/labels' && req.method === 'PUT') {
                return await this._handlePutLabels(req, res);
            }
            if (urlPath === '/api/labels' && req.method === 'PATCH') {
                return await this._handlePatchLabels(req, res);
            }
            if (urlPath === '/api/labels/import' && req.method === 'POST') {
                return await this._handleImportLabels(req, res);
            }
            if (urlPath === '/api/labels/export.xml' && req.method === 'GET') {
                return this._handleExportLabelsXml(req, res);
            }
            if (urlPath === '/api/status' && req.method === 'GET') {
                return this._handleGetStatus(req, res);
            }
            if (urlPath === '/api/dashboard' && req.method === 'GET') {
                return this._handleGetDashboard(req, res);
            }
            if (urlPath === '/api/areas' && req.method === 'GET') {
                return await this._handleGetAreas(req, res);
            }
            if (urlPath === '/healthz' && req.method === 'GET') {
                return this._handleHealth(req, res);
            }
            if (urlPath === '/readyz' && req.method === 'GET') {
                return this._handleReady(req, res);
            }
            if (urlPath === '/api/events/stream' && req.method === 'GET') {
                return this._handleEventStream(req, res);
            }

            // Static files
            return this._serveStatic(urlPath, res);
        } catch (err) {
            this.logger.error(`Request error: ${err.message}`);
            this._sendJSON(res, 500, { error: 'Internal server error' });
        }
    }

    _handleGetLabels(_req, res) {
        const fullData = this.labelLoader.getFullData();
        this._sendJSON(res, 200, {
            labels: fullData.labels,
            count: Object.keys(fullData.labels).length,
            ...(fullData.type_overrides && { type_overrides: fullData.type_overrides }),
            ...(fullData.entity_ids && { entity_ids: fullData.entity_ids }),
            ...(fullData.exclude && { exclude: fullData.exclude }),
            ...(fullData.areas && { areas: fullData.areas }),
            ...(this.triggerAppId && { trigger_app_id: this.triggerAppId })
        });
    }

    async _handlePutLabels(req, res) {
        const body = await this._readBody(req);
        if (!body) return this._sendJSON(res, 400, { error: 'Request body required' });

        let data;
        try {
            data = JSON.parse(body);
        } catch (err) {
            this.logger.debug('Rejected PUT /labels with invalid JSON', { error: err.message });
            return this._sendJSON(res, 400, { error: 'Invalid JSON' });
        }

        if (!data.labels || typeof data.labels !== 'object') {
            return this._sendJSON(res, 400, { error: 'Body must contain a "labels" object' });
        }

        try {
            const fileData = {
                version: 1,
                source: 'web-ui',
                generated: new Date().toISOString(),
                labels: data.labels
            };
            if (data.type_overrides) fileData.type_overrides = data.type_overrides;
            if (data.entity_ids) fileData.entity_ids = data.entity_ids;
            if (data.exclude) fileData.exclude = data.exclude;
            if (data.areas) fileData.areas = data.areas;

            this.labelLoader.save(fileData);
            const fullData = this.labelLoader.getFullData();
            this._sendJSON(res, 200, {
                labels: fullData.labels,
                count: Object.keys(fullData.labels).length,
                saved: true
            });
        } catch (err) {
            this._sendJSON(res, 500, { error: `Failed to save: ${err.message}` });
        }
    }

    async _handlePatchLabels(req, res) {
        const body = await this._readBody(req);
        if (!body) return this._sendJSON(res, 400, { error: 'Request body required' });

        let patch;
        try {
            patch = JSON.parse(body);
        } catch (err) {
            this.logger.debug('Rejected PATCH /labels with invalid JSON', { error: err.message });
            return this._sendJSON(res, 400, { error: 'Invalid JSON' });
        }

        if (typeof patch !== 'object' || patch === null) {
            return this._sendJSON(res, 400, { error: 'Body must be an object of label updates' });
        }

        try {
            const existing = this.labelLoader.getLabelsObject();
            for (const [key, value] of Object.entries(patch)) {
                // Defence in depth: never let untrusted input write prototype-
                // polluting keys, even though label values are strings.
                if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
                if (value === null || value === '') {
                    delete existing[key];
                } else {
                    existing[key] = value;
                }
            }
            this.labelLoader.save(existing);
            const labels = this.labelLoader.getLabelsObject();
            this._sendJSON(res, 200, { labels, count: Object.keys(labels).length, saved: true });
        } catch (err) {
            this._sendJSON(res, 500, { error: `Failed to save: ${err.message}` });
        }
    }

    async _handleImportLabels(req, res) {
        if (!this.labelLoader.filePath) {
            return this._sendJSON(res, 400, {
                error: `Label file path not configured. In the Home Assistant add-on, set the "cbus_label_file" option (e.g. "${DEFAULT_ADDON_LABEL_FILE}"). In standalone mode, set cbus_label_file in settings.js.`
            });
        }

        const contentType = req.headers['content-type'] || '';
        let fileBuffer, filename;

        if (contentType.includes('multipart/form-data')) {
            const result = await this._parseMultipart(req, contentType);
            if (!result) {
                return this._sendJSON(res, 400, { error: 'No file found in upload' });
            }
            fileBuffer = result.buffer;
            filename = result.filename;
        } else {
            const body = await this._readBodyRaw(req);
            if (!body || body.length === 0) {
                return this._sendJSON(res, 400, { error: 'No file data received' });
            }
            fileBuffer = body;
            filename = 'upload';
        }

        try {
            const result = await this._parser.parse(fileBuffer, filename);

            // Check query param for merge mode
            const url = new URL(req.url, `http://${req.headers.host}`);
            const merge = url.searchParams.get('merge') === 'true';

            let finalLabels;
            if (merge) {
                const existing = this.labelLoader.getLabelsObject();
                finalLabels = { ...existing, ...result.labels };
            } else {
                finalLabels = result.labels;
            }

            this.labelLoader.save({
                version: 1,
                source: filename,
                generated: new Date().toISOString(),
                labels: finalLabels
            });

            this._sendJSON(res, 200, {
                imported: Object.keys(result.labels).length,
                total: Object.keys(finalLabels).length,
                networks: result.networks,
                stats: result.stats,
                merged: merge,
                saved: true,
                scope: 'labels-only',
                notice: 'Imported labels only. This does NOT load the C-Gate project itself. In managed mode, place a pre-built <PROJECT>.db file in /share/cgate/tag/ for the add-on to sync into C-Gate. See the add-on documentation for the supported managed-mode project workflow.'
            });
        } catch (err) {
            this._sendJSON(res, 400, { error: err.message });
        }
    }

    _handleExportLabelsXml(_req, res) {
        const labels = this.labelLoader.getLabelsObject();

        // Group labels by network -> app -> groups
        const networks = new Map();
        for (const [key, label] of Object.entries(labels)) {
            const parts = key.split('/');
            if (parts.length !== 3) continue;
            const [net, app, group] = parts;
            if (!networks.has(net)) networks.set(net, new Map());
            const apps = networks.get(net);
            if (!apps.has(app)) apps.set(app, new Map());
            apps.get(app).set(group, label);
        }

        const escapeXml = (str) => String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');

        const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<Project>'];

        for (const [netAddr, apps] of [...networks.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
            lines.push(`  <Network address="${escapeXml(netAddr)}">`);

            for (const [appAddr, groups] of [...apps.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
                const appName = CBUS_APP_NAMES[Number(appAddr)] || `Application ${appAddr}`;
                lines.push(`    <Application address="${escapeXml(appAddr)}" description="${escapeXml(appName)}">`);

                for (const [groupAddr, groupLabel] of [...groups.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
                    lines.push(`      <Group address="${escapeXml(groupAddr)}" description="${escapeXml(groupLabel)}" />`);
                }

                lines.push('    </Application>');
            }

            lines.push('  </Network>');
        }

        lines.push('</Project>');
        const xml = lines.join('\n');

        res.writeHead(200, {
            'Content-Type': 'application/xml; charset=utf-8',
            'Content-Disposition': 'attachment; filename="cbus_labels.xml"'
        });
        res.end(xml);
    }

    _handleGetStatus(_req, res) {
        const status = this.getStatus();
        const labels = this.labelLoader.getLabelsObject();
        this._sendJSON(res, 200, {
            ...status,
            labels: {
                count: Object.keys(labels).length,
                filePath: this.labelLoader.filePath
            }
        });
    }

    _handleGetDashboard(_req, res) {
        const status = this.getStatus();
        const labels = this.labelLoader.getLabelsObject();
        const labelCount = Object.keys(labels).length;

        // Build device list from device state manager
        const devices = [];
        if (this.deviceStateManager) {
            const allLastSeen = this.deviceStateManager.getAllLastSeen();
            const allLevels = this.deviceStateManager.getAllLevels
                ? this.deviceStateManager.getAllLevels()
                : new Map();
            for (const [address, lastSeen] of allLastSeen) {
                const level = allLevels.get(address);
                devices.push({
                    address,
                    level: level !== undefined ? level : null,
                    label: labels[address] || null,
                    lastSeen
                });
            }
            devices.sort((a, b) => b.lastSeen - a.lastSeen);
        }

        // Recent events from event stream
        const recentEvents = this.eventStream
            ? this.eventStream.getRecent().slice(-50)
            : [];

        this._sendJSON(res, 200, {
            bridge: {
                version: status.version,
                uptime: status.uptime,
                ready: status.ready,
                lifecycle: status.lifecycle
            },
            connections: status.connections,
            metrics: status.metrics,
            discovery: status.discovery,
            labels: { count: labelCount },
            devices: {
                total: devices.length,
                active: devices.filter(d => d.lastSeen > Date.now() - this.activeDeviceWindowMs).length,
                list: devices.slice(0, 200)
            },
            recentEvents: recentEvents.length
        });
    }

    async _handleGetAreas(_req, res) {
        // Collect areas from label file
        const labelAreas = new Set();
        if (this.labelLoader) {
            const areasMap = this.labelLoader.getLabelData?.()?.areas;
            if (areasMap) {
                const values = areasMap instanceof Map ? areasMap.values() : Object.values(areasMap);
                for (const area of values) {
                    if (area) labelAreas.add(area);
                }
            }
        }

        // Fetch areas from Home Assistant Supervisor API (cached 30s)
        let haAreas = [];
        const supervisorToken = process.env.SUPERVISOR_TOKEN;
        if (supervisorToken) {
            const now = Date.now();
            if (this._haAreasCache && now - this._haAreasCacheTime < this.haAreasCacheTtlMs) {
                haAreas = this._haAreasCache;
            } else {
                try {
                    const data = await new Promise((resolve) => {
                        const tmpl = '{{ areas() | map("area_name") | list | to_json }}';
                        const postBody = JSON.stringify({ template: tmpl });
                        const req = http.request('http://supervisor/core/api/template', {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${supervisorToken}`,
                                'Content-Type': 'application/json',
                                'Content-Length': Buffer.byteLength(postBody)
                            },
                            timeout: this.haApiTimeoutMs
                        }, (resp) => {
                            let body = '';
                            resp.on('data', (chunk) => { body += chunk; });
                            resp.on('end', () => {
                                this.logger.debug(`Area API HTTP ${resp.statusCode}, body length: ${body.length}`);
                                try { resolve(JSON.parse(body)); } catch { resolve(null); }
                            });
                        });
                        req.on('error', (e) => { this.logger.warn('Area API request error:', e.message); resolve(null); });
                        req.on('timeout', () => { this.logger.warn('Area API request timeout'); req.destroy(); resolve(null); });
                        req.write(postBody);
                        req.end();
                    });
                    this.logger.debug(`Area template response: isArray=${Array.isArray(data)}, count=${Array.isArray(data) ? data.length : 0}`);
                    if (Array.isArray(data)) {
                        for (const name of data) {
                            if (typeof name === 'string' && name) {
                                haAreas.push({ name, source: 'homeassistant' });
                            }
                        }
                        this._haAreasCache = haAreas;
                        this._haAreasCacheTime = now;
                    }
                } catch (err) {
                    this.logger.warn('Failed to fetch HA areas:', err.message || err);
                }
            }
        }

        // Merge: HA areas + label-file areas, deduplicated by name (case-insensitive)
        const seen = new Set();
        const merged = [];
        for (const ha of haAreas) {
            const key = ha.name.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                merged.push({ name: ha.name, source: 'homeassistant' });
            }
        }
        for (const name of labelAreas) {
            const key = name.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                merged.push({ name, source: 'labels' });
            }
        }
        merged.sort((a, b) => a.name.localeCompare(b.name));

        this._sendJSON(res, 200, { areas: merged });
    }

    _handleHealth(_req, res) {
        const status = this.getStatus();
        this._sendJSON(res, 200, {
            ok: true,
            uptime: status.uptime || process.uptime(),
            lifecycle: status.lifecycle || { state: 'unknown' }
        });
    }

    _handleReady(_req, res) {
        const status = this.getStatus();
        const isReady = !!status.ready;
        this._sendJSON(res, isReady ? 200 : 503, {
            ready: isReady,
            lifecycle: status.lifecycle || { state: 'unknown' }
        });
    }

    _handleEventStream(req, res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });

        // Flush headers immediately so the client knows the connection is open
        if (res.flushHeaders) res.flushHeaders();

        // Replay recent events first
        if (this.eventStream) {
            const recent = this.eventStream.getRecent();
            for (const entry of recent) {
                res.write(`data: ${JSON.stringify(entry)}\n\n`);
            }
        }

        // Listener for new events
        const listener = (entry) => {
            res.write(`data: ${JSON.stringify(entry)}\n\n`);
        };

        if (this.eventStream) {
            this.eventStream.subscribe(listener);
        }

        // Keepalive comment every 15 seconds to prevent proxy timeouts
        const keepaliveMs = this._sseKeepaliveMs || 15000;
        const keepaliveInterval = setInterval(() => {
            res.write(': keepalive\n\n');
        }, keepaliveMs);
        keepaliveInterval.unref();

        // Clean up on client disconnect
        req.on('close', () => {
            clearInterval(keepaliveInterval);
            if (this.eventStream) {
                this.eventStream.unsubscribe(listener);
            }
        });
    }

    _serveStatic(urlPath, res) {
        if (urlPath === '/' || urlPath === '') {
            urlPath = '/index.html';
        }

        const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
        const filePath = path.join(STATIC_DIR, safePath);

        if (!filePath.startsWith(STATIC_DIR)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        if (!fs.existsSync(filePath)) {
            // SPA fallback: serve index.html for non-API, non-file routes
            const indexPath = path.join(STATIC_DIR, 'index.html');
            if (fs.existsSync(indexPath)) {
                res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'] });
                fs.createReadStream(indexPath).pipe(res);
                return;
            }
            res.writeHead(404);
            res.end('Not Found');
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        fs.createReadStream(filePath).pipe(res);
    }

    _sendJSON(res, statusCode, data) {
        res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
    }

    _isMutatingApiRoute(urlPath, method) {
        if (!['PUT', 'PATCH', 'POST', 'DELETE'].includes(method)) return false;
        return urlPath === '/api/labels' || urlPath === '/api/labels/import';
    }

    _isAuthorizedMutation(req) {
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

    _isIngressRequest(req) {
        // Only trust the ingress marker when the server was actually started in
        // ingress mode (INGRESS_ENTRY -> basePath). This prevents a spoofed
        // X-Ingress-Path header from bypassing auth on a standalone deployment
        // that is not fronted by the Supervisor proxy.
        if (!this.basePath) return false;
        const ingressPath = req.headers['x-ingress-path'];
        return typeof ingressPath === 'string' && ingressPath.length > 0;
    }

    _setCorsHeaders(req, res) {
        const requestOrigin = req.headers.origin;
        if (this.allowedOrigins && this.allowedOrigins.length > 0) {
            res.setHeader('Vary', 'Origin');
            if (requestOrigin && this.allowedOrigins.includes(requestOrigin)) {
                res.setHeader('Access-Control-Allow-Origin', requestOrigin);
            }
            // If origin is not in the allowlist, omit the header entirely —
            // the browser will block the cross-origin request.
        }
        res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, PATCH, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
    }

    _isRateLimited(req) {
        // Use socket address for rate limiting — X-Forwarded-For is spoofable
        // and would allow bypass by rotating the header value.
        const source = String(req.socket?.remoteAddress || 'unknown');
        const now = Date.now();
        const windowStart = now - this.rateLimitWindowMs;
        this._pruneMutationRequestLog(windowStart);
        const inWindow = this._mutationRequestLog.get(source) || [];
        // Cap array size to prevent memory exhaustion from rapid requests
        if (inWindow.length <= this.maxMutationRequestsPerWindow * 2) {
            inWindow.push(now);
        }
        this._mutationRequestLog.set(source, inWindow);
        return inWindow.length > this.maxMutationRequestsPerWindow;
    }

    _pruneMutationRequestLog(windowStart) {
        for (const [source, timestamps] of this._mutationRequestLog.entries()) {
            const inWindow = timestamps.filter((ts) => ts >= windowStart);
            if (inWindow.length === 0) {
                this._mutationRequestLog.delete(source);
                continue;
            }
            if (inWindow.length !== timestamps.length) {
                this._mutationRequestLog.set(source, inWindow);
            }
        }
    }

    _readBody(req) {
        return new Promise((resolve) => {
            let resolved = false;
            const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };
            const chunks = [];
            let size = 0;
            req.on('data', (chunk) => {
                size += chunk.length;
                if (size > this.maxBodySizeBytes) {
                    req.destroy();
                    done(null);
                    return;
                }
                chunks.push(chunk);
            });
            req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
            req.on('error', () => done(null));
        });
    }

    _readBodyRaw(req) {
        return new Promise((resolve) => {
            let resolved = false;
            const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };
            const chunks = [];
            let size = 0;
            req.on('data', (chunk) => {
                size += chunk.length;
                if (size > this.maxBodySizeBytes) {
                    req.destroy();
                    done(null);
                    return;
                }
                chunks.push(chunk);
            });
            req.on('end', () => done(Buffer.concat(chunks)));
            req.on('error', () => done(null));
        });
    }

    /**
     * Simple multipart/form-data parser for single file uploads.
     * Avoids adding busboy as a dependency for this simple use case.
     */
    async _parseMultipart(req, contentType) {
        const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
        if (!boundaryMatch) return null;

        const boundary = boundaryMatch[1];
        const rawBody = await this._readBodyRaw(req);
        if (!rawBody) return null;

        const boundaryBuffer = Buffer.from(`--${boundary}`);
        const parts = [];
        let start = 0;

        while (true) {
            const idx = rawBody.indexOf(boundaryBuffer, start);
            if (idx === -1) break;
            if (start > 0) {
                // slice between previous boundary end and this boundary start
                parts.push(rawBody.slice(start, idx));
            }
            start = idx + boundaryBuffer.length;
            // skip CRLF after boundary
            if (rawBody[start] === 0x0d && rawBody[start + 1] === 0x0a) start += 2;
            // check for closing --
            if (rawBody[start] === 0x2d && rawBody[start + 1] === 0x2d) break;
        }

        for (const part of parts) {
            const headerEnd = part.indexOf('\r\n\r\n');
            if (headerEnd === -1) continue;

            const headerStr = part.slice(0, headerEnd).toString('utf8');
            const body = part.slice(headerEnd + 4);
            // Trim trailing CRLF
            const trimmed = (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a)
                ? body.slice(0, body.length - 2)
                : body;

            const filenameMatch = headerStr.match(/filename="([^"]+)"/);
            if (filenameMatch) {
                return { buffer: trimmed, filename: filenameMatch[1] };
            }
        }

        return null;
    }
}

module.exports = WebServer;
