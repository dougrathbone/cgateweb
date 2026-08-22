const { defaultSettings } = require('../src/defaultSettings');
const defaultSettingsSnapshot = require('./fixtures/defaultSettings.snapshot.json');

describe('defaultSettings — frozen baseline', () => {
    // The exported defaults are derived from src/config/schema.js. This is the
    // backstop for that derivation: the snapshot fixture was captured from the
    // hand-written object and is ground truth. If this fails, the schema is
    // wrong — never "fix" the fixture. A changed default silently reconfigures
    // every install that did not set the key.
    it('deep-equals the captured baseline exactly (same keys, values and types)', () => {
        expect(defaultSettings).toStrictEqual(defaultSettingsSnapshot);
    });

    it('exports the same 135 keys as the baseline', () => {
        expect(Object.keys(defaultSettings).sort())
            .toEqual(Object.keys(defaultSettingsSnapshot).sort());
        // Bumping this count is only ever legitimate alongside a genuinely NEW
        // setting added to the fixture; a changed value for an existing key is
        // the thing this baseline exists to catch, and must never be "fixed"
        // in the fixture.
        expect(Object.keys(defaultSettings)).toHaveLength(135);
    });

    it('returns a fresh object so consumers cannot mutate the schema defaults', () => {
        const { buildDefaults } = require('../src/config/schema');
        const first = buildDefaults();
        first.cbusRawEventLogApps.push('172');
        expect(buildDefaults().cbusRawEventLogApps).toEqual([]);
    });
});

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

    it('defaults cbus_security_disarm_enabled to false (second opt-in; the PIN crosses MQTT)', () => {
        expect(defaultSettings.cbus_security_disarm_enabled).toBe(false);
    });
});

describe('measurement app id default', () => {
    it('defaults cbus_measurement_app_id to null (disabled)', () => {
        expect(defaultSettings.cbus_measurement_app_id).toBeNull();
    });
});

describe('clock default', () => {
    it('defaults cbus_clock_enabled to false (opt-in; the app-223 line format is under-evidenced)', () => {
        expect(defaultSettings.cbus_clock_enabled).toBe(false);
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
