#!/usr/bin/env node
// @ts-check
/**
 * ALPHA (issue #28): point a synced Toolkit project's network interface at the
 * configured USB-serial PCI.
 *
 * Toolkit projects saved on Windows reference a COMx port that cannot exist on
 * Linux, so managed C-Gate opens the network with InterfaceState=closed and
 * every TREEXML comes back empty. This rewrites any interface row whose
 * address is a Windows COMx path to the serial device given on the command
 * line, stored as the bare port name C-Gate reports in PORT LIST (e.g.
 * ttyUSB0) — the manual defines serial interface-address "as would be
 * returned by the PORT LIST command". Interfaces with a Linux-usable address
 * (/dev/..., a CNI IP, or the already-correct port) are left untouched.
 *
 * Usage: cgateweb-project-serial-fixup.js <project.db> <serial-device-path>
 * Must never break add-on startup: any failure prints a warning and exits 0.
 */

const fs = require('fs');
const path = require('path');

function loadSqlJs() {
    try {
        return require('sql.js');
    } catch (e) {
        // In the add-on container this script lives in /usr/bin and cannot
        // resolve /app/node_modules by default.
        return require('/app/node_modules/sql.js');
    }
}

function locateSqlJsFile(f) {
    try {
        return require.resolve(`sql.js/dist/${f}`);
    } catch (e) {
        return `/app/node_modules/sql.js/dist/${f}`;
    }
}

/**
 * Rewrite COMx interface addresses in a SQLite Toolkit project db.
 * Exported for tests; returns the list of "network N: old -> new" changes.
 *
 * @param {string} dbPath - Path to the project .db (SQLite).
 * @param {string} devicePath - Serial device path (symlinks resolved to the
 *   bare port name C-Gate lists, e.g. ttyUSB0).
 * @returns {Promise<string[]>}
 */
async function fixupProjectSerialInterface(dbPath, devicePath) {
    // C-Gate matches the project's interface address against the port names it
    // enumerates for PORT LIST (e.g. "ttyUSB0"), not /dev/serial/by-id symlink
    // paths — store the bare name of the resolved target.
    let portName;
    try {
        portName = path.basename(fs.realpathSync(devicePath));
    } catch (e) {
        portName = path.basename(devicePath);
    }

    const initSqlJs = loadSqlJs();
    const SQL = await initSqlJs({ locateFile: locateSqlJsFile });
    const db = new SQL.Database(fs.readFileSync(dbPath));

    const result = db.exec(
        `SELECT interface.id, interface.interface_type, interface.interface_address, network.network_number
         FROM interface JOIN network ON interface.network_id = network.id`
    );
    const rows = result.length ? result[0].values : [];

    const changes = [];
    for (const [id, type, address, networkNumber] of rows) {
        const addr = String(address);
        if (!/^COM\d+$/i.test(addr)) continue; // only Windows paths, unopenable on Linux
        if (String(type).toLowerCase() === 'serial' && addr === portName) continue;
        db.run('UPDATE interface SET interface_type = ?, interface_address = ? WHERE id = ?',
            ['serial', portName, id]);
        changes.push(`network ${networkNumber}: ${type}/${addr} -> serial/${portName}`);
    }

    if (changes.length > 0) {
        fs.writeFileSync(dbPath, Buffer.from(db.export()));
    }
    db.close();
    return changes;
}

async function main() {
    const [dbPath, devicePath] = process.argv.slice(2);
    if (!dbPath || !devicePath) {
        console.error('usage: cgateweb-project-serial-fixup.js <project.db> <serial-device-path>');
        return;
    }
    try {
        const changes = await fixupProjectSerialInterface(dbPath, devicePath);
        if (changes.length === 0) {
            console.log('INFO: no Windows COMx interface addresses found; nothing to change');
        } else {
            for (const change of changes) {
                console.log(`INFO: rewrote project interface ${change}`);
            }
        }
    } catch (e) {
        // Never break add-on startup over a fixup.
        console.error(`WARNING: project serial fixup failed for ${dbPath}: ${e.message}`);
    }
}

if (require.main === module) {
    main();
}

module.exports = { fixupProjectSerialInterface };
