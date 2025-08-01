const { ERROR_PREFIX } = require('./constants');

class ThrottledQueue {
    constructor(processFn, intervalMs, name = 'Queue') {
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
    }

    add(item) {
        this._queue.push(item);
        if (this._interval === null) {
            this._interval = setInterval(() => this._process(), this._intervalMs);
            this._process(); // Process immediately on first add
        }
    }

    _process() {
        if (this._queue.length === 0) {
            if (this._interval !== null) {
                clearInterval(this._interval);
                this._interval = null;
            }
        } else {
            const item = this._queue.shift();
            try {
                 this._processFn(item);
            } catch (error) {
                 console.error(`Error processing ${this._name} item:`, error, "Item:", item);
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

    size() {
        return this._queue.length;
    }

    get length() {
        return this._queue.length;
    }

    isEmpty() {
        return this._queue.length === 0;
    }
}

module.exports = ThrottledQueue;