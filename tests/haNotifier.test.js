const { createPersistentNotification, dismissPersistentNotification } = require('../src/haNotifier');

// Minimal fake http.request capturing url/opts/body and driving the response.
function fakeHttp(statusCode = 200) {
    const calls = [];
    const httpModule = {
        request(url, opts, cb) {
            const call = { url, opts, body: '' };
            calls.push(call);
            const res = {
                statusCode,
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
    return { httpModule, calls };
}

// Fake http.request whose req event handlers can be fired by the test, to
// exercise the 'error' and 'timeout' branches.
function controllableHttp() {
    const handlers = {};
    let destroyed = false;
    const req = {
        on(ev, fn) { handlers[ev] = fn; return req; },
        write() {},
        end() {},
        destroy() { destroyed = true; }
    };
    const httpModule = { request() { return req; } };
    return {
        httpModule,
        fireError: (err) => handlers.error && handlers.error(err),
        fireTimeout: () => handlers.timeout && handlers.timeout(),
        wasDestroyed: () => destroyed
    };
}

describe('haNotifier', () => {
    it('POSTs persistent_notification/create with id, title, message and bearer token', async () => {
        const { httpModule, calls } = fakeHttp(200);
        const res = await createPersistentNotification({
            notificationId: 'cgateweb_cni_254',
            title: 'C-Bus network offline',
            message: 'Network 254 CNI down',
            token: 'tok',
            httpModule
        });
        expect(res.statusCode).toBe(200);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('http://supervisor/core/api/services/persistent_notification/create');
        expect(calls[0].opts.method).toBe('POST');
        expect(calls[0].opts.headers.Authorization).toBe('Bearer tok');
        expect(JSON.parse(calls[0].body)).toEqual({
            notification_id: 'cgateweb_cni_254',
            title: 'C-Bus network offline',
            message: 'Network 254 CNI down'
        });
    });

    it('POSTs persistent_notification/dismiss with the notification id', async () => {
        const { httpModule, calls } = fakeHttp(200);
        await dismissPersistentNotification({ notificationId: 'cgateweb_cni_254', token: 'tok', httpModule });
        expect(calls[0].url).toBe('http://supervisor/core/api/services/persistent_notification/dismiss');
        expect(JSON.parse(calls[0].body)).toEqual({ notification_id: 'cgateweb_cni_254' });
    });

    it('resolves with the non-2xx status code rather than throwing', async () => {
        const { httpModule } = fakeHttp(403);
        const res = await createPersistentNotification({ notificationId: 'x', title: 't', message: 'm', token: 'tok', httpModule });
        expect(res.statusCode).toBe(403);
    });

    it('rejects when the request emits an error', async () => {
        const h = controllableHttp();
        const p = createPersistentNotification({ notificationId: 'x', title: 't', message: 'm', token: 'tok', httpModule: h.httpModule });
        h.fireError(new Error('socket fail'));
        await expect(p).rejects.toThrow('socket fail');
    });

    it('destroys the request and rejects with Timeout when the request times out', async () => {
        const h = controllableHttp();
        const p = dismissPersistentNotification({ notificationId: 'x', token: 'tok', httpModule: h.httpModule });
        h.fireTimeout();
        await expect(p).rejects.toThrow('Timeout');
        expect(h.wasDestroyed()).toBe(true);
    });
});
