const { supervisorRequest, supervisorJson } = require('../src/supervisorHttp');

function fakeGet({ statusCode = 200, json, rawBody, requestError } = {}) {
    const calls = [];
    const httpModule = {
        get(url, opts, cb) {
            calls.push({ url, opts });
            const req = {
                on(ev, fn) {
                    if (ev === 'error' && requestError) setImmediate(() => fn(requestError));
                    return req;
                },
                setTimeout() { return req; },
                destroy() {}
            };
            if (!requestError) {
                const res = {
                    statusCode,
                    on(ev, fn) {
                        if (ev === 'data') {
                            setImmediate(() => fn(rawBody !== undefined ? rawBody : JSON.stringify(json)));
                        }
                        if (ev === 'end') setImmediate(fn);
                        return res;
                    }
                };
                setImmediate(() => cb(res));
            }
            return req;
        }
    };
    return { httpModule, calls };
}

describe('supervisorHttp', () => {
    it('GETs JSON with the bearer token via http.get', async () => {
        const { httpModule, calls } = fakeGet({ json: { data: { host: 'core-mosquitto' } } });
        const data = await supervisorJson({
            url: 'http://supervisor/services/mqtt',
            token: 'tok',
            httpModule,
            timeoutMs: 5000
        });
        expect(data).toEqual({ data: { host: 'core-mosquitto' } });
        expect(calls[0].url).toBe('http://supervisor/services/mqtt');
        expect(calls[0].opts.headers.Authorization).toBe('Bearer tok');
    });

    it('throws on non-200 JSON responses', async () => {
        const { httpModule } = fakeGet({ statusCode: 503, json: {} });
        await expect(supervisorJson({
            url: 'http://supervisor/addons/self/info',
            token: 'tok',
            httpModule
        })).rejects.toThrow('Supervisor API returned 503');
    });

    it('POSTs a JSON body via http.request', async () => {
        const calls = [];
        const httpModule = {
            request(url, opts, cb) {
                const call = { url, opts, body: '' };
                calls.push(call);
                const res = {
                    statusCode: 200,
                    on(ev, fn) { if (ev === 'end') setImmediate(fn); return res; }
                };
                const req = {
                    on() { return req; },
                    write(d) { call.body += d; },
                    end() { cb(res); },
                    destroy() {}
                };
                return req;
            }
        };
        const res = await supervisorRequest({
            method: 'POST',
            url: 'http://supervisor/core/api/services/persistent_notification/create',
            token: 'tok',
            httpModule,
            body: { notification_id: 'n1', title: 't', message: 'm' }
        });
        expect(res.statusCode).toBe(200);
        expect(calls[0].opts.method).toBe('POST');
        expect(JSON.parse(calls[0].body)).toEqual({
            notification_id: 'n1', title: 't', message: 'm'
        });
    });
});
