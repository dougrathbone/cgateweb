// @ts-check
const httpDefault = require('http');

/**
 * One Supervisor HTTP client for every add-on call to http://supervisor/...
 *
 * Four call sites used to copy GET/POST + timeout + body collection. They still
 * choose their own URL, method, timeout and success policy; this only owns the
 * socket work. `httpModule` is injectable so tests can keep mocking `get`
 * (MQTT detect, ingress) or `request` (notifications, HA areas).
 *
 * @param {Object} [options]
 * @param {string} [options.method='GET']
 * @param {string} [options.url]
 * @param {string} [options.token]
 * @param {typeof httpDefault} [options.httpModule]
 * @param {number} [options.timeoutMs]
 * @param {string|Buffer|Object|null} [options.body]
 * @param {Object} [options.headers]
 * @returns {Promise<{statusCode:number, body:string}>}
 */
function supervisorRequest({
    method = 'GET',
    url,
    token,
    httpModule = httpDefault,
    timeoutMs,
    body,
    headers = {}
} = {}) {
    if (!url) {
        return Promise.reject(new Error('supervisorRequest requires a url'));
    }
    const payload = body === undefined || body === null
        ? null
        : (typeof body === 'string' || Buffer.isBuffer(body) ? String(body) : JSON.stringify(body));
    const reqHeaders = { ...headers };
    if (token) reqHeaders.Authorization = `Bearer ${token}`;
    if (payload !== null) {
        if (!reqHeaders['Content-Type']) reqHeaders['Content-Type'] = 'application/json';
        reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    const verb = String(method || 'GET').toUpperCase();

    return new Promise((resolve, reject) => {
        let settled = false;
        const succeed = (value) => {
            if (!settled) {
                settled = true;
                resolve(value);
            }
        };
        const fail = (err) => {
            if (!settled) {
                settled = true;
                reject(err);
            }
        };

        const onResponse = (res) => {
            let text = '';
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => succeed({ statusCode: res.statusCode, body: text }));
        };

        let req;
        if (verb === 'GET' && payload === null && typeof httpModule.get === 'function') {
            req = httpModule.get(url, { headers: reqHeaders }, onResponse);
        } else {
            const opts = { method: verb, headers: reqHeaders };
            if (Number.isFinite(timeoutMs) && timeoutMs > 0) opts.timeout = timeoutMs;
            req = httpModule.request(url, opts, onResponse);
        }

        req.on('error', fail);
        req.on('timeout', () => {
            req.destroy();
            fail(new Error('Timeout'));
        });
        if (typeof req.setTimeout === 'function' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
            req.setTimeout(timeoutMs, () => {
                req.destroy();
                fail(new Error('Timeout'));
            });
        }
        if (payload !== null && typeof req.write === 'function') req.write(payload);
        if (typeof req.end === 'function') req.end();
    });
}

/**
 * GET/POST JSON from the Supervisor, throwing on non-200 or invalid JSON.
 *
 * @param {Parameters<typeof supervisorRequest>[0]} options
 * @returns {Promise<*>}
 */
async function supervisorJson(options) {
    const { statusCode, body } = await supervisorRequest(options);
    if (statusCode !== 200) {
        throw new Error(`Supervisor API returned ${statusCode}`);
    }
    try {
        return JSON.parse(body);
    } catch (err) {
        throw new Error(`Invalid Supervisor API response: ${err.message}`, { cause: err });
    }
}

module.exports = { supervisorRequest, supervisorJson };
