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
//
// 'management' (PC_, PCLOCAL, TEXT) never affects entityTypeForGroup's return
// value below — it exists only so a caller can filter these out of its
// "unrecognised type" logging instead of warning about known-not-output units.
const UNIT_TYPE_PATTERNS = [
    { pattern: /^DIM/i, category: 'dimmer' },
    { pattern: /^REL/i, category: 'relay' },
    // Matches SENTEMP as well as SENLL. That's harmless here: this classifier
    // is only reached for Lighting-application (56) groups, so a temperature
    // sensor's unit type is never seen driving one — temperature/HVAC publish
    // through their own separate paths.
    { pattern: /^SEN/i, category: 'input' },
    { pattern: /^PC_/i, category: 'management' },
    { pattern: /^PCLOCAL/i, category: 'management' },
    { pattern: /^TEXT/i, category: 'management' }
];

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
 * Resolve the entity type for a group from the unit types driving it.
 *
 * Dimmer beats relay, so a group driven by both keeps its brightness slider
 * rather than silently losing it. Both conclusions are drawn even alongside
 * an unrecognised type: a recognised dimmer or relay positively proves an
 * output exists, and the fallback for an unclassified Lighting group is
 * already a dimmable light, so suppressing either conclusion here would gain
 * nothing while gutting the most common real topology — a load unit plus an
 * unrecognised wall-switch or key-input unit bound to the same group.
 *
 * binary_sensor is different: it is destructive downstream (the caller
 * publishes a read-only entity and clears the group's retained light config),
 * so it is only returned when every driving type is recognised. An
 * unrecognised type alongside an input suppresses it, because that
 * unrecognised type might itself be a real output this module doesn't know
 * about yet, and wrongly concluding binary_sensor would strip the group of
 * its command topic. 'management' types (PC_, PCLOCAL, TEXT) are
 * known-not-output, so they never count as unrecognised and never block this
 * conclusion.
 *
 * @param {{ types: Set<string>|string[] }|null} groupInfo
 * @param {Object} settings
 * @param {boolean} [settings.ha_discovery_type_from_unit]
 * @param {boolean} [settings.ha_discovery_auto_type]
 * @returns {'light-dimmable'|'light-onoff'|'binary_sensor'|null}
 */
function entityTypeForGroup(groupInfo, settings = {}) {
    if (settings.ha_discovery_type_from_unit !== true) return null;
    if (settings.ha_discovery_auto_type === false) return null;
    if (!groupInfo || !groupInfo.types) return null;

    let hasDimmer = false;
    let hasRelay = false;
    let hasInput = false;
    let hasUnrecognised = false;

    for (const type of groupInfo.types) {
        const category = categoriseUnitType(type);
        if (category === 'dimmer') hasDimmer = true;
        else if (category === 'relay') hasRelay = true;
        else if (category === 'input') hasInput = true;
        else if (category === null && typeof type === 'string' && type.trim()) hasUnrecognised = true;
    }

    if (hasDimmer) return 'light-dimmable';
    if (hasRelay) return 'light-onoff';
    if (hasInput && !hasUnrecognised) return 'binary_sensor';
    return null;
}

module.exports = { categoriseUnitType, entityTypeForGroup };
