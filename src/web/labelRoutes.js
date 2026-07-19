// @ts-check
const CbusProjectParser = require('../cbusProjectParser');
const { DEFAULT_ADDON_LABEL_FILE } = require('../constants');
const { sendJSON, sanitizePlainObject, isUnsafeObjectKey } = require('./httpHelpers');
const { readRequestBody, parseMultipart } = require('./bodyReader');

const CBUS_APP_NAMES = {
    56: 'Lighting',
    136: 'Heating',
    172: 'Air Conditioning',
    202: 'Trigger Groups',
    203: 'Blinds'
};

/**
 * Route handlers for label CRUD and C-Bus project XML import/export.
 */
class LabelRoutes {
    /**
     * @param {Object} options
     * @param {import('../labelLoader')} options.labelLoader - Label loader instance
     * @param {string|null} [options.triggerAppId] - C-Bus app ID configured as trigger groups (e.g. '202')
     * @param {number} options.maxBodySizeBytes - Maximum request body size
     * @param {Object} options.logger - Logger instance
     */
    constructor({ labelLoader, triggerAppId = null, maxBodySizeBytes, logger }) {
        this.labelLoader = labelLoader;
        this.triggerAppId = triggerAppId;
        this.maxBodySizeBytes = maxBodySizeBytes;
        this.logger = logger;
        this._parser = new CbusProjectParser();
    }

    /**
     * GET /api/labels — return the full label data.
     */
    handleGetLabels(_req, res) {
        const fullData = this.labelLoader.getFullData();
        sendJSON(res, 200, {
            labels: fullData.labels,
            count: Object.keys(fullData.labels).length,
            ...(fullData.type_overrides && { type_overrides: fullData.type_overrides }),
            ...(fullData.entity_ids && { entity_ids: fullData.entity_ids }),
            ...(fullData.exclude && { exclude: fullData.exclude }),
            ...(fullData.areas && { areas: fullData.areas }),
            ...(this.triggerAppId && { trigger_app_id: this.triggerAppId })
        });
    }

    /**
     * PUT /api/labels — replace the label file with the given data.
     */
    async handlePutLabels(req, res) {
        const body = /** @type {string|null} */ (await readRequestBody(req, this.maxBodySizeBytes));
        if (!body) return sendJSON(res, 400, { error: 'Request body required' });

        let data;
        try {
            data = JSON.parse(body);
        } catch (err) {
            this.logger.debug('Rejected PUT /labels with invalid JSON', { error: err.message });
            return sendJSON(res, 400, { error: 'Invalid JSON' });
        }

        if (!data.labels || typeof data.labels !== 'object') {
            return sendJSON(res, 400, { error: 'Body must contain a "labels" object' });
        }

        try {
            const fileData = {
                version: 1,
                source: 'web-ui',
                generated: new Date().toISOString(),
                labels: sanitizePlainObject(data.labels)
            };
            if (data.type_overrides) fileData.type_overrides = sanitizePlainObject(data.type_overrides);
            if (data.entity_ids) fileData.entity_ids = sanitizePlainObject(data.entity_ids);
            if (data.areas) fileData.areas = sanitizePlainObject(data.areas);
            if (data.exclude) fileData.exclude = data.exclude;

            this.labelLoader.save(fileData);
            const fullData = this.labelLoader.getFullData();
            sendJSON(res, 200, {
                labels: fullData.labels,
                count: Object.keys(fullData.labels).length,
                saved: true
            });
        } catch (err) {
            sendJSON(res, 500, { error: `Failed to save: ${err.message}` });
        }
    }

    /**
     * PATCH /api/labels — apply partial label updates (null/'' deletes).
     */
    async handlePatchLabels(req, res) {
        const body = /** @type {string|null} */ (await readRequestBody(req, this.maxBodySizeBytes));
        if (!body) return sendJSON(res, 400, { error: 'Request body required' });

        let patch;
        try {
            patch = JSON.parse(body);
        } catch (err) {
            this.logger.debug('Rejected PATCH /labels with invalid JSON', { error: err.message });
            return sendJSON(res, 400, { error: 'Invalid JSON' });
        }

        if (typeof patch !== 'object' || patch === null) {
            return sendJSON(res, 400, { error: 'Body must be an object of label updates' });
        }

        try {
            const existing = this.labelLoader.getLabelsObject();
            for (const [key, value] of Object.entries(patch)) {
                // Defence in depth: never let untrusted input write prototype-
                // polluting keys, even though label values are strings.
                if (isUnsafeObjectKey(key)) continue;
                if (value === null || value === '') {
                    delete existing[key];
                } else {
                    existing[key] = value;
                }
            }
            this.labelLoader.save(existing);
            const labels = this.labelLoader.getLabelsObject();
            sendJSON(res, 200, { labels, count: Object.keys(labels).length, saved: true });
        } catch (err) {
            sendJSON(res, 500, { error: `Failed to save: ${err.message}` });
        }
    }

    /**
     * POST /api/labels/import — import labels from an uploaded C-Bus project
     * XML file (multipart or raw body). ?merge=true merges with existing labels.
     */
    async handleImportLabels(req, res) {
        if (!this.labelLoader.filePath) {
            return sendJSON(res, 400, {
                error: `Label file path not configured. In the Home Assistant add-on, set the "cbus_label_file" option (e.g. "${DEFAULT_ADDON_LABEL_FILE}"). In standalone mode, set cbus_label_file in settings.js.`
            });
        }

        const contentType = req.headers['content-type'] || '';
        let fileBuffer, filename;

        if (contentType.includes('multipart/form-data')) {
            const result = await parseMultipart(req, contentType, this.maxBodySizeBytes);
            if (!result) {
                return sendJSON(res, 400, { error: 'No file found in upload' });
            }
            fileBuffer = result.buffer;
            filename = result.filename;
        } else {
            const body = await readRequestBody(req, this.maxBodySizeBytes, { raw: true });
            if (!body || body.length === 0) {
                return sendJSON(res, 400, { error: 'No file data received' });
            }
            fileBuffer = body;
            filename = 'upload';
        }

        try {
            const result = await this._parser.parse(fileBuffer, filename);

            // Check query param for merge mode
            const url = new URL(req.url, `http://${req.headers.host}`);
            const merge = url.searchParams.get('merge') === 'true';

            let finalLabels;
            if (merge) {
                const existing = this.labelLoader.getLabelsObject();
                finalLabels = { ...existing, ...result.labels };
            } else {
                finalLabels = result.labels;
            }

            this.labelLoader.save({
                version: 1,
                source: filename,
                generated: new Date().toISOString(),
                labels: finalLabels
            });

            sendJSON(res, 200, {
                imported: Object.keys(result.labels).length,
                total: Object.keys(finalLabels).length,
                networks: result.networks,
                stats: result.stats,
                merged: merge,
                saved: true,
                scope: 'labels-only',
                notice: 'Imported labels only. This does NOT load the C-Gate project itself. In managed mode, place a pre-built <PROJECT>.db file in /share/cgate/tag/ for the add-on to sync into C-Gate. See the add-on documentation for the supported managed-mode project workflow.'
            });
        } catch (err) {
            sendJSON(res, 400, { error: err.message });
        }
    }

    /**
     * GET /api/labels/export.xml — export labels as a C-Bus project XML file.
     */
    handleExportLabelsXml(_req, res) {
        const labels = this.labelLoader.getLabelsObject();

        // Group labels by network -> app -> groups
        const networks = new Map();
        for (const [key, label] of Object.entries(labels)) {
            const parts = key.split('/');
            if (parts.length !== 3) continue;
            const [net, app, group] = parts;
            if (!networks.has(net)) networks.set(net, new Map());
            const apps = networks.get(net);
            if (!apps.has(app)) apps.set(app, new Map());
            apps.get(app).set(group, label);
        }

        const escapeXml = (str) => String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');

        const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<Project>'];

        for (const [netAddr, apps] of [...networks.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
            lines.push(`  <Network address="${escapeXml(netAddr)}">`);

            for (const [appAddr, groups] of [...apps.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
                const appName = CBUS_APP_NAMES[Number(appAddr)] || `Application ${appAddr}`;
                lines.push(`    <Application address="${escapeXml(appAddr)}" description="${escapeXml(appName)}">`);

                for (const [groupAddr, groupLabel] of [...groups.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
                    lines.push(`      <Group address="${escapeXml(groupAddr)}" description="${escapeXml(groupLabel)}" />`);
                }

                lines.push('    </Application>');
            }

            lines.push('  </Network>');
        }

        lines.push('</Project>');
        const xml = lines.join('\n');

        res.writeHead(200, {
            'Content-Type': 'application/xml; charset=utf-8',
            'Content-Disposition': 'attachment; filename="cbus_labels.xml"'
        });
        res.end(xml);
    }
}

module.exports = LabelRoutes;
