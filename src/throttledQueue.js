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
        this._queues = {
            critical: [],
            interactive: [],
            normal: [],
            bulk: []
        };
        this._priorityOrder = ['critical', 'interactive', 'normal', 'bulk'];
        this._timer = null;
        this._isProcessing = false;
        this._active = false;
        this._length = 0;
        this._name = name;
        this._maxSize = options.maxSize !== undefined ? options.maxSize : 1000;
        this._getIntervalMs = typeof options.getIntervalMs === 'function' ? options.getIntervalMs : null;
        this._canProcessFn = typeof options.canProcessFn === 'function' ? options.canProcessFn : null;
        this._retryWhenBlockedMs = Math.max(10, options.retryWhenBlockedMs || Math.min(this._intervalMs, 200));
        this._droppedCount = 0;
        this._logger = createLogger({ component: 'ThrottledQueue' });
    }

    add(item, options = {}) {
        const priority = this._normalizePriority(options.priority);
        if (this._maxSize > 0 && this._length >= this._maxSize) {
            this._dropOneItem();
        }
        this._queues[priority].push(item);
        this._length++;

        if (!this._active) {
            this._active = true;
            this._process(); // Keep immediate first-item behavior
            return;
        }

        if (this._timer === null && !this._isProcessing) {
            this._scheduleNext(this._currentIntervalMs());
        }
    }

    _process() {
        if (this._isProcessing) return;

        if (this._length === 0) {
            this._active = false;
            this._clearTimer();
            return;
        }

        if (this._canProcessFn && !this._canProcessFn()) {
            this._scheduleNext(this._retryWhenBlockedMs);
            return;
        }

        const item = this._dequeueOneItem();
        if (item === undefined) {
            this._clearTimer();
            return;
        }

        this._isProcessing = true;
        let result;
        try {
            result = this._processFn(item);
        } catch (error) {
            this._logger.error(`Error processing ${this._name} item:`, { error, item });
            this._finishProcess();
            return;
        }

        if (result && typeof result.then === 'function') {
            result
                .catch((error) => {
                    this._logger.error(`Error processing ${this._name} item:`, { error, item });
                })
                .finally(() => this._finishProcess());
            return;
        }

        this._finishProcess();
    }

    _finishProcess() {
        this._isProcessing = false;
        if (!this._active) {
            this._clearTimer();
            return;
        }
        this._scheduleNext(this._currentIntervalMs());
    }

    _currentIntervalMs() {
        if (!this._getIntervalMs) {
            return this._intervalMs;
        }
        const value = Number(this._getIntervalMs(this));
        if (!Number.isFinite(value) || value <= 0) {
            return this._intervalMs;
        }
        return value;
    }

    _scheduleNext(delayMs) {
        if (this._timer !== null) {
            return;
        }
        const delay = Math.max(0, Number(delayMs) || 0);
        this._timer = setTimeout(() => {
            this._timer = null;
            this._process();
        }, delay);
    }

    _clearTimer() {
        if (this._timer !== null) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    }

    _dequeueOneItem() {
        for (const priority of this._priorityOrder) {
            const queue = this._queues[priority];
            if (queue.length > 0) {
                this._length--;
                return queue.shift();
            }
        }
        return undefined;
    }

    _dropOneItem() {
        // Preserve critical/interactive commands where possible by dropping bulk first.
        const dropOrder = ['bulk', 'normal', 'interactive', 'critical'];
        for (const priority of dropOrder) {
            const queue = this._queues[priority];
            if (queue.length > 0) {
                queue.shift();
                this._length--;
                this._droppedCount++;
                if (this._droppedCount === 1 || this._droppedCount % 100 === 0) {
                    this._logger.warn(`${this._name} queue full (max ${this._maxSize}), dropping ${priority} items (${this._droppedCount} total dropped)`);
                }
                return;
            }
        }
    }

    _normalizePriority(priority) {
        if (!priority || typeof priority !== 'string') {
            return 'normal';
        }
        const normalized = priority.toLowerCase();
        return this._queues[normalized] ? normalized : 'normal';
    }

    clear() {
        this._queues = { critical: [], interactive: [], normal: [], bulk: [] };
        this._length = 0;
        this._isProcessing = false;
        this._active = false;
        this._clearTimer();
    }

    get length() {
        return this._length;
    }

    get isEmpty() {
        return this._length === 0;
    }

    get droppedCount() {
        return this._droppedCount;
    }

    get maxSize() {
        return this._maxSize;
    }

    getStats() {
        return {
            depth: this._length,
            dropped: this._droppedCount,
            maxSize: this._maxSize,
            byPriority: {
                critical: this._queues.critical.length,
                interactive: this._queues.interactive.length,
                normal: this._queues.normal.length,
                bulk: this._queues.bulk.length
            }
        };
    }
}

module.exports = ThrottledQueue;