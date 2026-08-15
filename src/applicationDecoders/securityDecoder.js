// @ts-check
const { DEFAULT_CBUS_APP_SECURITY } = require('../constants');
const { normalizeAppEventLine } = require('./appEventLine');
const {
    PANEL_TROUBLE_VERBS,
    PANEL_TROUBLE_DETAIL_VERBS
} = require('../securityPanelConditions');

/**
 * C-Bus Security application (208 / $D0) line decoder.
 *
 * Decodes the following verbs from the C-Gate event stream (all observed as
 * `#`-prefixed comment lines on the event port — see docs/SECURITY_INVESTIGATION.md
 * and the live 64-zone Cytech panel captures in GitHub issue #42):
 *   - zone_sealed / zone_unsealed / zone_open / zone_short
 *       → { kind:'zone', …, zone, zoneState }
 *   - status_report_1  → { kind:'status_report_1', …, armState, armMode,
 *                          tamper, tamperActive, panic, panicActive, zones[] } (zones 1-32)
 *   - status_report_2  → { kind:'status_report_2', …, zones[] } (zones 33-80)
 *   - status_request     → { kind:'status_request', …, report } (our own command
 *                          echoes on the event port)
 *   - arm_ready        → { kind:'arm_ready', …, zone } (zone 0 = armed correctly;
 *                          absent on panels that omit it — see ZONE_ADDRESS_VERBS)
 *   - arm_not_ready    → { kind:'arm_not_ready', …, zone } (zone names the blocker)
 *   - exit_delay_started → { kind:'exit_delay_started', … }
 *   - system_arm       → { kind:'system_arm', …, mode, modeName } (0-4; 0 = disarmed)
 *   - alarm_on / alarm_off → { kind:'alarm_on'|'alarm_off', … }
 *   - zone_isolated    → { kind:'zone_isolated', …, zone } (zone bypassed on arming)
 *   - panel-wide trouble verbs → { kind:'panel_trouble', …, condition, active, detail }
 *       mains_failure/mains_restored, low_battery/low_battery_corrected,
 *       tamper_on/tamper_off, panic_activated/panic_off/panic_cleared, and the
 *       detail-suffixed line_cut_alarm, arm_failed and fire_alarm (whose
 *       "<verb>_raised"/"<verb>_cleared" argument carries the sense).
 *
 * Status report rendering: the spec (CBUS-APP/05 §5.5.1.20-21) packs 4 zones
 * per byte, 2 bits each (%00 sealed, %01 unsealed, %10 open, %11 short), but
 * C-Gate's text rendering explodes the packed bytes into one decimal per zone
 * (the same convention the Air Conditioning application uses for the Mode &
 * Flags byte) — confirmed by the #42 captures: report 1 carries 3 prefix
 * numbers (arm state, tamper, panic) followed by one number per zone from
 * zone 1; report 2 has no prefix and starts at zone 33. Decoding is lenient:
 * as many zone values as present are decoded.
 *
 * Field layouts verified against the official protocol spec ("Security
 * Application", CBUS-APP/05 issue 4.3 — docs/Security Application.md) and the
 * live captures quoted in docs/SECURITY_INVESTIGATION.md §1.
 * Other verbs return null.
 */

const appId = DEFAULT_CBUS_APP_SECURITY;

/**
 * Raw 2-bit zone states (spec §5.5.1.20), indexed by their numeric code.
 */
const ZONE_STATE = {
    SEALED: 'sealed',
    UNSEALED: 'unsealed',
    OPEN: 'open',
    SHORT: 'short'
};
const ZONE_STATE_BY_CODE = [ZONE_STATE.SEALED, ZONE_STATE.UNSEALED, ZONE_STATE.OPEN, ZONE_STATE.SHORT];

/**
 * Arm modes (spec §5.5.1.1, confirmed by #42 captures):
 * 0 disarmed, 1 away, 2 night, 3 day/stay, 4 vacation.
 */
const ARM_MODE_BY_CODE = { 0: 'disarmed', 1: 'away', 2: 'night', 3: 'day', 4: 'vacation' };

const MIN_ZONE = 1;
const MAX_ZONE = 127; // zone numbers are $01-$7F (spec §5.5.1.11)

// Verbs whose address carries a trailing zone (//PROJECT/<net>/<app>/<zone>).
// arm_ready belongs here: spec §5.5.1.25 defines one Arm Ready / Not Ready
// message carrying a zone, so the ready half carries one too. Without it the
// zone segment made the address look like it had one segment too many and the
// whole line was dropped.
const ZONE_ADDRESS_VERBS = new Set([
    'zone_sealed', 'zone_unsealed', 'zone_open', 'zone_short', 'zone_isolated',
    'arm_not_ready', 'arm_ready'
]);

// …but arm_ready's zone is optional in practice: the #42 capture is a bare
// "security arm_ready //MIDSTRM/254/208" with no zone at all. Requiring the
// zone would have regressed that live panel to undecoded, so a failed
// zone-bearing parse falls back to the zoneless shape for these verbs only.
const OPTIONAL_ZONE_ADDRESS_VERBS = new Set(['arm_ready']);

// Verbs where zone 0 is meaningful rather than out of range. Spec §5.5.1.25:
// the Arm Ready / Not Ready message is sent with a <zone number> of 0 when the
// system armed correctly — i.e. nothing is blocking. Zone 0 stays rejected for
// every other verb: a zone_sealed for zone 0 is a malformed line, not an event,
// and admitting it would invent a zone 0 sensor in Home Assistant.
const ZERO_ZONE_VERBS = new Set(['arm_ready', 'arm_not_ready']);

// Zone-event verb → 2-bit state name, hoisted so the dispatch allocates
// nothing per line.
const ZONE_STATE_BY_VERB = {
    zone_sealed: ZONE_STATE.SEALED,
    zone_unsealed: ZONE_STATE.UNSEALED,
    zone_open: ZONE_STATE.OPEN,
    zone_short: ZONE_STATE.SHORT
};

// Panel-wide trouble conditions and their verbs live in securityPanelConditions
// so the wire format, the HA entity metadata and the log wording for one
// condition stay in a single record.

/**
 * Whether a string is all decimal digits (at least one) — the /^\d+$/ check
 * without the regex.
 *
 * @private
 */
function isDigits(s) {
    if (s.length === 0) return false;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 48 || c > 57) return false;
    }
    return true;
}

/**
 * The last `count` non-empty '/'-separated segments of an address, in order —
 * the split('/').filter(Boolean) tail without the per-line array.
 *
 * @private
 */
function lastSegments(addr, count) {
    const segs = [];
    let end = addr.length;
    while (segs.length < count && end > 0) {
        const slash = addr.lastIndexOf('/', end - 1);
        const seg = addr.slice(slash + 1, end);
        if (seg) segs.unshift(seg);
        if (slash === -1) break;
        end = slash;
    }
    return segs;
}

/**
 * Number of non-empty '/'-separated segments in an address —
 * //PROJECT/<net>/<app> is 3, //PROJECT/<net>/<app>/<zone> is 4. Used to tell
 * "this address has no zone" apart from "this address has a bad zone", which
 * the parse result alone cannot distinguish.
 *
 * @private
 */
function countSegments(addr) {
    let count = 0;
    let inSegment = false;
    for (let i = 0; i < addr.length; i++) {
        if (addr.charCodeAt(i) === 47 /* '/' */) { inSegment = false; continue; }
        if (!inSegment) { count++; inSegment = true; }
    }
    return count;
}

/**
 * Parse a C-Bus address //PROJECT/<net>/<app>[/<zone>].
 *
 * @param {string} addr - Address token.
 * @param {boolean} expectZone - Whether a trailing zone segment is expected.
 * @param {number} [minZone] - Lowest acceptable zone number for this verb.
 * @returns {{ network: string, application: string, zone: string|null }|null}
 * @private
 */
function parseAddress(addr, expectZone, minZone = MIN_ZONE) {
    const segs = lastSegments(addr, 3);
    if (expectZone && segs.length >= 3) {
        const network = segs[segs.length - 3];
        const application = segs[segs.length - 2];
        const zone = segs[segs.length - 1];
        if (!isDigits(network) || !isDigits(application) || !isDigits(zone)) return null;
        const zoneNum = parseInt(zone, 10);
        if (zoneNum < minZone || zoneNum > MAX_ZONE) return null;
        return { network, application, zone };
    }
    if (segs.length >= 2) {
        const network = segs[segs.length - 2];
        const application = segs[segs.length - 1];
        if (!isDigits(network) || !isDigits(application)) return null;
        return { network, application, zone: null };
    }
    return null;
}

/**
 * Decode a run of exploded per-zone state values into {zone, state} entries.
 *
 * @param {string[]} params - Decimal state tokens (0-3 per zone).
 * @param {number} firstZone - Zone number of params[0].
 * @returns {Array<{ zone: number, state: string }>}
 * @private
 */
function decodeZoneStates(params, firstZone) {
    const zones = [];
    for (let i = 0; i < params.length; i++) {
        const code = parseInt(params[i], 10);
        if (!Number.isInteger(code) || code < 0 || code >= ZONE_STATE_BY_CODE.length) return null;
        const zone = firstZone + i;
        if (zone > MAX_ZONE) break;
        zones.push({ zone, state: ZONE_STATE_BY_CODE[code] });
    }
    return zones;
}

/**
 * Decode a status_report_1 event: <state> <tamper> <panic> <zone 1> … <zone 32>
 * (spec §5.5.1.20; C-Gate explodes the packed 2-bit fields — see header).
 * Tamper/panic are $00 = inactive, $FF = active (reserved values tolerated).
 *
 * @private
 */
function decodeStatusReport1({ network, application, params, verb }) {
    if (params.length < 3) return null;
    const armState = parseInt(params[0], 10);
    const tamper = parseInt(params[1], 10);
    const panic = parseInt(params[2], 10);
    if (!Number.isInteger(armState) || !Number.isInteger(tamper) || !Number.isInteger(panic)) return null;

    const zones = decodeZoneStates(params.slice(3), 1);
    if (zones === null) return null;

    const armMode = Object.prototype.hasOwnProperty.call(ARM_MODE_BY_CODE, armState)
        ? ARM_MODE_BY_CODE[armState]
        : null;

    return {
        kind: 'status_report_1', network, application,
        armState, armMode,
        tamper, tamperActive: tamper === 0xFF,
        panic, panicActive: panic === 0xFF,
        zones, verb
    };
}

/**
 * Decode a status_report_2 event: <zone 33> … <zone 80> — no prefix
 * (spec §5.5.1.21; same exploded rendering as report 1).
 *
 * @private
 */
function decodeStatusReport2({ network, application, params, verb }) {
    if (params.length < 1) return null;
    const zones = decodeZoneStates(params, 33);
    if (zones === null) return null;
    return { kind: 'status_report_2', network, application, zones, verb };
}

/**
 * Decode a single C-Gate event line from the Security application.
 *
 * @param {string} line - Raw line from the C-Gate event stream.
 * @returns {object|null} A reading object, or null for unrecognised/malformed lines.
 */
function decodeLine(line) {
    // 1. Shared preamble: trim, strip '#', require the "security " prefix,
    //    split trailing metadata (security has no use for the metadata).
    const normalized = normalizeAppEventLine(line, 'security');
    if (!normalized) return null;

    // 2. Tokenize: security <verb> <addr> <params...>
    const tokens = normalized.text.trim().split(/\s+/);
    // tokens[0] = 'security', tokens[1] = verb, tokens[2] = address, tokens[3..] = params
    if (tokens.length < 3) return null;

    const verb = tokens[1];
    const addr = tokens[2];
    const params = tokens.slice(3);

    // 3. Parse address //PROJECT/<network>/<application>[/<zone>]
    const minZone = ZERO_ZONE_VERBS.has(verb) ? 0 : MIN_ZONE;
    let parsed = parseAddress(addr, ZONE_ADDRESS_VERBS.has(verb), minZone);
    if (!parsed && OPTIONAL_ZONE_ADDRESS_VERBS.has(verb) && countSegments(addr) <= 3) {
        // No zone segment at all (//PROJECT/<net>/<app>) — the shape the #42
        // panel emits. Gated on the segment count so a *malformed* zone still
        // rejects the line: without the gate, ".../254/208/128" would fall
        // through and be read as network 208, application 128.
        parsed = parseAddress(addr, false);
    }
    if (!parsed) return null;
    const { network, application, zone } = parsed;

    // 4. Dispatch by verb
    const zoneState = ZONE_STATE_BY_VERB[verb];
    if (zoneState !== undefined) {
        if (zone === null) return null;
        return { kind: 'zone', network, application, zone, zoneState, verb };
    }

    if (verb === 'status_report_1') {
        return decodeStatusReport1({ network, application, params, verb });
    }

    if (verb === 'status_report_2') {
        return decodeStatusReport2({ network, application, params, verb });
    }

    // Our own status_request commands echo back on the event port
    // ("security status_request //PROJECT/<net>/<app> <report> #sourceunit=0
    // OID= sessionId=cmd6 …") — recognise them so they are consumed quietly
    // instead of logging as undecoded.
    if (verb === 'status_request') {
        const report = params.length > 0 ? parseInt(params[0], 10) : NaN;
        return { kind: 'status_request', network, application, report: Number.isInteger(report) ? report : null, verb };
    }

    // Same for our own `security arm` commands ("security arm //PROJECT/254/208
    // day #sourceunit=0 …"). The echo carries no state worth acting on — the
    // panel's own exit_delay_started/system_arm events follow and drive the
    // entity — so it is recognised purely to keep it out of the undecoded log
    // (#42).
    if (verb === 'arm') {
        return { kind: 'arm_command_echo', network, application, mode: params.length > 0 ? params[0] : null, verb };
    }

    // Our own `security emulate_keypad` commands echo back the same way. Beyond
    // the log noise, these must be recognised for a second reason: the argument
    // is one character of the user's alarm PIN, and every path that logs an
    // undecoded line would have written it out verbatim (#51). Deliberately does
    // not carry the key.
    if (verb === 'emulate_keypad') {
        return { kind: 'keypad_command_echo', network, application, verb };
    }

    // System state verbs (decoded, logged and surfaced to Live Events; the
    // panel condition sensors build on these — see securityPanelState).
    if (verb === 'arm_ready') {
        // zone is '0' when the panel armed with nothing blocking, a zone number
        // on panels that report readiness per zone, and null on panels that
        // omit the segment entirely.
        return { kind: 'arm_ready', network, application, zone, verb };
    }

    if (verb === 'arm_not_ready') {
        return { kind: 'arm_not_ready', network, application, zone, verb };
    }

    if (verb === 'exit_delay_started') {
        return { kind: 'exit_delay_started', network, application, verb };
    }

    if (verb === 'system_arm') {
        const mode = params.length > 0 ? parseInt(params[0], 10) : NaN;
        const modeName = Object.prototype.hasOwnProperty.call(ARM_MODE_BY_CODE, mode)
            ? ARM_MODE_BY_CODE[mode]
            : null;
        return { kind: 'system_arm', network, application, mode: Number.isInteger(mode) ? mode : null, modeName, verb };
    }

    if (verb === 'alarm_on' || verb === 'alarm_off') {
        return { kind: verb, network, application, verb };
    }

    if (verb === 'zone_isolated') {
        return { kind: 'zone_isolated', network, application, zone, verb };
    }

    // Panel-wide trouble conditions (mains, battery, tamper, panic, phone line,
    // arm failure, fire). These become diagnostic binary_sensors; the raise and
    // clear senses are resolved here so downstream code never parses verbs.
    const named = PANEL_TROUBLE_VERBS.get(verb);
    const detailCondition = PANEL_TROUBLE_DETAIL_VERBS.get(verb);
    if (named || detailCondition) {
        // Verbs in PANEL_TROUBLE_VERBS name their own sense; the rest carry it
        // in a "<verb>_raised" / "<verb>_cleared" argument, where a bare verb
        // with no argument means raised.
        const detail = params.length > 0 ? params.join(' ') : null;
        return {
            kind: 'panel_trouble', network, application,
            condition: named ? named.condition : detailCondition,
            active: named ? named.active : !(detail && detail.endsWith('_cleared')),
            verb,
            detail
        };
    }

    return null;
}

module.exports = {
    appId, decodeLine, ZONE_STATE, ZONE_STATE_BY_CODE, ARM_MODE_BY_CODE
};
