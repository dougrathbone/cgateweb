// @ts-check
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { createLogger } = require('./logger');
const { resolveSetting } = require('./config/schema');

const LABEL_FILE_VERSION = 1;

/**
 * Hydrate one of the label file's optional "address -> value" sections into a
 * Map, treating anything that is not an object (absent, null, a string) as
 * empty. Every section but `labels` is optional, and `labels` is already
 * checked by _validate.
 *
 * @param {*} value
 * @returns {Map<string, any>}
 */
function sectionToMap(value) {
    return new Map(value && typeof value === 'object' ? Object.entries(value) : []);
}

class LabelLoader extends EventEmitter {
    /**
     * @param {string|null} filePath - Path to the JSON label file (null = disabled)
     * @param {Object} [settings={}] - Runtime settings (debounce / grace / retry tunables)
     */
    constructor(filePath, settings = {}) {
        super();
        this.filePath = filePath ? path.resolve(filePath) : null;
        this.settings = settings;
        this._debounceMs = resolveSetting(settings, 'labelWatchDebounceMs');
        this._selfWriteGraceMs = resolveSetting(settings, 'labelWatchSelfWriteGraceMs');
        this._reloadRetryMs = resolveSetting(settings, 'labelReloadRetryMs');
        this.logger = createLogger({ component: 'LabelLoader' });
        this._labels = new Map();
        this._typeOverrides = new Map();
        this._entityIds = new Map();
        this._exclude = new Set();
        this._areas = new Map();
        this._watcher = null;
        this._debounceTimer = null;
        this._lastSaveTime = 0;
    }

    /**
     * Load labels from the configured JSON file.
     * Returns the label Map. On error or missing file, returns an empty Map.
     * With `keepOnError`, a missing or unreadable file instead keeps the
     * previously loaded labels and sets `this._lastLoadError` — used by the
     * file-watcher reload path, because backup tools (e.g. a Home Assistant
     * backup) briefly remove or replace the file and must not wipe every
     * entity name on the network.
     * @param {Object} [options]
     * @param {boolean} [options.keepOnError]
     * @returns {Map<string, string>}
     */
    load(options = {}) {
        const keepOnError = options.keepOnError === true;
        this._lastLoadError = null;
        if (!this.filePath) {
            this.logger.debug('No label file configured');
            this._clearAll();
            return this._labels;
        }

        if (!fs.existsSync(this.filePath)) {
            if (keepOnError) {
                this._lastLoadError = 'file missing';
                this.logger.debug(`Label file temporarily unavailable: ${this.filePath} (keeping current labels)`);
                return this._labels;
            }
            this.logger.info(`Label file not found: ${this.filePath} (will be created on first save)`);
            this._clearAll();
            return this._labels;
        }

        try {
            const raw = fs.readFileSync(this.filePath, 'utf8');
            const data = JSON.parse(raw);
            this._validate(data);

            this._labels = sectionToMap(data.labels);
            this._typeOverrides = sectionToMap(data.type_overrides);
            this._entityIds = sectionToMap(data.entity_ids);
            this._areas = sectionToMap(data.areas);
            this._exclude = new Set(Array.isArray(data.exclude) ? data.exclude : []);

            const extras = [];
            if (this._typeOverrides.size > 0) extras.push(`${this._typeOverrides.size} type overrides`);
            if (this._entityIds.size > 0) extras.push(`${this._entityIds.size} entity IDs`);
            if (this._exclude.size > 0) extras.push(`${this._exclude.size} excluded`);
            if (this._areas.size > 0) extras.push(`${this._areas.size} areas`);
            const extrasStr = extras.length > 0 ? `, ${extras.join(', ')}` : '';
            this.logger.info(`Loaded ${this._labels.size} labels from ${this.filePath}${extrasStr} (source: ${data.source || 'unknown'})`);
            return this._labels;
        } catch (err) {
            if (keepOnError) {
                this._lastLoadError = err.message;
                this.logger.warn(`Label file unreadable (${err.message}); keeping current labels`);
                return this._labels;
            }
            this.logger.error(`Failed to load label file ${this.filePath}: ${err.message}`);
            this._clearAll();
            return this._labels;
        }
    }

    /**
     * Save labels to disk. Accepts either a plain object of labels or a full label file object.
     * @param {Object} labelsObj - Either { "net/app/grp": "name", ... } or { version, labels, ... }
     */
    save(labelsObj) {
        if (!this.filePath) {
            throw new Error('No label file path configured');
        }

        let fileData;
        if (labelsObj.version !== undefined && labelsObj.labels !== undefined) {
            fileData = { ...labelsObj };
        } else {
            fileData = {
                version: LABEL_FILE_VERSION,
                source: 'manual',
                generated: new Date().toISOString(),
                labels: labelsObj
            };
        }

        // Preserve extended sections if present on the incoming data,
        // otherwise keep whatever is currently on disk by re-reading
        if (!fileData.type_overrides && this._typeOverrides.size > 0) {
            fileData.type_overrides = Object.fromEntries(this._typeOverrides);
        }
        if (!fileData.entity_ids && this._entityIds.size > 0) {
            fileData.entity_ids = Object.fromEntries(this._entityIds);
        }
        if (!fileData.exclude && this._exclude.size > 0) {
            fileData.exclude = Array.from(this._exclude);
        }
        if (!fileData.areas && this._areas.size > 0) {
            fileData.areas = Object.fromEntries(this._areas);
        }

        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        this._lastSaveTime = Date.now();
        fs.writeFileSync(this.filePath, JSON.stringify(fileData, null, 2) + '\n', 'utf8');
        this._lastSaveTime = Date.now();

        this._labels = sectionToMap(fileData.labels);

        if (fileData.type_overrides) {
            this._typeOverrides = new Map(Object.entries(fileData.type_overrides));
        }
        if (fileData.entity_ids) {
            this._entityIds = new Map(Object.entries(fileData.entity_ids));
        }
        if (fileData.exclude) {
            this._exclude = new Set(fileData.exclude);
        }
        if (fileData.areas) {
            this._areas = new Map(Object.entries(fileData.areas));
        }

        this.logger.info(`Saved ${this._labels.size} labels to ${this.filePath}`);

        // Notify in-process listeners (HA Discovery re-trigger, the Web UI
        // SSE event stream) directly. The file-watcher path will see the
        // same write but suppress it via labelWatchSelfWriteGraceMs - that grace
        // period prevents a double-fire here, it doesn't replace this emit.
        this.emit('labels-changed', this.getLabelData());
    }

    /**
     * Start watching the label file for changes. Emits 'labels-changed' with the new Map.
     */
    watch() {
        if (!this.filePath) return;
        if (this._watcher) return;

        const dir = path.dirname(this.filePath);
        const basename = path.basename(this.filePath);

        if (!fs.existsSync(dir)) {
            this.logger.debug(`Label file directory does not exist yet: ${dir}`);
            return;
        }

        try {
            this._watcher = fs.watch(dir, (eventType, filename) => {
                if (filename !== basename) return;
                // Ignore events caused by our own save() within the grace period
                if (Date.now() - this._lastSaveTime < this._selfWriteGraceMs) return;

                if (this._debounceTimer) clearTimeout(this._debounceTimer);
                this._debounceTimer = setTimeout(() => {
                    this._onFileChanged();
                }, this._debounceMs).unref();
            });

            this._watcher.on('error', (err) => {
                this.logger.warn(`Label file watcher error: ${err.message}`);
            });

            this.logger.info(`Watching label file for changes: ${this.filePath}`);
        } catch (err) {
            this.logger.warn(`Could not watch label file: ${err.message}`);
        }
    }

    /**
     * Stop watching the label file.
     */
    unwatch() {
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = null;
        }
        if (this._reloadRetryTimer) {
            clearTimeout(this._reloadRetryTimer);
            this._reloadRetryTimer = null;
        }
        this._reloadRetried = false;
        if (this._watcher) {
            this._watcher.close();
            this._watcher = null;
            this.logger.debug('Stopped watching label file');
        }
    }

    /**
     * @returns {Map<string, string>} Current label map
     */
    getLabels() {
        return this._labels;
    }

    /**
     * @returns {Map<string, string>} Type overrides (address -> "cover"|"switch"|"light"|"binary_sensor")
     */
    getTypeOverrides() {
        return this._typeOverrides;
    }

    /**
     * @returns {Map<string, string>} Entity ID hints (address -> default_entity_id for HA)
     */
    getEntityIds() {
        return this._entityIds;
    }

    /**
     * @returns {Set<string>} Addresses to exclude from discovery
     */
    getExcludeSet() {
        return this._exclude;
    }

    /**
     * @returns {Map<string, string>} Area assignments (address -> area name for HA suggested_area)
     */
    getAreas() {
        return this._areas;
    }

    /**
     * @returns {Object} All label data as a single object for passing to HaDiscovery
     */
    getLabelData() {
        return {
            labels: this._labels,
            typeOverrides: this._typeOverrides,
            entityIds: this._entityIds,
            exclude: this._exclude,
            areas: this._areas
        };
    }

    /**
     * @returns {Object} Current labels as a plain object (for JSON serialization)
     */
    getLabelsObject() {
        return Object.fromEntries(this._labels);
    }

    /**
     * @returns {Object} Full file data for JSON serialization (all sections)
     */
    getFullData() {
        const data = { labels: this.getLabelsObject() };
        if (this._typeOverrides.size > 0) {
            data.type_overrides = Object.fromEntries(this._typeOverrides);
        }
        if (this._entityIds.size > 0) {
            data.entity_ids = Object.fromEntries(this._entityIds);
        }
        if (this._exclude.size > 0) {
            data.exclude = Array.from(this._exclude);
        }
        if (this._areas.size > 0) {
            data.areas = Object.fromEntries(this._areas);
        }
        return data;
    }

    _clearAll() {
        this._labels = new Map();
        this._typeOverrides = new Map();
        this._entityIds = new Map();
        this._exclude = new Set();
        this._areas = new Map();
    }

    /**
     * Canonical form of everything a listener would act on, for deciding
     * whether a reload actually changed anything.
     * @returns {string}
     * @private
     */
    _dataSignature() {
        return JSON.stringify(this.getFullData());
    }

    _onFileChanged() {
        const previousSize = this._labels.size;
        const previousSignature = this._dataSignature();
        this.load({ keepOnError: true });
        if (this._lastLoadError) {
            // Backup tools (HA backup) briefly remove or replace the label
            // file. Keep serving the last good labels and retry once shortly
            // in case no further watch event arrives when the file returns.
            if (!this._reloadRetried) {
                this._reloadRetried = true;
                this.logger.info(`Label file reload skipped (${this._lastLoadError}); keeping current labels and retrying shortly`);
                clearTimeout(this._reloadRetryTimer);
                this._reloadRetryTimer = setTimeout(() => {
                    this._reloadRetryTimer = null;
                    this._onFileChanged();
                }, this._reloadRetryMs);
                if (typeof this._reloadRetryTimer.unref === 'function') this._reloadRetryTimer.unref();
            } else {
                this.logger.info(`Label file still unavailable after retry (${this._lastLoadError}); keeping current labels`);
            }
            return;
        }
        this._reloadRetried = false;
        // The grace window is checked when the OS delivers the watch event, so
        // an event for our own save() that arrives later than the grace escapes
        // it and reloads a file nobody edited. That happens whenever the event
        // loop stalls for about a second - a busy Home Assistant host, or a
        // loaded CI runner. Reloading identical data is harmless; telling every
        // listener the labels changed is not, since it re-runs HA Discovery and
        // pushes an SSE update for nothing. So the emit is gated on the data
        // rather than on the clock, which also makes the grace a pure
        // optimisation instead of the correctness mechanism.
        if (this._dataSignature() === previousSignature) {
            this.logger.debug('Label file reload produced no changes; not emitting labels-changed');
            return;
        }
        this.logger.info('Label file changed on disk, reloading...');
        this.logger.info(`Labels reloaded: ${previousSize} -> ${this._labels.size} labels`);
        this.emit('labels-changed', this.getLabelData());
    }

    _validate(data) {
        if (typeof data !== 'object' || data === null) {
            throw new Error('Label file must contain a JSON object');
        }
        if (data.version !== null && data.version !== undefined && data.version > LABEL_FILE_VERSION) {
            throw new Error(`Unsupported label file version: ${data.version} (max supported: ${LABEL_FILE_VERSION})`);
        }
        if (!data.labels || typeof data.labels !== 'object') {
            throw new Error('Label file must contain a "labels" object');
        }
    }
}

module.exports = LabelLoader;
