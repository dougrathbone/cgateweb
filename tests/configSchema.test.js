const {
    SETTINGS_SCHEMA,
    listSchemaEntries,
    UNIT_SUFFIX_EXEMPT_KEYS,
    UNIT_KEY_SUFFIXES,
    buildDefaults,
    getSchemaEntry
} = require('../src/config/schema');

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
