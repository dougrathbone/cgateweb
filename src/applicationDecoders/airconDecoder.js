// @ts-check
const { DEFAULT_CBUS_APP_AIRCON } = require('../constants');

/**
 * C-Bus Air Conditioning application (172 / $AC) line decoder.
 *
 * Decodes the following verbs from the C-Gate event stream:
 *   - zone_temperature      → { kind:'temperature', …, celsius, unit:'C', sensorStatus }
 *   - set_zone_hvac_mode    → { kind:'mode', …, mode, modeRaw, setpoint, fanSpeed, fanMode }
 *   - set_ward_on           → { kind:'state', …, on:true }
 *   - set_ward_off          → { kind:'state', …, on:false }
 *   - zone_hvac_plant_status → { kind:'action', …, cooling, heating, fan, damper, busy,
 *                               error, expansion, errorCode, errorDescription, action }
 *   - zone_humidity         → { kind:'humidity', …, humidity, unit:'%', sensorStatus }
 *   - set_zone_humidity_mode → { kind:'humidity_mode', …, mode, modeRaw, humiditySetpoint }
 *   - zone_humidity_plant_status → { kind:'humidity_action', …, humidifying,
 *                               dehumidifying, fan, error, errorCode, action }
 *
 * The humidity verbs are spec-derived (§25.8.5/§25.8.7/§25.8.12) from the HVAC
 * layouts and C-Gate's rendering convention — no live captures exist yet, so
 * their textual field order is unverified (marked ⚠️ in the field comments).
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
    return describePlantError(HVAC_ERROR_DESCRIPTION_BY_CODE, code);
}

/**
 * Humidity error code → description (spec §25.6.9). Same code structure as the
 * HVAC table with humidifier-specific meanings.
 */
const HUMIDITY_ERROR_DESCRIPTION_BY_CODE = {
    0x00: 'No error',
    0x01: 'Humidifier total failure',
    0x02: 'Dehumidifier total failure',
    0x03: 'Fan total failure',
    0x04: 'Humidity sensor failure',
    0x05: 'Humidifier temporary problem',
    0x06: 'Dehumidifier temporary problem',
    0x07: 'Fan temporary problem',
    0x08: 'Humidifier service required',
    0x09: 'Dehumidifier service required',
    0x0A: 'Fan service required',
    0x0B: 'Filter replacement required'
};

/**
 * Describe a humidity error code per spec §25.6.9.
 *
 * @param {number} code - Humidity Error Code (0–255).
 * @returns {string}
 */
function describeHumidityError(code) {
    return describePlantError(HUMIDITY_ERROR_DESCRIPTION_BY_CODE, code);
}

/**
 * Shared lookup for the §25.6.5/§25.6.9 error tables: named codes verbatim,
 * $0C–$7F reserved, $80–$FF developer-specific.
 *
 * @private
 */
function describePlantError(table, code) {
    if (Object.prototype.hasOwnProperty.call(table, code)) {
        return table[code];
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

    if (verb === 'zone_humidity') {
        return decodeZoneHumidity({ network, application, params, sourceUnit, verb });
    }

    if (verb === 'set_zone_humidity_mode') {
        return decodeZoneHumidityMode({ network, application, params, sourceUnit, verb });
    }

    if (verb === 'zone_humidity_plant_status') {
        return decodeZoneHumidityPlantStatus({ network, application, params, sourceUnit, verb });
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
 *   f2–f4 = setback / guard / aux-level-used flags (§25.6.3 B/G/A bits) —
 *        decoded as setbackEnabled / guardEnabled / auxLevelUsed so write-back
 *        can echo the thermostat's own configuration instead of clearing it.
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

    // f2–f4 (params indices 4–6) = Setback / Guard / Aux-Level-used enable flags
    // (§25.6.3 B/G/A bits) → booleans, null when unparseable. Learned by the
    // control registry so writes echo the thermostat's own configuration.
    const f2 = parseInt(params[4], 10);
    const f3 = parseInt(params[5], 10);
    const f4 = parseInt(params[6], 10);
    const setbackEnabled = Number.isInteger(f2) ? f2 === 1 : null;
    const guardEnabled = Number.isInteger(f3) ? f3 === 1 : null;
    const auxLevelUsed = Number.isInteger(f4) ? f4 === 1 : null;

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
    // The raw byte is also exposed verbatim so write-back can echo it.
    const auxLevelRaw = params.length > 9 ? parseInt(params[9], 10) : NaN;
    const auxLevel = Number.isInteger(auxLevelRaw) ? auxLevelRaw : null;
    const fanSpeed = auxLevel !== null ? auxLevel & 0x3F : null;
    const fanMode = auxLevel !== null ? ((auxLevel & 0x40) !== 0 ? 'continuous' : 'automatic') : null;

    // For vent/fan operating type (and evaporative plant cooling in manual
    // mode) the fan speed lives in the Raw Level, not the Aux Level (§25.12.8).
    // Normalise it to 0–100% of plant capacity (Raw Level / $7FFF) — the
    // plant's numbered speeds aren't broadcast (§25.12.11 Zone Group Data is
    // manual configuration only), so a percentage is the honest representation.
    const fanSpeedPercent = (levelIsRaw && Number.isInteger(f6Raw) && f6Raw >= 0 && f6Raw <= 32767)
        ? Math.round(f6Raw / 32767 * 100)
        : null;

    // Evaporative plant in (auto) cooling presents a Comfort Level instead of a
    // temperature (§25.12.7): CL = (T − TStart)/TStep + 1, using the spec
    // defaults TStart=16 °C / TStep=0.5 °C — the plant's actual values are
    // Toolkit config, not broadcast. Only meaningful inside the comfort range.
    const comfortLevel = (type === 2 && modeRaw === 2 && !levelIsRaw && setpoint !== null)
        ? Math.max(1, Math.round((setpoint - 16) / 0.5) + 1)
        : null;

    return { kind: 'mode', network, application, zoneGroup, zones, sourceUnit, mode, modeRaw, levelIsRaw, setbackEnabled, guardEnabled, auxLevelUsed, setpoint, setpointRaw, type, auxLevel, fanSpeed, fanMode, fanSpeedPercent, comfortLevel, verb };
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

/**
 * Decode a zone_humidity event — ⚠️ spec-derived (§25.8.7), no live capture yet.
 * Message: <Zone Group> <Zone List> <Humidity> <Sensor Status>
 * → params [zoneGroup, zoneList, rawHumidity, sensorStatus], mirroring
 * zone_temperature's textual layout.
 *
 * <Humidity> is two bytes where 0 = 0% and 65535 = 100% (§25.5.2). At
 * "Sensor total failure" ($03) the value is meaningless (§25.8.7), so
 * humidity is null — the reading is still returned so the status surfaces.
 *
 * @private
 */
function decodeZoneHumidity({ network, application, params, sourceUnit, verb }) {
    if (params.length < 3) return null;

    const zoneGroup = params[0];
    const zones = params[1];
    const raw = parseInt(params[2], 10);

    if (!Number.isInteger(raw) || raw < 0 || raw > 65535) return null;

    // % = raw / 65535 × 100, rounded to 1 decimal place
    const pct = Math.round(raw / 65535 * 1000) / 10;

    const statusRaw = params.length > 3 ? parseInt(params[3], 10) : NaN;
    const sensorStatus = Number.isInteger(statusRaw) ? statusRaw : null;
    const sensorFailed = sensorStatus !== null && sensorStatus >= 3;

    return { kind: 'humidity', network, application, zoneGroup, zones, sourceUnit, humidity: sensorFailed ? null : pct, sensorStatus, unit: '%', verb };
}

/**
 * Humidity mode map (spec §25.6.7): C-Bus code → string. Unlike HVAC modes
 * these have no HA climate equivalent; published as an MQTT-only topic.
 */
const HUMIDITY_MODE_BY_CODE = { 0: 'off', 1: 'humidify', 2: 'dehumidify', 3: 'auto' };

/**
 * Decode a set_zone_humidity_mode event — ⚠️ spec-derived (§25.8.12), no live
 * capture yet. Same argument layout as Set Zone HVAC Mode (§25.8.10) with the
 * Humidity Mode & Flags byte (§25.6.7) exploded: [zoneGroup, zones, f0..f7]
 *   f0 = mode (0=off, 1=humidify only, 2=dehumidify only, 3=humidity control)
 *   f1 = "Level is Raw" flag   f2–f4 = setback/guard/aux-used   f5 = humidity
 *        type (§25.6.8)   f6 = set level (humidity 0–65535 when f1=0)   f7 = aux
 *
 * @private
 */
function decodeZoneHumidityMode({ network, application, params, sourceUnit, verb }) {
    if (params.length < 9) return null;

    const zoneGroup = params[0];
    const zones = params[1];
    const modeRaw = parseInt(params[2], 10);

    if (!Number.isInteger(modeRaw)) return null;

    const mode = Object.prototype.hasOwnProperty.call(HUMIDITY_MODE_BY_CODE, modeRaw)
        ? HUMIDITY_MODE_BY_CODE[modeRaw]
        : null;

    const levelIsRaw = parseInt(params[3], 10) === 1;

    // f6 = set level: 0–65535 maps to 0–100% (§25.5.2) unless the raw-level
    // flag says it is a plant-capacity fraction instead (§25.5.3).
    const f6Raw = parseInt(params[8], 10);
    const humiditySetpoint = (!levelIsRaw && Number.isInteger(f6Raw) && f6Raw > 0 && f6Raw <= 65535)
        ? Math.round(f6Raw / 65535 * 1000) / 10
        : null;

    const typeParsed = parseInt(params[7], 10);
    const type = Number.isInteger(typeParsed) ? typeParsed : null;

    return { kind: 'humidity_mode', network, application, zoneGroup, zones, sourceUnit, mode, modeRaw, levelIsRaw, humiditySetpoint, type, verb };
}

/**
 * Decode a zone_humidity_plant_status event — ⚠️ spec-derived (§25.8.5), no
 * live capture yet. Message: <Zone Group> <Zone List> <Humidity Type>
 * <Humidity Status> <Humidity Error Code> → params [zoneGroup, zoneList,
 * humidityType, status, errorCode], mirroring zone_hvac_plant_status.
 *
 * Status bits (§25.6.10): 0 humidifying, 1 dehumidifying, 2 fan, 3 damper,
 * 5 busy, 6 error, 7 expansion. Error code decoded per §25.6.9.
 *
 * @private
 */
function decodeZoneHumidityPlantStatus({ network, application, params, sourceUnit, verb }) {
    if (params.length < 4) return null;

    const zoneGroup = params[0];
    const zones = params[1];
    const bits = parseInt(params[3], 10);
    if (!Number.isInteger(bits)) return null;

    const humidifying = (bits & 1) !== 0;
    const dehumidifying = (bits & 2) !== 0;
    const fan = (bits & 4) !== 0;
    const damper = (bits & 8) !== 0;
    const busy = (bits & 32) !== 0;
    const error = (bits & 64) !== 0;
    const expansion = (bits & 128) !== 0;

    const errorCodeRaw = params.length > 4 ? parseInt(params[4], 10) : NaN;
    const errorCode = Number.isInteger(errorCodeRaw) ? errorCodeRaw : null;
    const errorDescription = errorCode !== null ? describeHumidityError(errorCode) : null;

    const action = humidifying ? 'humidifying' : dehumidifying ? 'dehumidifying' : fan ? 'fan' : 'idle';

    return { kind: 'humidity_action', network, application, zoneGroup, zones, sourceUnit, humidifying, dehumidifying, fan, damper, busy, error, expansion, errorCode, errorDescription, action, verb };
}

module.exports = { appId, decodeLine };
