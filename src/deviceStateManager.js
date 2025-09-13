const { EventEmitter } = require('events');
const { createLogger } = require('./logger');
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
        this.activeOperations = new Set();
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
            this.logger.debug(`Level update: ${simpleAddr} = ${levelValue}`);
            // Emit internal level event for relative ramp operations (increase/decrease)
            this.internalEventEmitter.emit(MQTT_TOPIC_SUFFIX_LEVEL, simpleAddr, levelValue);
        }
    }

    /**
     * Sets up a relative level operation handler.
     * 
     * This method sets up a one-time listener for level responses from a specific device,
     * typically used for INCREASE/DECREASE operations that need to know the current level.
     * 
     * @param {string} address - Device address (network/app/group)
     * @param {Function} callback - Callback function to handle the level response
     * @param {number} [timeout=5000] - Timeout in milliseconds for the operation
     * @returns {string} Operation ID that can be used to cancel the operation
     */
    setupRelativeLevelOperation(address, callback, timeout = 5000) {
        if (this.activeOperations.has(address)) {
            this.logger.warn(`Relative level operation already active for ${address}, skipping`);
            return null;
        }

        this.activeOperations.add(address);
        const operationId = `${address}_${Date.now()}`;

        // Set up one-time listener for level response
        const levelHandler = (responseAddress, currentLevel) => {
            if (responseAddress === address) {
                this.activeOperations.delete(address);
                clearTimeout(timeoutHandle);
                
                this.logger.debug(`Received level response for ${address}: ${currentLevel}`);
                callback(currentLevel);
            }
        };

        // Set up timeout to clean up if no response
        const timeoutHandle = setTimeout(() => {
            this.internalEventEmitter.removeListener(MQTT_TOPIC_SUFFIX_LEVEL, levelHandler);
            this.activeOperations.delete(address);
            this.logger.warn(`Timeout waiting for level response from ${address}`);
        }, timeout);

        this.internalEventEmitter.once(MQTT_TOPIC_SUFFIX_LEVEL, levelHandler);
        
        return operationId;
    }

    /**
     * Cancels an active relative level operation.
     * 
     * @param {string} address - Device address to cancel operation for
     */
    cancelRelativeLevelOperation(address) {
        if (this.activeOperations.has(address)) {
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
        this.activeOperations.clear();
        if (count > 0) {
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
        this.internalEventEmitter.removeAllListeners();
        this.logger.debug('Device state manager shut down');
    }
}

module.exports = DeviceStateManager;
