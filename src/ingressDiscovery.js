// @ts-check
const httpDefault = require('http');
const { backoffDelay } = require('./backoff');

/**
 * Fetch this add-on's own info from the Supervisor API. Every installed add-on
 * may call /addons/self/* with its SUPERVISOR_TOKEN (the Supervisor grants it
 * without extra API roles), so this works on a default install. `httpModule`
 * is injectable for testing.
 *
 * @param {Object} options
 * @param {string} [options.token] - Supervisor token
 * @param {typeof httpDefault} [options.httpModule] - http implementation override (testing)
 * @param {number} [options.timeoutMs=5000] - per-request timeout
 */
function _fetchAddonInfo({ token, httpModule = httpDefault, timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
        const req = httpModule.get('http://supervisor/addons/self/info', {
            headers: { 'Authorization': `Bearer ${token}` }
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`Supervisor API returned ${res.statusCode}`));
                    return;
                }
                try {
                    resolve(JSON.parse(body));
                } catch (err) {
                    reject(new Error(`Invalid Supervisor API response: ${err.message}`));
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

/**
 * Discover the add-on's Home Assistant Ingress entry path (e.g.
 * '/api/hassio_ingress/<token>') from the Supervisor API. Nothing injects
 * INGRESS_ENTRY into add-on containers, so this lookup is the only way to learn
 * the path on a real install (GitHub #33). The Supervisor can be slow to answer
 * right after add-on start, so the lookup is retried with a short backoff
 * before giving up.
 *
 * @param {object} [options]
 * @param {string} [options.token] - the SUPERVISOR_TOKEN injected into the add-on container
 * @param {typeof httpDefault} [options.httpModule] - http implementation override (testing)
 * @param {number} [options.timeoutMs=5000] - per-request timeout
 * @param {number} [options.attempts=4] - total attempts before giving up
 * @param {number} [options.initialRetryDelayMs=1000] - base delay for the retry backoff
 * @param {Function} [options.sleep] - sleep implementation override (testing)
 * @returns {Promise<string|null>} the ingress entry path, or null when it could not be determined
 */
async function discoverIngressEntry({ token, httpModule, timeoutMs, attempts = 4, initialRetryDelayMs = 1000, sleep } = {}) {
    if (!token) return null;
    const doSleep = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const info = await _fetchAddonInfo({ token, httpModule, timeoutMs });
            const entry = info && info.data && typeof info.data.ingress_entry === 'string'
                ? info.data.ingress_entry.trim()
                : '';
            if (entry) {
                return entry;
            }
            throw new Error('Supervisor response did not include an ingress entry path');
        } catch {
            if (attempt >= attempts) break;
            await doSleep(backoffDelay(attempt - 1, { initialMs: initialRetryDelayMs, maxMs: 8000 }));
        }
    }

    return null;
}

module.exports = { discoverIngressEntry };
