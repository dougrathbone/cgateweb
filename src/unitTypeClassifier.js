// @ts-check
/**
 * Classify a C-Bus group by the unit that drives it (issues #38, #37).
 *
 * C-Gate's TREEXML reports a <Type> per unit, so a group's entity type can come
 * from the hardware rather than from guessing at its name. A dimmer channel is a
 * dimmable light, a relay channel is an on/off light, and a group driven only by
 * an input unit (bus coupler, key input, sensor) is a binary sensor.
 *
 * Unknown types return null and fall through to existing behaviour. The catalogue
 * of real type strings is incomplete, so guessing would misclassify hardware
 * nobody here has seen; the caller logs unrecognised types instead.
 */

// Prefixes matched case-insensitively against the unit's TREEXML <Type>.
// Confirmed real values: DIMDN8, RELDN12, RELAY2, PCLOCAL4, SENLL, SENTEMP,
// PC_CNIED, TEXT.
const UNIT_TYPE_PATTERNS = [
    { pattern: /^DIM/i, category: 'dimmer' },
    { pattern: /^REL/i, category: 'relay' },
    { pattern: /^SEN/i, category: 'input' },
    { pattern: /^PC_/i, category: 'management' },
    { pattern: /^PCLOCAL/i, category: 'management' },
    { pattern: /^TEXT/i, category: 'management' }
];

const UNKNOWN_TYPE_MARKER = 'unknown';

/**
 * @param {string} [type] - Raw TREEXML unit type string.
 * @returns {'dimmer'|'relay'|'input'|'management'|null}
 */
function categoriseUnitType(type) {
    if (typeof type !== 'string') return null;
    const trimmed = type.trim();
    if (!trimmed) return null;

    for (const { pattern, category } of UNIT_TYPE_PATTERNS) {
        if (pattern.test(trimmed)) return /** @type {any} */ (category);
    }
    return null;
}

/**
 * Resolve the entity type for a group from the units driving it.
 *
 * Output beats input, so a coupler that also switches a real load stays a light.
 * Dimmer beats relay, so a group on both keeps its brightness slider rather
 * than silently losing it.
 *
 * @param {{ types: Set<string>|string[], hasOutput: boolean, hasInput: boolean }|null} groupInfo
 * @param {Object} settings
 * @param {boolean} [settings.ha_discovery_type_from_unit]
 * @param {boolean} [settings.ha_discovery_auto_type]
 * @returns {'light-dimmable'|'light-onoff'|'binary_sensor'|null}
 */
function entityTypeForGroup(groupInfo, settings = {}) {
    if (settings.ha_discovery_type_from_unit !== true) return null;
    if (settings.ha_discovery_auto_type === false) return null;
    if (!groupInfo || !groupInfo.types) return null;

    const categories = new Set();
    for (const type of groupInfo.types) {
        const category = categoriseUnitType(type);
        if (category) categories.add(category);
    }

    if (categories.has('dimmer')) return 'light-dimmable';
    if (categories.has('relay')) return 'light-onoff';
    if (categories.has('input') && !groupInfo.hasOutput) return 'binary_sensor';
    return null;
}

module.exports = { categoriseUnitType, entityTypeForGroup, UNIT_TYPE_PATTERNS, UNKNOWN_TYPE_MARKER };
