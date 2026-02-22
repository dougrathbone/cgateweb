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
            this._labels = new Map();
            return this._labels;
        }

        if (!fs.existsSync(this.filePath)) {
            this.logger.info(`Label file not found: ${this.filePath} (will be created on first save)`);
            this._labels = new Map();
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

            this.logger.info(`Loaded ${this._labels.size} labels from ${this.filePath} (source: ${data.source || 'unknown'})`);
            return this._labels;
        } catch (err) {
            this.logger.error(`Failed to load label file ${this.filePath}: ${err.message}`);
            this._labels = new Map();
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
            fileData = labelsObj;
        } else {
            fileData = {
                version: LABEL_FILE_VERSION,
                source: 'manual',
                generated: new Date().toISOString(),
                labels: labelsObj
            };
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
     * @returns {Object} Current labels as a plain object (for JSON serialization)
     */
    getLabelsObject() {
        const obj = {};
        for (const [key, value] of this._labels) {
            obj[key] = value;
        }
        return obj;
    }

    _onFileChanged() {
        this.logger.info('Label file changed on disk, reloading...');
        const previousSize = this._labels.size;
        this.load();
        this.logger.info(`Labels reloaded: ${previousSize} -> ${this._labels.size} labels`);
        this.emit('labels-changed', this._labels);
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
