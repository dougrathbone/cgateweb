// @ts-check

/**
 * The security zone label-key convention, in one place. Zone labels live
 * under application 1 in the Toolkit project, so the label file keys them
 * `{net}/1/{zone}` while zone events, topics and entities are keyed on the
 * security application (208). Consumers on both sides of that mapping use
 * these helpers instead of re-implementing it.
 */

const MIN_ZONE = 1;
const MAX_ZONE = 127; // zone numbers are $01-$7F (spec §5.5.1.11)

/**
 * Build the label-map key for a security zone: `{network}/1/{zone}`.
 *
 * @param {string|number} network - C-Bus network id.
 * @param {string|number} zone - Security zone number.
 * @returns {string}
 */
function securityZoneLabelKey(network, zone) {
    return `${network}/1/${zone}`;
}

/**
 * Parse a security zone label key back into its parts. Returns null for keys
 * that don't match the convention — wrong shape, non-numeric segments, or an
 * out-of-range zone number (valid: 1-127) — so callers can skip malformed
 * label entries instead of announcing bogus entities for them.
 *
 * @param {string} key - Candidate label key, e.g. '254/1/35'.
 * @returns {{ network: string, zone: string }|null}
 */
function parseSecurityZoneLabelKey(key) {
    const match = /^(\d+)\/1\/(\d+)$/.exec(key);
    if (!match) return null;
    const zoneNum = parseInt(match[2], 10);
    if (zoneNum < MIN_ZONE || zoneNum > MAX_ZONE) return null;
    return { network: match[1], zone: match[2] };
}

module.exports = { securityZoneLabelKey, parseSecurityZoneLabelKey };
