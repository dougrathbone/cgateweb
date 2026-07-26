// @ts-check
const { categoriseUnitType } = require('./unitTypeClassifier');

function findNetworkData(networkId, treeData) {
    if (!treeData) return null;
    const idStr = String(networkId);

    const viaInterface = treeData.Network && treeData.Network.Interface && treeData.Network.Interface.Network;
    if (viaInterface && String(viaInterface.NetworkNumber) === idStr) return viaInterface;

    if (treeData.Network && String(treeData.Network.NetworkNumber) === idStr) return treeData.Network;

    if (String(treeData.NetworkNumber) === idStr) return treeData;

    if (treeData.Network && treeData.Network.Unit) return treeData.Network;

    for (const key of Object.keys(treeData)) {
        const child = treeData[key];
        if (child && typeof child === 'object') {
            if (String(child.NetworkNumber) === idStr) return child;
            if (child.Network && String(child.Network.NetworkNumber) === idStr) return child.Network;
            if (child.Interface && child.Interface.Network && String(child.Interface.Network.NetworkNumber) === idStr) {
                return child.Interface.Network;
            }
            if (child.Unit) return child;
        }
    }

    return null;
}

// C-Bus application 255 (0xFF) is the Network Management application that every
// unit participates in. During startup sync C-Gate returns the network
// containing only its interface/management unit (e.g. PC_CNIED at address 4,
// Application "255, 255", empty Groups) before the load units have synced their
// group data. A tree that carries only management data is "still syncing", not a
// genuine zero-device network — accepting it as success publishes 0 entities and
// stops retrying, so real devices never appear (issue #17).
const CBUS_NETWORK_MANAGEMENT_APP = '255';

// True if a single Unit carries at least one group address on a non-management
// application. A unit that advertises a real application (e.g. 56) but has no
// groups yet is NOT enough: at startup C-Gate reports load units in state=new
// with empty <Groups> before their group bindings sync, and accepting that made
// discovery complete with 0 entities and stop retrying before the groups
// arrived (issue #16). Groups on the management application (255) are network
// variables, not addressable devices, so they never count (subsumes issue #17).
// Handles both TREEXML shapes (structured Application objects and the flat
// "56, 255" / Groups "10,11" form).
function unitHasDeviceData(unit) {
    if (!unit) return false;

    if (unit.Application && typeof unit.Application === 'object') {
        const apps = Array.isArray(unit.Application) ? unit.Application : [unit.Application];
        return apps.some(app => {
            if (!app || !app.Group) return false;
            const appId = app.ApplicationAddress !== null && app.ApplicationAddress !== undefined
                ? String(app.ApplicationAddress)
                : undefined;
            // Require a resolvable application id before counting it: a Group with
            // no ApplicationAddress is incomplete data, and collectUnitGroups skips
            // it (no appId to map groups to), so it must not mark the tree synced.
            return Boolean(appId) && appId !== CBUS_NETWORK_MANAGEMENT_APP;
        });
    }

    const appIds = (unit.Application !== null && unit.Application !== undefined)
        ? String(unit.Application).split(',').map(s => s.trim()).filter(Boolean)
        : [];
    const hasRealApp = appIds.some(a => a !== CBUS_NETWORK_MANAGEMENT_APP);
    const groupIds = (unit.Groups && typeof unit.Groups === 'string')
        ? unit.Groups.split(',').map(s => s.trim()).filter(Boolean)
        : [];
    return hasRealApp && groupIds.length > 0;
}

// True if the network has finished syncing enough to carry at least one
// addressable device, i.e. some unit has group addresses on a non-management
// application. A tree with only management units, or load units whose groups
// have not synced yet, is treated as "still syncing" so discovery keeps
// retrying rather than completing with zero entities (issues #16 and #17).
function networkHasDeviceData(networkData) {
    if (!networkData) return false;
    let units = networkData.Unit || [];
    if (!Array.isArray(units)) units = [units];
    return units.some(unitHasDeviceData);
}

// True if a single Unit advertises a non-management application but carries NO
// group addresses at all. During startup sync C-Gate reports load units with
// empty <Groups> before their group bindings arrive; such a unit will gain
// groups once the sync completes (issue #25). Units on the management
// application only (255, 255) legitimately have no groups and are excluded, as
// are units with no application data at all (nothing to judge). Handles both
// TREEXML shapes (structured Application objects and the flat "56, 255" /
// Groups "10,11" form).
function unitHasUnsyncedGroups(unit) {
    if (!unit) return false;

    if (unit.Application && typeof unit.Application === 'object') {
        const apps = Array.isArray(unit.Application) ? unit.Application : [unit.Application];
        const isRealApp = (app) => {
            if (!app || app.ApplicationAddress === null || app.ApplicationAddress === undefined) return false;
            return String(app.ApplicationAddress) !== CBUS_NETWORK_MANAGEMENT_APP;
        };
        if (!apps.some(isRealApp)) return false;
        // Unsynced: no real application carries any group entries yet. Groups
        // on the management application (network variables) don't count.
        return !apps.some(app => isRealApp(app) && app.Group);
    }

    const appIds = (unit.Application !== null && unit.Application !== undefined)
        ? String(unit.Application).split(',').map(s => s.trim()).filter(Boolean)
        : [];
    const hasRealApp = appIds.some(a => a !== CBUS_NETWORK_MANAGEMENT_APP);
    if (!hasRealApp) return false;
    const groupIds = (unit.Groups && typeof unit.Groups === 'string')
        ? unit.Groups.split(',').map(s => s.trim()).filter(Boolean)
        : [];
    return groupIds.length === 0;
}

// True if any unit in the network looks like it has not finished syncing its
// group bindings yet. A tree can pass networkHasDeviceData (some units already
// have groups) while other units are still empty — accepting it as final would
// leave those groups undiscovered until a manual gettree (issue #25).
function networkHasUnsyncedUnits(networkData) {
    if (!networkData) return false;
    let units = networkData.Unit || [];
    if (!Array.isArray(units)) units = [units];
    return units.some(unitHasUnsyncedGroups);
}

// Short "address TYPE" labels for the units unitHasUnsyncedGroups flags in a
// tree, e.g. ["14 RELAY2", "20 SENTEMP"]. Used in re-fetch diagnostics so
// field reports can see which units are being waited on / treated as
// unassigned without raw-tree archaeology (issue #25 follow-up).
function unsyncedUnitSummaries(networkData) {
    if (!networkData) return [];
    let units = networkData.Unit || [];
    if (!Array.isArray(units)) units = [units];
    const summaries = [];
    units.forEach(unit => {
        if (!unitHasUnsyncedGroups(unit)) return;
        const rawAddress = (unit.UnitAddress !== null && unit.UnitAddress !== undefined)
            ? unit.UnitAddress
            : unit.Address;
        const address = (rawAddress !== null && rawAddress !== undefined) ? String(rawAddress).trim() : '?';
        const type = (unit.Type !== null && unit.Type !== undefined) ? String(unit.Type).trim() : '?';
        summaries.push(`${address} ${type}`);
    });
    return summaries;
}

// Numeric-aware comparator so a signature does not depend on document order:
// unit and group addresses are numeric strings in practice, but fall back to a
// plain string compare for anything else (including the empty string, which
// Number() would otherwise treat as 0).
function compareTreeIds(a, b) {
    const na = Number(a);
    const nb = Number(b);
    if (a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    if (a === b) return 0;
    return String(a) < String(b) ? -1 : 1;
}

// Group ids advertised on a unit's non-management applications, or null when
// the unit advertises no non-management application at all. Management-only
// units legitimately have no groups and are excluded from the signature, as
// are units with no application data — the same judgement unitHasUnsyncedGroups
// makes. Handles both TREEXML shapes (structured Application objects and the
// flat "56, 255" / Groups "10,11" form).
function nonManagementGroupIds(unit) {
    if (unit.Application && typeof unit.Application === 'object') {
        const apps = Array.isArray(unit.Application) ? unit.Application : [unit.Application];
        let hasRealApp = false;
        const groupIds = new Set();
        apps.forEach(app => {
            if (!app || app.ApplicationAddress === null || app.ApplicationAddress === undefined) return;
            if (String(app.ApplicationAddress) === CBUS_NETWORK_MANAGEMENT_APP) return;
            hasRealApp = true;
            if (!app.Group) return;
            const groups = Array.isArray(app.Group) ? app.Group : [app.Group];
            groups.forEach(g => {
                if (g && g.GroupAddress !== null && g.GroupAddress !== undefined) {
                    groupIds.add(String(g.GroupAddress));
                }
            });
        });
        return hasRealApp ? [...groupIds] : null;
    }

    const appIds = (unit.Application !== null && unit.Application !== undefined)
        ? String(unit.Application).split(',').map(s => s.trim()).filter(Boolean)
        : [];
    if (!appIds.some(a => a !== CBUS_NETWORK_MANAGEMENT_APP)) return null;
    const groupIds = (unit.Groups && typeof unit.Groups === 'string')
        ? unit.Groups.split(',').map(s => s.trim()).filter(Boolean)
        : [];
    return [...new Set(groupIds)];
}

// A stable fingerprint of a network tree's group data: one "address:g1,g2"
// entry per unit that advertises a non-management application, entries sorted
// by unit address and group ids sorted within each entry. Two trees with the
// same signature carry identical group bindings, so a re-fetch (issue #25)
// whose result matches the tree that scheduled it made no progress — the
// group-less units are genuinely unassigned and the re-fetch loop can stop
// early instead of burning its remaining attempts.
function treeGroupSignature(networkData) {
    if (!networkData) return '';
    let units = networkData.Unit || [];
    if (!Array.isArray(units)) units = [units];

    const entries = [];
    units.forEach(unit => {
        if (!unit) return;
        const groupIds = nonManagementGroupIds(unit);
        if (groupIds === null) return;
        const rawAddress = (unit.UnitAddress !== null && unit.UnitAddress !== undefined)
            ? unit.UnitAddress
            : unit.Address;
        const address = (rawAddress !== null && rawAddress !== undefined) ? String(rawAddress) : '';
        entries.push({ address, groups: groupIds.sort(compareTreeIds).join(',') });
    });
    entries.sort((a, b) => compareTreeIds(a.address, b.address));
    return entries.map(e => `${e.address}:${e.groups}`).join('|');
}

function collectUnitGroups(unit, groupsByApp, targetApps) {
    if (!unit.Application) return;

    if (typeof unit.Application === 'object') {
        const apps = Array.isArray(unit.Application) ? unit.Application : [unit.Application];
        apps.forEach(app => {
            const appId = app.ApplicationAddress !== null && app.ApplicationAddress !== undefined
                ? String(app.ApplicationAddress)
                : undefined;
            if (!appId || !targetApps.includes(appId) || !app.Group) return;
            const groups = Array.isArray(app.Group) ? app.Group : [app.Group];
            if (!groupsByApp.has(appId)) groupsByApp.set(appId, new Map());
            const groupMap = groupsByApp.get(appId);
            groups.forEach(g => {
                if (g.GroupAddress !== null && g.GroupAddress !== undefined && !groupMap.has(String(g.GroupAddress))) {
                    groupMap.set(String(g.GroupAddress), g);
                }
            });
        });
        return;
    }

    const unitAppIds = String(unit.Application).split(',').map(s => s.trim()).filter(Boolean);
    const groupIds = (unit.Groups && typeof unit.Groups === 'string')
        ? unit.Groups.split(',').map(s => s.trim()).filter(Boolean)
        : [];
    if (groupIds.length === 0) return;

    const matchingApps = targetApps.filter(t => unitAppIds.includes(t));
    matchingApps.forEach(appId => {
        if (!groupsByApp.has(appId)) groupsByApp.set(appId, new Map());
        const groupMap = groupsByApp.get(appId);
        groupIds.forEach(gid => {
            if (!groupMap.has(gid)) {
                groupMap.set(gid, { GroupAddress: gid });
            }
        });
    });
}

// Which app/group pairs each unit type drives, and which unit types on the
// network the classifier does not recognise. Both are derived from the same
// per-unit Type/Application data, so a single pass over networkData.Unit
// produces both instead of walking the array twice (once per aggregate) on
// every discovery run.
//
// The two aggregates have different scope, though, and must not be conflated:
//   - index is scoped to targetApps, since it exists to classify groups on the
//     apps discovery actually cares about (issues #38, #37). Mirrors
//     collectUnitGroups' handling of both TREEXML shapes, but keeps the unit
//     type that collectUnitGroups discards. Records every type it encounters
//     for a matching group, recognised or not: entityTypeForGroup's asymmetric
//     unknown handling (an unrecognised type blocks only the destructive
//     binary_sensor conclusion) depends on unrecognised types surviving into
//     this index rather than being filtered out here.
//
//     That includes the blank type a unit with an absent or empty <Type> gets.
//     Dropping those used to let a driving unit register its group while
//     contributing nothing to it, so a load sharing a group with a key input
//     looked input-only, was published as a read-only binary_sensor, and had
//     its light config retracted — an unswitchable load. A blank type is
//     precisely "a unit we cannot classify", which is what the unrecognised
//     path is for, so it belongs in the set.
//   - unknownTypes is, by default, restricted to the units that actually fed
//     the index. The log line it drives asks users to report types so they can
//     be classified (issue #37), so a type that could never classify anything —
//     a measurement-only unit, a PC interface, anything bound to no discovered
//     application — is pure noise on every run, gettree refreshes included, and
//     invites issues about irrelevant hardware. opts.scopeUnknownTypesToIndex
//     false restores the whole-network view for the unknownUnitTypes diagnostic
//     helper below.
/**
 * @param {any} networkData
 * @param {string[]} targetApps
 * @param {{ scopeUnknownTypesToIndex?: boolean }} [opts]
 * @returns {{ index: Map<string, { types: Set<string> }>, unknownTypes: string[] }}
 */
function collectUnitTypeData(networkData, targetApps, opts = {}) {
    const scopeUnknownTypesToIndex = opts.scopeUnknownTypesToIndex !== false;
    /** @type {Map<string, { types: Set<string> }>} */
    const index = new Map();
    const unknownTypes = new Set();
    if (!networkData) return { index, unknownTypes: [] };

    let units = networkData.Unit || [];
    if (!Array.isArray(units)) units = [units];

    // Index every (app, group) this unit drives on a target app; true when it
    // drove at least one, i.e. when its type is relevant to classification.
    const indexUnitGroups = (unit, type) => {
        let indexed = false;
        const record = (appId, groupId) => {
            const key = `${appId}/${groupId}`;
            if (!index.has(key)) index.set(key, { types: new Set() });
            // Added even when blank: see the scope note above. A unit that
            // drives the group must contribute to its classification, and "we
            // could not read a type for it" is information, not absence.
            index.get(key).types.add(type);
            indexed = true;
        };

        if (!unit.Application) return false;

        if (typeof unit.Application === 'object') {
            const apps = Array.isArray(unit.Application) ? unit.Application : [unit.Application];
            apps.forEach(app => {
                if (!app || app.ApplicationAddress === null || app.ApplicationAddress === undefined) return;
                const appId = String(app.ApplicationAddress);
                if (!targetApps.includes(appId) || !app.Group) return;
                const groups = Array.isArray(app.Group) ? app.Group : [app.Group];
                groups.forEach(g => {
                    if (g && g.GroupAddress !== null && g.GroupAddress !== undefined) {
                        record(appId, String(g.GroupAddress));
                    }
                });
            });
            return indexed;
        }

        const unitAppIds = String(unit.Application).split(',').map(s => s.trim()).filter(Boolean);
        const groupIds = (unit.Groups && typeof unit.Groups === 'string')
            ? unit.Groups.split(',').map(s => s.trim()).filter(Boolean)
            : [];
        if (groupIds.length === 0) return false;
        targetApps.filter(t => unitAppIds.includes(t)).forEach(appId => {
            groupIds.forEach(gid => record(appId, gid));
        });
        return indexed;
    };

    units.forEach(unit => {
        if (!unit) return;
        const type = (unit.Type !== null && unit.Type !== undefined) ? String(unit.Type).trim() : '';
        const indexed = indexUnitGroups(unit, type);
        if (type && !categoriseUnitType(type) && (indexed || !scopeUnknownTypesToIndex)) {
            unknownTypes.add(type);
        }
    });

    return { index, unknownTypes: [...unknownTypes] };
}

// Thin wrapper kept for existing callers/tests that only need the per-group
// index. Prefer collectUnitTypeData directly when both aggregates are needed
// in the same discovery pass (see src/haDiscovery.js), so the unit array is
// only walked once.
/**
 * @param {any} networkData
 * @param {string[]} targetApps
 * @returns {Map<string, { types: Set<string> }>}
 */
function collectUnitTypesByGroup(networkData, targetApps) {
    return collectUnitTypeData(networkData, targetApps).index;
}

// Whole-network diagnostic view: every unrecognised type anywhere on the
// network, including units bound to no application at all. Discovery
// deliberately does NOT use this (see collectUnitTypeData: the log line it feeds
// is about classifiable hardware only) — it is here for callers that genuinely
// want an inventory of what the classifier does not know.
/**
 * @param {any} networkData
 * @returns {string[]}
 */
function unknownUnitTypes(networkData) {
    return collectUnitTypeData(networkData, [], { scopeUnknownTypesToIndex: false }).unknownTypes;
}

module.exports = {
    findNetworkData,
    collectUnitGroups,
    networkHasDeviceData,
    networkHasUnsyncedUnits,
    unsyncedUnitSummaries,
    treeGroupSignature,
    unitHasDeviceData,
    unitHasUnsyncedGroups,
    collectUnitTypeData,
    collectUnitTypesByGroup,
    unknownUnitTypes
};
