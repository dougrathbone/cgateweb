const HaDiscovery = require('../src/haDiscovery');

describe('HaDiscovery — unlisted live groups (#63)', () => {
    let publishFn;
    let d;

    beforeEach(() => {
        publishFn = jest.fn();
        d = new HaDiscovery(
            {
                ha_discovery_enabled: true,
                ha_discovery_prefix: 'homeassistant',
                ha_discovery_unlisted_groups: true
            },
            publishFn,
            jest.fn()
        );
    });

    it('is off by default', () => {
        const off = new HaDiscovery(
            { ha_discovery_enabled: true, ha_discovery_prefix: 'homeassistant' },
            publishFn,
            jest.fn()
        );
        expect(off.ensureUnlistedGroupDiscovery('254', '56', '251')).toBe(false);
        expect(publishFn).not.toHaveBeenCalled();
    });

    it('publishes a lighting entity the first time an unlisted group is seen', () => {
        expect(d.ensureUnlistedGroupDiscovery('254', '56', '251')).toBe(true);
        const call = publishFn.mock.calls.find(
            (c) => c[0] === 'homeassistant/light/cgateweb_254_56_251/config'
        );
        expect(call).toBeDefined();
        expect(d.ensureUnlistedGroupDiscovery('254', '56', '251')).toBe(false);
    });

    it('honours the exclude list', () => {
        d.exclude.add('254/56/251');
        expect(d.ensureUnlistedGroupDiscovery('254', '56', '251')).toBe(false);
        expect(publishFn.mock.calls.some((c) => c[1])).toBe(false);
    });

    it('skips applications that are not lighting-style', () => {
        expect(d.ensureUnlistedGroupDiscovery('254', '208', '1')).toBe(false);
        expect(publishFn).not.toHaveBeenCalled();
    });

    it('publishes a PIR binary_sensor when that application is configured', () => {
        d.settings.ha_discovery_pir_app_id = '8';
        expect(d.ensureUnlistedGroupDiscovery('254', '8', '12')).toBe(true);
        const call = publishFn.mock.calls.find(
            (c) => c[0] === 'homeassistant/binary_sensor/cgateweb_254_8_12/config'
        );
        expect(call).toBeDefined();
    });

    it('clears the label snapshot after a standalone unlisted publish', () => {
        expect(d.ensureUnlistedGroupDiscovery('254', '56', '251')).toBe(true);
        expect(d._labelSnapshot).toBeNull();
        expect(d._currentRunTopics).toBeNull();
    });

    it('does not wipe an in-progress tree run snapshot or topic set', () => {
        const snapshot = {
            labelMap: d.labelMap,
            typeOverrides: d.typeOverrides,
            entityIds: d.entityIds,
            exclude: d.exclude,
            areas: d.areas
        };
        d._labelSnapshot = snapshot;
        d._unitTypeIndex = new Map();
        d._treeIncomplete = true;
        d._currentRunTopics = new Set(['keep-me']);

        expect(d.ensureUnlistedGroupDiscovery('254', '56', '251')).toBe(true);

        expect(d._labelSnapshot).toBe(snapshot);
        expect(d._unitTypeIndex).toBeInstanceOf(Map);
        expect(d._treeIncomplete).toBe(true);
        expect(d._currentRunTopics.has('keep-me')).toBe(true);
        expect(d._currentRunTopics.size).toBeGreaterThan(1);
    });

    it('retracts leftover configs when the option is turned off', () => {
        expect(d.ensureUnlistedGroupDiscovery('254', '56', '251')).toBe(true);
        d.settings.ha_discovery_unlisted_groups = false;
        expect(d.syncUnlistedGroupDiscovery()).toBe(1);
        const retract = publishFn.mock.calls.find(
            (c) => c[0] === 'homeassistant/light/cgateweb_254_56_251/config' && c[1] === ''
        );
        expect(retract).toBeDefined();
        expect(d.ensureUnlistedGroupDiscovery('254', '56', '251')).toBe(false);
    });

    it('retracts an unlisted group that is later excluded', () => {
        expect(d.ensureUnlistedGroupDiscovery('254', '56', '251')).toBe(true);
        d.exclude.add('254/56/251');
        d.updateLabels({
            labels: d.labelMap,
            typeOverrides: d.typeOverrides,
            entityIds: d.entityIds,
            exclude: d.exclude,
            areas: d.areas
        });
        const retract = publishFn.mock.calls.find(
            (c) => c[0] === 'homeassistant/light/cgateweb_254_56_251/config' && c[1] === ''
        );
        expect(retract).toBeDefined();
    });

    it('does not retract a group that later appears in the Toolkit tree', () => {
        expect(d.ensureUnlistedGroupDiscovery('254', '56', '251')).toBe(true);
        d._withDiscoveryRun(() => {
            d._recordingTreeGroups = true;
            d._processOneLightingGroup('254', '56', { GroupAddress: '251' });
        });
        d.settings.ha_discovery_unlisted_groups = false;
        expect(d.syncUnlistedGroupDiscovery()).toBe(0);
        const retracts = publishFn.mock.calls.filter(
            (c) => c[0] === 'homeassistant/light/cgateweb_254_56_251/config' && c[1] === ''
        );
        expect(retracts).toHaveLength(0);
    });

    it('retracts persisted leftovers after a restart with the option off', () => {
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgateweb-unlisted-'));
        const labelFile = path.join(dir, 'labels.json');
        fs.writeFileSync(labelFile, '{}');

        const first = new HaDiscovery(
            {
                ha_discovery_enabled: true,
                ha_discovery_prefix: 'homeassistant',
                ha_discovery_unlisted_groups: true,
                cbus_label_file: labelFile
            },
            publishFn,
            jest.fn()
        );
        expect(first.ensureUnlistedGroupDiscovery('254', '56', '251')).toBe(true);

        const restarted = new HaDiscovery(
            {
                ha_discovery_enabled: true,
                ha_discovery_prefix: 'homeassistant',
                ha_discovery_unlisted_groups: false,
                cbus_label_file: labelFile
            },
            publishFn,
            jest.fn()
        );
        expect(restarted.syncUnlistedGroupDiscovery()).toBe(1);
        const retract = publishFn.mock.calls.find(
            (c) => c[0] === 'homeassistant/light/cgateweb_254_56_251/config' && c[1] === ''
        );
        expect(retract).toBeDefined();
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
