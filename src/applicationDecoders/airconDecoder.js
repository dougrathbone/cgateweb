// @ts-check
const { DEFAULT_CBUS_APP_AIRCON } = require('../constants');

/**
 * C-Bus Air Conditioning application (172 / $AC) line decoder.
 *
 * Decodes the following verbs from the C-Gate event stream:
 *   - zone_temperature      → { kind:'temperature', …, celsius, unit:'C' }
 *   - set_zone_hvac_mode    → { kind:'mode', …, mode, modeRaw, setpoint, fanSpeed, fanMode }
 *   - set_ward_on           → { kind:'state', …, on:true }
 *   - set_ward_off          → { kind:'state', …, on:false }
 *   - zone_hvac_plant_status → { kind:'action', …, cooling, heating, fan, damper, busy,
 *                               error, expansion, errorCode, errorDescription, action }
 *
 * Temperature encoding: °C = rawTemp / 256 (signed 2's complement, §25.5.1)
 * Setpoint encoding:    °C = rawSetpoint / 256 when the Level-is-Raw flag is
 *                       clear; null when rawSetpoint === 0 or the level is raw
 *
 * Field layouts verified against the official protocol spec
 * ("Air Conditioning Application", CBUS-APP/25 issue 1.12 — docs/Air Conditioning
 * Application.md) and real PICED captures (two thermostats, sourceunit 201/202).
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
 * HVAC error code → description (spec §25.6.5). Codes $0C–$7F are reserved and
 * $80–$FF are developer-specific; both ranges get a generated description.
 */
const HVAC_ERROR_DESCRIPTION_BY_CODE = {
    0x00: 'No error',
    0x01: 'Heater total failure',
    0x02: 'Cooler total failure',
    0x03: 'Fan total failure',
    0x04: 'Temperature sensor failure',
    0x05: 'Heater temporary problem',
    0x06: 'Cooler temporary problem',
    0x07: 'Fan temporary problem',
    0x08: 'Heater service required',
    0x09: 'Cooler service required',
    0x0A: 'Fan service required',
    0x0B: 'Filter replacement required'
};

/**
 * Describe an HVAC error code per spec §25.6.5.
 *
 * @param {number} code - HVAC Error Code (0–255).
 * @returns {string}
 */
function describeHvacError(code) {
    if (Object.prototype.hasOwnProperty.call(HVAC_ERROR_DESCRIPTION_BY_CODE, code)) {
        return HVAC_ERROR_DESCRIPTION_BY_CODE[code];
    }
    const hex = `0x${code.toString(16).toUpperCase().padStart(2, '0')}`;
    return code >= 0x80 ? `Developer-specific (${hex})` : `Reserved (${hex})`;
}

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
 * Spec §25.8.6 message: <Zone Group> <Zone List> <Temperature> <Sensor Status>
 * → params [zoneGroup, zoneList, rawTemp, sensorStatus].
 *
 * <Temperature> is a signed 2's complement 2-byte value in 1/256 °C (§25.5.1 —
 * e.g. -37.9 °C = $DA1A). C-Gate may render the two bytes as a signed or an
 * unsigned 16-bit decimal; treat values > 32767 as wrapped negatives so both
 * forms decode correctly.
 *
 * <Sensor Status> (§25.6.12) is an optional trailing field. When it reaches
 * "Sensor total failure" ($03) the temperature is meaningless per §25.8.6, so
 * celsius is null — the reading is still returned so the status surfaces.
 *
 * @private
 */
function decodeZoneTemperature({ network, application, params, sourceUnit, verb }) {
    // Need at least zoneGroup, zoneList, rawTemp
    if (params.length < 3) return null;

    const zoneGroup = params[0];
    const zones = params[1];
    const raw = parseInt(params[2], 10);

    // Two-byte field: accept the signed (-32768..32767) and unsigned (0..65535)
    // renderings, reject anything outside both.
    if (!Number.isInteger(raw) || raw < -32768 || raw > 65535) return null;
    const signed = raw > 32767 ? raw - 65536 : raw;

    // °C = raw / 256, rounded to 1 decimal place
    const celsius = Math.round(signed / 256 * 10) / 10;

    // <Sensor Status> (spec §25.6.12: 0=ok, 1=relaxed accuracy, 2=out of
    // calibration, 3=total failure) — optional in practice.
    const statusRaw = params.length > 3 ? parseInt(params[3], 10) : NaN;
    const sensorStatus = Number.isInteger(statusRaw) ? statusRaw : null;
    const sensorFailed = sensorStatus !== null && sensorStatus >= 3;

    return { kind: 'temperature', network, application, zoneGroup, zones, sourceUnit, celsius: sensorFailed ? null : celsius, sensorStatus, unit: 'C', verb };
}

/**
 * Decode a set_zone_hvac_mode event.
 * Spec §25.8.10 message: <Zone Group> <Zone List> <HVAC Mode & Flags> <HVAC Type>
 * <Level> <Aux Level>. C-Gate renders that as ten decimal fields, exploding the
 * 1-byte Mode & Flags (§25.6.3) into five: [zoneGroup, zoneList, f0..f7]
 *   f0 = mode code (0=off, 1=heat, 2=cool, 3=auto, 4=fan_only) — ✅ captures + spec
 *   f1 = "Level is Raw" flag (§25.6.3 L bit) — decoded as levelIsRaw. When 1,
 *        f6 carries a raw fraction of plant capacity (§25.5.3), not a
 *        temperature — e.g. the fan_only capture's 32512 ≈ 99.2% fan output.
 *   f2–f4 = setback / guard / aux-level-used flags (always 0/0/1 in captures; not decoded)
 *   f5 = HVAC plant type (§25.6.4 — ✅ captures: 1=furnace, 3=heat pump reverse
 *        cycle, 255=Any match the captured units)
 *   f6 = setpoint raw when f1=0 (°C = f6/256); 0 means no setpoint
 *   f7 = Aux Level (§25.6.11): bits 0–5 fan speed (0-63, 0=default speed), bit 6
 *        fan mode (0=automatic, 1=continuous), bit 7 reserved. Note fan speed can
 *        live in the Raw Level instead under some conditions (§25.12.8 / mimic
 *        notes) — we expose what the Aux Level actually carries, nothing more.
 *
 * Requires params indices 0–8 (zoneGroup, zones, f0–f6) — at least 9 params.
 * f7 (params index 9) is optional: fanSpeed/fanMode are null when absent.
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

    // f1 (params index 3) = "Level is Raw" flag (§25.6.3 L bit).
    const levelIsRaw = parseInt(params[3], 10) === 1;

    // f6 is at params index 8 (zoneGroup + zones + f0..f5 = 8 items before f6).
    // Its meaning follows f1: with Level-is-Raw it is a signed fraction of
    // plant capacity (§25.5.3 — the fan_only broadcast's 32512 ≈ 99.2% fan
    // output), never a temperature, so there is no setpoint to publish.
    // Otherwise it is °C × 256 (§25.5.1); 0 means no setpoint, and a >0 °C /
    // ≤50 °C plausibility window keeps garbage from becoming a bogus target.
    const f6Raw = parseInt(params[8], 10);
    const setpoint = (!levelIsRaw && Number.isInteger(f6Raw) && f6Raw > 0 && f6Raw <= 12800)
        ? Math.round(f6Raw / 256 * 10) / 10
        : null;
    // setpointRaw (f6) and type (f5) are retained verbatim so write-back can echo
    // the thermostat's own ward/zone/type when controlling it (see
    // airconControlRegistry / AIRCON SET_ZONE_HVAC_MODE).
    const setpointRaw = Number.isInteger(f6Raw) ? f6Raw : null;
    const typeParsed = parseInt(params[7], 10); // f5
    const type = Number.isInteger(typeParsed) ? typeParsed : null;

    // f7 (params index 9) = Aux Level per spec §25.6.11. Bits 0–5 are the raw fan
    // speed setting (0 = run at default speed, 1–63 plant-dependant), bit 6 is the
    // fan mode; bit 7 is reserved and tolerated (ignored) if a device sets it.
    const auxLevel = params.length > 9 ? parseInt(params[9], 10) : NaN;
    const fanSpeed = Number.isInteger(auxLevel) ? auxLevel & 0x3F : null;
    const fanMode = Number.isInteger(auxLevel) ? ((auxLevel & 0x40) !== 0 ? 'continuous' : 'automatic') : null;

    return { kind: 'mode', network, application, zoneGroup, zones, sourceUnit, mode, modeRaw, levelIsRaw, setpoint, setpointRaw, type, fanSpeed, fanMode, verb };
}

/**
 * Decode a zone_hvac_plant_status event — the live plant running state.
 * Spec §25.8.4 message: <Zone Group> <Zone List> <HVAC Type> <HVAC Status>
 * <HVAC Error Code> → params [zoneGroup, zoneList, hvacType, status, errorCode].
 * (params[2] was formerly misread as "statusValid"; it is the HVAC Type §25.6.4 —
 * the captures show 3 = heat pump reverse cycle, matching the plant.)
 *
 * Status bits (spec §25.6.6 — ✅ all positions now spec-verified; heating/fan/
 * damper/busy also confirmed against PICED text in the 2026-06-11 captures):
 *   bit0 (1)  = cooling      bit4 (16)  = free (unused)
 *   bit1 (2)  = heating      bit5 (32)  = busy
 *   bit2 (4)  = fan active   bit6 (64)  = error
 *   bit3 (8)  = damper open  bit7 (128) = expansion
 *
 * The error code (params[4]) is decoded per the §25.6.5 table into errorCode +
 * errorDescription. `action` keeps reflecting the running state only — a plant
 * fault does not repurpose it.
 *
 * Derives `action` for Home Assistant's climate hvac_action:
 *   cooling → 'cooling', else heating → 'heating', else fan → 'fan', else 'idle'.
 *
 * @private
 */
function decodeZonePlantStatus({ network, application, params, sourceUnit, verb }) {
    // Need at least zoneGroup, zones, hvacType, status
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
    const error = (bits & 64) !== 0;
    const expansion = (bits & 128) !== 0;

    // <HVAC Error Code> (spec §25.6.5) — the argument after <HVAC Status>.
    // Optional in practice: null when the field is absent or unparseable.
    const errorCodeRaw = params.length > 4 ? parseInt(params[4], 10) : NaN;
    const errorCode = Number.isInteger(errorCodeRaw) ? errorCodeRaw : null;
    const errorDescription = errorCode !== null ? describeHvacError(errorCode) : null;

    const action = cooling ? 'cooling' : heating ? 'heating' : fan ? 'fan' : 'idle';

    return { kind: 'action', network, application, zoneGroup, zones, sourceUnit, cooling, heating, fan, damper, busy, error, expansion, errorCode, errorDescription, action, verb };
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
