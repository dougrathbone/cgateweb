const { DEFAULT_CBUS_APP_AIRCON } = require('../constants');

/**
 * C-Bus Air Conditioning application (172 / $AC) line decoder.
 *
 * Decodes the following verbs from the C-Gate event stream:
 *   - zone_temperature      → { kind:'temperature', …, celsius, unit:'C' }
 *   - set_zone_hvac_mode    → { kind:'mode', …, mode, modeRaw, setpoint }
 *   - set_ward_on           → { kind:'state', …, on:true }
 *   - set_ward_off          → { kind:'state', …, on:false }
 *   - zone_hvac_plant_status → { kind:'action', …, cooling, heating, fan, damper, busy, action }
 *
 * Temperature encoding: °C = rawTemp / 256
 * Setpoint encoding:    °C = rawSetpoint / 256 (null when rawSetpoint === 0)
 *
 * Verified from real PICED captures (two thermostats, sourceunit 201/202).
 * Other verbs return null.
 */

const appId = DEFAULT_CBUS_APP_AIRCON;

/**
 * HVAC mode map: C-Bus integer code → HA climate mode string.
 * All codes verified against real PICED captures (2026-06-11, units 201/202
 * cycled through every mode): 0=off, 1=heat, 2=cool, 3=auto, 4=fan_only.
 * PICED labels code 3 "Heat/Cool (Auto)"; we publish HA mode "auto".
 * Unknown codes → null (caller should warn).
 */
const HVAC_MODE_BY_CODE = { 0: 'off', 1: 'heat', 2: 'cool', 3: 'auto', 4: 'fan_only' };

/**
 * Extract the #sourceunit value from raw trailing metadata, or null if absent.
 * Must be called on the original (pre-strip) text.
 *
 * @param {string} raw - The portion of the line from " #" onward (e.g. " #sourceunit=202 OID=…").
 * @returns {string|null}
 */
function extractSourceUnit(raw) {
    const m = raw.match(/#sourceunit=(\d+)/);
    return m ? m[1] : null;
}

/**
 * Decode a single C-Gate event line from the Air Conditioning application.
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

    // 3. Must start with "aircon " to be relevant
    if (!text.startsWith('aircon ')) return null;

    // 4. Extract sourceUnit from trailing metadata BEFORE stripping it
    const metaIdx = text.indexOf(' #');
    let sourceUnit = null;
    if (metaIdx !== -1) {
        sourceUnit = extractSourceUnit(text.slice(metaIdx));
        text = text.slice(0, metaIdx);
    }

    // 5. Tokenize: aircon <verb> <addr> <params...>
    const tokens = text.trim().split(/\s+/);
    // tokens[0] = 'aircon', tokens[1] = verb, tokens[2] = address, tokens[3..] = params
    if (tokens.length < 3) return null;

    const verb = tokens[1];
    const addr = tokens[2];
    const params = tokens.slice(3);

    // 6. Parse address //PROJECT/<network>/<application>
    //    Split on '/', drop empties, take last two segments.
    const addrParts = addr.split('/').filter(Boolean);
    if (addrParts.length < 2) return null;
    const network = addrParts[addrParts.length - 2];
    const application = addrParts[addrParts.length - 1];
    if (!/^\d+$/.test(network) || !/^\d+$/.test(application)) return null;

    // 7. Dispatch by verb
    if (verb === 'zone_temperature') {
        return decodeZoneTemperature({ network, application, params, sourceUnit, verb });
    }

    if (verb === 'set_zone_hvac_mode') {
        return decodeZoneHvacMode({ network, application, params, sourceUnit, verb });
    }

    if (verb === 'set_ward_on' || verb === 'set_ward_off') {
        return decodeWardState({ network, application, params, sourceUnit, verb });
    }

    if (verb === 'zone_hvac_plant_status') {
        return decodeZonePlantStatus({ network, application, params, sourceUnit, verb });
    }

    return null;
}

/**
 * Decode a zone_temperature event.
 * Params layout: [zoneGroup, zoneList, rawTemp, flag]
 *
 * @private
 */
function decodeZoneTemperature({ network, application, params, sourceUnit, verb }) {
    // Need at least zoneGroup, zoneList, rawTemp
    if (params.length < 3) return null;

    const zoneGroup = params[0];
    const zones = params[1];
    const raw = parseInt(params[2], 10);

    if (!Number.isInteger(raw) || raw < 0) return null;

    // °C = raw / 256, rounded to 1 decimal place
    const celsius = Math.round(raw / 256 * 10) / 10;

    return { kind: 'temperature', network, application, zoneGroup, zones, sourceUnit, celsius, unit: 'C', verb };
}

/**
 * Decode a set_zone_hvac_mode event.
 * Params layout: [zoneGroup, zoneList, f0, f1, f2, f3, f4, f5, f6, f7]
 *   f0 = mode code (0=off, 1=heat, 2=cool, 3=auto, 4=fan_only)
 *   f6 = setpoint raw (°C = f6/256); 0 means no setpoint
 *
 * Requires params indices 0–8 (zoneGroup, zones, f0–f6) — at least 9 params.
 *
 * @private
 */
function decodeZoneHvacMode({ network, application, params, sourceUnit, verb }) {
    // Need indices 0–8: zoneGroup(0), zones(1), f0(2)..f6(8)
    if (params.length < 9) return null;

    const zoneGroup = params[0];
    const zones = params[1];
    const modeRaw = parseInt(params[2], 10); // f0

    if (!Number.isInteger(modeRaw)) return null;

    const mode = Object.prototype.hasOwnProperty.call(HVAC_MODE_BY_CODE, modeRaw)
        ? HVAC_MODE_BY_CODE[modeRaw]
        : null;

    // f6 is at params index 8 (zoneGroup + zones + f0..f5 = 8 items before f6).
    // Setpoint raw is °C × 256. Fan Only mode (and some idle states) send the
    // 0x7F00 (32512) "no setpoint" sentinel — guard with a plausible-range check
    // (>0 °C and ≤ 50 °C) so we never publish a bogus 127 °C target.
    const f6Raw = parseInt(params[8], 10);
    const setpoint = (Number.isInteger(f6Raw) && f6Raw > 0 && f6Raw <= 12800)
        ? Math.round(f6Raw / 256 * 10) / 10
        : null;

    return { kind: 'mode', network, application, zoneGroup, zones, sourceUnit, mode, modeRaw, setpoint, verb };
}

/**
 * Decode a zone_hvac_plant_status event — the live plant running state.
 * Params layout: [zoneGroup, zoneList, statusValid, bitmask, reserved]
 *   bitmask bits: 1=cooling, 2=heating, 4=fan, 8=damper, 32=busy
 *   (heating/fan/damper/busy verified against PICED text in the 2026-06-11
 *    captures; cooling=bit0 is inferred by position — the plant never asserted
 *    cooling in the capture, so that bit is best-effort.)
 *
 * Derives `action` for Home Assistant's climate hvac_action:
 *   cooling → 'cooling', else heating → 'heating', else fan → 'fan', else 'idle'.
 *
 * @private
 */
function decodeZonePlantStatus({ network, application, params, sourceUnit, verb }) {
    // Need at least zoneGroup, zones, statusValid, bitmask
    if (params.length < 4) return null;

    const zoneGroup = params[0];
    const zones = params[1];
    const bits = parseInt(params[3], 10);
    if (!Number.isInteger(bits)) return null;

    const cooling = (bits & 1) !== 0;
    const heating = (bits & 2) !== 0;
    const fan = (bits & 4) !== 0;
    const damper = (bits & 8) !== 0;
    const busy = (bits & 32) !== 0;

    const action = cooling ? 'cooling' : heating ? 'heating' : fan ? 'fan' : 'idle';

    return { kind: 'action', network, application, zoneGroup, zones, sourceUnit, cooling, heating, fan, damper, busy, action, verb };
}

/**
 * Decode a set_ward_on or set_ward_off event.
 * Params layout: [zoneGroup]
 *
 * @private
 */
function decodeWardState({ network, application, params, sourceUnit, verb }) {
    // Need at least zoneGroup
    if (params.length < 1) return null;

    const zoneGroup = params[0];
    const on = verb === 'set_ward_on';

    return { kind: 'state', network, application, zoneGroup, sourceUnit, on, verb };
}

module.exports = { appId, decodeLine };
