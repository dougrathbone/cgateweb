const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const {
    SETTINGS_SCHEMA,
    INTERNAL_CONFIG_KEYS,
    listSchemaEntries,
    listSettingAliases,
    listKnownConfigKeys,
    resolveSettingKey,
    UNIT_SUFFIX_EXEMPT_KEYS,
    UNIT_KEY_SUFFIXES,
    buildDefaults,
    getSchemaEntry
} = require('../src/config/schema');
const { ADDON_OPTION_MAP } = require('../src/config/addonOptionMap');

const ENTRIES = listSchemaEntries();
const defaultSettingsModule = require('../src/defaultSettings');
const defaultSettingsSnapshot = require('./fixtures/defaultSettings.snapshot.json');

const VALID_TYPES = ['string', 'number', 'boolean', 'array', 'object', 'enum'];
const VALID_UNITS = ['ms', 's', 'hours', 'none'];
const VALID_EXPOSURES = ['both', 'standalone', 'addon'];

describe('settings schema — self lint', () => {
    it('has no duplicate keys', () => {
        const keys = ENTRIES.map((entry) => entry.key);
        const duplicates = keys.filter((key, i) => keys.indexOf(key) !== i);
        expect(duplicates).toEqual([]);
    });

    it('keys every entry under its own setting name', () => {
        // The schema is a map so a setting can be looked up directly; the
        // entry repeats its name in `key`, and a copy-paste that leaves the
        // two disagreeing would publish a setting under the wrong name.
        const mismatched = Object.entries(SETTINGS_SCHEMA)
            .filter(([mapKey, entry]) => mapKey !== entry.key)
            .map(([mapKey, entry]) => `${mapKey} -> ${entry.key}`);
        expect(mismatched).toEqual([]);
    });

    it('gives every entry a key, a type and a default', () => {
        const bad = ENTRIES.filter((entry) => (
            typeof entry.key !== 'string'
            || entry.key === ''
            || !VALID_TYPES.includes(entry.type)
            || !Object.prototype.hasOwnProperty.call(entry, 'default')
        )).map((entry) => entry.key);
        expect(bad).toEqual([]);
    });

    it('gives every entry a unit, an exposure and a description', () => {
        const bad = ENTRIES.filter((entry) => (
            !VALID_UNITS.includes(entry.unit)
            || !VALID_EXPOSURES.includes(entry.exposure)
            || typeof entry.description !== 'string'
            || entry.description.trim() === ''
        )).map((entry) => entry.key);
        expect(bad).toEqual([]);
    });

    it('lists permitted values for every enum, and defaults to one of them', () => {
        const bad = ENTRIES.filter((entry) => entry.type === 'enum' && (
            !Array.isArray(entry.values)
            || entry.values.length === 0
            || !entry.values.includes(entry.default)
        )).map((entry) => entry.key);
        expect(bad).toEqual([]);
    });

    it('declares nullable on every entry whose default is null, and only those', () => {
        const bad = ENTRIES
            .filter((entry) => (entry.default === null) !== (entry.nullable === true))
            .map((entry) => entry.key);
        expect(bad).toEqual([]);
    });

    it('gives every non-default exposure a reason', () => {
        const bad = ENTRIES
            .filter((entry) => entry.exposure !== 'both' && !entry.reason)
            .map((entry) => entry.key);
        // Restricting a setting to one front-end is always a decision; the
        // reason is the only place that decision is recorded.
        expect(bad).toEqual([]);
    });

    it('types every default consistently with its declared type', () => {
        const bad = ENTRIES.filter((entry) => {
            if (entry.default === null) {
                return false; // nullable is checked separately
            }
            switch (entry.type) {
                case 'array':
                    return !Array.isArray(entry.default);
                case 'object':
                    return typeof entry.default !== 'object' || Array.isArray(entry.default);
                case 'enum':
                    return typeof entry.default !== 'string';
                default:
                    return typeof entry.default !== entry.type;
            }
        }).map((entry) => entry.key);
        expect(bad).toEqual([]);
    });
});

describe('settings schema — unit suffix convention', () => {
    const carriesUnitSuffix = (key, unit) => UNIT_KEY_SUFFIXES[unit].some((suffix) => key.endsWith(suffix));

    it('names every timed setting with the suffix its unit implies', () => {
        const violations = ENTRIES
            .filter((entry) => entry.unit !== 'none')
            .filter((entry) => !carriesUnitSuffix(entry.key, entry.unit))
            .map((entry) => entry.key)
            .filter((key) => !UNIT_SUFFIX_EXEMPT_KEYS.includes(key));
        expect(violations).toEqual([]);
    });

    it('keeps the exemption list frozen at the known warts', () => {
        // FROZEN. These names shipped before the suffix convention existed and
        // renaming them would break existing settings.js files and saved add-on
        // options. New settings must carry the suffix instead of being added here.
        expect([...UNIT_SUFFIX_EXEMPT_KEYS]).toEqual([
            'getallperiod',
            'messageinterval',
            'reconnectinitialdelay',
            'reconnectmaxdelay',
            'healthCheckInterval',
            'keepAliveInterval',
            'eventConnectionKeepAliveInterval',
            'connectionTimeout'
        ]);
    });

    it('does not exempt a key that actually satisfies the convention', () => {
        const unnecessary = UNIT_SUFFIX_EXEMPT_KEYS.filter((key) => {
            const entry = getSchemaEntry(key);
            return entry && entry.unit !== 'none' && carriesUnitSuffix(entry.key, entry.unit);
        });
        expect(unnecessary).toEqual([]);
    });

    it('exempts only keys that exist in the schema and carry a real unit', () => {
        const stale = UNIT_SUFFIX_EXEMPT_KEYS.filter((key) => {
            const entry = getSchemaEntry(key);
            return !entry || entry.unit === 'none';
        });
        expect(stale).toEqual([]);
    });
});

describe('settings schema — aliases', () => {
    const ALIASES = listSettingAliases();
    const CANONICAL_KEYS = new Set(ENTRIES.map((entry) => entry.key));

    const addonConfig = YAML.parse(
        fs.readFileSync(path.join(__dirname, '..', 'homeassistant-addon', 'config.yaml'), 'utf8')
    );
    const ADDON_OPTION_NAMES = new Set(Object.keys(addonConfig.schema));

    it('declares aliases as arrays of non-empty strings', () => {
        const bad = ENTRIES
            .filter((entry) => entry.aliases !== undefined)
            .filter((entry) => (
                !Array.isArray(entry.aliases)
                || entry.aliases.length === 0
                || entry.aliases.some((alias) => typeof alias !== 'string' || alias.trim() === '')
            ))
            .map((entry) => entry.key);
        expect(bad).toEqual([]);
    });

    it('never aliases a name that is already a canonical key', () => {
        // An alias that shadowed a real setting would quietly redirect it.
        const shadowing = [...ALIASES.keys()].filter((alias) => CANONICAL_KEYS.has(alias));
        expect(shadowing).toEqual([]);
    });

    it('never gives the same alias to two settings', () => {
        const declared = ENTRIES.flatMap((entry) => entry.aliases || []);
        const duplicates = declared.filter((alias, i) => declared.indexOf(alias) !== i);
        expect(duplicates).toEqual([]);
    });

    it('aliases only names the Home Assistant add-on actually offers', () => {
        // An alias exists so that an add-on option name typed into settings.js
        // resolves; a name that is not an add-on option (a typo in the alias
        // itself, say) would just be dead weight in the vocabulary.
        const notAnAddonOption = [...ALIASES.keys()]
            .filter((alias) => !ADDON_OPTION_NAMES.has(alias));
        expect(notAnAddonOption).toEqual([]);
    });

    it('resolves every alias and every canonical key to the canonical key', () => {
        for (const [alias, canonicalKey] of ALIASES) {
            expect(resolveSettingKey(alias)).toBe(canonicalKey);
        }
        for (const key of CANONICAL_KEYS) {
            expect(resolveSettingKey(key)).toBe(key);
        }
        expect(resolveSettingKey('cbusnmae')).toBeUndefined();
    });

    // THE CRUX. An add-on option may only be aliased when it maps to exactly
    // one runtime key with no transformation. None of these does: aliasing one
    // would accept the name and store a wrong value — seconds where the runtime
    // wants milliseconds, half a broker address — which is worse than the
    // "unknown setting" warning the user gets instead.
    const NOT_ALIASABLE = {
        mqtt_host: 'Composed with mqtt_port into the single mqtt host:port string.',
        mqtt_port: 'Composed with mqtt_host into the single mqtt host:port string.',
        connection_health_check_interval_sec: 'Seconds; healthCheckInterval is milliseconds.',
        connection_keep_alive_interval_sec: 'Seconds, and sets keepAliveInterval AND eventConnectionKeepAliveInterval.',
        cover_ramp_duration_sec: 'Seconds; cover_ramp_duration_ms is milliseconds.',
        cgate_download_sha256: 'Add-on container script only; no runtime setting reads it.',
        cgate_force_reinstall: 'Add-on container script only; no runtime setting reads it.',
        cgate_external_clients: 'Add-on container script only; no runtime setting reads it.'
    };

    it.each(Object.entries(NOT_ALIASABLE))('does not alias %s (%s)', (option) => {
        expect(ALIASES.has(option)).toBe(false);
    });

    it('does not alias getall_app_periods, whose add-on shape differs', () => {
        // Same name on both sides, but the add-on takes [{app_id, period_sec}]
        // and the runtime wants {"56": 3600}. Nothing to alias, and nothing may
        // pretend the two shapes are interchangeable.
        expect(ALIASES.has('getall_app_periods')).toBe(false);
        expect(getSchemaEntry('getall_app_periods').aliases).toBeUndefined();
    });

    // Every add-on option must be one of: a runtime key by the same name, an
    // alias, an internal key, or a conscious exclusion above. A new option that
    // renames a runtime key fails this until someone decides which it is —
    // which is the whole point.
    it('accounts for every add-on option: same name, alias, internal key, or a listed exclusion', () => {
        const canonicalOrInternal = new Set([
            ...CANONICAL_KEYS,
            ...Object.keys(INTERNAL_CONFIG_KEYS)
        ]);
        const unaccounted = [...ADDON_OPTION_NAMES].filter((option) => (
            !canonicalOrInternal.has(option)
            && !ALIASES.has(option)
            && !Object.prototype.hasOwnProperty.call(NOT_ALIASABLE, option)
        ));
        expect(unaccounted).toEqual([]);
    });

    it('excludes nothing that it also aliases', () => {
        const contradictory = Object.keys(NOT_ALIASABLE).filter((option) => ALIASES.has(option));
        expect(contradictory).toEqual([]);
    });

    it('agrees with ADDON_OPTION_MAP on the destination of every mechanical mapping it aliases', () => {
        // Where both describe the same option, they must not disagree about
        // which runtime key it feeds.
        const disagreements = ADDON_OPTION_MAP
            .filter((rule) => ALIASES.has(rule.src))
            .filter((rule) => ALIASES.get(rule.src) !== rule.dst)
            .map((rule) => `${rule.src}: schema says ${ALIASES.get(rule.src)}, map says ${rule.dst}`);
        expect(disagreements).toEqual([]);
    });

    it('aliases no option that ADDON_OPTION_MAP transforms', () => {
        // secToMs is the transforming kind; anything aliased must be a plain
        // copy of the value under a different name.
        const transformed = ADDON_OPTION_MAP
            .filter((rule) => rule.kind === 'secToMs')
            .filter((rule) => ALIASES.has(rule.src))
            .map((rule) => rule.src);
        expect(transformed).toEqual([]);
    });
});

describe('settings schema — the known-key vocabulary', () => {
    it('covers every canonical key, every alias and every internal key', () => {
        const known = listKnownConfigKeys();
        const expected = new Set([
            ...ENTRIES.map((entry) => entry.key),
            ...listSettingAliases().keys(),
            ...Object.keys(INTERNAL_CONFIG_KEYS)
        ]);
        expect([...known].sort()).toEqual([...expected].sort());
    });

    it('describes every internal key, since none of them has a default to explain it', () => {
        const undescribed = Object.entries(INTERNAL_CONFIG_KEYS)
            .filter(([, description]) => typeof description !== 'string' || description.trim() === '')
            .map(([key]) => key);
        expect(undescribed).toEqual([]);
    });

    it('keeps internal keys out of the runtime defaults', () => {
        // An internal key has no default by definition; one leaking into
        // buildDefaults would change the shipped settings object.
        const defaults = buildDefaults();
        const leaked = Object.keys(INTERNAL_CONFIG_KEYS)
            .filter((key) => Object.prototype.hasOwnProperty.call(defaults, key));
        expect(leaked).toEqual([]);
    });

    it('keeps aliases out of the runtime defaults', () => {
        const defaults = buildDefaults();
        const leaked = [...listSettingAliases().keys()]
            .filter((alias) => Object.prototype.hasOwnProperty.call(defaults, alias));
        expect(leaked).toEqual([]);
    });
});

describe('settings schema — coverage of the runtime defaults', () => {
    it('covers exactly the keys in the captured baseline', () => {
        const schemaKeys = ENTRIES.map((entry) => entry.key).sort();
        const snapshotKeys = Object.keys(defaultSettingsSnapshot).sort();

        // Neither side may drift: a setting added to one and forgotten in the
        // other is exactly the failure this test exists to catch.
        expect(schemaKeys).toEqual(snapshotKeys);
    });

    it('builds defaults that match the captured baseline exactly', () => {
        expect(buildDefaults()).toStrictEqual(defaultSettingsSnapshot);
    });

    it('keeps the defaultSettings module export signature', () => {
        expect(Object.keys(defaultSettingsModule)).toEqual(['defaultSettings']);
    });
});
