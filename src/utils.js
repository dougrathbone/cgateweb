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

// `security emulate_keypad <address> <key>` — the key argument is one character
// of the user's alarm PIN. Anchored on the verb so only that argument is
// touched; the address and C-Gate's trailing metadata are left readable.
const EMULATE_KEYPAD_KEY = /(security\s+emulate_keypad\s+\S+\s+)(\S+)/gi;

/**
 * Strip secrets from a raw C-Gate protocol line before it is logged.
 *
 * Disarming types the PIN at the panel one keypress per command (#51), and
 * C-Gate echoes each of those commands back on both the command and event
 * ports. Those echoes are logged verbatim at debug level, so a debug log
 * captured while disarming contained the whole PIN, one digit per line — even
 * though none of the security code paths log the code themselves. Reported by
 * the user who found it in his own logs.
 *
 * Applied at the two raw-line log sites rather than at each caller, so a future
 * sensitive command cannot bypass it by logging somewhere new.
 *
 * @param {string} line - Raw C-Gate line, inbound or outbound.
 * @returns {string} The line with any keypad key replaced by `***`.
 */
function redactCgateLine(line) {
    if (typeof line !== 'string' || !line) return line;
    // No cheap indexOf pre-check here: it has to match the case-insensitive
    // regex below or an echo in a different case slips through unredacted,
    // which is exactly the leak this exists to close. Only reached when debug
    // logging is on, so one regex per line costs nothing that matters.
    return line.replace(EMULATE_KEYPAD_KEY, '$1***');
}

module.exports = {
    clampSetting,
    evictOldestFifo,
    temperatureToCbusLevel,
    looksLikeTlsRecord,
    redactCgateLine
};
