const { defaultSettings } = require('../src/defaultSettings');

describe('aircon app id default', () => {
    it('defaults cbus_aircon_app_id to null (disabled)', () => {
        expect(defaultSettings.cbus_aircon_app_id).toBeNull();
    });
});

describe('security app id default', () => {
    it('defaults cbus_security_app_id to "208" (enabled; 0/empty disables)', () => {
        expect(defaultSettings.cbus_security_app_id).toBe('208');
    });

    it('defaults cbus_security_control_enabled to false (opt-in; bus writes carry no PIN)', () => {
        expect(defaultSettings.cbus_security_control_enabled).toBe(false);
    });
});

describe('raw event capture defaults', () => {
    it('defaults cbusRawEventLogApps to an empty array (capture off)', () => {
        expect(defaultSettings.cbusRawEventLogApps).toEqual([]);
    });
});

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
