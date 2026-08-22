// @ts-check
const httpDefault = require('http');
const { backoffDelay } = require('./backoff');
const { resolveSetting } = require('./config/schema');

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
 * @param {number} [options.timeoutMs] - per-request timeout (schema: ingressDiscoveryTimeoutMs)
 * @param {number} [options.attempts] - total attempts before giving up (schema: ingressDiscoveryAttempts)
 * @param {number} [options.initialRetryDelayMs] - base delay for the retry backoff (schema: ingressDiscoveryInitialRetryDelayMs)
 * @param {number} [options.maxRetryDelayMs] - ceiling for the retry backoff (schema: ingressDiscoveryMaxBackoffMs)
 * @param {Function} [options.sleep] - sleep implementation override (testing)
 * @returns {Promise<string|null>} the ingress entry path, or null when it could not be determined
 */
async function discoverIngressEntry({ token, httpModule, timeoutMs, attempts, initialRetryDelayMs, maxRetryDelayMs, sleep } = {}) {
    if (!token) return null;
    const doSleep = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const resolvedTimeoutMs = timeoutMs !== undefined
        ? timeoutMs
        : resolveSetting({}, 'ingressDiscoveryTimeoutMs');
    const resolvedAttempts = attempts !== undefined
        ? attempts
        : resolveSetting({}, 'ingressDiscoveryAttempts');
    const resolvedInitialRetryDelayMs = initialRetryDelayMs !== undefined
        ? initialRetryDelayMs
        : resolveSetting({}, 'ingressDiscoveryInitialRetryDelayMs');
    const maxMs = maxRetryDelayMs !== undefined
        ? maxRetryDelayMs
        : resolveSetting({}, 'ingressDiscoveryMaxBackoffMs');

    for (let attempt = 1; attempt <= resolvedAttempts; attempt++) {
        try {
            const info = await _fetchAddonInfo({ token, httpModule, timeoutMs: resolvedTimeoutMs });
            const entry = info && info.data && typeof info.data.ingress_entry === 'string'
                ? info.data.ingress_entry.trim()
                : '';
            if (entry) {
                return entry;
            }
            throw new Error('Supervisor response did not include an ingress entry path');
        } catch {
            if (attempt >= resolvedAttempts) break;
            await doSleep(backoffDelay(attempt - 1, { initialMs: resolvedInitialRetryDelayMs, maxMs }));
        }
    }

    return null;
}

module.exports = { discoverIngressEntry };
