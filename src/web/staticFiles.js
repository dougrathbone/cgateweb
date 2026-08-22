// @ts-check
const fs = require('fs');
const path = require('path');

const STATIC_DIR = path.join(__dirname, '..', '..', 'public');

/**
 * Map a request path to a file under STATIC_DIR, or null if it escapes.
 *
 * Rebuilds the path from path.relative() after rejecting `..` and absolute
 * relatives, so fs APIs never see the raw request URL.
 *
 * @param {string} urlPath
 * @returns {string|null}
 */
function containedStaticPath(urlPath) {
    const requested = path.normalize(String(urlPath || ''))
        .replace(/^(\.\.[/\\])+/, '')
        .replace(/^[/\\]+/, '');
    const staticRoot = path.resolve(STATIC_DIR);
    const resolved = path.resolve(staticRoot, requested || 'index.html');
    const relative = path.relative(staticRoot, resolved);
    if (
        relative.startsWith('..')
        || path.isAbsolute(relative)
        || relative.split(/[/\\]/).includes('..')
    ) {
        return null;
    }
    return path.join(staticRoot, relative);
}

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

        const filePath = containedStaticPath(urlPath);
        if (!filePath) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        if (!fs.existsSync(filePath)) {
            const indexPath = containedStaticPath('/index.html');
            if (indexPath && fs.existsSync(indexPath)) {
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
        stream.on('error', (err) => {
            this.logger.error(`Error streaming static file ${filePath}: ${err.message}`);
            if (!res.headersSent) {
                res.writeHead(500);
                res.end('Internal Server Error');
            } else {
                res.destroy(err);
            }
        });
        stream.on('open', () => {
            res.writeHead(200, { 'Content-Type': contentType });
            stream.pipe(res);
        });
    }
}

module.exports = StaticFileServer;
