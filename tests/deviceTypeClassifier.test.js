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

    it('keeps a light when a cover keyword co-occurs with a light word', () => {
        // Regression: "Garage Door Lamps" was being classified as a cover.
        expect(classifyLightingGroup('Garage Door Lamps', on)).toBeNull();
        expect(classifyLightingGroup('Garage Door Light', on)).toBeNull();
        expect(classifyLightingGroup('Awning Spotlight', on)).toBeNull();
        // …but a real cover with no light word is still a cover.
        expect(classifyLightingGroup('Garage Door', on)).toBe('cover');
        expect(classifyLightingGroup('Patio Blind', on)).toBe('cover');
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

describe('typeFromLabelPrefix (issue #35)', () => {
    const { typeFromLabelPrefix, LABEL_PREFIX_TYPES } = require('../src/deviceTypeClassifier');
    const on = { ha_discovery_type_from_label_prefix: true };

    it('maps entity-id domain prefixes to discovery types', () => {
        expect(typeFromLabelPrefix('light.bedroom_downlights', on)).toBe('light');
        expect(typeFromLabelPrefix('cover.bedroom_shutter', on)).toBe('cover');
        expect(typeFromLabelPrefix('switch.porch_light', on)).toBe('switch');
        expect(typeFromLabelPrefix('relay.pool_pump', on)).toBe('relay');
        expect(typeFromLabelPrefix('pir.hallway_sensor', on)).toBe('pir');
    });

    it('returns null when the setting is off or absent', () => {
        expect(typeFromLabelPrefix('cover.bedroom_shutter', { ha_discovery_type_from_label_prefix: false })).toBeNull();
        expect(typeFromLabelPrefix('cover.bedroom_shutter', {})).toBeNull();
        expect(typeFromLabelPrefix('cover.bedroom_shutter')).toBeNull();
    });

    it('ignores unsupported prefixes (e.g. lock.) and non-prefix labels', () => {
        expect(typeFromLabelPrefix('lock.front_door', on)).toBeNull();
        expect(typeFromLabelPrefix('fan.bedroom_fan', on)).toBeNull();
        expect(typeFromLabelPrefix('Master Bedroom Blind', on)).toBeNull();
        expect(typeFromLabelPrefix('lightbedroom', on)).toBeNull();
    });

    it('requires a lowercase domain (entity-id style) at the very start', () => {
        expect(typeFromLabelPrefix('Cover.bedroom_shutter', on)).toBeNull();
        expect(typeFromLabelPrefix(' cover.bedroom_shutter', on)).toBeNull();
        expect(typeFromLabelPrefix('x cover.bedroom_shutter', on)).toBeNull();
    });

    it('returns null for empty/invalid labels', () => {
        expect(typeFromLabelPrefix('', on)).toBeNull();
        expect(typeFromLabelPrefix(undefined, on)).toBeNull();
        expect(typeFromLabelPrefix(null, on)).toBeNull();
    });

    it('exposes exactly the supported prefix map', () => {
        expect(LABEL_PREFIX_TYPES).toEqual({ light: 'light', cover: 'cover', switch: 'switch', relay: 'relay', pir: 'pir' });
    });
});
