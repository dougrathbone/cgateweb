// @ts-check
/**
 * Clamp a settings value to a minimum, falling back to a default when the
 * configured value is missing, NaN, or zero. Encodes the canonical pattern
 * for reading numeric settings (Math.max(floor, Number(value) || default))
 * used throughout the bridge.
 *
 * @param {*} value         The raw configured value (any type; coerced via Number).
 * @param {number} floor    Hard lower bound enforced regardless of value or default.
 * @param {number} defaultValue Value used when Number(value) is falsy (0, NaN, undefined, etc).
 * @returns {number}
 */
function clampSetting(value, floor, defaultValue) {
    return Math.max(floor, Number(value) || defaultValue);
}

/**
 * Remove the oldest key from a Map (FIFO order matches insertion order in JS)
 * and return the evicted key. Used by the bounded caches across the bridge to
 * keep size at or below configured limits.
 *
 * @param {Map} map
 * @returns {*} the evicted key (undefined if map was empty)
 */
function evictOldestFifo(map) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
    return oldestKey;
}

/**
 * Encode a temperature (°C) as an 8-bit C-Bus level for the lighting-style HVAC
 * application, which uses 0.5°C resolution (level = temperature × 2), clamped to
 * the valid 0-255 range. This is the inverse of `level / 2`.
 *
 * Note: the native C-Bus air-conditioning application uses a different 16-bit
 * (×256) encoding and is intentionally not handled here.
 *
 * @param {number} tempCelsius
 * @returns {number} C-Bus raw level (0-255)
 */
function temperatureToCbusLevel(tempCelsius) {
    return Math.max(0, Math.min(255, Math.round(tempCelsius * 2)));
}

module.exports = { clampSetting, evictOldestFifo, temperatureToCbusLevel };
