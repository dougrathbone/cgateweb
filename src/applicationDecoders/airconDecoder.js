const { DEFAULT_CBUS_APP_AIRCON } = require('../constants');

/**
 * C-Bus Air Conditioning application (172 / $AC) line decoder.
 *
 * Only `zone_temperature` is decoded. The encoding is:
 *   °C = rawTemp / 256   (e.g. 4431 / 256 = 17.3°C, displayed to 1 d.p.)
 *
 * Other verbs (set_zone_hvac_mode, set_ward_off, zone_hvac_plant_status, etc.)
 * return null — their encodings are not yet verified from live samples.
 *
 * Lines may arrive with or without a leading "# " comment marker and with or
 * without trailing "#sourceunit=… OID=…" metadata; both forms are handled.
 */

const appId = DEFAULT_CBUS_APP_AIRCON;

/**
 * Decode a single C-Gate event line from the Air Conditioning application.
 *
 * @param {string} line - Raw line from the C-Gate event stream.
 * @returns {{ kind: string, network: string, application: string,
 *             zoneGroup: string, zones: string, celsius: number,
 *             unit: string, verb: string }|null}
 *   A reading object for `zone_temperature` lines, or null for everything else.
 */
function decodeLine(line) {
    // Guard against null / undefined / non-string input
    if (line == null || typeof line !== 'string') return null;

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

    // 4. Strip trailing metadata: everything from the first " #" onward
    const metaIdx = text.indexOf(' #');
    if (metaIdx !== -1) {
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
        return decodeZoneTemperature({ network, application, params, verb });
    }

    // All other verbs: encodings not yet verified
    return null;
}

/**
 * Decode a zone_temperature event.
 * Params layout: [zoneGroup, zoneList, rawTemp, flag]
 *
 * @private
 */
function decodeZoneTemperature({ network, application, params, verb }) {
    // Need at least zoneGroup, zoneList, rawTemp
    if (params.length < 3) return null;

    const zoneGroup = params[0];
    const zones = params[1];
    const raw = parseInt(params[2], 10);

    if (!Number.isInteger(raw) || raw < 0) return null;

    // °C = raw / 256, rounded to 1 decimal place
    const celsius = Math.round(raw / 256 * 10) / 10;

    return { kind: 'temperature', network, application, zoneGroup, zones, celsius, unit: 'C', verb };
}

module.exports = { appId, decodeLine };
