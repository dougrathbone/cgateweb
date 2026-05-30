// Conservative keyword list for detecting motorised cover devices (blinds,
// shutters, curtains, etc.) that are wired onto the C-Bus Lighting application
// (56). The C-Gate tree cannot tell a shutter relay from a lighting relay, so
// the group's name is the only automatic signal. Leading word-boundary match
// (no trailing boundary) so plurals like "blinds"/"shutters" are caught.
const DEFAULT_COVER_KEYWORDS = [
    'blind', 'shutter', 'shade', 'awning', 'curtain', 'roller', 'garage door'
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
 * @param {object} settings - Bridge settings.
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
        if (re.test(label)) return 'cover';
    }
    return null;
}

module.exports = { classifyLightingGroup, DEFAULT_COVER_KEYWORDS };
