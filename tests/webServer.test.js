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

        it('should contain all four tab buttons', async () => {
            const res = await request('GET', '/');
            expect(res.body).toContain('data-tab="status"');
            expect(res.body).toContain('data-tab="labels"');
            expect(res.body).toContain('data-tab="events"');
            expect(res.body).toContain('data-tab="import"');
        });

        it('should contain all four tab panels', async () => {
            const res = await request('GET', '/');
            expect(res.body).toContain('id="tabStatus"');
            expect(res.body).toContain('id="tabLabels"');
            expect(res.body).toContain('id="tabEvents"');
            expect(res.body).toContain('id="tabImport"');
        });

        it('should have status tab active by default', async () => {
            const res = await request('GET', '/');
            // The status tab button should have class="tab-btn active"
            expect(res.body).toMatch(/tab-btn active[^"]*" data-tab="status"/);
            // The status panel should have class="tab-panel active"
            expect(res.body).toMatch(/tab-panel active[^"]*" id="tabStatus"/);
        });

        it('should persist active tab via localStorage in client JS', async () => {
            const res = await request('GET', '/');
            expect(res.body).toContain("localStorage.getItem('activeTab')");
            expect(res.body).toContain("localStorage.setItem('activeTab'");
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

        it('should omit Access-Control-Allow-Origin on OPTIONS preflight from a disallowed origin', async () => {
            const corsServer = new WebServer({
                port: 0,
                labelLoader,
                allowedOrigins: ['https://ha.local'],
                getStatus: () => ({})
            });
            await corsServer.start();
            const corsPort = corsServer._server.address().port;

            try {
                const res = await new Promise((resolve, reject) => {
                    const req = http.request({
                        hostname: '127.0.0.1',
                        port: corsPort,
                        path: '/api/labels',
                        method: 'OPTIONS',
                        headers: { Origin: 'https://evil.example' }
                    }, (response) => {
                        resolve({ status: response.statusCode, headers: response.headers });
                    });
                    req.on('error', reject);
                    req.end();
                });

                // Browsers treat a missing Allow-Origin header on the preflight
                // response as a hard CORS denial. Server should NEVER reflect an
                // origin that is not in the allowlist.
                expect(res.headers['access-control-allow-origin']).toBeUndefined();
            } finally {
                await corsServer.close();
            }
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

        it('should honor maxBodySizeBytes override for body-size enforcement', () => {
            const tiny = new WebServer({
                port: 0,
                labelLoader,
                getStatus: () => ({}),
                maxBodySizeBytes: 4096
            });
            expect(tiny.maxBodySizeBytes).toBe(4096);

            const defaultBody = new WebServer({
                port: 0,
                labelLoader,
                getStatus: () => ({})
            });
            expect(defaultBody.maxBodySizeBytes).toBe(10 * 1024 * 1024);
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

    describe('Ingress authentication (HA-authenticated requests)', () => {
        let ingressServer;
        let ingressPort;
        const BASE = '/api/hassio_ingress/abc123';

        afterEach(async () => {
            if (ingressServer) await ingressServer.close();
            ingressServer = null;
        });

        const patchThroughIngress = (port, headers = {}) => new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port,
                path: `${BASE}/api/labels`,
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

        it('allows a mutation that arrives via HA Ingress when no API key is set (default add-on install)', async () => {
            // Reproduces the user bug: a default HA add-on install has no
            // web_api_key and web_allow_unauthenticated_mutations=false. The
            // bundled UI is served through ingress, which HA has already
            // authenticated, so the Supervisor-injected X-Ingress-Path header
            // must be trusted. Previously this returned 401 "Unauthorized".
            ingressServer = new WebServer({
                port: 0,
                basePath: BASE,
                labelLoader,
                getStatus: () => ({})
            });
            await ingressServer.start();
            ingressPort = ingressServer._server.address().port;

            const res = await patchThroughIngress(ingressPort, { 'X-Ingress-Path': BASE });
            expect(res.status).toBe(200);
        });

        it('still rejects a non-ingress unauthenticated mutation when no API key is set', async () => {
            // A direct request (no X-Ingress-Path) must remain blocked so an
            // exposed port is not opened up by the ingress trust.
            ingressServer = new WebServer({
                port: 0,
                basePath: BASE,
                labelLoader,
                getStatus: () => ({})
            });
            await ingressServer.start();
            ingressPort = ingressServer._server.address().port;

            const res = await patchThroughIngress(ingressPort);
            expect(res.status).toBe(401);
        });

        it('ignores X-Ingress-Path when the server is not running in ingress mode', async () => {
            // Without basePath the server is not behind ingress; a spoofed
            // X-Ingress-Path header must not grant access.
            ingressServer = new WebServer({
                port: 0,
                labelLoader,
                getStatus: () => ({})
            });
            await ingressServer.start();
            ingressPort = ingressServer._server.address().port;

            const res = await new Promise((resolve, reject) => {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port: ingressPort,
                    path: '/api/labels',
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json', 'X-Ingress-Path': '/spoofed' }
                }, (response) => {
                    let data = '';
                    response.on('data', (chunk) => { data += chunk; });
                    response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
                });
                req.on('error', reject);
                req.write(JSON.stringify({ '254/56/10': 'Patched' }));
                req.end();
            });

            expect(res.status).toBe(401);
        });

        it('still enforces a configured API key even for ingress requests', async () => {
            // When an operator has explicitly set web_api_key (e.g. to harden an
            // exposed port), it must always win over ingress trust.
            ingressServer = new WebServer({
                port: 0,
                basePath: BASE,
                labelLoader,
                apiKey: 'secret-key',
                getStatus: () => ({})
            });
            await ingressServer.start();
            ingressPort = ingressServer._server.address().port;

            const res = await patchThroughIngress(ingressPort, { 'X-Ingress-Path': BASE });
            expect(res.status).toBe(401);

            const ok = await patchThroughIngress(ingressPort, { 'X-Ingress-Path': BASE, 'X-API-Key': 'secret-key' });
            expect(ok.status).toBe(200);
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
            expect(second.body).toEqual({ error: 'Too many requests' });
        });

        it('does not rate-limit GET / read traffic regardless of frequency', async () => {
            // Mutation budget is 1 per window, but reads must never be capped -
            // a noisy dashboard polling /api/labels shouldn't lock itself out.
            limitedServer = new WebServer({
                port: 0,
                labelLoader,
                allowUnauthenticatedMutations: true,
                maxMutationRequestsPerWindow: 1,
                getStatus: () => ({})
            });
            await limitedServer.start();
            limitedPort = limitedServer._server.address().port;

            const doGet = () => new Promise((resolve, reject) => {
                http.get({
                    hostname: '127.0.0.1',
                    port: limitedPort,
                    path: '/api/labels'
                }, (res) => {
                    res.on('data', () => {});
                    res.on('end', () => resolve({ status: res.statusCode }));
                }).on('error', reject);
            });

            // Fire well past the mutation budget on GET - none should 429.
            for (let i = 0; i < 5; i++) {
                const r = await doGet();
                expect(r.status).toBe(200);
            }
        });

        it('removes dormant source entries after the rate limit window passes', () => {
            const directServer = new WebServer({
                labelLoader,
                maxMutationRequestsPerWindow: 5,
                getStatus: () => ({})
            });
            directServer.rateLimitWindowMs = 1000;

            const ipA = { headers: {}, socket: { remoteAddress: '192.168.1.10' } };
            const ipB = { headers: {}, socket: { remoteAddress: '192.168.1.11' } };

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

        it('returns a scope=labels-only notice so users do not assume the C-Gate project itself was loaded', async () => {
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
            expect(res.body.scope).toBe('labels-only');
            expect(res.body.notice).toMatch(/labels only/i);
            expect(res.body.notice).toMatch(/managed mode/i);
            expect(res.body.notice).toMatch(/\/share\/cgate\/tag/);
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

        it('returns 400 with a helpful message when label file path is not configured', async () => {
            // GitHub issue #3: reach the import handler with no file path set.
            const originalFilePath = labelLoader.filePath;
            labelLoader.filePath = null;
            try {
                const res = await request('POST', '/api/labels/import', Buffer.from('<xml>fake</xml>'),
                    { 'Content-Type': 'application/octet-stream' });
                expect(res.status).toBe(400);
                expect(res.body.error).toMatch(/label file path not configured/i);
                expect(res.body.error).toMatch(/cbus_label_file/);
            } finally {
                labelLoader.filePath = originalFilePath;
            }
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

    describe('Label mutation round-trip (undo/redo simulation)', () => {
        it('GET after PUT returns updated labels matching what was saved', async () => {
            // Simulate a save mutation then verify retrieval matches
            const saveRes = await request('PUT', '/api/labels', JSON.stringify({
                labels: { '254/56/10': 'Lounge Light', '254/56/20': 'Bedroom Light' },
                type_overrides: { '254/56/20': 'switch' }
            }));
            expect(saveRes.status).toBe(200);
            expect(saveRes.body.saved).toBe(true);

            const getRes = await request('GET', '/api/labels');
            expect(getRes.status).toBe(200);
            expect(getRes.body.labels['254/56/10']).toBe('Lounge Light');
            expect(getRes.body.labels['254/56/20']).toBe('Bedroom Light');
            expect(getRes.body.type_overrides['254/56/20']).toBe('switch');
        });

        it('re-saving original labels after a mutation restores the previous state', async () => {
            // Step 1: capture the initial server state (analogous to snapshot before mutation)
            const before = await request('GET', '/api/labels');
            expect(before.status).toBe(200);

            // Step 2: mutate labels (the "dirty" operation)
            const mutateRes = await request('PUT', '/api/labels', JSON.stringify({
                labels: { '254/56/10': 'Changed Label' }
            }));
            expect(mutateRes.status).toBe(200);
            expect(mutateRes.body.labels['254/56/10']).toBe('Changed Label');

            // Step 3: "undo" — re-save the original snapshot
            const undoRes = await request('PUT', '/api/labels', JSON.stringify({
                labels: before.body.labels,
                type_overrides: before.body.type_overrides,
                entity_ids: before.body.entity_ids,
                areas: before.body.areas,
                exclude: before.body.exclude
            }));
            expect(undoRes.status).toBe(200);

            // Step 4: verify the state matches the original snapshot
            const afterUndo = await request('GET', '/api/labels');
            expect(afterUndo.body.labels).toEqual(before.body.labels);
        });

        it('applying then reverting excludes produces original exclude list', async () => {
            // Initial: no excludes
            const initial = await request('GET', '/api/labels');
            expect(initial.body.exclude).toBeUndefined();

            // Exclude a key
            const withExclude = await request('PUT', '/api/labels', JSON.stringify({
                labels: initial.body.labels,
                exclude: ['254/56/10']
            }));
            expect(withExclude.status).toBe(200);

            const midState = await request('GET', '/api/labels');
            expect(midState.body.exclude).toContain('254/56/10');

            // Revert: remove the exclude (undo simulation) — pass exclude: [] to explicitly clear
            const revertRes = await request('PUT', '/api/labels', JSON.stringify({
                labels: initial.body.labels,
                exclude: []
            }));
            expect(revertRes.status).toBe(200);

            const afterRevert = await request('GET', '/api/labels');
            // labelLoader preserves sections that are explicitly provided as empty arrays
            expect(afterRevert.body.exclude ?? []).toEqual([]);
        });

        it('sequential PATCH mutations accumulate correctly and can be replaced via PUT', async () => {
            // PATCH 1: add a new label
            const patch1 = await request('PATCH', '/api/labels',
                JSON.stringify({ '254/56/30': 'Study Light' }));
            expect(patch1.status).toBe(200);
            expect(patch1.body.labels['254/56/30']).toBe('Study Light');

            // PATCH 2: update an existing label
            const patch2 = await request('PATCH', '/api/labels',
                JSON.stringify({ '254/56/10': 'Renamed Kitchen' }));
            expect(patch2.status).toBe(200);
            expect(patch2.body.labels['254/56/10']).toBe('Renamed Kitchen');
            expect(patch2.body.labels['254/56/30']).toBe('Study Light');

            // Simulate undo by restoring via PUT to the state before patch1
            const restore = await request('PUT', '/api/labels', JSON.stringify({
                labels: { '254/56/10': 'Kitchen', '254/56/11': 'Living Room' }
            }));
            expect(restore.status).toBe(200);

            const final = await request('GET', '/api/labels');
            expect(final.body.labels['254/56/10']).toBe('Kitchen');
            expect(final.body.labels['254/56/30']).toBeUndefined();
        });

        it('type_overrides and entity_ids round-trip without data loss', async () => {
            const payload = {
                labels: { '254/56/10': 'Kitchen Blind', '254/56/11': 'Garden Pump' },
                type_overrides: { '254/56/10': 'cover', '254/56/11': 'switch' },
                entity_ids: { '254/56/10': 'kitchen_blind', '254/56/11': 'garden_pump' },
                areas: { '254/56/10': 'Kitchen', '254/56/11': 'Garden' },
                exclude: ['254/56/99']
            };

            const saveRes = await request('PUT', '/api/labels', JSON.stringify(payload));
            expect(saveRes.status).toBe(200);

            const getRes = await request('GET', '/api/labels');
            expect(getRes.body.type_overrides).toEqual(payload.type_overrides);
            expect(getRes.body.entity_ids).toEqual(payload.entity_ids);
            expect(getRes.body.areas).toEqual(payload.areas);
            expect(getRes.body.exclude).toEqual(payload.exclude);

            // Re-PUT the fetched payload (simulating redo or save after undo)
            const redoRes = await request('PUT', '/api/labels', JSON.stringify({
                labels: getRes.body.labels,
                type_overrides: getRes.body.type_overrides,
                entity_ids: getRes.body.entity_ids,
                areas: getRes.body.areas,
                exclude: getRes.body.exclude
            }));
            expect(redoRes.status).toBe(200);
            expect(redoRes.body.saved).toBe(true);

            const afterRedo = await request('GET', '/api/labels');
            expect(afterRedo.body.labels).toEqual(payload.labels);
            expect(afterRedo.body.type_overrides).toEqual(payload.type_overrides);
        });

        it('removing a label via PUT null removal and re-adding via PATCH restores it', async () => {
            // Remove a label by omitting it in PUT
            const removeRes = await request('PUT', '/api/labels', JSON.stringify({
                labels: { '254/56/11': 'Living Room' }
            }));
            expect(removeRes.status).toBe(200);
            expect(removeRes.body.labels['254/56/10']).toBeUndefined();

            // Re-add via PATCH (simulate redo restoring the label)
            const readdRes = await request('PATCH', '/api/labels',
                JSON.stringify({ '254/56/10': 'Kitchen' }));
            expect(readdRes.status).toBe(200);
            expect(readdRes.body.labels['254/56/10']).toBe('Kitchen');
            expect(readdRes.body.labels['254/56/11']).toBe('Living Room');
        });
    });

    describe('GET /api/events/stream (SSE)', () => {
        /**
         * Helper that opens an SSE connection and collects data.
         * Returns { lines, res, destroy } where destroy() closes the connection.
         */
        function openSSE(ssePort, path = '/api/events/stream') {
            return new Promise((resolve, reject) => {
                const options = {
                    hostname: '127.0.0.1',
                    port: ssePort,
                    path,
                    method: 'GET',
                    headers: { Accept: 'text/event-stream' }
                };
                const req = http.request(options, (res) => {
                    const lines = [];
                    res.on('data', (chunk) => {
                        lines.push(...chunk.toString().split('\n').filter(Boolean));
                    });
                    resolve({ lines, res, destroy: () => req.destroy() });
                });
                req.on('error', (e) => {
                    // Ignore ECONNRESET from destroy()
                    if (e.code !== 'ECONNRESET') reject(e);
                });
                req.end();
            });
        }

        it('returns 200 with Content-Type text/event-stream', async () => {
            const { res, destroy } = await openSSE(port);
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toBe('text/event-stream');
            destroy();
        });

        it('sends data: prefixed JSON lines for recent events on connect', async () => {
            // Build a server with an eventStream that has buffered recent events
            const sampleEvent = { ts: 1000, network: '254', app: '56', group: '5', level: 128, type: 'update' };
            const listeners = new Set();
            const mockStream = {
                subscribe: (fn) => listeners.add(fn),
                unsubscribe: (fn) => listeners.delete(fn),
                getRecent: () => [sampleEvent]
            };
            const sseServer = new WebServer({
                port: 0,
                labelLoader,
                allowUnauthenticatedMutations: true,
                eventStream: mockStream
            });
            await sseServer.start();
            const ssePort = sseServer._server.address().port;

            const { lines, destroy } = await openSSE(ssePort);
            // Give response a tick to flush
            await new Promise((r) => setTimeout(r, 50));
            destroy();
            await sseServer.close();

            const dataLines = lines.filter((l) => l.startsWith('data:'));
            expect(dataLines.length).toBeGreaterThanOrEqual(1);
            const parsed = JSON.parse(dataLines[0].slice('data:'.length).trim());
            expect(parsed).toMatchObject({ ts: 1000, network: '254', app: '56', group: '5' });
        });

        it('SSE client receives new events pushed after connecting', (done) => {
            const listeners = new Set();
            const mockStream = {
                subscribe: (fn) => listeners.add(fn),
                unsubscribe: (fn) => listeners.delete(fn),
                getRecent: () => []
            };
            const sseServer = new WebServer({
                port: 0,
                labelLoader,
                allowUnauthenticatedMutations: true,
                eventStream: mockStream
            });
            sseServer.start().then(() => {
                const ssePort = sseServer._server.address().port;
                const received = [];
                const req = http.request(
                    { hostname: '127.0.0.1', port: ssePort, path: '/api/events/stream', method: 'GET' },
                    (res) => {
                        res.on('data', (chunk) => {
                            received.push(...chunk.toString().split('\n').filter(Boolean));
                        });

                        // After connection is open, push a live event
                        setTimeout(() => {
                            const liveEvent = { ts: 2000, network: '254', app: '56', group: '10', level: 255, type: 'on' };
                            for (const fn of listeners) fn(liveEvent);

                            setTimeout(() => {
                                req.destroy();
                                sseServer.close().then(() => {
                                    const dataLines = received.filter((l) => l.startsWith('data:'));
                                    expect(dataLines.length).toBeGreaterThanOrEqual(1);
                                    const parsed = JSON.parse(dataLines[dataLines.length - 1].slice('data:'.length).trim());
                                    expect(parsed).toMatchObject({ ts: 2000, group: '10', level: 255 });
                                    done();
                                }).catch(done);
                            }, 50);
                        }, 30);
                    }
                );
                req.on('error', (e) => { if (e.code !== 'ECONNRESET') done(e); });
                req.end();
            }).catch(done);
        }, 10000);

        it('disconnect cleans up the listener (no memory leak)', async () => {
            const listeners = new Set();
            const mockStream = {
                subscribe: (fn) => listeners.add(fn),
                unsubscribe: (fn) => listeners.delete(fn),
                getRecent: () => []
            };
            const sseServer = new WebServer({
                port: 0,
                labelLoader,
                allowUnauthenticatedMutations: true,
                eventStream: mockStream
            });
            await sseServer.start();
            const ssePort = sseServer._server.address().port;

            const { destroy } = await openSSE(ssePort);
            await new Promise((r) => setTimeout(r, 30));
            expect(listeners.size).toBe(1);

            // Disconnect the SSE client
            destroy();
            await new Promise((r) => setTimeout(r, 80));
            expect(listeners.size).toBe(0);

            await sseServer.close();
        });

        it('works without an eventStream (no crash, returns 200)', async () => {
            const plainServer = new WebServer({
                port: 0,
                labelLoader,
                allowUnauthenticatedMutations: true
                // no eventStream
            });
            await plainServer.start();
            const plainPort = plainServer._server.address().port;

            const { res, destroy } = await openSSE(plainPort);
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toBe('text/event-stream');
            destroy();
            await plainServer.close();
        });

        it('multiple simultaneous SSE clients each receive events', async () => {
            const listeners = new Set();
            const mockStream = {
                subscribe: (fn) => listeners.add(fn),
                unsubscribe: (fn) => listeners.delete(fn),
                getRecent: () => []
            };
            const sseServer = new WebServer({
                port: 0,
                labelLoader,
                allowUnauthenticatedMutations: true,
                eventStream: mockStream
            });
            await sseServer.start();
            const ssePort = sseServer._server.address().port;

            const client1Lines = [];
            const client2Lines = [];

            const makeClient = (lines) => new Promise((resolve, reject) => {
                const req = http.request(
                    { hostname: '127.0.0.1', port: ssePort, path: '/api/events/stream', method: 'GET' },
                    (res) => {
                        res.on('data', (chunk) => {
                            lines.push(...chunk.toString().split('\n').filter(Boolean));
                        });
                        resolve(req);
                    }
                );
                req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
                req.end();
            });

            const req1 = await makeClient(client1Lines);
            const req2 = await makeClient(client2Lines);

            await new Promise((r) => setTimeout(r, 30));
            expect(listeners.size).toBe(2);

            // Broadcast an event to all listeners
            const broadcastEvent = { ts: 3000, network: '254', app: '56', group: '7', level: 64, type: 'ramp' };
            for (const fn of listeners) fn(broadcastEvent);

            await new Promise((r) => setTimeout(r, 50));
            req1.destroy();
            req2.destroy();
            await sseServer.close();

            const c1data = client1Lines.filter((l) => l.startsWith('data:'));
            const c2data = client2Lines.filter((l) => l.startsWith('data:'));
            expect(c1data.length).toBeGreaterThanOrEqual(1);
            expect(c2data.length).toBeGreaterThanOrEqual(1);

            const p1 = JSON.parse(c1data[c1data.length - 1].slice('data:'.length).trim());
            const p2 = JSON.parse(c2data[c2data.length - 1].slice('data:'.length).trim());
            expect(p1).toMatchObject({ ts: 3000, group: '7' });
            expect(p2).toMatchObject({ ts: 3000, group: '7' });
        });

        it('keepalive comment is sent at interval', (done) => {
            const listeners = new Set();
            const mockStream = {
                subscribe: (fn) => listeners.add(fn),
                unsubscribe: (fn) => listeners.delete(fn),
                getRecent: () => []
            };
            // Use a very short keepalive interval for the test
            const sseServer = new WebServer({
                port: 0,
                labelLoader,
                allowUnauthenticatedMutations: true,
                eventStream: mockStream,
                _sseKeepaliveMs: 80
            });
            sseServer.start().then(() => {
                const ssePort = sseServer._server.address().port;
                const received = [];
                const req = http.request(
                    { hostname: '127.0.0.1', port: ssePort, path: '/api/events/stream', method: 'GET' },
                    (res) => {
                        res.on('data', (chunk) => {
                            received.push(chunk.toString());
                        });
                        // Wait long enough for at least one keepalive
                        setTimeout(() => {
                            req.destroy();
                            sseServer.close().then(() => {
                                const combined = received.join('');
                                expect(combined).toContain(': keepalive');
                                done();
                            }).catch(done);
                        }, 200);
                    }
                );
                req.on('error', (e) => { if (e.code !== 'ECONNRESET') done(e); });
                req.end();
            }).catch(done);
        }, 10000);

        it('filter/search on client side does not affect SSE server-side streaming', async () => {
            // The SSE endpoint streams all events without filtering;
            // filtering is purely a client-side concern.
            const events = [
                { ts: 100, network: '254', app: '56', group: '1', level: 100, type: 'on' },
                { ts: 200, network: '254', app: '56', group: '2', level: 50, type: 'update' }
            ];
            const listeners = new Set();
            const mockStream = {
                subscribe: (fn) => listeners.add(fn),
                unsubscribe: (fn) => listeners.delete(fn),
                getRecent: () => events
            };
            const sseServer = new WebServer({
                port: 0,
                labelLoader,
                allowUnauthenticatedMutations: true,
                eventStream: mockStream
            });
            await sseServer.start();
            const ssePort = sseServer._server.address().port;

            const { lines, destroy } = await openSSE(ssePort);
            await new Promise((r) => setTimeout(r, 50));
            destroy();
            await sseServer.close();

            // All buffered events should be sent; no server-side filtering
            const dataLines = lines.filter((l) => l.startsWith('data:'));
            expect(dataLines.length).toBeGreaterThanOrEqual(2);
        });
    });

    describe('GET /api/dashboard', () => {
        it('should return bridge status, devices, and labels', async () => {
            const now = Date.now();
            const mockDeviceStateManager = {
                getAllLastSeen: () => new Map([
                    ['254/56/10', now - 1000],
                    ['254/56/11', now - 100000000]
                ]),
                getAllLevels: () => new Map([
                    ['254/56/10', 128],
                    ['254/56/11', 0]
                ])
            };

            const dashServer = new WebServer({
                port: 0,
                labelLoader,
                deviceStateManager: mockDeviceStateManager,
                getStatus: () => ({
                    version: '1.5.3',
                    uptime: 3600,
                    ready: true,
                    lifecycle: { state: 'ready' },
                    connections: { mqtt: true, event: true },
                    metrics: {},
                    discovery: { count: 5 }
                })
            });
            await dashServer.start();
            const dashPort = dashServer._server.address().port;

            try {
                const res = await new Promise((resolve, reject) => {
                    http.get(`http://127.0.0.1:${dashPort}/api/dashboard`, (resp) => {
                        let data = '';
                        resp.on('data', (c) => { data += c; });
                        resp.on('end', () => resolve({ status: resp.statusCode, body: JSON.parse(data) }));
                    }).on('error', reject);
                });

                expect(res.status).toBe(200);
                expect(res.body.bridge.version).toBe('1.5.3');
                expect(res.body.bridge.ready).toBe(true);
                expect(res.body.labels.count).toBe(2);
                expect(res.body.devices.total).toBe(2);
                expect(res.body.devices.active).toBe(1); // only 254/56/10 within 24h
                expect(res.body.devices.list).toHaveLength(2);
                expect(res.body.devices.list[0].address).toBe('254/56/10');
                expect(res.body.devices.list[0].level).toBe(128);
                expect(res.body.devices.list[0].label).toBe('Kitchen');
                expect(res.body.devices.list[1].level).toBe(0);
                expect(res.body.devices.list[1].label).toBe('Living Room');
            } finally {
                await dashServer.close();
            }
        });

        it('should handle missing deviceStateManager gracefully', async () => {
            const res = await request('GET', '/api/dashboard');
            expect(res.status).toBe(200);
            expect(res.body.devices.total).toBe(0);
            expect(res.body.devices.list).toEqual([]);
        });
    });

    describe('GET /api/areas', () => {
        it('should return areas from label file', async () => {
            // Save labels with areas
            labelLoader.save({
                version: 1,
                labels: { '254/56/10': 'Kitchen', '254/56/11': 'Living Room' },
                areas: { '254/56/10': 'Kitchen', '254/56/11': 'Lounge' }
            });

            const res = await request('GET', '/api/areas');
            expect(res.status).toBe(200);
            expect(res.body.areas).toBeInstanceOf(Array);
            const names = res.body.areas.map(a => a.name);
            expect(names).toContain('Kitchen');
            expect(names).toContain('Lounge');
            res.body.areas.forEach(a => {
                expect(a).toHaveProperty('name');
                expect(a).toHaveProperty('source');
                expect(a.source).toBe('labels');
            });
        });

        it('should return empty array when no areas exist', async () => {
            const res = await request('GET', '/api/areas');
            expect(res.status).toBe(200);
            expect(res.body.areas).toEqual([]);
        });

        it('should deduplicate areas by name (case-insensitive)', async () => {
            labelLoader.save({
                version: 1,
                labels: { '254/56/10': 'Test', '254/56/11': 'Test2' },
                areas: { '254/56/10': 'Kitchen', '254/56/11': 'kitchen' }
            });

            const res = await request('GET', '/api/areas');
            expect(res.status).toBe(200);
            const kitchenAreas = res.body.areas.filter(a => a.name.toLowerCase() === 'kitchen');
            expect(kitchenAreas).toHaveLength(1);
        });

        it('should return areas sorted alphabetically', async () => {
            labelLoader.save({
                version: 1,
                labels: { '254/56/10': 'T1', '254/56/11': 'T2', '254/56/12': 'T3' },
                areas: { '254/56/10': 'Lounge', '254/56/11': 'Bedroom', '254/56/12': 'Kitchen' }
            });

            const res = await request('GET', '/api/areas');
            const names = res.body.areas.map(a => a.name);
            expect(names).toEqual(['Bedroom', 'Kitchen', 'Lounge']);
        });
    });

    describe('Security headers', () => {
        it('should include X-Content-Type-Options: nosniff', async () => {
            const res = await request('GET', '/api/status');
            expect(res.headers['x-content-type-options']).toBe('nosniff');
        });

        it('should not set CORS header for disallowed origins', async () => {
            const corsServer = new WebServer({
                port: 0,
                labelLoader,
                allowedOrigins: ['http://trusted.local'],
                getStatus: () => ({})
            });
            await corsServer.start();
            const corsPort = corsServer._server.address().port;

            try {
                const res = await new Promise((resolve, reject) => {
                    http.get(`http://127.0.0.1:${corsPort}/api/status`, {
                        headers: { 'Origin': 'http://evil.com' }
                    }, (resp) => {
                        resp.on('data', () => {});
                        resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers }));
                    }).on('error', reject);
                });

                expect(res.headers['access-control-allow-origin']).toBeUndefined();
            } finally {
                await corsServer.close();
            }
        });

        it('should set CORS header for allowed origins', async () => {
            const corsServer = new WebServer({
                port: 0,
                labelLoader,
                allowedOrigins: ['http://trusted.local'],
                getStatus: () => ({})
            });
            await corsServer.start();
            const corsPort = corsServer._server.address().port;

            try {
                const res = await new Promise((resolve, reject) => {
                    http.get(`http://127.0.0.1:${corsPort}/api/status`, {
                        headers: { 'Origin': 'http://trusted.local' }
                    }, (resp) => {
                        resp.on('data', () => {});
                        resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers }));
                    }).on('error', reject);
                });

                expect(res.headers['access-control-allow-origin']).toBe('http://trusted.local');
            } finally {
                await corsServer.close();
            }
        });
    });
});
