// @ts-check
const { DEFAULT_CBUS_APP_SECURITY } = require('../constants');

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
 *   - arm_ready        → { kind:'arm_ready', … }
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
const ZONE_ADDRESS_VERBS = new Set([
    'zone_sealed', 'zone_unsealed', 'zone_open', 'zone_short', 'zone_isolated', 'arm_not_ready'
]);

/**
 * Panel-wide trouble conditions, in display order.
 */
const PANEL_TROUBLE_CONDITIONS = ['mains', 'battery', 'tamper', 'panic', 'line', 'arm_failed', 'fire'];

/**
 * Verbs that name their own sense. Confirmed by the #42 captures except
 * low_battery, tamper_on and panic_off/panic_cleared: the panel only ever
 * emitted the other half of those three pairs (low_battery_corrected,
 * tamper_off, panic_activated), so these names are inferred from the naming
 * convention of the confirmed pairs. An inferred verb that never arrives costs
 * nothing, and panic still recovers via the disarm-derived clear in
 * securityPanelState.
 */
const PANEL_TROUBLE_VERBS = new Map([
    ['mains_failure', { condition: 'mains', active: true }],
    ['mains_restored', { condition: 'mains', active: false }],
    ['low_battery', { condition: 'battery', active: true }],
    ['low_battery_corrected', { condition: 'battery', active: false }],
    ['tamper_on', { condition: 'tamper', active: true }],
    ['tamper_off', { condition: 'tamper', active: false }],
    ['panic_activated', { condition: 'panic', active: true }],
    ['panic_off', { condition: 'panic', active: false }],
    ['panic_cleared', { condition: 'panic', active: false }]
]);

/**
 * Verbs whose active/cleared sense rides a "<verb>_raised" / "<verb>_cleared"
 * detail argument rather than the verb name (confirmed for all three in the
 * #42 captures). A bare verb with no detail means raised.
 */
const PANEL_TROUBLE_DETAIL_VERBS = new Map([
    ['line_cut_alarm', 'line'],
    ['arm_failed', 'arm_failed'],
    ['fire_alarm', 'fire']
]);

/**
 * Parse a C-Bus address //PROJECT/<net>/<app>[/<zone>].
 *
 * @param {string} addr - Address token.
 * @param {boolean} expectZone - Whether a trailing zone segment is expected.
 * @returns {{ network: string, application: string, zone: string|null }|null}
 * @private
 */
function parseAddress(addr, expectZone) {
    const parts = addr.split('/').filter(Boolean);
    if (expectZone && parts.length >= 3) {
        const zone = parts[parts.length - 1];
        const application = parts[parts.length - 2];
        const network = parts[parts.length - 3];
        if (!/^\d+$/.test(network) || !/^\d+$/.test(application) || !/^\d+$/.test(zone)) return null;
        const zoneNum = parseInt(zone, 10);
        if (zoneNum < MIN_ZONE || zoneNum > MAX_ZONE) return null;
        return { network, application, zone };
    }
    if (parts.length >= 2) {
        const application = parts[parts.length - 1];
        const network = parts[parts.length - 2];
        if (!/^\d+$/.test(network) || !/^\d+$/.test(application)) return null;
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
    // Guard against null / undefined / non-string input
    if (typeof line !== 'string') return null;

    // 1. Trim whitespace
    let text = line.trim();

    // 2. Strip a single leading "# " or "#" comment marker if present
    if (text.startsWith('# ')) {
        text = text.slice(2);
    } else if (text.startsWith('#')) {
        text = text.slice(1);
    }
    text = text.trim();

    // 3. Must start with "security " to be relevant
    if (!text.startsWith('security ')) return null;

    // 4. Strip trailing metadata (" #sourceunit=18 OID=…") if present
    const metaIdx = text.indexOf(' #');
    if (metaIdx !== -1) {
        text = text.slice(0, metaIdx);
    }

    // 5. Tokenize: security <verb> <addr> <params...>
    const tokens = text.trim().split(/\s+/);
    // tokens[0] = 'security', tokens[1] = verb, tokens[2] = address, tokens[3..] = params
    if (tokens.length < 3) return null;

    const verb = tokens[1];
    const addr = tokens[2];
    const params = tokens.slice(3);

    // 6. Parse address //PROJECT/<network>/<application>[/<zone>]
    const parsed = parseAddress(addr, ZONE_ADDRESS_VERBS.has(verb));
    if (!parsed) return null;
    const { network, application, zone } = parsed;

    // 7. Dispatch by verb
    if (verb === 'zone_sealed' || verb === 'zone_unsealed' || verb === 'zone_open' || verb === 'zone_short') {
        if (zone === null) return null;
        const zoneState = ZONE_STATE_BY_CODE[['zone_sealed', 'zone_unsealed', 'zone_open', 'zone_short'].indexOf(verb)];
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

    // System state verbs (phase 2 builds on these; phase 1 decodes + logs only).
    if (verb === 'arm_ready') {
        return { kind: 'arm_ready', network, application, verb };
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
    if (named) {
        return {
            kind: 'panel_trouble', network, application,
            condition: named.condition, active: named.active, verb, detail: null
        };
    }

    const detailCondition = PANEL_TROUBLE_DETAIL_VERBS.get(verb);
    if (detailCondition) {
        const detail = params.length > 0 ? params.join(' ') : null;
        return {
            kind: 'panel_trouble', network, application,
            condition: detailCondition, active: !(detail && detail.endsWith('_cleared')), verb, detail
        };
    }

    return null;
}

module.exports = {
    appId, decodeLine, ZONE_STATE, ZONE_STATE_BY_CODE, ARM_MODE_BY_CODE,
    PANEL_TROUBLE_CONDITIONS, PANEL_TROUBLE_VERBS, PANEL_TROUBLE_DETAIL_VERBS
};
