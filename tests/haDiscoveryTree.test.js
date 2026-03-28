const { findNetworkData, collectUnitGroups } = require('../src/haDiscoveryTree');

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
