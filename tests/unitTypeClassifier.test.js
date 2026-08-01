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
        ['SENPIRIB', 'input'],
        ['KEYGL5', 'input'],
        ['KEYE1', 'input'],
        ['KEYE4', 'input'],
        ['KEY1', 'input'],
        ['KEYB2', 'input'],
        ['KEYB4', 'input'],
        ['BCN4B', 'input'],
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
        const result = entityTypeForGroup({ types: ['DIMDN8'] }, ON);
        expect(result).toBe('light-dimmable');
    });

    it('makes a relay-driven group an on/off light', () => {
        const result = entityTypeForGroup({ types: ['RELDN12'] }, ON);
        expect(result).toBe('light-onoff');
    });

    it('keeps brightness when a group is driven by both a dimmer and a relay', () => {
        const result = entityTypeForGroup({ types: ['RELDN12', 'DIMDN8'] }, ON);
        expect(result).toBe('light-dimmable');
    });

    it('makes an input-only group a binary sensor', () => {
        const result = entityTypeForGroup({ types: ['SENLL'] }, ON);
        expect(result).toBe('binary_sensor');
    });

    it('keeps a group a light when an input unit also drives a relay, not just by branch order', () => {
        // Uses relay rather than dimmer so this fails if the dimmer branch is
        // ever checked first for the wrong reason, and fails outright if the
        // "output beats input" precedence is removed rather than genuinely
        // implemented via categorisation.
        const result = entityTypeForGroup({ types: ['SENLL', 'RELDN12'] }, ON);
        expect(result).toBe('light-onoff');
    });

    it('has no opinion on a management-only group', () => {
        const result = entityTypeForGroup({ types: ['PC_CNIED'] }, ON);
        expect(result).toBeNull();
    });

    it('has no opinion when every driving unit type is unknown', () => {
        const result = entityTypeForGroup({ types: ['WIDGET9000'] }, ON);
        expect(result).toBeNull();
    });

    it('does not conclude binary_sensor when an unrecognised type accompanies an input (regression: issue Critical 1)', () => {
        // An unrecognised type might be a real output cgateweb doesn't know
        // about yet. Concluding binary_sensor here would strip the group of
        // its command topic if WIDGET9000 turns out to drive a real load.
        const result = entityTypeForGroup({ types: ['WIDGET9000', 'SENLL'] }, ON);
        expect(result).toBeNull();
    });

    it('still concludes a dimmable light alongside an unrecognised type', () => {
        const result = entityTypeForGroup({ types: ['DIMDN8', 'WIDGET9000'] }, ON);
        expect(result).toBe('light-dimmable');
    });

    it('still concludes an on/off light alongside an unrecognised type', () => {
        const result = entityTypeForGroup({ types: ['RELDN12', 'WIDGET9000'] }, ON);
        expect(result).toBe('light-onoff');
    });

    it('does not let a management type block the binary_sensor conclusion', () => {
        const result = entityTypeForGroup({ types: ['PC_CNIED', 'SENLL'] }, ON);
        expect(result).toBe('binary_sensor');
    });

    it('returns null when the setting is off', () => {
        const result = entityTypeForGroup(
            { types: ['RELDN12'] },
            { ha_discovery_type_from_unit: false }
        );
        expect(result).toBeNull();
    });

    it('returns null when the auto-type master switch is off', () => {
        const result = entityTypeForGroup(
            { types: ['RELDN12'] },
            { ha_discovery_type_from_unit: true, ha_discovery_auto_type: false }
        );
        expect(result).toBeNull();
    });

    it('accepts a Set of types as well as an array', () => {
        const result = entityTypeForGroup({ types: new Set(['DIMDN8']) }, ON);
        expect(result).toBe('light-dimmable');
    });

    it('returns null for missing group info', () => {
        expect(entityTypeForGroup(null, ON)).toBeNull();
    });

    it('ignores hasOutput/hasInput fields if present, deriving everything from types', () => {
        // The interface no longer reads these fields at all; a caller that
        // still passes stale or contradictory values must not affect the result.
        const result = entityTypeForGroup(
            { types: ['SENLL'], hasOutput: true, hasInput: false },
            ON
        );
        expect(result).toBe('binary_sensor');
    });
});
