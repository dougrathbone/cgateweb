// @ts-check
'use strict';

/**
 * Command builder for Temperature Broadcast (app 25 / $19) injection.
 *
 * Encoding matches the read path: rawByte = round(°C × 4), 0–255 → 0.0–63.75°C.
 * C-Gate syntax follows the documented TEMPERATURE BROADCAST verb; the decimal
 * argument style matches Measurement (C-Gate resolves the SAL bytes).
 *
 * @param {Object} opts
 * @param {string} opts.cbusname
 * @param {string|number} opts.network
 * @param {string|number} opts.application
 * @param {string|number} opts.group
 * @param {number} opts.rawByte - 0–255
 * @returns {string}
 */
function buildTemperatureBroadcastCommand({ cbusname, network, application, group, rawByte }) {
    return `TEMPERATURE BROADCAST //${cbusname}/${network}/${application}/${group} ${rawByte}`;
}

/**
 * Encode °C as a Temperature Broadcast raw byte. Returns null when the value
 * is not a finite number in 0.0–63.75°C (the representable range).
 *
 * @param {number} celsius
 * @returns {number|null}
 */
function celsiusToTemperatureBroadcastByte(celsius) {
    if (typeof celsius !== 'number' || !Number.isFinite(celsius)) return null;
    if (celsius < 0 || celsius > 63.75) return null;
    return Math.round(celsius * 4);
}

module.exports = {
    buildTemperatureBroadcastCommand,
    celsiusToTemperatureBroadcastByte
};
