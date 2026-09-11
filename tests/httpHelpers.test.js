const {
    sendJSON,
    sendJSONAndClose,
    setSecurityHeaders,
    setCorsHeaders,
    isUnsafeObjectKey,
    sanitizePlainObject
} = require('../src/web/httpHelpers');

function mockRes() {
    return {
        headers: {},
        statusCode: null,
        body: null,
        setHeader(name, value) { this.headers[name] = value; },
        writeHead(status, headers) {
            this.statusCode = status;
            Object.assign(this.headers, headers || {});
        },
        end(body, cb) {
            this.body = body;
            if (typeof cb === 'function') cb();
        }
    };
}

describe('httpHelpers', () => {
    describe('isUnsafeObjectKey / sanitizePlainObject', () => {
        it('flags prototype-polluting keys', () => {
            expect(isUnsafeObjectKey('__proto__')).toBe(true);
            expect(isUnsafeObjectKey('constructor')).toBe(true);
            expect(isUnsafeObjectKey('prototype')).toBe(true);
            expect(isUnsafeObjectKey('labels')).toBe(false);
        });

        it('drops unsafe keys from a shallow copy', () => {
            const polluted = JSON.parse('{"labels":{"a":"1"},"__proto__":{"polluted":true},"constructor":"x"}');
            const clean = sanitizePlainObject(polluted);
            expect(clean.labels).toEqual({ a: '1' });
            expect(Object.prototype.hasOwnProperty.call(clean, '__proto__')).toBe(false);
            expect(clean.constructor).toBe(Object);
        });

        it('returns non-objects unchanged', () => {
            expect(sanitizePlainObject(null)).toBeNull();
            expect(sanitizePlainObject('x')).toBe('x');
            const arr = [1];
            expect(sanitizePlainObject(arr)).toBe(arr);
        });
    });

    describe('setCorsHeaders', () => {
        it('reflects an allowlisted origin and always sets Vary', () => {
            const req = { headers: { origin: 'https://ha.local' } };
            const res = mockRes();
            setCorsHeaders(req, res, ['https://ha.local']);
            expect(res.headers['Access-Control-Allow-Origin']).toBe('https://ha.local');
            expect(res.headers.Vary).toBe('Origin');
        });

        it('omits Allow-Origin for a disallowed origin', () => {
            const req = { headers: { origin: 'https://evil.example' } };
            const res = mockRes();
            setCorsHeaders(req, res, ['https://ha.local']);
            expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
            expect(res.headers.Vary).toBe('Origin');
        });

        it('does not set Vary when no allowlist is configured', () => {
            const req = { headers: { origin: 'https://ha.local' } };
            const res = mockRes();
            setCorsHeaders(req, res, null);
            expect(res.headers.Vary).toBeUndefined();
            expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
        });
    });

    describe('sendJSON / sendJSONAndClose', () => {
        it('writes a JSON body and content type', () => {
            const res = mockRes();
            sendJSON(res, 200, { ok: true });
            expect(res.statusCode).toBe(200);
            expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8');
            expect(JSON.parse(res.body)).toEqual({ ok: true });
        });

        it('destroys the request socket after sending', () => {
            const req = { destroy: jest.fn() };
            const res = mockRes();
            sendJSONAndClose(req, res, 413, { error: 'too large' });
            expect(res.statusCode).toBe(413);
            expect(req.destroy).toHaveBeenCalled();
        });
    });

    describe('setSecurityHeaders', () => {
        it('sets nosniff, referrer, and a same-origin CSP', () => {
            const res = mockRes();
            setSecurityHeaders(res);
            expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
            expect(res.headers['Referrer-Policy']).toBe('no-referrer');
            expect(res.headers['Content-Security-Policy']).toContain("default-src 'self'");
        });
    });
});
