// @ts-check
const DEFAULT_MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB

/** Distinct from null (error/empty) so callers can return 413 vs 400. */
const BODY_TOO_LARGE = Symbol('BODY_TOO_LARGE');

/**
 * Read a request body, enforcing the size cap.
 * Resolves:
 * - string/Buffer on success (may be empty)
 * - BODY_TOO_LARGE when the body exceeds the cap
 * - null on request error
 * @param {import('http').IncomingMessage} req
 * @param {number} [maxBodySizeBytes=DEFAULT_MAX_BODY_SIZE]
 * @param {Object} [options]
 * @param {boolean} [options.raw=false] - Resolve a Buffer instead of a UTF-8 string
 * @returns {Promise<string|Buffer|null|typeof BODY_TOO_LARGE>}
 */
function readRequestBody(req, maxBodySizeBytes = DEFAULT_MAX_BODY_SIZE, { raw = false } = {}) {
    return new Promise((resolve) => {
        let resolved = false;
        const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            if (resolved) return;
            size += chunk.length;
            if (size > maxBodySizeBytes) {
                // Do not destroy here — callers need to write a 413 first.
                // Pause so the socket stops filling the buffer until the response ends.
                req.pause();
                done(BODY_TOO_LARGE);
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            const body = Buffer.concat(chunks);
            done(raw ? body : body.toString('utf8'));
        });
        req.on('error', () => done(null));
    });
}

/**
 * Simple multipart/form-data parser for single file uploads.
 * Avoids adding busboy as a dependency for this simple use case.
 * @param {import('http').IncomingMessage} req
 * @param {string} contentType - The request Content-Type header
 * @param {number} [maxBodySizeBytes=DEFAULT_MAX_BODY_SIZE]
 * @returns {Promise<{buffer: Buffer, filename: string}|null|typeof BODY_TOO_LARGE>}
 */
async function parseMultipart(req, contentType, maxBodySizeBytes = DEFAULT_MAX_BODY_SIZE) {
    const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
    if (!boundaryMatch) return null;

    const boundary = boundaryMatch[1];
    const rawBody = /** @type {Buffer|null|typeof BODY_TOO_LARGE} */ (
        await readRequestBody(req, maxBodySizeBytes, { raw: true })
    );
    if (rawBody === BODY_TOO_LARGE) return BODY_TOO_LARGE;
    if (!rawBody) return null;

    const boundaryBuffer = Buffer.from(`--${boundary}`);
    const parts = [];
    let start = 0;

    while (true) {
        const idx = rawBody.indexOf(boundaryBuffer, start);
        if (idx === -1) break;
        if (start > 0) {
            parts.push(rawBody.slice(start, idx));
        }
        start = idx + boundaryBuffer.length;
        if (rawBody[start] === 0x0d && rawBody[start + 1] === 0x0a) start += 2;
        if (rawBody[start] === 0x2d && rawBody[start + 1] === 0x2d) break;
    }

    for (const part of parts) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;

        const headerStr = part.slice(0, headerEnd).toString('utf8');
        const body = part.slice(headerEnd + 4);
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

module.exports = {
    DEFAULT_MAX_BODY_SIZE,
    BODY_TOO_LARGE,
    readRequestBody,
    parseMultipart
};
