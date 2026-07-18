const { discoverIngressEntry } = require('../src/ingressDiscovery');

const ENTRY = '/api/hassio_ingress/abc123token';

// Minimal fake http.get, haNotifier-test style. `steps` is a list of per-call
// behaviours (last one repeats): { statusCode, json, rawBody, requestError }.
function scriptedHttpGet(steps) {
    const calls = [];
    let i = 0;
    const httpModule = {
        get(url, opts, cb) {
            const step = steps[Math.min(i, steps.length - 1)];
            i++;
            calls.push({ url, opts });
            const req = {
                on(ev, fn) {
                    if (ev === 'error' && step.requestError) setImmediate(() => fn(step.requestError));
                    return req;
                },
                setTimeout() { return req; },
                destroy() {}
            };
            if (!step.requestError) {
                const res = {
                    statusCode: step.statusCode || 200,
                    on(ev, fn) {
                        if (ev === 'data') {
                            setImmediate(() => fn(step.rawBody !== undefined ? step.rawBody : JSON.stringify(step.json)));
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

const noSleep = () => Promise.resolve();

describe('ingressDiscovery', () => {
    it('returns data.ingress_entry from the Supervisor API with the bearer token', async () => {
        const { httpModule, calls } = scriptedHttpGet([{ json: { data: { ingress_entry: ENTRY } } }]);

        const entry = await discoverIngressEntry({ token: 'tok', httpModule, sleep: noSleep });

        expect(entry).toBe(ENTRY);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('http://supervisor/addons/self/info');
        expect(calls[0].opts.headers.Authorization).toBe('Bearer tok');
    });

    it('returns null without a token and never calls the Supervisor', async () => {
        const { httpModule, calls } = scriptedHttpGet([{ json: {} }]);

        const entry = await discoverIngressEntry({ token: null, httpModule, sleep: noSleep });

        expect(entry).toBeNull();
        expect(calls).toHaveLength(0);
    });

    it('retries after a request error and succeeds on a later attempt', async () => {
        const { httpModule, calls } = scriptedHttpGet([
            { requestError: new Error('Connection refused') },
            { json: { data: { ingress_entry: ENTRY } } }
        ]);

        const entry = await discoverIngressEntry({ token: 'tok', httpModule, sleep: noSleep });

        expect(entry).toBe(ENTRY);
        expect(calls).toHaveLength(2);
    });

    it('retries on non-200 responses and gives up with null after all attempts', async () => {
        const { httpModule, calls } = scriptedHttpGet([{ statusCode: 503, json: {} }]);

        const entry = await discoverIngressEntry({ token: 'tok', httpModule, attempts: 3, sleep: noSleep });

        expect(entry).toBeNull();
        expect(calls).toHaveLength(3);
    });

    it('treats a response without ingress_entry as a failure and retries', async () => {
        const { httpModule, calls } = scriptedHttpGet([
            { json: { data: { slug: 'cgateweb' } } },
            { json: { data: { ingress_entry: ENTRY } } }
        ]);

        const entry = await discoverIngressEntry({ token: 'tok', httpModule, sleep: noSleep });

        expect(entry).toBe(ENTRY);
        expect(calls).toHaveLength(2);
    });

    it('retries on invalid JSON and returns null when it never recovers', async () => {
        const { httpModule, calls } = scriptedHttpGet([{ rawBody: 'not json{' }]);

        const entry = await discoverIngressEntry({ token: 'tok', httpModule, attempts: 2, sleep: noSleep });

        expect(entry).toBeNull();
        expect(calls).toHaveLength(2);
    });

    it('times out a hanging request and moves on to the next attempt', async () => {
        const calls = [];
        let i = 0;
        const httpModule = {
            get(url, opts, cb) {
                i++;
                calls.push({ url });
                const req = {
                    on() { return req; },
                    setTimeout(_ms, fn) {
                        // First request times out; second succeeds immediately.
                        if (i === 1) setImmediate(() => { req.destroy(); fn(); });
                        return req;
                    },
                    destroy() {}
                };
                if (i === 2) {
                    const res = {
                        statusCode: 200,
                        on(ev, fn) {
                            if (ev === 'data') setImmediate(() => fn(JSON.stringify({ data: { ingress_entry: ENTRY } })));
                            if (ev === 'end') setImmediate(fn);
                            return res;
                        }
                    };
                    setImmediate(() => cb(res));
                }
                return req;
            }
        };

        const entry = await discoverIngressEntry({ token: 'tok', httpModule, sleep: noSleep });

        expect(entry).toBe(ENTRY);
        expect(calls).toHaveLength(2);
    });

    it('trims whitespace around the discovered entry', async () => {
        const { httpModule } = scriptedHttpGet([{ json: { data: { ingress_entry: ` ${ENTRY}\n` } } }]);

        const entry = await discoverIngressEntry({ token: 'tok', httpModule, sleep: noSleep });

        expect(entry).toBe(ENTRY);
    });
});
