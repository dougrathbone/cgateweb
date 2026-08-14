// @ts-check
'use strict';

/**
 * Command builder for the C-Bus Measurement application (228 / $E4) write
 * path: injecting a channel measurement reading onto C-Bus, e.g. from a
 * scripted/virtual sensor (temperature, solar inverter power) rather than
 * physical hardware — the primary use case for this write support.
 *
 * Confirmed working syntax via live end-to-end testing against real C-Gate
 * and physical DLT input units: C-Gate's command interface takes plain
 * decimal value/multiplier/units — it resolves these to the raw MSB/LSB SAL
 * bytes itself (docs/Measurement Application.md §28.5.1.1), so no byte-level
 * encoding is needed here.
 */

/**
 * Build a `MEASUREMENT DATA` command.
 *
 * @param {Object} opts
 * @param {string} opts.cbusname - C-Gate project name.
 * @param {string|number} opts.network - C-Bus network id.
 * @param {string|number} opts.application - Measurement application id (e.g. 228).
 * @param {string|number} opts.device - Measurement device id.
 * @param {string|number} opts.channel - Device channel number.
 * @param {number} opts.value - Signed 16-bit scaled measurement.
 * @param {number} opts.multiplier - Signed power-of-ten exponent.
 * @param {number} opts.unitsCode - Units code (docs/Measurement Application.md §28.5.1.2).
 * @returns {string}
 */
function buildMeasurementDataCommand({ cbusname, network, application, device, channel, value, multiplier, unitsCode }) {
    return `MEASUREMENT DATA //${cbusname}/${network}/${application}/${device}/${channel} ${value} ${multiplier} ${unitsCode}`;
}

module.exports = { buildMeasurementDataCommand };
