// @ts-check
'use strict';

const { normalizeAppEventLine, isAppEventLine } = require('./appEventLine');

/**
 * C-Bus Clock and Timekeeping Application ($DF / app 223) decoder.
 *
 * WHAT IS PROVEN, AND WHAT IS NOT
 * -------------------------------
 * The only ground truth in this repository for app-223 event-port traffic is
 * two lines captured off a live C-Gate and committed in 833b60e ("filter out
 * C-Gate clock/timekeeping events"):
 *
 *   clock date //CLIPSAL/254/223 2026-03-02 0 #sourceunit=8 OID=
 *   clock time //CLIPSAL/254/223 21:13:21 0 #sourceunit=8 OID=
 *
 * They are near-certainly genuine: that commit is dated 2026-03-02 21:17:32
 * +1100, so the captured date equals the commit date and the captured time is
 * four minutes before it.
 *
 * From those two lines the following is established:
 *   - the verb is `clock`, with a sub-verb of `date` or `time`;
 *   - the address is TWO segments (`//PROJECT/<net>/<app>`) — network and
 *     application, no group. This is why clock lines can never be parsed by
 *     CBusEvent, whose EVENT_REGEX requires three (see the note in
 *     src/measurementEventHandler.js for the same problem in app 228);
 *   - `date` carries ISO `YYYY-MM-DD`, `time` carries `HH:MM:SS`, both in the
 *     network's own local time with NO timezone or UTC offset;
 *   - a trailing field follows the value, `0` in both captures.
 *
 * The following is NOT established, and this decoder therefore refuses to
 * guess at it:
 *   - the meaning of the trailing `0`. It is parsed off and discarded, never
 *     published. docs/cgate-manual.md documents only the command names
 *     (`CLOCK DATE|TIME|REQUEST_REFRESH`), never an event-port grammar.
 *   - any sub-verb other than `date` and `time`. C-Gate has a
 *     `REQUEST_REFRESH` command, so a corresponding broadcast may well exist,
 *     but no capture of one exists here — it decodes to null rather than to an
 *     invented shape.
 *
 * Everything not proven above returns null (fail closed). A wrong guess in a
 * decoder is worse than a missing feature: it publishes confident nonsense.
 * Unrecognised clock traffic still reaches raw event capture
 * (`cbusRawEventLogApps`), which is how a real `request_refresh` or
 * variant-format capture can be obtained to extend this decoder later.
 */

// C-Bus Clock and Timekeeping is fixed at $DF / 223 by the application spec —
// unlike the Aircon/Measurement app ids, it is not site-configurable, so it is
// a literal here rather than a setting.
const appId = '223';

const PREFIX = 'clock';

// Two-segment address: `//PROJECT/<net>/<app>` or a bare `<net>/<app>`. The
// project prefix is optional because C-Gate omits it at some event levels.
const ADDRESS_REGEX = /^(?:\/\/[^/]+\/)?(\d+)\/(\d+)$/;

const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_REGEX = /^(\d{2}):(\d{2}):(\d{2})$/;

/**
 * Whether a raw event line is clock-application traffic (a `clock <verb> ...`
 * line, optionally `#`-comment-prefixed), regardless of whether the feature is
 * enabled or the line can be decoded. Such lines are never valid CBusEvents
 * (two-segment address), so callers use this to keep them out of the standard
 * parser, which would otherwise log a "Could not parse event line" warning on
 * every clock tick — the original reason these lines were dropped.
 *
 * @param {string} line - Raw line from the C-Gate event stream.
 * @returns {boolean}
 */
function isClockLine(line) {
    if (typeof line !== 'string' || line.length === 0) return false;
    return isAppEventLine(line, PREFIX);
}

/**
 * Validate a `YYYY-MM-DD` string and confirm it is a real calendar date.
 * Rejects 2026-02-30 and friends, which the regex alone would accept.
 *
 * @param {string} value
 * @returns {string|null} the value unchanged, or null if it is not a real date.
 */
function parseDate(value) {
    const match = DATE_REGEX.exec(value);
    if (!match) return null;

    const [, year, month, day] = match;
    const y = Number(year);
    const m = Number(month);
    const d = Number(day);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;

    // Round-trip through Date to reject impossible days (Feb 30, Apr 31).
    // Date.UTC avoids any local-timezone shifting of the components.
    const asDate = new Date(Date.UTC(y, m - 1, d));
    if (asDate.getUTCFullYear() !== y || asDate.getUTCMonth() !== m - 1 || asDate.getUTCDate() !== d) {
        return null;
    }
    return value;
}

/**
 * Validate an `HH:MM:SS` string.
 *
 * @param {string} value
 * @returns {string|null} the value unchanged, or null if out of range.
 */
function parseTime(value) {
    const match = TIME_REGEX.exec(value);
    if (!match) return null;

    const [, hours, minutes, seconds] = match;
    if (Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) return null;
    return value;
}

/**
 * @typedef {Object} ClockReading
 * @property {'clock'} kind
 * @property {string} network - C-Bus network id from the address.
 * @property {string} application - Application id from the address (223).
 * @property {'date'|'time'} variant - Which half of the network clock this line carries.
 * @property {string} value - `YYYY-MM-DD` for date, `HH:MM:SS` for time, verbatim
 *   as the network reported it. Deliberately not converted to a timestamp: the
 *   broadcast carries no timezone, and date and time arrive as separate events.
 */

/**
 * Decode a Clock and Timekeeping event line.
 *
 * @param {string} line - Raw line from the C-Gate event stream.
 * @returns {ClockReading|null} null for anything not provably a clock date or
 *   time broadcast — including clock traffic with an unknown sub-verb.
 */
function decodeLine(line) {
    if (typeof line !== 'string') return null;

    const normalized = normalizeAppEventLine(line, PREFIX);
    if (!normalized) return null;

    const parts = normalized.text.split(/\s+/).filter(Boolean);
    // [clock, <variant>, <address>, <value>, ...] — the trailing field seen in
    // both captures is deliberately not read (its meaning is undocumented).
    if (parts.length < 4) return null;

    const variant = parts[1];
    if (variant !== 'date' && variant !== 'time') return null;

    const address = ADDRESS_REGEX.exec(parts[2]);
    if (!address) return null;
    const [, network, application] = address;

    const value = variant === 'date' ? parseDate(parts[3]) : parseTime(parts[3]);
    if (value === null) return null;

    return { kind: 'clock', network, application, variant, value };
}

/**
 * Registry contract (CBusEvent._applyDecoder). Clock traffic is line-oriented
 * with a two-segment address, so it never reaches the standard byte-valued
 * path this method serves — there is no group-addressed clock reading to
 * decode. It exists so app 223 can be listed in the decoder registry without
 * _applyDecoder throwing on a stray three-segment app-223 line (a `300
 * //PROJECT/254/223/1: level=0` status response would reach it). Returning
 * null leaves such a line on its existing path rather than inventing a
 * reading for it.
 *
 * @returns {null}
 */
function decodeValue() {
    return null;
}

module.exports = { appId, isClockLine, decodeLine, decodeValue };
