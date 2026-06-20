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

// True if a single Unit advertises any real (non-management) application or
// carries group data. Handles both TREEXML shapes (structured Application
// objects and the flat "56, 255" / Groups "10,11" form).
function unitHasDeviceData(unit) {
    if (!unit) return false;

    if (unit.Application && typeof unit.Application === 'object') {
        const apps = Array.isArray(unit.Application) ? unit.Application : [unit.Application];
        return apps.some(app => {
            if (!app) return false;
            const appId = app.ApplicationAddress !== null && app.ApplicationAddress !== undefined
                ? String(app.ApplicationAddress)
                : undefined;
            if (appId && appId !== CBUS_NETWORK_MANAGEMENT_APP) return true;
            // A management-app entry still counts if it actually carries groups.
            return Boolean(app.Group);
        });
    }

    if (unit.Application !== null && unit.Application !== undefined) {
        const appIds = String(unit.Application).split(',').map(s => s.trim()).filter(Boolean);
        if (appIds.some(a => a !== CBUS_NETWORK_MANAGEMENT_APP)) return true;
    }

    const groupIds = (unit.Groups && typeof unit.Groups === 'string')
        ? unit.Groups.split(',').map(s => s.trim()).filter(Boolean)
        : [];
    return groupIds.length > 0;
}

// True if the network has finished syncing enough to carry at least one
// addressable device (a non-management application or any group). A tree with
// only network-management units is treated as "still syncing" so discovery
// keeps retrying rather than completing with zero entities (issue #17).
function networkHasDeviceData(networkData) {
    if (!networkData) return false;
    let units = networkData.Unit || [];
    if (!Array.isArray(units)) units = [units];
    return units.some(unitHasDeviceData);
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

module.exports = {
    findNetworkData,
    collectUnitGroups,
    networkHasDeviceData,
    unitHasDeviceData
};
