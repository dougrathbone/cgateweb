const http = require('http');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');
const CbusProjectParser = require('./cbusProjectParser');

const STATIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB

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
 * @param {string[]|string|null} [options.allowedOrigins] - CORS allowlist (null means '*')
 * @param {number} [options.maxMutationRequestsPerWindow=120] - Maximum mutating requests per minute per client
     */
    constructor(options = {}) {
        this.port = (options.port !== null && options.port !== undefined) ? options.port : 8080;
        this.bindHost = options.bindHost || '127.0.0.1';
        this.basePath = (options.basePath || '').replace(/\/+$/, '');
        this.labelLoader = options.labelLoader;
        this.getStatus = options.getStatus || (() => ({}));
        this.apiKey = options.apiKey || null;
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
        this._mutationRequestLog = new Map();
        this.logger = createLogger({ component: 'WebServer' });
        this._server = null;
        this._parser = new CbusProjectParser();
        if (!this.apiKey) {
            this.logger.warn('Web API key not configured; mutating endpoints are not authenticated.');
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
            if (urlPath === '/api/status' && req.method === 'GET') {
                return this._handleGetStatus(req, res);
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
            ...(fullData.exclude && { exclude: fullData.exclude })
        });
    }

    async _handlePutLabels(req, res) {
        const body = await this._readBody(req);
        if (!body) return this._sendJSON(res, 400, { error: 'Request body required' });

        let data;
        try {
            data = JSON.parse(body);
        } catch {
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
        } catch {
            return this._sendJSON(res, 400, { error: 'Invalid JSON' });
        }

        if (typeof patch !== 'object' || patch === null) {
            return this._sendJSON(res, 400, { error: 'Body must be an object of label updates' });
        }

        try {
            const existing = this.labelLoader.getLabelsObject();
            for (const [key, value] of Object.entries(patch)) {
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
                saved: true
            });
        } catch (err) {
            this._sendJSON(res, 400, { error: `Import failed: ${err.message}` });
        }
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
            return true;
        }

        const rawAuth = req.headers.authorization || '';
        const bearer = rawAuth.startsWith('Bearer ') ? rawAuth.slice('Bearer '.length).trim() : null;
        const headerKey = req.headers['x-api-key'];
        const provided = bearer || headerKey;
        return provided === this.apiKey;
    }

    _setCorsHeaders(req, res) {
        const requestOrigin = req.headers.origin;
        let origin = '*';
        if (this.allowedOrigins && this.allowedOrigins.length > 0) {
            const isAllowed = requestOrigin && this.allowedOrigins.includes(requestOrigin);
            origin = isAllowed ? requestOrigin : this.allowedOrigins[0];
            res.setHeader('Vary', 'Origin');
        }

        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, PATCH, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
    }

    _isRateLimited(req) {
        const source = String(
            req.headers['x-forwarded-for'] ||
            req.socket?.remoteAddress ||
            'unknown'
        ).split(',')[0].trim();
        const now = Date.now();
        const windowStart = now - this.rateLimitWindowMs;
        const existing = this._mutationRequestLog.get(source) || [];
        const inWindow = existing.filter((ts) => ts >= windowStart);
        inWindow.push(now);
        this._mutationRequestLog.set(source, inWindow);
        return inWindow.length > this.maxMutationRequestsPerWindow;
    }

    _readBody(req) {
        return new Promise((resolve) => {
            const chunks = [];
            let size = 0;
            req.on('data', (chunk) => {
                size += chunk.length;
                if (size > MAX_BODY_SIZE) {
                    req.destroy();
                    resolve(null);
                    return;
                }
                chunks.push(chunk);
            });
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            req.on('error', () => resolve(null));
        });
    }

    _readBodyRaw(req) {
        return new Promise((resolve) => {
            const chunks = [];
            let size = 0;
            req.on('data', (chunk) => {
                size += chunk.length;
                if (size > MAX_BODY_SIZE) {
                    req.destroy();
                    resolve(null);
                    return;
                }
                chunks.push(chunk);
            });
            req.on('end', () => resolve(Buffer.concat(chunks)));
            req.on('error', () => resolve(null));
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
