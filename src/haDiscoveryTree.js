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
    collectUnitGroups
};
