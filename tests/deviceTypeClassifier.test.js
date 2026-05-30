const {
    classifyLightingGroup,
    DEFAULT_COVER_KEYWORDS
} = require('../src/deviceTypeClassifier');

describe('classifyLightingGroup', () => {
    const on = { ha_discovery_auto_type: true };

    it('returns "cover" for blind/shutter labels (incl. plurals)', () => {
        expect(classifyLightingGroup('Master Bedroom Blind', on)).toBe('cover');
        expect(classifyLightingGroup('Living Blinds', on)).toBe('cover');
        expect(classifyLightingGroup('Patio Shutter', on)).toBe('cover');
        expect(classifyLightingGroup('Kitchen Curtains', on)).toBe('cover');
        expect(classifyLightingGroup('Front Awning', on)).toBe('cover');
        expect(classifyLightingGroup('Roller Door', on)).toBe('cover');
        expect(classifyLightingGroup('Garage Door', on)).toBe('cover');
    });

    it('returns null for ordinary light labels', () => {
        expect(classifyLightingGroup('Kitchen Downlights', on)).toBeNull();
        expect(classifyLightingGroup('Hallway', on)).toBeNull();
        expect(classifyLightingGroup('Bedroom Lamp', on)).toBeNull();
    });

    it('returns null for empty/invalid labels', () => {
        expect(classifyLightingGroup('', on)).toBeNull();
        expect(classifyLightingGroup('   ', on)).toBeNull();
        expect(classifyLightingGroup(undefined, on)).toBeNull();
        expect(classifyLightingGroup(null, on)).toBeNull();
    });

    it('is disabled when auto_type is false', () => {
        expect(classifyLightingGroup('Master Blind', { ha_discovery_auto_type: false })).toBeNull();
    });

    it('is disabled when name heuristics are turned off', () => {
        expect(classifyLightingGroup('Master Blind', {
            ha_discovery_auto_type: true,
            ha_discovery_auto_type_name_heuristics: false
        })).toBeNull();
    });

    it('defaults to enabled when auto_type key is absent', () => {
        expect(classifyLightingGroup('Master Blind', {})).toBe('cover');
    });

    it('honours a custom keyword list', () => {
        const s = { ha_discovery_auto_type: true, ha_discovery_auto_type_cover_keywords: ['persiana'] };
        expect(classifyLightingGroup('Persiana Salon', s)).toBe('cover');
        expect(classifyLightingGroup('Bedroom Blind', s)).toBeNull();
    });

    it('exports the default keyword list', () => {
        expect(DEFAULT_COVER_KEYWORDS).toEqual(
            expect.arrayContaining(['blind', 'shutter', 'curtain', 'awning', 'roller', 'garage door', 'shade'])
        );
    });
});
