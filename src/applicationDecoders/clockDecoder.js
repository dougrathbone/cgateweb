// @ts-check
'use strict';

const { normalizeAppEventLine, isAppEventLine } = require('./appEventLine');

/**
 * C-Bus Clock and Timekeeping Application ($DF / app 223) decoder.
 *
 * WHAT IS PROVEN, AND WHAT IS NOT
 * -------------------------------
 * Ground truth for app-223 event-port traffic in this repository:
 *
 *   clock date //CLIPSAL/254/223 2026-03-02 0 #sourceunit=8 OID=
 *   clock time //CLIPSAL/254/223 21:13:21 0 #sourceunit=8 OID=
 *
 * (833b60e; the captured date equals that commit date and the captured time
 * is four minutes before it.) And a second site, an alarm panel NTP-syncing
 * onto the bus (github.com/dougrathbone/cgateweb/issues/66):
 *
 *   #s# clock time //MIDSTRM/254/223 08:44:00 255 #sourceunit=18 OID=
 *   #s# clock date //MIDSTRM/254/223 2026-08-22 5 #sourceunit=18 OID=
 *
 * The `#s#` prefix is C-Gate's status-channel marker (EVENT s1, §4.5.83),
 * not part of the clock grammar.
 *
 * Established from both captures:
 *   - the verb is `clock`, with a sub-verb of `date` or `time`;
 *   - the address is TWO segments (`//PROJECT/<net>/<app>`) — network and
 *     application, no group. This is why clock lines can never be parsed by
 *     CBusEvent, whose EVENT_REGEX requires three (see the note in
 *     src/measurementEventHandler.js for the same problem in app 228);
 *   - `date` carries ISO `YYYY-MM-DD`, `time` carries `HH:MM:SS`, both in the
 *     network's own local time with NO timezone or UTC offset;
 *   - a trailing field follows the value. It has been `0`, `5`, and `255`
 *     across the two sites; its meaning is still undocumented, so it is
 *     parsed off and discarded, never published.
 *
 * The following is NOT established, and this decoder therefore refuses to
 * guess at it:
 *   - the meaning of that trailing field (docs/cgate-manual.md documents only
 *     the command names `CLOCK DATE|TIME|REQUEST_REFRESH`, never an
 *     event-port grammar).
 *   - any sub-verb other than `date` and `time` as a published reading. A
 *     `clock request_refresh` echo is now captured (#66) and recognised so
 *     callers can consume it without logging it as unparsed; it is not a
 *     date or time broadcast, so decodeLine still returns null.
 *
 * Everything not proven above returns null (fail closed). A wrong guess in a
 * decoder is worse than a missing feature: it publishes confident nonsense.
 * Unrecognised clock traffic still reaches raw event capture
 * (`cbusRawEventLogApps`).
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
 * Whether a clock line is a REQUEST_REFRESH command echo, not a date/time
 * broadcast. Captured on a live site (#66):
 *
 *   clock request_refresh //MIDSTRM/254/223  #sourceunit=0 OID=
 *
 * sourceunit=0 is the bridge's own command coming back on the event port.
 * Callers consume these silently; they are not readings.
 *
 * @param {string} line - Raw line from the C-Gate event stream.
 * @returns {boolean}
 */
function isClockRequestRefreshLine(line) {
    if (typeof line !== 'string') return false;
    const normalized = normalizeAppEventLine(line, PREFIX);
    if (!normalized) return false;
    const parts = normalized.text.split(/\s+/).filter(Boolean);
    return parts.length >= 2 && parts[1] === 'request_refresh';
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
    // [clock, <variant>, <address>, <value>, ...] — the trailing field (0, 5,
    // 255 in captures) is deliberately not read (its meaning is undocumented).
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

module.exports = { appId, isClockLine, isClockRequestRefreshLine, decodeLine, decodeValue };
