const { categoriseUnitType, entityTypeForGroup } = require('../src/unitTypeClassifier');

const ON = { ha_discovery_type_from_unit: true };

describe('categoriseUnitType', () => {
    it.each([
        ['DIMDN8', 'dimmer'],
        ['DIMMER4', 'dimmer'],
        ['RELDN12', 'relay'],
        ['RELAY2', 'relay'],
        ['SENLL', 'input'],
        ['SENTEMP', 'input'],
        ['PC_CNIED', 'management'],
        ['PCLOCAL4', 'management'],
        ['TEXT', 'management']
    ])('categorises %s as %s', (type, expected) => {
        expect(categoriseUnitType(type)).toBe(expected);
    });

    it('is case-insensitive', () => {
        expect(categoriseUnitType('dimdn8')).toBe('dimmer');
    });

    it('returns null for an unknown type rather than guessing', () => {
        expect(categoriseUnitType('WIDGET9000')).toBeNull();
    });

    it('returns null for missing or blank input', () => {
        expect(categoriseUnitType(undefined)).toBeNull();
        expect(categoriseUnitType('')).toBeNull();
        expect(categoriseUnitType('   ')).toBeNull();
    });
});

describe('entityTypeForGroup', () => {
    it('makes a dimmer-driven group a dimmable light', () => {
        const result = entityTypeForGroup(
            { types: ['DIMDN8'], hasOutput: true, hasInput: false }, ON
        );
        expect(result).toBe('light-dimmable');
    });

    it('makes a relay-driven group an on/off light', () => {
        const result = entityTypeForGroup(
            { types: ['RELDN12'], hasOutput: true, hasInput: false }, ON
        );
        expect(result).toBe('light-onoff');
    });

    it('keeps brightness when a group is driven by both a dimmer and a relay', () => {
        const result = entityTypeForGroup(
            { types: ['RELDN12', 'DIMDN8'], hasOutput: true, hasInput: false }, ON
        );
        expect(result).toBe('light-dimmable');
    });

    it('makes an input-only group a binary sensor', () => {
        const result = entityTypeForGroup(
            { types: ['SENLL'], hasOutput: false, hasInput: true }, ON
        );
        expect(result).toBe('binary_sensor');
    });

    it('keeps a group a light when an input unit also drives an output', () => {
        const result = entityTypeForGroup(
            { types: ['SENLL', 'DIMDN8'], hasOutput: true, hasInput: true }, ON
        );
        expect(result).toBe('light-dimmable');
    });

    it('has no opinion on a management-only group', () => {
        const result = entityTypeForGroup(
            { types: ['PC_CNIED'], hasOutput: false, hasInput: false }, ON
        );
        expect(result).toBeNull();
    });

    it('has no opinion when every driving unit type is unknown', () => {
        const result = entityTypeForGroup(
            { types: ['WIDGET9000'], hasOutput: false, hasInput: false }, ON
        );
        expect(result).toBeNull();
    });

    it('returns null when the setting is off', () => {
        const result = entityTypeForGroup(
            { types: ['RELDN12'], hasOutput: true, hasInput: false },
            { ha_discovery_type_from_unit: false }
        );
        expect(result).toBeNull();
    });

    it('returns null when the auto-type master switch is off', () => {
        const result = entityTypeForGroup(
            { types: ['RELDN12'], hasOutput: true, hasInput: false },
            { ha_discovery_type_from_unit: true, ha_discovery_auto_type: false }
        );
        expect(result).toBeNull();
    });

    it('accepts a Set of types as well as an array', () => {
        const result = entityTypeForGroup(
            { types: new Set(['DIMDN8']), hasOutput: true, hasInput: false }, ON
        );
        expect(result).toBe('light-dimmable');
    });

    it('returns null for missing group info', () => {
        expect(entityTypeForGroup(null, ON)).toBeNull();
    });
});
