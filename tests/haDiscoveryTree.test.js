const { findNetworkData, collectUnitGroups, networkHasDeviceData, networkHasUnsyncedUnits, unsyncedUnitSummaries, treeGroupSignature, unitHasDeviceData, unitHasUnsyncedGroups } = require('../src/haDiscoveryTree');

describe('findNetworkData', () => {
    it('should return null when treeData is null', () => {
        expect(findNetworkData('254', null)).toBeNull();
    });

    it('should return null when treeData is undefined', () => {
        expect(findNetworkData('254', undefined)).toBeNull();
    });

    it('should find network via Interface.Network path', () => {
        const treeData = {
            Network: {
                Interface: {
                    Network: { NetworkNumber: '254', Unit: [] }
                }
            }
        };
        const result = findNetworkData('254', treeData);
        expect(result).toBe(treeData.Network.Interface.Network);
    });

    it('should find network via direct Network.NetworkNumber path', () => {
        const treeData = {
            Network: { NetworkNumber: '254', Unit: [] }
        };
        const result = findNetworkData('254', treeData);
        expect(result).toBe(treeData.Network);
    });

    it('should find network when NetworkNumber is on treeData itself', () => {
        const treeData = { NetworkNumber: '254', Unit: [] };
        const result = findNetworkData('254', treeData);
        expect(result).toBe(treeData);
    });

    it('should return Network when it has a Unit property (fallback)', () => {
        const treeData = {
            Network: { Unit: [{ UnitAddress: '1' }] }
        };
        const result = findNetworkData('999', treeData);
        expect(result).toBe(treeData.Network);
    });

    it('should find network by child NetworkNumber in loop', () => {
        const child = { NetworkNumber: '100', Unit: [] };
        const treeData = { someKey: child };
        const result = findNetworkData('100', treeData);
        expect(result).toBe(child);
    });

    it('should find network by child.Network.NetworkNumber in loop', () => {
        const innerNetwork = { NetworkNumber: '200', Unit: [] };
        const child = { Network: innerNetwork };
        const treeData = { someKey: child };
        const result = findNetworkData('200', treeData);
        expect(result).toBe(innerNetwork);
    });

    it('should find network by child.Interface.Network.NetworkNumber in loop', () => {
        const innerNetwork = { NetworkNumber: '300', Unit: [] };
        const child = { Interface: { Network: innerNetwork } };
        const treeData = { someKey: child };
        const result = findNetworkData('300', treeData);
        expect(result).toBe(innerNetwork);
    });

    it('should return child with Unit property in loop when no NetworkNumber matches', () => {
        const child = { Unit: [{ UnitAddress: '5' }] };
        const treeData = { someKey: child };
        const result = findNetworkData('999', treeData);
        expect(result).toBe(child);
    });

    it('should return null when no match found', () => {
        const treeData = { someKey: { foo: 'bar' } };
        const result = findNetworkData('999', treeData);
        expect(result).toBeNull();
    });

    it('should handle numeric networkId matching string NetworkNumber', () => {
        const treeData = { NetworkNumber: '254', Unit: [] };
        const result = findNetworkData(254, treeData);
        expect(result).toBe(treeData);
    });
});

describe('collectUnitGroups', () => {
    it('should do nothing when unit has no Application', () => {
        const groupsByApp = new Map();
        collectUnitGroups({ UnitAddress: '1' }, groupsByApp, ['56']);
        expect(groupsByApp.size).toBe(0);
    });

    it('should collect groups from object Application with matching app', () => {
        const unit = {
            Application: {
                ApplicationAddress: '56',
                Group: [
                    { GroupAddress: '10', Label: 'Light 1' },
                    { GroupAddress: '11', Label: 'Light 2' }
                ]
            }
        };
        const groupsByApp = new Map();
        collectUnitGroups(unit, groupsByApp, ['56']);

        expect(groupsByApp.has('56')).toBe(true);
        const groups = groupsByApp.get('56');
        expect(groups.has('10')).toBe(true);
        expect(groups.has('11')).toBe(true);
    });

    it('should collect groups from array Application with matching app', () => {
        const unit = {
            Application: [
                {
                    ApplicationAddress: '56',
                    Group: { GroupAddress: '5', Label: 'Single Group' }
                },
                {
                    ApplicationAddress: '203',
                    Group: [{ GroupAddress: '20', Label: 'Blind' }]
                }
            ]
        };
        const groupsByApp = new Map();
        collectUnitGroups(unit, groupsByApp, ['56', '203']);

        expect(groupsByApp.has('56')).toBe(true);
        expect(groupsByApp.get('56').has('5')).toBe(true);
        expect(groupsByApp.has('203')).toBe(true);
        expect(groupsByApp.get('203').has('20')).toBe(true);
    });

    it('should skip Application with no matching targetApps', () => {
        const unit = {
            Application: { ApplicationAddress: '99', Group: [{ GroupAddress: '1' }] }
        };
        const groupsByApp = new Map();
        collectUnitGroups(unit, groupsByApp, ['56']);
        expect(groupsByApp.size).toBe(0);
    });

    it('should skip Application entry with no Group', () => {
        const unit = {
            Application: { ApplicationAddress: '56' }
        };
        const groupsByApp = new Map();
        collectUnitGroups(unit, groupsByApp, ['56']);
        expect(groupsByApp.size).toBe(0);
    });

    it('should not overwrite existing group entries', () => {
        const existingGroup = { GroupAddress: '10', Label: 'Original' };
        const groupsByApp = new Map([['56', new Map([['10', existingGroup]])]]);

        const unit = {
            Application: {
                ApplicationAddress: '56',
                Group: [{ GroupAddress: '10', Label: 'New' }, { GroupAddress: '11', Label: 'New2' }]
            }
        };
        collectUnitGroups(unit, groupsByApp, ['56']);

        expect(groupsByApp.get('56').get('10')).toBe(existingGroup);
        expect(groupsByApp.get('56').has('11')).toBe(true);
    });

    it('should handle string Application with matching appId and string Groups', () => {
        const unit = {
            Application: '56',
            Groups: '10, 11, 12'
        };
        const groupsByApp = new Map();
        collectUnitGroups(unit, groupsByApp, ['56']);

        expect(groupsByApp.has('56')).toBe(true);
        const groups = groupsByApp.get('56');
        expect(groups.has('10')).toBe(true);
        expect(groups.has('11')).toBe(true);
        expect(groups.has('12')).toBe(true);
    });

    it('should handle string Application with multiple apps', () => {
        const unit = {
            Application: '56, 203',
            Groups: '5, 6'
        };
        const groupsByApp = new Map();
        collectUnitGroups(unit, groupsByApp, ['56', '203']);

        expect(groupsByApp.has('56')).toBe(true);
        expect(groupsByApp.has('203')).toBe(true);
        expect(groupsByApp.get('56').has('5')).toBe(true);
        expect(groupsByApp.get('203').has('6')).toBe(true);
    });

    it('should skip string Application when Groups is empty', () => {
        const unit = {
            Application: '56',
            Groups: ''
        };
        const groupsByApp = new Map();
        collectUnitGroups(unit, groupsByApp, ['56']);
        expect(groupsByApp.size).toBe(0);
    });

    it('should skip string Application when Groups is missing', () => {
        const unit = { Application: '56' };
        const groupsByApp = new Map();
        collectUnitGroups(unit, groupsByApp, ['56']);
        expect(groupsByApp.size).toBe(0);
    });

    it('should skip string Application when no targetApps match', () => {
        const unit = {
            Application: '99',
            Groups: '1, 2'
        };
        const groupsByApp = new Map();
        collectUnitGroups(unit, groupsByApp, ['56']);
        expect(groupsByApp.size).toBe(0);
    });

    it('should skip Application entries with null ApplicationAddress', () => {
        const unit = {
            Application: { ApplicationAddress: null, Group: [{ GroupAddress: '1' }] }
        };
        const groupsByApp = new Map();
        collectUnitGroups(unit, groupsByApp, ['56']);
        expect(groupsByApp.size).toBe(0);
    });

    it('should skip group entries with null GroupAddress', () => {
        const unit = {
            Application: {
                ApplicationAddress: '56',
                Group: [{ GroupAddress: null }, { GroupAddress: '10' }]
            }
        };
        const groupsByApp = new Map();
        collectUnitGroups(unit, groupsByApp, ['56']);
        const groups = groupsByApp.get('56');
        expect(groups.has('null')).toBe(false);
        expect(groups.has('10')).toBe(true);
    });
});

describe('unitHasDeviceData', () => {
    it('returns false for the network management unit (flat: Application "255, 255", empty Groups)', () => {
        // The PC_CNIED interface unit C-Gate reports mid-sync (issue #17).
        expect(unitHasDeviceData({ Application: '255, 255', Groups: '' })).toBe(false);
    });

    it('returns true for a flat load unit in a real application', () => {
        expect(unitHasDeviceData({ Application: '56, 255', Groups: '10,11' })).toBe(true);
    });

    it('returns false for a flat unit that advertises a real app but has not synced its groups yet (#16)', () => {
        // djagerif: at startup, units advertise app 56 but their <Groups> is
        // still empty (state=new). Treating that as a synced device made
        // discovery complete with 0 entities and stop retrying before the
        // groups arrived. A real app with no groups is still syncing.
        expect(unitHasDeviceData({ Application: '56, 255', Groups: '' })).toBe(false);
    });

    it('returns false for a management-only flat unit even when it carries groups', () => {
        // Groups on the management application (255) are network variables, not
        // addressable devices, so they never yield discoverable entities.
        expect(unitHasDeviceData({ Application: '255', Groups: '200' })).toBe(false);
    });

    it('returns true for a structured unit in a real application', () => {
        expect(unitHasDeviceData({
            Application: { ApplicationAddress: '56', Group: { GroupAddress: '10' } }
        })).toBe(true);
    });

    it('returns false for a structured unit in a real app that carries no groups yet (#16)', () => {
        expect(unitHasDeviceData({ Application: { ApplicationAddress: '56' } })).toBe(false);
    });

    it('returns false for a structured management-only unit with no groups', () => {
        expect(unitHasDeviceData({ Application: { ApplicationAddress: '255' } })).toBe(false);
    });

    it('returns false for a structured app that has groups but no ApplicationAddress', () => {
        // Incomplete unit data: a Group present with no resolvable application id
        // is not an addressable device, and collectUnitGroups skips it (no appId
        // to map the groups to), so it must not mark the tree as synced either.
        expect(unitHasDeviceData({
            Application: { Group: { GroupAddress: '10' } }
        })).toBe(false);
        expect(unitHasDeviceData({
            Application: { ApplicationAddress: null, Group: { GroupAddress: '10' } }
        })).toBe(false);
        expect(unitHasDeviceData({
            Application: { ApplicationAddress: '', Group: { GroupAddress: '10' } }
        })).toBe(false);
    });

    it('returns false for a unit with no application or groups', () => {
        expect(unitHasDeviceData({ UnitAddress: '100' })).toBe(false);
    });

    it('returns false for null/undefined', () => {
        expect(unitHasDeviceData(null)).toBe(false);
        expect(unitHasDeviceData(undefined)).toBe(false);
    });
});

describe('networkHasDeviceData', () => {
    it('returns false when the only unit is the network management interface (issue #17)', () => {
        const network = { Unit: { Application: '255, 255', Groups: '' } };
        expect(networkHasDeviceData(network)).toBe(false);
    });

    it('returns true once a load unit has synced alongside the management unit', () => {
        const network = { Unit: [
            { Application: '255, 255', Groups: '' },
            { Application: '56, 255', Groups: '10' }
        ] };
        expect(networkHasDeviceData(network)).toBe(true);
    });

    it('returns false when units advertise app 56 but none have synced their groups (#16)', () => {
        // The progressive-sync window: real load units are present but their
        // group bindings have not arrived yet. Must keep retrying, not complete.
        const network = { Unit: [
            { Application: '56, 255', Groups: '' },
            { Application: '56, 255', Groups: '' }
        ] };
        expect(networkHasDeviceData(network)).toBe(false);
    });

    it('returns true as soon as any one unit has synced its groups (mixed)', () => {
        const network = { Unit: [
            { Application: '56, 255', Groups: '' },
            { Application: '56, 255', Groups: '42' }
        ] };
        expect(networkHasDeviceData(network)).toBe(true);
    });

    it('returns false for a network element with no units', () => {
        expect(networkHasDeviceData({ NetworkNumber: '254' })).toBe(false);
    });

    it('returns false for null', () => {
        expect(networkHasDeviceData(null)).toBe(false);
    });
});

describe('unitHasUnsyncedGroups', () => {
    it('returns true for a flat unit in a real app with empty Groups (#25)', () => {
        expect(unitHasUnsyncedGroups({ Application: '56, 255', Groups: '' })).toBe(true);
    });

    it('returns true for a flat unit in a real app with no Groups key', () => {
        expect(unitHasUnsyncedGroups({ Application: '56, 255' })).toBe(true);
    });

    it('returns false for a flat unit that has synced its groups', () => {
        expect(unitHasUnsyncedGroups({ Application: '56, 255', Groups: '10,11' })).toBe(false);
    });

    it('returns false for a management-only unit (app 255 legitimately has no groups)', () => {
        expect(unitHasUnsyncedGroups({ Application: '255, 255', Groups: '' })).toBe(false);
    });

    it('returns false for a unit with no application data', () => {
        expect(unitHasUnsyncedGroups({ UnitAddress: '100' })).toBe(false);
    });

    it('returns true for a structured unit whose real app carries no Group entries', () => {
        expect(unitHasUnsyncedGroups({
            Application: { ApplicationAddress: '56' }
        })).toBe(true);
        expect(unitHasUnsyncedGroups({
            Application: [
                { ApplicationAddress: '56' },
                { ApplicationAddress: '255', Group: { GroupAddress: '1' } }
            ]
        })).toBe(true);
    });

    it('returns false for a structured unit whose real app carries a Group', () => {
        expect(unitHasUnsyncedGroups({
            Application: { ApplicationAddress: '56', Group: { GroupAddress: '10' } }
        })).toBe(false);
    });

    it('returns false for a structured management-only unit', () => {
        expect(unitHasUnsyncedGroups({ Application: { ApplicationAddress: '255' } })).toBe(false);
    });

    it('returns false for null/undefined', () => {
        expect(unitHasUnsyncedGroups(null)).toBe(false);
        expect(unitHasUnsyncedGroups(undefined)).toBe(false);
    });
});

describe('networkHasUnsyncedUnits', () => {
    it('returns true when any unit is still missing its group bindings (#25)', () => {
        const network = { Unit: [
            { Application: '56, 255', Groups: '31,32' },
            { Application: '56, 255', Groups: '' }
        ] };
        expect(networkHasUnsyncedUnits(network)).toBe(true);
    });

    it('returns false once every unit with a real app has groups', () => {
        const network = { Unit: [
            { Application: '56, 255', Groups: '31,32' },
            { Application: '56, 255', Groups: '115' },
            { Application: '255, 255', Groups: '' }
        ] };
        expect(networkHasUnsyncedUnits(network)).toBe(false);
    });

    it('returns false for a management-only network (nothing to wait for)', () => {
        const network = { Unit: { Application: '255, 255', Groups: '' } };
        expect(networkHasUnsyncedUnits(network)).toBe(false);
    });

    it('returns false for a network element with no units and for null', () => {
        expect(networkHasUnsyncedUnits({ NetworkNumber: '254' })).toBe(false);
        expect(networkHasUnsyncedUnits(null)).toBe(false);
    });
});

describe('treeGroupSignature', () => {
    it('returns an empty string for null and for a network with no units', () => {
        expect(treeGroupSignature(null)).toBe('');
        expect(treeGroupSignature({ NetworkNumber: '254' })).toBe('');
    });

    it('fingerprints flat-shape units as address:sorted-groups, one entry per non-management unit', () => {
        const network = { Unit: [
            { Address: '13', Application: '56, 255', Groups: '32,31' },
            { Address: '14', Application: '56, 255', Groups: '' }
        ] };
        expect(treeGroupSignature(network)).toBe('13:31,32|14:');
    });

    it('fingerprints structured-shape units, collecting groups across real apps', () => {
        const network = { Unit: [
            { UnitAddress: '100', Application: [
                { ApplicationAddress: '56', Group: [
                    { GroupAddress: '10', Label: 'Kitchen' },
                    { GroupAddress: '9', Label: 'Hall' }
                ] },
                { ApplicationAddress: '57', Group: { GroupAddress: '21' } }
            ] },
            { UnitAddress: '101', Application: { ApplicationAddress: '56' } }
        ] };
        expect(treeGroupSignature(network)).toBe('100:9,10,21|101:');
    });

    it('excludes management-only units and units with no application data', () => {
        const network = { Unit: [
            { Address: '4', Application: '255, 255', Groups: '' },
            { Address: '9' },
            { Address: '13', Application: '56, 255', Groups: '31' }
        ] };
        expect(treeGroupSignature(network)).toBe('13:31');
    });

    it('ignores groups carried on the management application (network variables)', () => {
        const network = { Unit: { UnitAddress: '100', Application: [
            { ApplicationAddress: '56', Group: { GroupAddress: '10' } },
            { ApplicationAddress: '255', Group: { GroupAddress: '200' } }
        ] } };
        expect(treeGroupSignature(network)).toBe('100:10');
    });

    it('is stable across unit and group ordering (both shapes)', () => {
        const flatA = { Unit: [
            { Address: '13', Application: '56, 255', Groups: '31,32' },
            { Address: '14', Application: '56, 255', Groups: '' }
        ] };
        const flatB = { Unit: [
            { Address: '14', Application: '56, 255', Groups: '' },
            { Address: '13', Application: '56, 255', Groups: '32,31' }
        ] };
        expect(treeGroupSignature(flatA)).toBe(treeGroupSignature(flatB));

        const structuredA = { Unit: [
            { UnitAddress: '100', Application: { ApplicationAddress: '56', Group: [
                { GroupAddress: '10' }, { GroupAddress: '9' }
            ] } },
            { UnitAddress: '101', Application: { ApplicationAddress: '56' } }
        ] };
        const structuredB = { Unit: [
            { UnitAddress: '101', Application: { ApplicationAddress: '56' } },
            { UnitAddress: '100', Application: { ApplicationAddress: '56', Group: [
                { GroupAddress: '9' }, { GroupAddress: '10' }
            ] } }
        ] };
        expect(treeGroupSignature(structuredA)).toBe(treeGroupSignature(structuredB));
    });

    it('sorts numerically, not lexically (4 before 13, 9 before 10)', () => {
        const network = { Unit: [
            { Address: '13', Application: '56', Groups: '10,9' },
            { Address: '4', Application: '56', Groups: '2' }
        ] };
        expect(treeGroupSignature(network)).toBe('4:2|13:9,10');
    });

    it('changes when any group binding changes, appears, or disappears', () => {
        const base = { Unit: [
            { Address: '13', Application: '56, 255', Groups: '31,32' },
            { Address: '14', Application: '56, 255', Groups: '' }
        ] };
        const changed = { Unit: [
            { Address: '13', Application: '56, 255', Groups: '31,33' },
            { Address: '14', Application: '56, 255', Groups: '' }
        ] };
        const lateSynced = { Unit: [
            { Address: '13', Application: '56, 255', Groups: '31,32' },
            { Address: '14', Application: '56, 255', Groups: '115' }
        ] };
        const baseSignature = treeGroupSignature(base);
        expect(treeGroupSignature(changed)).not.toBe(baseSignature);
        expect(treeGroupSignature(lateSynced)).not.toBe(baseSignature);
    });

    it('handles a single unit given as an object rather than an array', () => {
        const network = { Unit: { Address: '13', Application: '56, 255', Groups: '31' } };
        expect(treeGroupSignature(network)).toBe('13:31');
    });
});

describe('unsyncedUnitSummaries', () => {
    it('returns "address TYPE" labels for units with unsynced groups (flat shape)', () => {
        const network = { Unit: [
            { Type: 'RELDN12', Address: '13', Application: '56, 255', Groups: '31,32' },
            { Type: 'SENLL', Address: '15', Application: '56, 255', Groups: '' },
            { Type: 'SENTEMP', Address: '20', Application: '56, 255' }
        ] };
        expect(unsyncedUnitSummaries(network)).toEqual(['15 SENLL', '20 SENTEMP']);
    });

    it('excludes management-only units (255, 255) even with no groups', () => {
        const network = { Unit: [
            { Type: 'PCLOCAL4', Address: '0', Application: '255, 255', Groups: '' },
            { Type: 'SENLL', Address: '15', Application: '56, 255', Groups: '' }
        ] };
        expect(unsyncedUnitSummaries(network)).toEqual(['15 SENLL']);
    });

    it('prefers UnitAddress over Address when both exist', () => {
        const network = { Unit: [
            { Type: 'SENLL', UnitAddress: '15', Address: '99', Application: '56, 255', Groups: '' }
        ] };
        expect(unsyncedUnitSummaries(network)).toEqual(['15 SENLL']);
    });

    it('falls back to ? for missing address/type, and handles a single object unit', () => {
        const network = { Unit: { Application: '56, 255', Groups: '' } };
        expect(unsyncedUnitSummaries(network)).toEqual(['? ?']);
    });

    it('returns [] for null/empty input and fully-synced trees', () => {
        expect(unsyncedUnitSummaries(null)).toEqual([]);
        expect(unsyncedUnitSummaries(undefined)).toEqual([]);
        expect(unsyncedUnitSummaries({ Unit: [] })).toEqual([]);
        const synced = { Unit: [{ Type: 'RELDN12', Address: '13', Application: '56, 255', Groups: '31' }] };
        expect(unsyncedUnitSummaries(synced)).toEqual([]);
    });

    it('handles the structured Application shape', () => {
        const network = { Unit: [
            { Type: 'DIMDN8', Address: '1', Application: [{ ApplicationAddress: '56' }] },
            { Type: 'RELDN12', Address: '13', Application: [{ ApplicationAddress: '56', Group: [{ GroupAddress: '31' }] }] }
        ] };
        expect(unsyncedUnitSummaries(network)).toEqual(['1 DIMDN8']);
    });
});
