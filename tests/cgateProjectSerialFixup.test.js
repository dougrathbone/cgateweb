const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const initSqlJs = require('sql.js');

const {
    fixupProjectSerialInterface
} = require('../homeassistant-addon/rootfs/usr/bin/cgateweb-project-serial-fixup.js');
const { addonBin } = require('./helpers/addonPaths');

const SCRIPT = addonBin('cgateweb-project-serial-fixup.js');
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

    // Compile the sql.js WASM module once, up front. Instantiating it costs
    // seconds on a loaded CI runner with coverage instrumentation, and without
    // this the whole cost landed on whichever test ran first, flaking it
    // against the default 5s per-test timeout while every later test reused
    // the cached module and passed.
    beforeAll(async () => {
        await initSqlJs();
    }, 60000);

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

    describe('repointStaleSerial (in-flight recovery, issue #28)', () => {
        // Recovery after a replug has to fix a project that already names a
        // *Linux* port — the old ttyUSBn — which the default COMx-only rule
        // deliberately leaves alone. Without this the restart reopens the
        // network on the port that just disappeared.
        it('repoints a stale serial port name at the resolved device', async () => {
            const SQL = await initSqlJs();
            const db = new SQL.Database(fs.readFileSync(dbPath));
            db.run("UPDATE interface SET interface_type = 'serial', interface_address = 'ttyUSB0' WHERE id = 1");
            fs.writeFileSync(dbPath, Buffer.from(db.export()));
            db.close();

            const changes = await fixupProjectSerialInterface(dbPath, '/dev/ttyUSB1', { repointStaleSerial: true });
            expect(changes).toEqual(['network 254: serial/ttyUSB0 -> serial/ttyUSB1']);
            expect(await readInterface(dbPath)).toEqual([['serial', 'ttyUSB1']]);
        });

        it('repoints a stale /dev/ path too', async () => {
            const SQL = await initSqlJs();
            const db = new SQL.Database(fs.readFileSync(dbPath));
            db.run("UPDATE interface SET interface_type = 'serial', interface_address = '/dev/ttyUSB9' WHERE id = 1");
            fs.writeFileSync(dbPath, Buffer.from(db.export()));
            db.close();

            const changes = await fixupProjectSerialInterface(dbPath, '/dev/ttyUSB1', { repointStaleSerial: true });
            expect(changes).toEqual(['network 254: serial//dev/ttyUSB9 -> serial/ttyUSB1']);
            expect(await readInterface(dbPath)).toEqual([['serial', 'ttyUSB1']]);
        });

        it('leaves a CNI/IP interface alone even when repointing', async () => {
            // A project can mix a serial PCI on one network with a CNI on
            // another; repointing an IP interface at a serial port would take
            // a working network down.
            const SQL = await initSqlJs();
            const db = new SQL.Database(fs.readFileSync(dbPath));
            db.run("UPDATE interface SET interface_type = 'ip', interface_address = '192.168.0.2:10001' WHERE id = 1");
            fs.writeFileSync(dbPath, Buffer.from(db.export()));
            db.close();

            const changes = await fixupProjectSerialInterface(dbPath, '/dev/ttyUSB1', { repointStaleSerial: true });
            expect(changes).toEqual([]);
            expect(await readInterface(dbPath)).toEqual([['ip', '192.168.0.2:10001']]);
        });

        it('leaves a host:port address alone even on a row labelled serial', async () => {
            // The other half of the CNI guard: the row type says serial but the
            // address is a network host. Types in a hand-edited or converted
            // project cannot be trusted on their own, and repointing a CNI at a
            // tty takes that network off the air, so the address shape has to
            // agree before anything is rewritten. Without the shape test this
            // row would be rewritten to serial/ttyUSB1.
            const SQL = await initSqlJs();
            const db = new SQL.Database(fs.readFileSync(dbPath));
            db.run("UPDATE interface SET interface_type = 'serial', interface_address = '192.168.0.2:10001' WHERE id = 1");
            fs.writeFileSync(dbPath, Buffer.from(db.export()));
            db.close();

            const changes = await fixupProjectSerialInterface(dbPath, '/dev/ttyUSB1', { repointStaleSerial: true });
            expect(changes).toEqual([]);
            expect(await readInterface(dbPath)).toEqual([['serial', '192.168.0.2:10001']]);
        });

        it('leaves a hostname address alone even on a row labelled serial', async () => {
            const SQL = await initSqlJs();
            const db = new SQL.Database(fs.readFileSync(dbPath));
            db.run("UPDATE interface SET interface_type = 'serial', interface_address = 'cni.local:10001' WHERE id = 1");
            fs.writeFileSync(dbPath, Buffer.from(db.export()));
            db.close();

            const changes = await fixupProjectSerialInterface(dbPath, '/dev/ttyUSB1', { repointStaleSerial: true });
            expect(changes).toEqual([]);
            expect(await readInterface(dbPath)).toEqual([['serial', 'cni.local:10001']]);
        });

        it('is idempotent when the project already names the resolved port', async () => {
            const SQL = await initSqlJs();
            const db = new SQL.Database(fs.readFileSync(dbPath));
            db.run("UPDATE interface SET interface_type = 'serial', interface_address = 'ttyUSB1' WHERE id = 1");
            fs.writeFileSync(dbPath, Buffer.from(db.export()));
            db.close();

            const changes = await fixupProjectSerialInterface(dbPath, '/dev/ttyUSB1', { repointStaleSerial: true });
            expect(changes).toEqual([]);
        });

        it('leaves a stale serial port name alone without the flag (cont-init behaviour)', async () => {
            const SQL = await initSqlJs();
            const db = new SQL.Database(fs.readFileSync(dbPath));
            db.run("UPDATE interface SET interface_type = 'serial', interface_address = 'ttyUSB0' WHERE id = 1");
            fs.writeFileSync(dbPath, Buffer.from(db.export()));
            db.close();

            const changes = await fixupProjectSerialInterface(dbPath, '/dev/ttyUSB1');
            expect(changes).toEqual([]);
            expect(await readInterface(dbPath)).toEqual([['serial', 'ttyUSB0']]);
        });

        it('accepts --repoint-stale-serial on the command line', async () => {
            // A stale *Linux* port, so only the flag can produce a rewrite —
            // a COMx address would be rewritten either way and would not prove
            // the flag was parsed.
            const SQL = await initSqlJs();
            const db = new SQL.Database(fs.readFileSync(dbPath));
            db.run("UPDATE interface SET interface_type = 'serial', interface_address = 'ttyUSB0' WHERE id = 1");
            fs.writeFileSync(dbPath, Buffer.from(db.export()));
            db.close();

            const out = execFileSync('node', [SCRIPT, dbPath, '/dev/ttyUSB1', '--repoint-stale-serial'], { encoding: 'utf8' });
            expect(out).toMatch(/rewrote project interface network 254: serial\/ttyUSB0 -> serial\/ttyUSB1/);
            // Second run: the address is now the resolved port, so nothing changes.
            const out2 = execFileSync('node', [SCRIPT, dbPath, '/dev/ttyUSB1', '--repoint-stale-serial'], { encoding: 'utf8' });
            expect(out2).toMatch(/nothing to change/);
        });
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
