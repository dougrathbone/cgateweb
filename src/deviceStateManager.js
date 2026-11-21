// @ts-check
const { EventEmitter } = require('events');
const { createLogger } = require('./logger');
const { evictOldestFifo } = require('./utils');
const { resolveSetting } = require('./config/schema');
const {
    MQTT_TOPIC_SUFFIX_LEVEL,
    CGATE_CMD_ON,
    CGATE_CMD_OFF,
    CGATE_LEVEL_MIN,
    CGATE_LEVEL_MAX
} = require('./constants');

/**
 * Manages device state coordination between components.
 * 
 * This class handles:
 * - Tracking device levels from C-Bus events
 * - Coordinating state between components via internal events
 * - Supporting relative level operations (INCREASE/DECREASE)
 * 
 * @example
 * const stateManager = new DeviceStateManager({
 *   settings: settings,
 *   logger: logger
 * });
 * 
 * // Track level from an event
 * stateManager.updateLevelFromEvent(event);
 * 
 * // Set up relative level operation
 * stateManager.setupRelativeLevelOperation(address, (currentLevel) => {
 *   // Handle level response
 * });
 */
class DeviceStateManager {
    /**
     * Creates a new DeviceStateManager instance.
     * 
     * @param {Object} options - Configuration options
     * @param {Object} options.settings - Application settings
     * @param {Object} [options.logger] - Logger instance (optional)
     */
    constructor({ settings, logger }) {
        this.settings = settings;
        this.logger = logger || createLogger({ 
            component: 'DeviceStateManager', 
            level: 'info',
            enabled: true 
        });
        
        // Internal event emitter for coordinating state between components
        this.internalEventEmitter = new EventEmitter();

        // Track active relative level operations to prevent conflicts
        // Maps address -> { handler, timeoutHandle } for proper cleanup on cancel
        this.activeOperations = new Map();

        // Store last-known level for each device address (network/app/group → 0-255)
        this._deviceLevels = new Map();

        // Track last-seen timestamp per device address (network/app/group → ms since epoch)
        this._lastSeen = new Map();

        // Bound on _deviceLevels / _lastSeen growth.
        this._maxEntries = Math.max(100, resolveSetting(this.settings, 'deviceStateMaxEntries'));
    }

    /**
     * Gets the internal event emitter for component coordination.
     * 
     * @returns {EventEmitter} Internal event emitter
     */
    getEventEmitter() {
        return this.internalEventEmitter;
    }

    /**
     * Returns the last-known C-Bus level (0–255) for the given address, or
     * `undefined` when no level has been received yet.
     *
     * @param {string} network     - C-Bus network number
     * @param {string} application - C-Bus application number
     * @param {string} group       - C-Bus group number
     * @returns {number|undefined}
     */
    getLevel(network, application, group) {
        return this._deviceLevels.get(`${network}/${application}/${group}`);
    }

    /**
     * Updates device level tracking from a C-Bus event.
     * 
     * Extracts level information from C-Bus events and emits internal
     * level events for coordination with other components.
     * 
     * @param {Object} event - C-Bus event object
     */
    updateLevelFromEvent(event) {
        // PIR sensors only send state (motion detected/cleared), not brightness levels
        if (event.getApplication() === this.settings.ha_discovery_pir_app_id) {
            return;
        }
        
        const simpleAddr = `${event.getNetwork()}/${event.getApplication()}/${event.getGroup()}`;
        let levelValue = null;

        if (event.getLevel() !== null) {
            // Ramp events include explicit level (0-255)
            levelValue = event.getLevel();
        } else if (event.getAction() === CGATE_CMD_ON.toLowerCase()) {
            // "on" events imply full brightness (255)
            levelValue = CGATE_LEVEL_MAX;
        } else if (event.getAction() === CGATE_CMD_OFF.toLowerCase()) {
            // "off" events imply no brightness (0) 
            levelValue = CGATE_LEVEL_MIN;
        }

        if (levelValue !== null) {
            if (this.logger.isLevelEnabled && this.logger.isLevelEnabled('debug')) {
                this.logger.debug(`Level update: ${simpleAddr} = ${levelValue}`);
            }
            // FIFO-evict the oldest entry before inserting to keep both maps
            // bounded; _lastSeen tracks the same key space so it must evict in
            // lockstep.
            if (!this._deviceLevels.has(simpleAddr) && this._deviceLevels.size >= this._maxEntries) {
                const oldestKey = evictOldestFifo(this._deviceLevels);
                this._lastSeen.delete(oldestKey);
            }
            // Store latest known level so callers can retrieve it synchronously
            this._deviceLevels.set(simpleAddr, levelValue);
            // Record when this device was last seen (for stale device detection)
            this._lastSeen.set(simpleAddr, Date.now());
            // Emit internal level event for relative ramp operations (increase/decrease)
            this.internalEventEmitter.emit(MQTT_TOPIC_SUFFIX_LEVEL, simpleAddr, levelValue);
        }
    }

    /**
     * Returns the last-seen timestamp (ms since epoch) for the given address, or
     * `undefined` when no event has been received yet.
     *
     * @param {string|number} network     - C-Bus network number
     * @param {string|number} application - C-Bus application number
     * @param {string|number} group       - C-Bus group number
     * @returns {number|undefined}
     */
    getLastSeen(network, application, group) {
        return this._lastSeen.get(`${network}/${application}/${group}`);
    }

    /**
     * Returns a copy of the internal last-seen Map (key → timestamp ms).
     *
     * @returns {Map<string, number>}
     */
    getAllLastSeen() {
        return new Map(this._lastSeen);
    }

    /**
     * Returns a copy of the internal device levels Map (key → 0-255).
     *
     * @returns {Map<string, number>}
     */
    getAllLevels() {
        return new Map(this._deviceLevels);
    }

    /**
     * Sets up a relative level operation handler.
     * 
     * This method sets up a one-time listener for level responses from a specific device,
     * typically used for INCREASE/DECREASE operations that need to know the current level.
     * 
     * @param {string} address - Device address (network/app/group)
     * @param {Function} callback - Callback function to handle the level response
     * @param {number} [timeout] - Timeout in milliseconds (schema default if omitted)
     * @param {{ deferTimeout?: boolean }} [options] - deferTimeout waits to arm the
     *   timer until startRelativeLevelTimeout, so queue time is not part of the wait
     * @returns {string|null} Operation ID that can be used to cancel the operation
     */
    setupRelativeLevelOperation(address, callback, timeout, options = {}) {
        if (!Number.isFinite(timeout) || timeout <= 0) {
            timeout = resolveSetting(this.settings, 'relativeLevelTimeoutMs');
        }
        if (this.activeOperations.has(address)) {
            this.logger.warn(`Relative level operation already active for ${address}, skipping`);
            return null;
        }

        const operationId = `${address}_${Date.now()}`;
        const deferTimeout = options.deferTimeout === true;

        /** @type {{ handler: (...args: any[]) => void, timeoutHandle: NodeJS.Timeout|null, timeout: number, finish: (level: number|null, timedOut: boolean) => void }} */
        const operation = {
            handler: () => {},
            timeoutHandle: null,
            timeout,
            finish: () => {}
        };

        const finish = (level, timedOut) => {
            if (!this.activeOperations.has(address)) return;
            this.internalEventEmitter.removeListener(MQTT_TOPIC_SUFFIX_LEVEL, operation.handler);
            if (operation.timeoutHandle) clearTimeout(operation.timeoutHandle);
            this.activeOperations.delete(address);
            if (timedOut) {
                this.logger.warn(`Timeout waiting for level response from ${address}`);
            }
            callback(level);
        };
        operation.finish = finish;

        // Use .on() instead of .once() so non-matching address events don't consume the listener
        const levelHandler = (responseAddress, currentLevel) => {
            if (responseAddress === address) {
                this.logger.debug(`Received level response for ${address}: ${currentLevel}`);
                finish(currentLevel, false);
            }
        };
        operation.handler = levelHandler;

        this.activeOperations.set(address, operation);
        this.internalEventEmitter.on(MQTT_TOPIC_SUFFIX_LEVEL, levelHandler);
        if (!deferTimeout) this.startRelativeLevelTimeout(address);

        return operationId;
    }

    /**
     * Arm the wait for a relative-level read. Called when the GET leaves the
     * command queue, so a connection outage does not consume the timeout
     * before C-Gate has been asked.
     * @param {string} address
     */
    startRelativeLevelTimeout(address) {
        const operation = this.activeOperations.get(address);
        if (!operation || operation.timeoutHandle) return;
        operation.timeoutHandle = setTimeout(() => {
            operation.finish(null, true);
        }, operation.timeout).unref();
    }

    /**
     * The level read will never be sent (the queue dropped it, or the queue
     * was cleared). Fail the operation now so the listener does not stay
     * registered until process exit.
     * @param {string} address
     */
    failRelativeLevelOperation(address) {
        const operation = this.activeOperations.get(address);
        if (!operation) return;
        this.logger.warn(`Relative level read for ${address} left the queue before C-Gate saw it`);
        operation.finish(null, false);
    }

    /**
     * Cancels an active relative level operation.
     * 
     * @param {string} address - Device address to cancel operation for
     */
    cancelRelativeLevelOperation(address) {
        const operation = this.activeOperations.get(address);
        if (operation) {
            this.internalEventEmitter.removeListener(MQTT_TOPIC_SUFFIX_LEVEL, operation.handler);
            if (operation.timeoutHandle) clearTimeout(operation.timeoutHandle);
            this.activeOperations.delete(address);
            this.logger.debug(`Cancelled relative level operation for ${address}`);
        }
    }

    /**
     * Checks if a relative level operation is active for an address.
     * 
     * @param {string} address - Device address to check
     * @returns {boolean} True if operation is active
     */
    isRelativeLevelOperationActive(address) {
        return this.activeOperations.has(address);
    }

    /**
     * Gets the number of active relative level operations.
     * 
     * @returns {number} Number of active operations
     */
    getActiveOperationCount() {
        return this.activeOperations.size;
    }

    /**
     * Clears all active operations (useful for cleanup during shutdown).
     */
    clearAllOperations() {
        const count = this.activeOperations.size;
        if (count > 0) {
            for (const [, operation] of this.activeOperations) {
                this.internalEventEmitter.removeListener(MQTT_TOPIC_SUFFIX_LEVEL, operation.handler);
                clearTimeout(operation.timeoutHandle);
            }
            this.activeOperations.clear();
            this.logger.info(`Cleared ${count} active relative level operations`);
        }
    }

    /**
     * Shuts down the device state manager.
     *
     * Cleans up all active operations and removes event listeners.
     */
    shutdown() {
        this.clearAllOperations();
        this._deviceLevels.clear();
        this._lastSeen.clear();
        this.internalEventEmitter.removeAllListeners();
        this.logger.debug('Device state manager shut down');
    }
}

module.exports = DeviceStateManager;
