const DEFAULT_MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Read a request body as a UTF-8 string, enforcing the size cap.
 * Resolves null when the body exceeds the cap or the request errors.
 * @param {http.IncomingMessage} req
 * @param {number} [maxBodySizeBytes=DEFAULT_MAX_BODY_SIZE]
 * @returns {Promise<string|null>}
 */
function readRequestBody(req, maxBodySizeBytes = DEFAULT_MAX_BODY_SIZE) {
    return new Promise((resolve) => {
        let resolved = false;
        const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBodySizeBytes) {
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

/**
 * Read a request body as a raw Buffer, enforcing the size cap.
 * Resolves null when the body exceeds the cap or the request errors.
 * @param {http.IncomingMessage} req
 * @param {number} [maxBodySizeBytes=DEFAULT_MAX_BODY_SIZE]
 * @returns {Promise<Buffer|null>}
 */
function readRequestBodyRaw(req, maxBodySizeBytes = DEFAULT_MAX_BODY_SIZE) {
    return new Promise((resolve) => {
        let resolved = false;
        const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBodySizeBytes) {
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
 * @param {http.IncomingMessage} req
 * @param {string} contentType - The request Content-Type header
 * @param {number} [maxBodySizeBytes=DEFAULT_MAX_BODY_SIZE]
 * @returns {Promise<{buffer: Buffer, filename: string}|null>}
 */
async function parseMultipart(req, contentType, maxBodySizeBytes = DEFAULT_MAX_BODY_SIZE) {
    const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
    if (!boundaryMatch) return null;

    const boundary = boundaryMatch[1];
    const rawBody = await readRequestBodyRaw(req, maxBodySizeBytes);
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

module.exports = {
    DEFAULT_MAX_BODY_SIZE,
    readRequestBody,
    readRequestBodyRaw,
    parseMultipart
};
