'use strict';

const {
    resolveSetting,
    resolveClampedSetting,
    SETTINGS_SCHEMA
} = require('../../src/config/schema');

describe('resolveSetting', () => {
    it('returns the schema default when the key is undefined', () => {
        expect(resolveSetting({}, 'web_port')).toBe(SETTINGS_SCHEMA.web_port.default);
        expect(resolveSetting(undefined, 'connectionTimeout')).toBe(5000);
        expect(resolveSetting(null, 'mqttReconnectPeriodMs')).toBe(5000);
    });

    it('preserves 0 as a configured value', () => {
        expect(resolveSetting({ connectionTimeout: 0 }, 'connectionTimeout')).toBe(0);
        expect(resolveSetting({ eventPublishDedupWindowMs: 0 }, 'eventPublishDedupWindowMs')).toBe(0);
        expect(resolveSetting({ initDebounceMs: 0 }, 'initDebounceMs')).toBe(0);
    });

    it('preserves false as a configured value', () => {
        expect(resolveSetting({ retainreads: false }, 'retainreads')).toBe(false);
        expect(resolveSetting({ logging: false }, 'logging')).toBe(false);
        expect(resolveSetting({ ha_discovery_enabled: false }, 'ha_discovery_enabled')).toBe(false);
    });

    it('preserves empty string as a configured value', () => {
        expect(resolveSetting({ mqtt: '' }, 'mqtt')).toBe('');
        expect(resolveSetting({ web_bind_host: '' }, 'web_bind_host')).toBe('');
    });

    it('returns null for nullable entries when null is configured', () => {
        expect(resolveSetting({ getallperiod: null }, 'getallperiod')).toBeNull();
        expect(resolveSetting({ cbus_label_file: null }, 'cbus_label_file')).toBeNull();
        expect(resolveSetting({ web_api_key: null }, 'web_api_key')).toBeNull();
    });

    it('falls back to default when null is set on a non-nullable entry', () => {
        expect(resolveSetting({ web_port: null }, 'web_port')).toBe(8080);
        expect(resolveSetting({ connectionPoolSize: null }, 'connectionPoolSize')).toBe(3);
    });

    it('throws on an unknown key (programmer error)', () => {
        expect(() => resolveSetting({}, 'notARealSetting')).toThrow(/Unknown setting key/);
        expect(() => resolveSetting({}, 'auto_discover_networks')).toThrow(/Unknown setting key/);
    });

    it('returns configured values as-is when present', () => {
        expect(resolveSetting({ web_port: 9090 }, 'web_port')).toBe(9090);
        expect(resolveSetting({ ha_discovery_prefix: 'hass' }, 'ha_discovery_prefix')).toBe('hass');
    });
});

describe('resolveClampedSetting', () => {
    it('applies Math.max(min, resolved) after reading the schema default', () => {
        expect(resolveClampedSetting({}, 'connectionTimeout', { min: 1000 })).toBe(5000);
        expect(resolveClampedSetting({ connectionTimeout: 500 }, 'connectionTimeout', { min: 1000 })).toBe(1000);
        expect(resolveClampedSetting({ connectionTimeout: 0 }, 'connectionTimeout', { min: 1000 })).toBe(1000);
        expect(resolveClampedSetting({ connectionPoolSize: 0 }, 'connectionPoolSize', { min: 1 })).toBe(1);
        // Interval floors used by stale-device / diagnostics: 0 clamps to min, not the schema default
        expect(resolveClampedSetting({ stale_device_check_interval_sec: 0 }, 'stale_device_check_interval_sec', { min: 60 })).toBe(60);
        expect(resolveClampedSetting({ ha_bridge_diagnostics_interval_sec: 0 }, 'ha_bridge_diagnostics_interval_sec', { min: 10 })).toBe(10);
    });

    it('returns the resolved value when no min is given', () => {
        expect(resolveClampedSetting({ connectionTimeout: 0 }, 'connectionTimeout')).toBe(0);
    });

    it('falls back to the schema default when the configured value is not finite', () => {
        expect(resolveClampedSetting(
            { ha_bridge_diagnostics_interval_sec: 'sixty' },
            'ha_bridge_diagnostics_interval_sec',
            { min: 10 }
        )).toBe(60);
        expect(resolveClampedSetting({ connectionTimeout: Number.NaN }, 'connectionTimeout', { min: 1000 })).toBe(5000);
        expect(resolveClampedSetting({ connectionTimeout: Infinity }, 'connectionTimeout', { min: 1000 })).toBe(5000);
    });
});
