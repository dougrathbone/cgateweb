// @ts-check
const http = require('http');
const { sendJSON } = require('./httpHelpers');
const { supervisorRequest } = require('../supervisorHttp');
const { resolveSetting } = require('../config/schema');

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
 * @param {number} [options.maxDashboardDevices] - Cap on dashboard device rows
 * @param {Object} options.logger - Logger instance
     * @param {typeof http} [options.httpModule] - Injectable http module (tests)
     */
    constructor({
        getStatus,
        labelLoader,
        deviceStateManager = null,
        eventStream = null,
        activeDeviceWindowMs,
        haAreasCacheTtlMs,
        haApiTimeoutMs,
        maxDashboardDevices,
        logger,
        httpModule = http
    }) {
        this.getStatus = getStatus;
        this.labelLoader = labelLoader;
        this.deviceStateManager = deviceStateManager;
        this.eventStream = eventStream;
        this.activeDeviceWindowMs = activeDeviceWindowMs;
        this.haAreasCacheTtlMs = haAreasCacheTtlMs;
        this.haApiTimeoutMs = haApiTimeoutMs;
        this.maxDashboardDevices = Number.isFinite(maxDashboardDevices) && maxDashboardDevices > 0
            ? maxDashboardDevices
            : resolveSetting({}, 'webDashboardMaxDevices');
        this.logger = logger;
        this._http = httpModule;
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
                count: Object.keys(labels).length
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
                list: devices.slice(0, this.maxDashboardDevices)
            },
            recentEvents: recentEvents.length
        });
    }

    /**
     * Fetch Home Assistant area names via the Supervisor template API.
     * Resolves null on transport/parse failure so the caller can skip caching.
     * @param {string} supervisorToken
     * @returns {Promise<Array<{name: string, source: string}>|null>}
     */
    _fetchHaAreas(supervisorToken) {
        const tmpl = '{{ areas() | map("area_name") | list | to_json }}';
        const postBody = JSON.stringify({ template: tmpl });
        return supervisorRequest({
            method: 'POST',
            url: 'http://supervisor/core/api/template',
            token: supervisorToken,
            httpModule: this._http,
            timeoutMs: this.haApiTimeoutMs,
            body: postBody
        }).then(({ statusCode, body }) => {
            this.logger.debug(`Area API HTTP ${statusCode}, body length: ${body.length}`);
            let data;
            try { data = JSON.parse(body); } catch { return null; }
            if (!Array.isArray(data)) {
                return null;
            }
            const haAreas = [];
            for (const name of data) {
                if (typeof name === 'string' && name) {
                    haAreas.push({ name, source: 'homeassistant' });
                }
            }
            this.logger.debug(`Area template response: count=${haAreas.length}`);
            return haAreas;
        }).catch((e) => {
            if (e && e.message === 'Timeout') {
                this.logger.warn('Area API request timeout');
            } else {
                this.logger.warn(`Area API request error: ${e && e.message}`);
            }
            return null;
        });
    }

    /**
     * GET /api/areas — areas from the label file merged with Home Assistant
     * areas fetched from the Supervisor API (cached).
     */
    async handleGetAreas(_req, res) {
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

        let haAreas = [];
        const supervisorToken = process.env.SUPERVISOR_TOKEN;
        if (supervisorToken) {
            const now = Date.now();
            if (this._haAreasCache && now - this._haAreasCacheTime < this.haAreasCacheTtlMs) {
                haAreas = this._haAreasCache;
            } else {
                try {
                    const fetched = await this._fetchHaAreas(supervisorToken);
                    if (fetched) {
                        haAreas = fetched;
                        this._haAreasCache = haAreas;
                        this._haAreasCacheTime = now;
                    }
                } catch (err) {
                    this.logger.warn('Failed to fetch HA areas:', err.message || err);
                }
            }
        }

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
