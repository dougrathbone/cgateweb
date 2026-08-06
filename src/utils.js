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

// TLS record content types: change_cipher_spec, alert, handshake,
// application_data. A plaintext client hitting a TLS listener normally gets an
// alert (0x15) as its first bytes.
const TLS_CONTENT_TYPES = new Set([0x14, 0x15, 0x16, 0x17]);

/**
 * Does this look like the start of a TLS record rather than C-Gate protocol?
 *
 * Safe to test against C-Gate traffic: its ports speak a line-based ASCII
 * protocol, so a leading byte in 0x14-0x17 followed by a 0x03 major version
 * cannot occur legitimately. Only worth checking on the first chunk of a
 * connection, where a TLS server's alert or handshake would appear.
 *
 * Exists because pointing cgateweb at one of C-Gate's SSL ports used to surface
 * only as unparseable control characters and an endless reconnect loop (#52).
 *
 * @param {Buffer|string} data - First chunk received on the socket.
 * @returns {boolean}
 */
function looksLikeTlsRecord(data) {
    if (!Buffer.isBuffer(data) || data.length < 3) return false;
    // data[1]/data[2] are the record's protocol version: 0x03 0x00 (SSL 3.0)
    // through 0x03 0x04 (TLS 1.3).
    return TLS_CONTENT_TYPES.has(data[0]) && data[1] === 0x03 && data[2] <= 0x04;
}

module.exports = { clampSetting, evictOldestFifo, temperatureToCbusLevel, looksLikeTlsRecord };
