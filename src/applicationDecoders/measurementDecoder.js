// @ts-check
const { DEFAULT_CBUS_APP_MEASUREMENT } = require('../constants');
const { normalizeAppEventLine, isAppEventLine } = require('./appEventLine');

/**
 * C-Bus Measurement Application ($E4 / app 228) decoder.
 *
 * Byte-level encoding per docs/Measurement Application.md (Clipsal CBUS-APP/28
 * §28.5.1.1): a channel-data message carries
 * <Device ID> <Channel> <Units> <Multiplier> <MSB> <LSB>, decoded as
 * `value = int16(MSB, LSB) x 10^Multiplier`, unit from the §28.5.1.2 table.
 *
 * C-Gate's event-port text framing (confirmed via live end-to-end testing
 * against a real C-Gate instance and physical DLT input units) already
 * resolves MSB/LSB into a plain decimal value, so the line-level format
 * decoded here is:
 *   measurement data //<project>/<net>/<app>/<device>/<channel> <value> <multiplier> <units>
 * e.g. "measurement data //HOME/254/228/0/0 5042 0 38" -> device 0, channel 0,
 * 5042 W (units code 38 = Watts).
 */

const appId = DEFAULT_CBUS_APP_MEASUREMENT;

// Unit codes per docs/Measurement Application.md §28.5.1.2 -> { unit, deviceClass }.
// deviceClass is only set where the mapping to a Home Assistant device_class is
// unambiguous; every other code is a plain sensor (deviceClass: null) rather
// than a guessed one.
//
// stateClass overrides the default 'measurement' where Home Assistant requires
// a different one: device_class 'energy' is only valid with a total state
// class, and pairing it with 'measurement' makes HA reject the entity outright.
const UNIT_TABLE = {
    0: { unit: '°C', deviceClass: 'temperature' },       // $00
    1: { unit: 'A', deviceClass: 'current' },                 // $01
    2: { unit: '°', deviceClass: null },                 // $02 Angle
    3: { unit: 'C', deviceClass: null },                      // $03 Coulomb
    4: { unit: null, deviceClass: null },                     // $04 Boolean
    5: { unit: 'F', deviceClass: null },                      // $05 Farads
    6: { unit: 'H', deviceClass: null },                      // $06 Henrys
    7: { unit: 'Hz', deviceClass: 'frequency' },               // $07
    8: { unit: 'J', deviceClass: null },                      // $08 Joules
    9: { unit: 'kat', deviceClass: null },                    // $09 Katal
    10: { unit: 'kg/m³', deviceClass: null },            // $0A
    11: { unit: 'kg', deviceClass: null },                    // $0B
    12: { unit: 'L', deviceClass: null },                     // $0C
    13: { unit: 'L/h', deviceClass: null },                   // $0D
    14: { unit: 'L/min', deviceClass: null },                 // $0E
    15: { unit: 'L/s', deviceClass: null },                   // $0F
    16: { unit: 'lx', deviceClass: 'illuminance' },            // $10
    17: { unit: 'm', deviceClass: null },                     // $11
    18: { unit: 'm/min', deviceClass: null },                 // $12
    19: { unit: 'm/s', deviceClass: null },                   // $13
    20: { unit: 'm/s²', deviceClass: null },             // $14
    21: { unit: 'mol', deviceClass: null },                   // $15
    22: { unit: 'N·m', deviceClass: null },              // $16
    23: { unit: 'N', deviceClass: null },                     // $17
    24: { unit: 'Ω', deviceClass: null },                // $18 Ohms
    25: { unit: 'Pa', deviceClass: 'pressure' },               // $19
    // $1A. No device_class: the spec calls this "Humidity, generic percentages
    // & linear ratios", so a tank level or valve position shares the code and
    // would otherwise announce itself to Home Assistant as a humidity sensor.
    26: { unit: '%', deviceClass: null },
    27: { unit: 'dB', deviceClass: null },                    // $1B
    28: { unit: 'ppm', deviceClass: null },                   // $1C
    29: { unit: 'rpm', deviceClass: null },                   // $1D
    30: { unit: 's', deviceClass: null },                     // $1E
    31: { unit: 'min', deviceClass: null },                   // $1F
    32: { unit: 'h', deviceClass: null },                     // $20
    33: { unit: 'Sv', deviceClass: null },                    // $21
    34: { unit: 'sr', deviceClass: null },                    // $22
    35: { unit: 'T', deviceClass: null },                     // $23
    36: { unit: 'V', deviceClass: 'voltage' },                 // $24
    37: { unit: 'Wh', deviceClass: 'energy', stateClass: 'total_increasing' }, // $25
    38: { unit: 'W', deviceClass: 'power' },                   // $26
    39: { unit: 'Wb', deviceClass: null },                    // $27
    254: { unit: null, deviceClass: null },                   // $FE No units
    255: { unit: null, deviceClass: null }                    // $FF Custom
};

const MEASUREMENT_LINE_REGEX = /^measurement\s+data\s+\/\/[^/]+\/(\d+)\/(\d+)\/(\d+)\/(\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*$/;

/**
 * Whether a raw event line is native-measurement traffic ("measurement data
 * ..."), regardless of whether it can be decoded. Mirrors isAirconLine/
 * isSecurityLine: such lines are never valid CBusEvents.
 * @param {string} line
 * @returns {boolean}
 */
function isMeasurementLine(line) {
    return isAppEventLine(line, 'measurement');
}

/**
 * Parses a raw C-Gate "measurement data //project/net/app/device/channel value
 * multiplier units" event line into its constituent fields and decodes them.
 * Returns null for non-measurement lines or malformed data (never throws).
 *
 * @param {string} line - Raw line from the C-Gate event stream.
 * @returns {ReturnType<typeof decodeChannelData>}
 */
function decodeLine(line) {
    const normalized = normalizeAppEventLine(line, 'measurement');
    if (!normalized) return null;

    const match = normalized.text.match(MEASUREMENT_LINE_REGEX);
    if (!match) return null;

    const [, network, application, device, channel, rawValue, rawMultiplier, rawUnits] = match;
    return decodeChannelData({
        network,
        application,
        device,
        channel,
        value: parseInt(rawValue, 10),
        multiplier: parseInt(rawMultiplier, 10),
        unitsCode: parseInt(rawUnits, 10)
    });
}

/**
 * Pure decode of already-parsed channel measurement fields, per CBUS-APP/28
 * §28.5.1.1: value = raw x 10^multiplier (raw is the C-Gate-resolved signed
 * 16-bit value, multiplier the signed 8-bit power-of-ten exponent), unit from
 * the §28.5.1.2 table. Never throws; returns null for out-of-range/unknown
 * input so the caller can drop the reading cleanly.
 *
 * @param {{network?: string|number, application?: string|number, device: string|number, channel: string|number, value: number, multiplier: number, unitsCode: number}} args
 * @returns {{kind: 'measurement', network: string|null, application: string, device: string, channel: string, value: number, unit: string|null, unitCode: number, deviceClass: string|null, stateClass: string}|null}
 */
function decodeChannelData({ network, application, device, channel, value, multiplier, unitsCode }) {
    if (!Number.isInteger(value) || value < -32768 || value > 32767) return null;
    if (!Number.isInteger(multiplier) || multiplier < -128 || multiplier > 127) return null;
    if (!Number.isInteger(unitsCode) || !Object.prototype.hasOwnProperty.call(UNIT_TABLE, unitsCode)) return null;

    // toFixed only accepts 0-100 fraction digits and throws RangeError beyond
    // that, but the spec's multiplier is a full signed byte — so a legal
    // multiplier of -101 or lower used to crash the bridge (the event path has
    // no try/catch). Round through toFixed where it is defined, since it is
    // what keeps 215 x 10^-1 at 21.5 rather than 21.500000000000004; past that
    // the value is ~1e-101 and float noise is irrelevant, so scale directly.
    const digits = -multiplier;
    const scaled = multiplier >= 0
        ? value * Math.pow(10, multiplier)
        : digits <= 100
            ? Number((value / Math.pow(10, digits)).toFixed(digits))
            : value * Math.pow(10, multiplier);

    const { unit, deviceClass, stateClass } = UNIT_TABLE[unitsCode];
    return {
        kind: 'measurement',
        network: network !== undefined && network !== null ? String(network) : null,
        application: application !== undefined && application !== null ? String(application) : appId,
        device: String(device),
        channel: String(channel),
        value: scaled,
        unit,
        unitCode: unitsCode,
        deviceClass,
        stateClass: stateClass || 'measurement'
    };
}

module.exports = { appId, isMeasurementLine, decodeLine, decodeChannelData, UNIT_TABLE };
