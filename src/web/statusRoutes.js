// @ts-check
const http = require('http');
const { sendJSON } = require('./httpHelpers');

/**
 * Route handlers for bridge status, dashboard, HA areas, and health probes.
 */
class StatusRoutes {
    /**
     * @param {Object} options
     * @param {Function} options.getStatus - Function returning bridge status info
     * @param {import('../labelLoader')} options.labelLoader - Label loader instance
     * @param {Object|null} [options.deviceStateManager] - Device state manager instance
     * @param {Object|null} [options.eventStream] - Event stream instance
     * @param {number} options.activeDeviceWindowMs - Window for counting active devices
     * @param {number} options.haAreasCacheTtlMs - Cache TTL for Home Assistant areas
     * @param {number} options.haApiTimeoutMs - Timeout for Home Assistant API calls
     * @param {Object} options.logger - Logger instance
     */
    constructor({
        getStatus,
        labelLoader,
        deviceStateManager = null,
        eventStream = null,
        activeDeviceWindowMs,
        haAreasCacheTtlMs,
        haApiTimeoutMs,
        logger
    }) {
        this.getStatus = getStatus;
        this.labelLoader = labelLoader;
        this.deviceStateManager = deviceStateManager;
        this.eventStream = eventStream;
        this.activeDeviceWindowMs = activeDeviceWindowMs;
        this.haAreasCacheTtlMs = haAreasCacheTtlMs;
        this.haApiTimeoutMs = haApiTimeoutMs;
        this.logger = logger;
        this._haAreasCache = null;
        this._haAreasCacheTime = 0;
    }

    /**
     * GET /api/status — bridge status plus label file summary.
     */
    handleGetStatus(_req, res) {
        const status = this.getStatus();
        const labels = this.labelLoader.getLabelsObject();
        sendJSON(res, 200, {
            ...status,
            labels: {
                count: Object.keys(labels).length,
                filePath: this.labelLoader.filePath
            }
        });
    }

    /**
     * GET /api/dashboard — aggregated bridge, device, and event summary.
     */
    handleGetDashboard(_req, res) {
        const status = this.getStatus();
        const labels = this.labelLoader.getLabelsObject();
        const labelCount = Object.keys(labels).length;

        // Build device list from device state manager
        const devices = [];
        if (this.deviceStateManager) {
            const allLastSeen = this.deviceStateManager.getAllLastSeen();
            const allLevels = this.deviceStateManager.getAllLevels
                ? this.deviceStateManager.getAllLevels()
                : new Map();
            for (const [address, lastSeen] of allLastSeen) {
                const level = allLevels.get(address);
                devices.push({
                    address,
                    level: level !== undefined ? level : null,
                    label: labels[address] || null,
                    lastSeen
                });
            }
            devices.sort((a, b) => b.lastSeen - a.lastSeen);
        }

        // Recent events from event stream
        const recentEvents = this.eventStream
            ? this.eventStream.getRecent().slice(-50)
            : [];

        sendJSON(res, 200, {
            bridge: {
                version: status.version,
                uptime: status.uptime,
                ready: status.ready,
                lifecycle: status.lifecycle
            },
            connections: status.connections,
            metrics: status.metrics,
            discovery: status.discovery,
            labels: { count: labelCount },
            devices: {
                total: devices.length,
                active: devices.filter(d => d.lastSeen > Date.now() - this.activeDeviceWindowMs).length,
                list: devices.slice(0, 200)
            },
            recentEvents: recentEvents.length
        });
    }

    /**
     * GET /api/areas — areas from the label file merged with Home Assistant
     * areas fetched from the Supervisor API (cached).
     */
    async handleGetAreas(_req, res) {
        // Collect areas from label file
        const labelAreas = new Set();
        if (this.labelLoader) {
            const areasMap = this.labelLoader.getLabelData?.()?.areas;
            if (areasMap) {
                const values = areasMap instanceof Map ? areasMap.values() : Object.values(areasMap);
                for (const area of values) {
                    if (area) labelAreas.add(area);
                }
            }
        }

        // Fetch areas from Home Assistant Supervisor API (cached 30s)
        let haAreas = [];
        const supervisorToken = process.env.SUPERVISOR_TOKEN;
        if (supervisorToken) {
            const now = Date.now();
            if (this._haAreasCache && now - this._haAreasCacheTime < this.haAreasCacheTtlMs) {
                haAreas = this._haAreasCache;
            } else {
                try {
                    const data = await new Promise((resolve) => {
                        const tmpl = '{{ areas() | map("area_name") | list | to_json }}';
                        const postBody = JSON.stringify({ template: tmpl });
                        const req = http.request('http://supervisor/core/api/template', {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${supervisorToken}`,
                                'Content-Type': 'application/json',
                                'Content-Length': Buffer.byteLength(postBody)
                            },
                            timeout: this.haApiTimeoutMs
                        }, (resp) => {
                            let body = '';
                            resp.on('data', (chunk) => { body += chunk; });
                            resp.on('end', () => {
                                this.logger.debug(`Area API HTTP ${resp.statusCode}, body length: ${body.length}`);
                                try { resolve(JSON.parse(body)); } catch { resolve(null); }
                            });
                        });
                        req.on('error', (e) => { this.logger.warn('Area API request error:', e.message); resolve(null); });
                        req.on('timeout', () => { this.logger.warn('Area API request timeout'); req.destroy(); resolve(null); });
                        req.write(postBody);
                        req.end();
                    });
                    this.logger.debug(`Area template response: isArray=${Array.isArray(data)}, count=${Array.isArray(data) ? data.length : 0}`);
                    if (Array.isArray(data)) {
                        for (const name of data) {
                            if (typeof name === 'string' && name) {
                                haAreas.push({ name, source: 'homeassistant' });
                            }
                        }
                        this._haAreasCache = haAreas;
                        this._haAreasCacheTime = now;
                    }
                } catch (err) {
                    this.logger.warn('Failed to fetch HA areas:', err.message || err);
                }
            }
        }

        // Merge: HA areas + label-file areas, deduplicated by name (case-insensitive)
        const seen = new Set();
        const merged = [];
        for (const ha of haAreas) {
            const key = ha.name.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                merged.push({ name: ha.name, source: 'homeassistant' });
            }
        }
        for (const name of labelAreas) {
            const key = name.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                merged.push({ name, source: 'labels' });
            }
        }
        merged.sort((a, b) => a.name.localeCompare(b.name));

        sendJSON(res, 200, { areas: merged });
    }

    /**
     * GET /healthz — liveness probe (public).
     */
    handleHealth(_req, res) {
        const status = this.getStatus();
        sendJSON(res, 200, {
            ok: true,
            uptime: status.uptime || process.uptime(),
            lifecycle: status.lifecycle || { state: 'unknown' }
        });
    }

    /**
     * GET /readyz — readiness probe (public).
     */
    handleReady(_req, res) {
        const status = this.getStatus();
        const isReady = !!status.ready;
        sendJSON(res, isReady ? 200 : 503, {
            ready: isReady,
            lifecycle: status.lifecycle || { state: 'unknown' }
        });
    }
}

module.exports = StatusRoutes;
