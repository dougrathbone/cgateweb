const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebServer = require('../src/webServer');
const LabelLoader = require('../src/labelLoader');

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
            expect(res.headers['access-control-allow-origin']).toBe('*');
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
});
