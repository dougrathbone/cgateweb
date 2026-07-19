// @ts-check
const fs = require('fs');
const path = require('path');

const STATIC_DIR = path.join(__dirname, '..', '..', 'public');

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

/**
 * Static file server for the bundled UI, with SPA fallback to index.html.
 */
class StaticFileServer {
    /**
     * @param {Object} options
     * @param {Object} options.logger - Logger instance
     */
    constructor({ logger }) {
        this.logger = logger;
    }

    /**
     * Serve a file from the static directory, falling back to index.html for
     * non-API, non-file routes (SPA fallback).
     * @param {string} urlPath
     * @param {import('http').ServerResponse} res
     */
    serve(urlPath, res) {
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
                this._streamFile(indexPath, MIME_TYPES['.html'], res);
                return;
            }
            res.writeHead(404);
            res.end('Not Found');
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        this._streamFile(filePath, contentType, res);
    }

    /**
     * Stream a file to the response with the given content type.
     * @param {string} filePath
     * @param {string} contentType
     * @param {import('http').ServerResponse} res
     */
    _streamFile(filePath, contentType, res) {
        const stream = fs.createReadStream(filePath);
        // Handle read failures (file removed mid-request, permission error).
        // Errors on open (ENOENT/EACCES) fire before 'open', so headers are not
        // yet sent and we can return a 500. A mid-stream read error arrives
        // after headers are sent, leaving no option but to destroy the response.
        stream.on('error', (err) => {
            this.logger.error(`Error streaming static file ${filePath}: ${err.message}`);
            if (!res.headersSent) {
                res.writeHead(500);
                res.end('Internal Server Error');
            } else {
                res.destroy(err);
            }
        });
        // Defer the success header until the file descriptor is open so an open
        // failure can still produce a clean 500 rather than a truncated 200.
        stream.on('open', () => {
            res.writeHead(200, { 'Content-Type': contentType });
            stream.pipe(res);
        });
    }
}

module.exports = StaticFileServer;
