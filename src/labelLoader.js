const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { createLogger } = require('./logger');

const LABEL_FILE_VERSION = 1;
const DEBOUNCE_MS = 500;

class LabelLoader extends EventEmitter {
    /**
     * @param {string|null} filePath - Path to the JSON label file (null = disabled)
     */
    constructor(filePath) {
        super();
        this.filePath = filePath ? path.resolve(filePath) : null;
        this.logger = createLogger({ component: 'LabelLoader' });
        this._labels = new Map();
        this._typeOverrides = new Map();
        this._entityIds = new Map();
        this._exclude = new Set();
        this._watcher = null;
        this._debounceTimer = null;
        this._lastSaveTime = 0;
    }

    /**
     * Load labels from the configured JSON file.
     * Returns the label Map. On error or missing file, returns an empty Map.
     * @returns {Map<string, string>}
     */
    load() {
        if (!this.filePath) {
            this.logger.debug('No label file configured');
            this._clearAll();
            return this._labels;
        }

        if (!fs.existsSync(this.filePath)) {
            this.logger.info(`Label file not found: ${this.filePath} (will be created on first save)`);
            this._clearAll();
            return this._labels;
        }

        try {
            const raw = fs.readFileSync(this.filePath, 'utf8');
            const data = JSON.parse(raw);
            this._validate(data);

            this._labels = new Map();
            for (const [key, value] of Object.entries(data.labels)) {
                this._labels.set(key, value);
            }

            this._typeOverrides = new Map();
            if (data.type_overrides && typeof data.type_overrides === 'object') {
                for (const [key, value] of Object.entries(data.type_overrides)) {
                    this._typeOverrides.set(key, value);
                }
            }

            this._entityIds = new Map();
            if (data.entity_ids && typeof data.entity_ids === 'object') {
                for (const [key, value] of Object.entries(data.entity_ids)) {
                    this._entityIds.set(key, value);
                }
            }

            this._exclude = new Set();
            if (Array.isArray(data.exclude)) {
                for (const addr of data.exclude) {
                    this._exclude.add(addr);
                }
            }

            const extras = [];
            if (this._typeOverrides.size > 0) extras.push(`${this._typeOverrides.size} type overrides`);
            if (this._entityIds.size > 0) extras.push(`${this._entityIds.size} entity IDs`);
            if (this._exclude.size > 0) extras.push(`${this._exclude.size} excluded`);
            const extrasStr = extras.length > 0 ? `, ${extras.join(', ')}` : '';
            this.logger.info(`Loaded ${this._labels.size} labels from ${this.filePath}${extrasStr} (source: ${data.source || 'unknown'})`);
            return this._labels;
        } catch (err) {
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

        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        this._lastSaveTime = Date.now();
        fs.writeFileSync(this.filePath, JSON.stringify(fileData, null, 2) + '\n', 'utf8');

        this._labels = new Map();
        for (const [key, value] of Object.entries(fileData.labels)) {
            this._labels.set(key, value);
        }

        if (fileData.type_overrides) {
            this._typeOverrides = new Map(Object.entries(fileData.type_overrides));
        }
        if (fileData.entity_ids) {
            this._entityIds = new Map(Object.entries(fileData.entity_ids));
        }
        if (fileData.exclude) {
            this._exclude = new Set(fileData.exclude);
        }

        this.logger.info(`Saved ${this._labels.size} labels to ${this.filePath}`);
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
        const SELF_WRITE_GRACE_MS = 1000;

            this._watcher = fs.watch(dir, (eventType, filename) => {
                if (filename !== basename) return;
                // Ignore events caused by our own save() within the grace period
                if (Date.now() - this._lastSaveTime < SELF_WRITE_GRACE_MS) return;

                if (this._debounceTimer) clearTimeout(this._debounceTimer);
                this._debounceTimer = setTimeout(() => {
                    this._onFileChanged();
                }, DEBOUNCE_MS);
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
     * @returns {Map<string, string>} Entity ID hints (address -> object_id for HA)
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
     * @returns {Object} All label data as a single object for passing to HaDiscovery
     */
    getLabelData() {
        return {
            labels: this._labels,
            typeOverrides: this._typeOverrides,
            entityIds: this._entityIds,
            exclude: this._exclude
        };
    }

    /**
     * @returns {Object} Current labels as a plain object (for JSON serialization)
     */
    getLabelsObject() {
        const obj = {};
        for (const [key, value] of this._labels) {
            obj[key] = value;
        }
        return obj;
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
        return data;
    }

    _clearAll() {
        this._labels = new Map();
        this._typeOverrides = new Map();
        this._entityIds = new Map();
        this._exclude = new Set();
    }

    _onFileChanged() {
        this.logger.info('Label file changed on disk, reloading...');
        const previousSize = this._labels.size;
        this.load();
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
