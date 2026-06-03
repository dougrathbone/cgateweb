const { DEFAULT_CBUS_APP_TEMPERATURE } = require('../constants');

/**
 * C-Bus Temperature Broadcast ($19 / app 25) decoder.
 * Encoding (per the C-Bus Temperature Broadcast Application): °C = rawByte / 4,
 * valid 0.0–63.75°C. Group address identifies the reporting sensor/zone.
 */
const appId = DEFAULT_CBUS_APP_TEMPERATURE;

function decodeValue({ group, rawByte }) {
    if (!Number.isInteger(rawByte) || rawByte < 0 || rawByte > 255) {
        return null;
    }
    return { kind: 'temperature', group: String(group), celsius: rawByte / 4, unit: 'C' };
}

module.exports = { appId, decodeValue };
