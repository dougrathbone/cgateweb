const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const initSqlJs = require('sql.js');

const {
    fixupProjectSerialInterface
} = require('../homeassistant-addon/rootfs/usr/bin/cgateweb-project-serial-fixup.js');

const SCRIPT = path.join(
    __dirname, '..', 'homeassistant-addon', 'rootfs', 'usr', 'bin', 'cgateweb-project-serial-fixup.js'
);
const FIXTURE_DB = path.join(__dirname, '..', 'test-env', 'volumes', 'share', 'cgate', 'tag', 'HOME.db');

async function readInterface(dbPath) {
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(dbPath));
    const rows = db.exec('SELECT interface_type, interface_address FROM interface')[0].values;
    db.close();
    return rows;
}

describe('cgateweb-project-serial-fixup (issue #28)', () => {
    let tmpDir;
    let dbPath;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serial-fixup-'));
        dbPath = path.join(tmpDir, 'TEST.db');
        fs.copyFileSync(FIXTURE_DB, dbPath);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('rewrites a Windows COMx interface address to the serial port name, keeping type serial', async () => {
        const changes = await fixupProjectSerialInterface(dbPath, '/dev/nonexistent/usb-xyz');
        expect(changes).toEqual(['network 254: serial/COM1 -> serial/usb-xyz']);
        expect(await readInterface(dbPath)).toEqual([['serial', 'usb-xyz']]);
    });

    it('resolves /dev/serial/by-id symlinks to the bare port name (ttyUSB0)', async () => {
        // by-id path → real target; the port name is the target's basename.
        const target = path.join(tmpDir, 'ttyUSB0');
        fs.writeFileSync(target, '');
        const byId = path.join(tmpDir, 'usb-FTDI-test-if00-port0');
        fs.symlinkSync(target, byId);
        const changes = await fixupProjectSerialInterface(dbPath, byId);
        expect(changes).toEqual(['network 254: serial/COM1 -> serial/ttyUSB0']);
        expect(await readInterface(dbPath)).toEqual([['serial', 'ttyUSB0']]);
    });

    it('is idempotent — a second run finds nothing to change', async () => {
        await fixupProjectSerialInterface(dbPath, '/dev/nonexistent/usb-xyz');
        const second = await fixupProjectSerialInterface(dbPath, '/dev/nonexistent/usb-xyz');
        expect(second).toEqual([]);
        expect(await readInterface(dbPath)).toEqual([['serial', 'usb-xyz']]);
    });

    it('leaves Linux-usable interface addresses untouched', async () => {
        const SQL = await initSqlJs();
        const db = new SQL.Database(fs.readFileSync(dbPath));
        db.run("UPDATE interface SET interface_address = '/dev/ttyUSB9' WHERE id = 1");
        fs.writeFileSync(dbPath, Buffer.from(db.export()));
        db.close();

        const changes = await fixupProjectSerialInterface(dbPath, '/dev/nonexistent/usb-xyz');
        expect(changes).toEqual([]);
        expect(await readInterface(dbPath)).toEqual([['serial', '/dev/ttyUSB9']]);
    });

    it('prints a warning and exits 0 on a corrupt db (never breaks startup)', () => {
        fs.writeFileSync(dbPath, 'not a sqlite database');
        const { spawnSync } = require('child_process');
        const result = spawnSync('node', [SCRIPT, dbPath, '/dev/ttyUSB0'], { encoding: 'utf8' });
        expect(result.status).toBe(0);
        expect(result.stderr).toMatch(/project serial fixup failed/);
    });

    it('prints the nothing-to-change message for a COM-free project', () => {
        const out = execFileSync('node', [SCRIPT, dbPath, '/dev/ttyUSB0'], { encoding: 'utf8' });
        expect(out).toMatch(/rewrote project interface network 254: serial\/COM1 -> serial\/ttyUSB0/);
        const out2 = execFileSync('node', [SCRIPT, dbPath, '/dev/ttyUSB0'], { encoding: 'utf8' });
        expect(out2).toMatch(/nothing to change/);
    });
});
