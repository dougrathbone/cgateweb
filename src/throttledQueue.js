const { createLogger } = require('./logger');

class ThrottledQueue {
    /**
     * @param {Function} processFn - Function to process each item
     * @param {number} intervalMs - Minimum interval between processing items
     * @param {string} name - Queue name for logging
     * @param {Object} [options] - Additional options
     * @param {number} [options.maxSize=1000] - Maximum queue size (0 = unlimited)
     */
    constructor(processFn, intervalMs, name = 'Queue', options = {}) {
        if (typeof processFn !== 'function') {
            throw new Error(`processFn for ${name} must be a function`);
        }
        if (typeof intervalMs !== 'number' || intervalMs <= 0) {
            throw new Error(`intervalMs for ${name} must be a positive number`);
        }
        this._processFn = processFn;
        this._intervalMs = intervalMs;
        this._queue = [];
        this._interval = null;
        this._name = name;
        this._maxSize = options.maxSize !== undefined ? options.maxSize : 1000;
        this._droppedCount = 0;
        this._logger = createLogger({ component: 'ThrottledQueue' });
    }

    add(item) {
        if (this._maxSize > 0 && this._queue.length >= this._maxSize) {
            this._queue.shift();
            this._droppedCount++;
            if (this._droppedCount === 1 || this._droppedCount % 100 === 0) {
                this._logger.warn(`${this._name} queue full (max ${this._maxSize}), dropping oldest items (${this._droppedCount} total dropped)`);
            }
        }
        this._queue.push(item);
        if (this._interval === null) {
            this._interval = setInterval(() => this._process(), this._intervalMs);
            this._process(); // Process immediately on first add
        }
    }

    async _process() {
        if (this._queue.length === 0) {
            if (this._interval !== null) {
                clearInterval(this._interval);
                this._interval = null;
            }
        } else {
            const item = this._queue.shift();
            try {
                await this._processFn(item);
            } catch (error) {
                 this._logger.error(`Error processing ${this._name} item:`, { error, item });
            }
        }
    }

    clear() {
        this._queue = [];
        if (this._interval !== null) {
            clearInterval(this._interval);
            this._interval = null;
        }
    }

    get length() {
        return this._queue.length;
    }

    get isEmpty() {
        return this._queue.length === 0;
    }

    get droppedCount() {
        return this._droppedCount;
    }

    get maxSize() {
        return this._maxSize;
    }
}

module.exports = ThrottledQueue;