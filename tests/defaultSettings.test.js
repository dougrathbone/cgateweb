const { defaultSettings } = require('../src/defaultSettings');

describe('defaultSettings — auto device-type detection', () => {
    it('enables auto type detection and name heuristics by default', () => {
        expect(defaultSettings.ha_discovery_auto_type).toBe(true);
        expect(defaultSettings.ha_discovery_auto_type_name_heuristics).toBe(true);
    });

    it('ships a non-empty default cover keyword list', () => {
        expect(Array.isArray(defaultSettings.ha_discovery_auto_type_cover_keywords)).toBe(true);
        expect(defaultSettings.ha_discovery_auto_type_cover_keywords).toContain('blind');
    });
});
