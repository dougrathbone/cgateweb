// @ts-check
// Conservative keyword list for detecting motorised cover devices (blinds,
// shutters, curtains, etc.) that are wired onto the C-Bus Lighting application
// (56). The C-Gate tree cannot tell a shutter relay from a lighting relay, so
// the group's name is the only automatic signal. Leading word-boundary match
// (no trailing boundary) so plurals like "blinds"/"shutters" are caught.
const DEFAULT_COVER_KEYWORDS = [
    'blind', 'shutter', 'shade', 'awning', 'curtain', 'roller', 'garage door'
];

// If a cover keyword matches but the label ALSO clearly names a light
// (e.g. "Garage Door Lamps"), keep it a light. Stops a substring like
// "garage door" from turning a light group into a cover.
const LIGHT_HINT_KEYWORDS = [
    'lamp', 'light', 'downlight', 'globe', 'spotlight', 'sconce', 'pendant', 'chandelier'
];

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Decide an effective HA discovery type for a Lighting-application group from
 * its resolved label. Returns 'cover' on a keyword match, otherwise null
 * (meaning "leave as the default light").
 *
 * @param {string} label - The resolved group label (custom label or TREEXML label).
 * @param {Object} settings - Bridge settings.
 * @param {boolean} [settings.ha_discovery_auto_type] - Master switch for automatic type classification.
 * @param {boolean} [settings.ha_discovery_auto_type_name_heuristics] - Enable name-keyword heuristics.
 * @param {string[]} [settings.ha_discovery_auto_type_cover_keywords] - Override cover keyword list.
 * @returns {'cover'|null}
 */
function classifyLightingGroup(label, settings = {}) {
    if (settings.ha_discovery_auto_type === false) return null;
    if (settings.ha_discovery_auto_type_name_heuristics === false) return null;
    if (typeof label !== 'string' || !label.trim()) return null;

    const keywords = (Array.isArray(settings.ha_discovery_auto_type_cover_keywords)
        && settings.ha_discovery_auto_type_cover_keywords.length)
        ? settings.ha_discovery_auto_type_cover_keywords
        : DEFAULT_COVER_KEYWORDS;

    for (const kw of keywords) {
        if (typeof kw !== 'string' || !kw.trim()) continue;
        const re = new RegExp(`\\b${escapeRegExp(kw.trim())}`, 'i');
        if (re.test(label)) {
            // A cover keyword matched — but if the label also names a light,
            // it's a light (e.g. "Garage Door Lamps", "Awning Light").
            if (LIGHT_HINT_KEYWORDS.some(lw => new RegExp(`\\b${lw}`, 'i').test(label))) {
                return null;
            }
            return 'cover';
        }
    }
    return null;
}

// Domain prefixes accepted by the label-prefix rule, aligned with the manual
// type_overrides vocabulary. Lowercase only: a prefix is an entity-id domain,
// which HA itself writes in lowercase.
const LABEL_PREFIX_TYPES = { light: 'light', cover: 'cover', switch: 'switch', relay: 'relay', pir: 'pir' };

/**
 * Resolve a discovery type from an entity-id-style label prefix
 * (e.g. "cover.bedroom_shutter" → 'cover'). For users who name C-Bus groups
 * with their intended Home Assistant entity id (issue #35). Opt-in via
 * settings.ha_discovery_type_from_label_prefix; a manual type_overrides entry
 * still wins (the caller checks it first). Unknown prefixes (e.g. "lock.")
 * return null — only types cgateweb can actually publish are mapped.
 *
 * @param {string} label - The resolved group label (custom label or TREEXML label).
 * @param {Object} settings - Bridge settings.
 * @param {boolean} [settings.ha_discovery_type_from_label_prefix] - Enable the prefix rule.
 * @returns {'light'|'cover'|'switch'|'relay'|'pir'|null}
 */
function typeFromLabelPrefix(label, settings = {}) {
    if (settings.ha_discovery_type_from_label_prefix !== true) return null;
    if (typeof label !== 'string') return null;
    const match = label.match(/^([a-z]+)\./);
    if (!match) return null;
    return Object.prototype.hasOwnProperty.call(LABEL_PREFIX_TYPES, match[1])
        ? LABEL_PREFIX_TYPES[match[1]]
        : null;
}

// Keyword → HA binary_sensor device_class for Security application (208)
// zones, inferred from the zone's label (issue #42: "PIR"/"motion" → motion,
// "Garage Door" → garage_door, etc.). Ordered: the first match wins, so
// "garage" precedes "door" and "Garage Door" becomes garage_door, not door.
const DEFAULT_SECURITY_ZONE_DEVICE_CLASS_KEYWORDS = [
    ['pir', 'motion'],
    ['motion', 'motion'],
    ['garage', 'garage_door'],
    ['door', 'door'],
    ['window', 'window'],
    ['smoke', 'smoke']
];

/**
 * Infer a Home Assistant binary_sensor device_class for a security zone from
 * its label. Returns null (no device_class) when nothing matches — a generic
 * binary_sensor is the right default for names like Toolkit's "Group1".
 *
 * @param {string} label - The zone label (custom label from the app-1 import).
 * @param {Object} settings - Bridge settings.
 * @param {Object<string, string>} [settings.ha_discovery_security_device_class_keywords] -
 *   Override keyword → device_class map (replaces the default when non-empty).
 * @returns {string|null} HA device_class (e.g. 'motion', 'door') or null.
 */
function classifySecurityZoneDeviceClass(label, settings = {}) {
    if (typeof label !== 'string' || !label.trim()) return null;

    const overrides = settings.ha_discovery_security_device_class_keywords;
    const entries = (overrides && typeof overrides === 'object' && Object.keys(overrides).length > 0)
        ? Object.entries(overrides)
        : DEFAULT_SECURITY_ZONE_DEVICE_CLASS_KEYWORDS;

    for (const [kw, deviceClass] of entries) {
        if (typeof kw !== 'string' || !kw.trim()) continue;
        if (typeof deviceClass !== 'string' || !deviceClass.trim()) continue;
        const re = new RegExp(`\\b${escapeRegExp(kw.trim())}`, 'i');
        if (re.test(label)) {
            return deviceClass;
        }
    }
    return null;
}

module.exports = {
    classifyLightingGroup,
    typeFromLabelPrefix,
    classifySecurityZoneDeviceClass,
    LABEL_PREFIX_TYPES,
    DEFAULT_COVER_KEYWORDS,
    DEFAULT_SECURITY_ZONE_DEVICE_CLASS_KEYWORDS
};