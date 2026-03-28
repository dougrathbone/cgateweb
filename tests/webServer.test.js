const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebServer = require('../src/webServer');
const LabelLoader = require('../src/labelLoader');
const CbusProjectParser = require('../src/cbusProjectParser');

describe('WebServer', () => {
    let tmpDir, labelFile, labelLoader, server, port;

    beforeEach(async () => {
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});

        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webserver-test-'));
        labelFile = path.join(tmpDir, 'labels.json');
        fs.writeFileSync(labelFile, JSON.stringify({
            version: 1,
            source: 'test',
            labels: { '254/56/10': 'Kitchen', '254/56/11': 'Living Room' }
        }));

        labelLoader = new LabelLoader(labelFile);
        labelLoader.load();

        // Use port 0 for random available port
        port = 0;
        server = new WebServer({
            port,
            labelLoader,
            allowUnauthenticatedMutations: true,
            getStatus: () => ({ test: true })
        });
        await server.start();
        port = server._server.address().port;
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        await server.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function request(method, urlPath, body = null, extraHeaders = {}) {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: '127.0.0.1',
                port,
                path: urlPath,
                method,
                headers: { ...extraHeaders }
            };
            if (body && typeof body === 'string') {
                options.headers['Content-Type'] = 'application/json';
            }
            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers });
                    } catch {
                        resolve({ status: res.statusCode, body: data, headers: res.headers });
                    }
                });
            });
            req.on('error', reject);
            if (body) req.write(typeof body === 'string' ? body : body);
            req.end();
        });
    }

    describe('GET /api/labels', () => {
        it('should return current labels', async () => {
            const res = await request('GET', '/api/labels');
            expect(res.status).toBe(200);
            expect(res.body.labels).toEqual({ '254/56/10': 'Kitchen', '254/56/11': 'Living Room' });
            expect(res.body.count).toBe(2);
        });

        it('should return type_overrides, entity_ids, and exclude when present', async () => {
            fs.writeFileSync(labelFile, JSON.stringify({
                version: 1,
                source: 'test',
                labels: { '254/56/10': 'Kitchen' },
                type_overrides: { '254/56/10': 'cover' },
                entity_ids: { '254/56/10': 'kitchenblind' },
                exclude: ['254/56/99']
            }));
            labelLoader.load();

            const res = await request('GET', '/api/labels');
            expect(res.status).toBe(200);
            expect(res.body.type_overrides).toEqual({ '254/56/10': 'cover' });
            expect(res.body.entity_ids).toEqual({ '254/56/10': 'kitchenblind' });
            expect(res.body.exclude).toEqual(['254/56/99']);
        });

        it('should omit type_overrides, entity_ids, exclude when not present', async () => {
            const res = await request('GET', '/api/labels');
            expect(res.status).toBe(200);
            expect(res.body.type_overrides).toBeUndefined();
            expect(res.body.entity_ids).toBeUndefined();
            expect(res.body.exclude).toBeUndefined();
        });

        it('should omit trigger_app_id when not configured', async () => {
            const res = await request('GET', '/api/labels');
            expect(res.status).toBe(200);
            expect(res.body.trigger_app_id).toBeUndefined();
        });

        it('should include trigger_app_id when configured', async () => {
            await server.close();
            const triggerServer = new WebServer({
                port: 0,
                labelLoader,
                allowUnauthenticatedMutations: true,
                triggerAppId: '202'
            });
            await triggerServer.start();
            const triggerPort = triggerServer._server.address().port;

            try {
                const res = await new Promise((resolve, reject) => {
                    const options = { hostname: '127.0.0.1', port: triggerPort, path: '/api/labels', method: 'GET' };
                    const req = http.request(options, (r) => {
                        let data = '';
                        r.on('data', (c) => { data += c; });
                        r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(data) }));
                    });
                    req.on('error', reject);
                    req.end();
                });
                expect(res.status).toBe(200);
                expect(res.body.trigger_app_id).toBe('202');
            } finally {
                await triggerServer.close();
            }
        });
    });

    describe('PUT /api/labels', () => {
        it('should replace all labels', async () => {
            const res = await request('PUT', '/api/labels',
                JSON.stringify({ labels: { '254/56/10': 'New Kitchen', '254/56/12': 'Bedroom' } }));

            expect(res.status).toBe(200);
            expect(res.body.saved).toBe(true);
            expect(res.body.labels['254/56/10']).toBe('New Kitchen');
            expect(res.body.labels['254/56/12']).toBe('Bedroom');
            expect(res.body.labels['254/56/11']).toBeUndefined();
        });

        it('should reject invalid JSON', async () => {
            const res = await request('PUT', '/api/labels', 'not json');
            expect(res.status).toBe(400);
        });

        it('should reject missing labels key', async () => {
            const res = await request('PUT', '/api/labels', JSON.stringify({ foo: 'bar' }));
            expect(res.status).toBe(400);
        });

        it('should save type_overrides, entity_ids, and exclude', async () => {
            const res = await request('PUT', '/api/labels', JSON.stringify({
                labels: { '254/56/10': 'Kitchen Blind', '254/56/6': 'Pond Pump' },
                type_overrides: { '254/56/10': 'cover', '254/56/6': 'switch' },
                entity_ids: { '254/56/10': 'kitchenblind', '254/56/6': 'pondpump' },
                exclude: ['254/56/255']
            }));

            expect(res.status).toBe(200);
            expect(res.body.saved).toBe(true);

            const saved = JSON.parse(fs.readFileSync(labelFile, 'utf8'));
            expect(saved.type_overrides).toEqual({ '254/56/10': 'cover', '254/56/6': 'switch' });
            expect(saved.entity_ids).toEqual({ '254/56/10': 'kitchenblind', '254/56/6': 'pondpump' });
            expect(saved.exclude).toEqual(['254/56/255']);
        });

        it('should not write empty type_overrides/entity_ids/exclude sections', async () => {
            const res = await request('PUT', '/api/labels', JSON.stringify({
                labels: { '254/56/10': 'Kitchen' }
            }));

            expect(res.status).toBe(200);
            const saved = JSON.parse(fs.readFileSync(labelFile, 'utf8'));
            expect(saved.type_overrides).toBeUndefined();
            expect(saved.entity_ids).toBeUndefined();
            expect(saved.exclude).toBeUndefined();
        });
    });

    describe('PATCH /api/labels', () => {
        it('should merge label updates', async () => {
            const res = await request('PATCH', '/api/labels',
                JSON.stringify({ '254/56/10': 'Updated Kitchen', '254/56/12': 'New Entry' }));

            expect(res.status).toBe(200);
            expect(res.body.labels['254/56/10']).toBe('Updated Kitchen');
            expect(res.body.labels['254/56/11']).toBe('Living Room');
            expect(res.body.labels['254/56/12']).toBe('New Entry');
        });

        it('should remove labels when value is null', async () => {
            const res = await request('PATCH', '/api/labels',
                JSON.stringify({ '254/56/10': null }));

            expect(res.status).toBe(200);
            expect(res.body.labels['254/56/10']).toBeUndefined();
            expect(res.body.labels['254/56/11']).toBe('Living Room');
        });
    });

    describe('GET /api/status', () => {
        it('should return status info', async () => {
            const res = await request('GET', '/api/status');
            expect(res.status).toBe(200);
            expect(res.body.test).toBe(true);
            expect(res.body.labels.count).toBe(2);
        });
    });

    describe('GET /healthz and /readyz', () => {
        it('should return healthy status from /healthz', async () => {
            const res = await request('GET', '/healthz');
            expect(res.status).toBe(200);
            expect(res.body.ok).toBe(true);
        });

        it('should return 503 from /readyz when bridge is not ready', async () => {
            const unreadyServer = new WebServer({
                port: 0,
                labelLoader,
                getStatus: () => ({ ready: false, lifecycle: { state: 'booting' } })
            });
            await unreadyServer.start();
            const unreadyPort = unreadyServer._server.address().port;
            const res = await new Promise((resolve, reject) => {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port: unreadyPort,
                    path: '/readyz',
                    method: 'GET'
                }, (response) => {
                    let data = '';
                    response.on('data', (chunk) => { data += chunk; });
                    response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
                });
                req.on('error', reject);
                req.end();
            });
            await unreadyServer.close();

            expect(res.status).toBe(503);
            expect(res.body.ready).toBe(false);
        });
    });

    describe('GET / (static file)', () => {
        it('should serve index.html', async () => {
            const res = await request('GET', '/');
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toContain('text/html');
        });
    });

    describe('Ingress base path', () => {
        let ingressServer;
        let ingressPort;

        afterEach(async () => {
            if (ingressServer) await ingressServer.close();
        });

        it('should strip ingress base path from API requests', async () => {
            ingressServer = new WebServer({
                port: 0,
                basePath: '/api/hassio_ingress/abc123',
                labelLoader,
                getStatus: () => ({})
            });
            await ingressServer.start();
            ingressPort = ingressServer._server.address().port;

            const res = await new Promise((resolve, reject) => {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port: ingressPort,
                    path: '/api/hassio_ingress/abc123/api/labels',
                    method: 'GET'
                }, (res) => {
                    let data = '';
                    res.on('data', (chunk) => { data += chunk; });
                    res.on('end', () => {
                        resolve({ status: res.statusCode, body: JSON.parse(data) });
                    });
                });
                req.on('error', reject);
                req.end();
            });

            expect(res.status).toBe(200);
            expect(res.body.labels).toBeDefined();
        });
    });

    describe('CORS', () => {
        it('should handle OPTIONS preflight', async () => {
            const res = await new Promise((resolve, reject) => {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port,
                    path: '/api/labels',
                    method: 'OPTIONS'
                }, (response) => {
                    resolve({ status: response.statusCode, headers: response.headers });
                });
                req.on('error', reject);
                req.end();
            });

            expect(res.status).toBe(204);
            expect(res.headers['access-control-allow-origin']).toBeUndefined();
        });

        it('should return an allowlisted origin when configured', async () => {
            const corsServer = new WebServer({
                port: 0,
                labelLoader,
                allowedOrigins: ['https://ha.local'],
                getStatus: () => ({})
            });
            await corsServer.start();
            const corsPort = corsServer._server.address().port;

            const res = await new Promise((resolve, reject) => {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port: corsPort,
                    path: '/api/labels',
                    method: 'OPTIONS',
                    headers: { Origin: 'https://ha.local' }
                }, (response) => {
                    resolve({ status: response.statusCode, headers: response.headers });
                });
                req.on('error', reject);
                req.end();
            });
            await corsServer.close();

            expect(res.status).toBe(204);
            expect(res.headers['access-control-allow-origin']).toBe('https://ha.local');
        });
    });

    describe('API key protection', () => {
        let protectedServer;
        let protectedPort;

        afterEach(async () => {
            if (protectedServer) await protectedServer.close();
        });

        it('should require API key for mutating routes', async () => {
            protectedServer = new WebServer({
                port: 0,
                labelLoader,
                apiKey: 'secret-key',
                getStatus: () => ({})
            });
            await protectedServer.start();
            protectedPort = protectedServer._server.address().port;

            const makeReq = (headers = {}) => new Promise((resolve, reject) => {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port: protectedPort,
                    path: '/api/labels',
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json', ...headers }
                }, (res) => {
                    let data = '';
                    res.on('data', (chunk) => { data += chunk; });
                    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
                });
                req.on('error', reject);
                req.write(JSON.stringify({ '254/56/10': 'Patched' }));
                req.end();
            });

            const unauthorized = await makeReq();
            expect(unauthorized.status).toBe(401);

            const authorized = await makeReq({ 'X-API-Key': 'secret-key' });
            expect(authorized.status).toBe(200);
        });

        it('should reject mutating routes by default when no API key is configured', async () => {
            const defaultServer = new WebServer({
                port: 0,
                labelLoader,
                getStatus: () => ({})
            });
            await defaultServer.start();
            const defaultPort = defaultServer._server.address().port;

            const res = await new Promise((resolve, reject) => {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port: defaultPort,
                    path: '/api/labels',
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' }
                }, (response) => {
                    let data = '';
                    response.on('data', (chunk) => { data += chunk; });
                    response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
                });
                req.on('error', reject);
                req.write(JSON.stringify({ '254/56/10': 'Patched' }));
                req.end();
            });
            await defaultServer.close();

            expect(res.status).toBe(401);
        });

        it('should allow unauthenticated mutating routes only with explicit override', async () => {
            protectedServer = new WebServer({
                port: 0,
                labelLoader,
                allowUnauthenticatedMutations: true,
                getStatus: () => ({})
            });
            await protectedServer.start();
            protectedPort = protectedServer._server.address().port;

            const res = await new Promise((resolve, reject) => {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port: protectedPort,
                    path: '/api/labels',
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' }
                }, (response) => {
                    let data = '';
                    response.on('data', (chunk) => { data += chunk; });
                    response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
                });
                req.on('error', reject);
                req.write(JSON.stringify({ '254/56/10': 'Patched' }));
                req.end();
            });

            expect(res.status).toBe(200);
        });
    });

    describe('Mutation rate limiting', () => {
        let limitedServer;
        let limitedPort;

        afterEach(async () => {
            if (limitedServer) await limitedServer.close();
        });

        it('returns 429 when mutating requests exceed per-minute limit', async () => {
            limitedServer = new WebServer({
                port: 0,
                labelLoader,
                allowUnauthenticatedMutations: true,
                maxMutationRequestsPerWindow: 1,
                getStatus: () => ({})
            });
            await limitedServer.start();
            limitedPort = limitedServer._server.address().port;

            const doPatch = () => new Promise((resolve, reject) => {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port: limitedPort,
                    path: '/api/labels',
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' }
                }, (res) => {
                    let data = '';
                    res.on('data', (chunk) => { data += chunk; });
                    res.on('end', () => {
                        let body;
                        try {
                            body = JSON.parse(data);
                        } catch {
                            body = data;
                        }
                        resolve({ status: res.statusCode, body });
                    });
                });
                req.on('error', reject);
                req.write(JSON.stringify({ '254/56/10': 'Updated' }));
                req.end();
            });

            const first = await doPatch();
            expect(first.status).toBe(200);

            const second = await doPatch();
            expect(second.status).toBe(429);
        });

        it('removes dormant source entries after the rate limit window passes', () => {
            const directServer = new WebServer({
                labelLoader,
                maxMutationRequestsPerWindow: 5,
                getStatus: () => ({})
            });
            directServer.rateLimitWindowMs = 1000;

            const ipA = { headers: { 'x-forwarded-for': '192.168.1.10' }, socket: {} };
            const ipB = { headers: { 'x-forwarded-for': '192.168.1.11' }, socket: {} };

            const nowSpy = jest.spyOn(Date, 'now');
            nowSpy.mockReturnValue(1000);
            expect(directServer._isRateLimited(ipA)).toBe(false);
            expect(directServer._mutationRequestLog.has('192.168.1.10')).toBe(true);

            nowSpy.mockReturnValue(2501);
            expect(directServer._isRateLimited(ipB)).toBe(false);
            expect(directServer._mutationRequestLog.has('192.168.1.10')).toBe(false);
            expect(directServer._mutationRequestLog.has('192.168.1.11')).toBe(true);
        });
    });

    describe('Constructor options', () => {
        it('accepts allowedOrigins as a comma-separated string', () => {
            const s = new WebServer({
                labelLoader,
                allowedOrigins: 'https://a.local, https://b.local',
                getStatus: () => ({})
            });
            expect(s.allowedOrigins).toEqual(['https://a.local', 'https://b.local']);
        });

        it('sets allowedOrigins to null for empty string', () => {
            const s = new WebServer({ labelLoader, allowedOrigins: '', getStatus: () => ({}) });
            expect(s.allowedOrigins).toBeNull();
        });
    });

    describe('Static file serving', () => {
        it('returns 200 and falls back to index.html for unknown SPA routes', async () => {
            const res = await request('GET', '/some-nonexistent-route');
            // SPA fallback: index.html exists, so should get 200 text/html
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toContain('text/html');
        });

        it('returns 404 when SPA fallback index.html does not exist', () => {
            const fakeRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn(), pipe: jest.fn() };
            const directServer = new WebServer({ labelLoader, getStatus: () => ({}) });

            const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(false);
            directServer._serveStatic('/no-such-file.json', fakeRes);
            existsSpy.mockRestore();

            expect(fakeRes.writeHead).toHaveBeenCalledWith(404);
            expect(fakeRes.end).toHaveBeenCalledWith('Not Found');
        });
    });

    describe('Error handling', () => {
        it('returns 500 when PUT /api/labels labelLoader.save throws', async () => {
            jest.spyOn(labelLoader, 'save').mockImplementationOnce(() => { throw new Error('disk full'); });
            const res = await request('PUT', '/api/labels', JSON.stringify({ labels: { '254/56/1': 'Test' } }));
            expect(res.status).toBe(500);
            expect(res.body.error).toContain('disk full');
        });

        it('returns 500 when PATCH /api/labels labelLoader.save throws', async () => {
            jest.spyOn(labelLoader, 'save').mockImplementationOnce(() => { throw new Error('disk full'); });
            const res = await request('PATCH', '/api/labels', JSON.stringify({ '254/56/1': 'Test' }));
            expect(res.status).toBe(500);
            expect(res.body.error).toContain('disk full');
        });

        it('returns 400 when PATCH body is null JSON', async () => {
            const res = await request('PATCH', '/api/labels', 'null');
            expect(res.status).toBe(400);
        });

        it('returns 400 when PATCH body is malformed JSON', async () => {
            const res = await request('PATCH', '/api/labels', '{bad json}');
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('Invalid JSON');
        });
    });

    describe('POST /api/labels/import', () => {
        let parseSpy;

        beforeEach(() => {
            parseSpy = jest.spyOn(CbusProjectParser.prototype, 'parse').mockResolvedValue({
                labels: { '254/56/1': 'Imported Light' },
                networks: [254],
                stats: { total: 1 }
            });
        });

        afterEach(() => {
            parseSpy.mockRestore();
        });

        it('imports labels from raw body', async () => {
            const res = await new Promise((resolve, reject) => {
                const body = Buffer.from('<xml>fake</xml>');
                const req = http.request({
                    hostname: '127.0.0.1',
                    port,
                    path: '/api/labels/import',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'Content-Length': body.length
                    }
                }, (response) => {
                    let data = '';
                    response.on('data', (chunk) => { data += chunk; });
                    response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
                });
                req.on('error', reject);
                req.write(body);
                req.end();
            });
            expect(res.status).toBe(200);
            expect(res.body.imported).toBe(1);
            expect(res.body.saved).toBe(true);
        });

        it('merges imported labels with existing when merge=true', async () => {
            const res = await new Promise((resolve, reject) => {
                const body = Buffer.from('<xml>fake</xml>');
                const req = http.request({
                    hostname: '127.0.0.1',
                    port,
                    path: '/api/labels/import?merge=true',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'Content-Length': body.length
                    }
                }, (response) => {
                    let data = '';
                    response.on('data', (chunk) => { data += chunk; });
                    response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
                });
                req.on('error', reject);
                req.write(body);
                req.end();
            });
            expect(res.status).toBe(200);
            // merged: existing 2 labels + 1 imported (they may overlap, but total >= 1)
            expect(res.body.merged).toBe(true);
            expect(res.body.total).toBeGreaterThanOrEqual(1);
        });

        it('returns 400 when parse throws', async () => {
            parseSpy.mockRejectedValueOnce(new Error('bad file'));
            const res = await new Promise((resolve, reject) => {
                const body = Buffer.from('garbage');
                const req = http.request({
                    hostname: '127.0.0.1',
                    port,
                    path: '/api/labels/import',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'Content-Length': body.length
                    }
                }, (response) => {
                    let data = '';
                    response.on('data', (chunk) => { data += chunk; });
                    response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
                });
                req.on('error', reject);
                req.write(body);
                req.end();
            });
            expect(res.status).toBe(400);
            expect(res.body.error).toContain('bad file');
        });

        it('returns 400 when no body is sent', async () => {
            const res = await new Promise((resolve, reject) => {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port,
                    path: '/api/labels/import',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': 0 }
                }, (response) => {
                    let data = '';
                    response.on('data', (chunk) => { data += chunk; });
                    response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
                });
                req.on('error', reject);
                req.end();
            });
            expect(res.status).toBe(400);
        });

        it('imports labels from multipart/form-data upload', async () => {
            const fileContent = Buffer.from('<xml>fake</xml>');
            const boundary = 'TestBoundary123';
            const body = Buffer.concat([
                Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="labels.xml"\r\n\r\n`),
                fileContent,
                Buffer.from(`\r\n--${boundary}--\r\n`)
            ]);

            const res = await new Promise((resolve, reject) => {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port,
                    path: '/api/labels/import',
                    method: 'POST',
                    headers: {
                        'Content-Type': `multipart/form-data; boundary=${boundary}`,
                        'Content-Length': body.length
                    }
                }, (response) => {
                    let data = '';
                    response.on('data', (chunk) => { data += chunk; });
                    response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
                });
                req.on('error', reject);
                req.write(body);
                req.end();
            });
            expect(res.status).toBe(200);
            expect(res.body.imported).toBe(1);
        });

        it('returns 400 for multipart with no file part', async () => {
            const boundary = 'TestBoundary456';
            // No Content-Disposition with filename
            const body = Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="notafile"\r\n\r\nhello\r\n--${boundary}--\r\n`
            );

            const res = await new Promise((resolve, reject) => {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port,
                    path: '/api/labels/import',
                    method: 'POST',
                    headers: {
                        'Content-Type': `multipart/form-data; boundary=${boundary}`,
                        'Content-Length': body.length
                    }
                }, (response) => {
                    let data = '';
                    response.on('data', (chunk) => { data += chunk; });
                    response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
                });
                req.on('error', reject);
                req.write(body);
                req.end();
            });
            expect(res.status).toBe(400);
        });
    });

    describe('_readBody size limit', () => {
        it('resolves null and destroys the request when body exceeds 10MB', async () => {
            const directServer = new WebServer({ labelLoader, allowUnauthenticatedMutations: true, getStatus: () => ({}) });
            const EventEmitter = require('events');
            const mockReq = new EventEmitter();
            mockReq.destroy = jest.fn();

            const resultPromise = directServer._readBody(mockReq);
            const bigChunk = Buffer.alloc(11 * 1024 * 1024);
            mockReq.emit('data', bigChunk);

            const result = await resultPromise;
            expect(result).toBeNull();
            expect(mockReq.destroy).toHaveBeenCalled();
        });

        it('resolves null for _readBodyRaw when body exceeds 10MB', async () => {
            const directServer = new WebServer({ labelLoader, getStatus: () => ({}) });
            const EventEmitter = require('events');
            const mockReq = new EventEmitter();
            mockReq.destroy = jest.fn();

            const resultPromise = directServer._readBodyRaw(mockReq);
            mockReq.emit('data', Buffer.alloc(11 * 1024 * 1024));

            const result = await resultPromise;
            expect(result).toBeNull();
            expect(mockReq.destroy).toHaveBeenCalled();
        });
    });

    describe('Server startup error', () => {
        it('rejects when server emits an error event during start', async () => {
            const badServer = new WebServer({ port: 0, labelLoader, getStatus: () => ({}) });
            // Start once to occupy the port
            await badServer.start();
            const occupiedPort = badServer._server.address().port;

            const dupServer = new WebServer({ port: occupiedPort, labelLoader, getStatus: () => ({}) });
            await expect(dupServer.start()).rejects.toThrow();
            await badServer.close();
        });
    });

    describe('Request error handler (catch block)', () => {
        it('returns 500 when _handleRequest throws unexpectedly', async () => {
            jest.spyOn(server, '_handleGetStatus').mockImplementationOnce(() => { throw new Error('boom'); });
            const res = await request('GET', '/api/status');
            expect(res.status).toBe(500);
            expect(res.body.error).toBe('Internal server error');
        });
    });

    describe('PATCH empty body', () => {
        it('returns 400 when PATCH body is empty', async () => {
            const res = await new Promise((resolve, reject) => {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port,
                    path: '/api/labels',
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': 0 }
                }, (response) => {
                    let data = '';
                    response.on('data', (chunk) => { data += chunk; });
                    response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
                });
                req.on('error', reject);
                req.end();
            });
            expect(res.status).toBe(400);
        });
    });

    describe('_pruneMutationRequestLog partial prune', () => {
        it('updates the log entry when some timestamps are stale but others are fresh', () => {
            const directServer = new WebServer({ labelLoader, getStatus: () => ({}) });
            // Seed the log with a mix of old and new timestamps
            directServer._mutationRequestLog.set('10.0.0.1', [100, 200, 5000]);
            directServer._pruneMutationRequestLog(1000); // window starts at 1000
            // 100 and 200 are evicted; 5000 remains
            expect(directServer._mutationRequestLog.get('10.0.0.1')).toEqual([5000]);
        });
    });

    describe('GET /api/labels (label export / backup)', () => {
        // The label export "Download backup" feature in the UI uses GET /api/labels directly.
        // No dedicated /api/labels/export endpoint is needed; the existing endpoint returns
        // a valid JSON payload that can be re-imported.

        it('returns valid JSON with labels, count, and no extra fields when minimal data is present', async () => {
            const res = await request('GET', '/api/labels');
            expect(res.status).toBe(200);
            expect(typeof res.body.labels).toBe('object');
            expect(typeof res.body.count).toBe('number');
            expect(res.body.count).toBe(Object.keys(res.body.labels).length);
        });

        it('returned payload contains areas when present, making it re-importable', async () => {
            fs.writeFileSync(labelFile, JSON.stringify({
                version: 1,
                source: 'test',
                labels: { '254/56/10': 'Kitchen Light' },
                areas: { '254/56/10': 'Kitchen' }
            }));
            labelLoader.load();

            const res = await request('GET', '/api/labels');
            expect(res.status).toBe(200);
            expect(res.body.areas).toEqual({ '254/56/10': 'Kitchen' });
            // Verify we can round-trip: PUT the export back and it succeeds
            const putRes = await request('PUT', '/api/labels',
                JSON.stringify({ labels: res.body.labels, areas: res.body.areas }));
            expect(putRes.status).toBe(200);
            expect(putRes.body.saved).toBe(true);
        });

        it('content-type is application/json for backup consumption', async () => {
            const res = await request('GET', '/api/labels');
            expect(res.headers['content-type']).toMatch(/application\/json/);
        });
    });

    describe('GET /api/labels/export.xml', () => {
        it('returns 200 with Content-Type application/xml', async () => {
            const res = await request('GET', '/api/labels/export.xml');
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toMatch(/application\/xml/);
        });

        it('response contains XML declaration', async () => {
            const res = await request('GET', '/api/labels/export.xml');
            expect(res.body).toContain('<?xml version');
        });

        it('response contains <Project> root element', async () => {
            const res = await request('GET', '/api/labels/export.xml');
            expect(res.body).toContain('<Project>');
            expect(res.body).toContain('</Project>');
        });

        it('response contains <Network address="254"> for labels in network 254', async () => {
            const res = await request('GET', '/api/labels/export.xml');
            expect(res.body).toContain('<Network address="254">');
        });

        it('response contains <Application address="56"> for lighting app', async () => {
            const res = await request('GET', '/api/labels/export.xml');
            expect(res.body).toContain('<Application address="56"');
        });

        it('response contains <Group> elements for known devices', async () => {
            const res = await request('GET', '/api/labels/export.xml');
            expect(res.body).toContain('<Group address="10" description="Kitchen"');
            expect(res.body).toContain('<Group address="11" description="Living Room"');
        });

        it('groups are sorted numerically by address within application', async () => {
            fs.writeFileSync(labelFile, JSON.stringify({
                version: 1,
                source: 'test',
                labels: {
                    '254/56/20': 'Bedroom',
                    '254/56/3': 'Hall',
                    '254/56/10': 'Kitchen'
                }
            }));
            labelLoader.load();
            const res = await request('GET', '/api/labels/export.xml');
            const hallIdx = res.body.indexOf('address="3"');
            const kitchenIdx = res.body.indexOf('address="10"');
            const bedroomIdx = res.body.indexOf('address="20"');
            expect(hallIdx).toBeLessThan(kitchenIdx);
            expect(kitchenIdx).toBeLessThan(bedroomIdx);
        });

        it('empty labels dataset returns a valid empty <Project></Project>', async () => {
            fs.writeFileSync(labelFile, JSON.stringify({ version: 1, source: 'test', labels: {} }));
            labelLoader.load();
            const res = await request('GET', '/api/labels/export.xml');
            expect(res.status).toBe(200);
            expect(res.body).toContain('<Project>');
            expect(res.body).toContain('</Project>');
            expect(res.body).not.toContain('<Network');
        });

        it('XML is well-formed (parseable by xml2js)', async () => {
            const { parseString } = require('xml2js');
            const res = await request('GET', '/api/labels/export.xml');
            await new Promise((resolve, reject) => {
                parseString(res.body, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        });

        it('uses known app name descriptions (Lighting for app 56)', async () => {
            const res = await request('GET', '/api/labels/export.xml');
            expect(res.body).toContain('description="Lighting"');
        });

        it('includes Content-Disposition attachment header for browser download', async () => {
            const res = await request('GET', '/api/labels/export.xml');
            expect(res.headers['content-disposition']).toMatch(/attachment/);
            expect(res.headers['content-disposition']).toMatch(/cbus_labels\.xml/);
        });
    });

    describe('Path traversal guard', () => {
        it('sends 403 when resolved filePath escapes static dir', () => {
            const directServer = new WebServer({ labelLoader, getStatus: () => ({}) });
            const fakeRes = { writeHead: jest.fn(), end: jest.fn() };

            // Inject a path that path.join resolves to a location outside STATIC_DIR
            const origJoin = path.join;
            jest.spyOn(path, 'join').mockImplementationOnce(() => '/etc/passwd');
            directServer._serveStatic('/anything', fakeRes);
            path.join = origJoin;

            expect(fakeRes.writeHead).toHaveBeenCalledWith(403);
            expect(fakeRes.end).toHaveBeenCalledWith('Forbidden');
        });
    });
});
