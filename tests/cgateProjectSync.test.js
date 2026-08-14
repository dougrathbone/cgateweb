const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { posixBashAvailable } = require('./helpers/posixBash');
const { addonBin, addonLib, addonInit } = require('./helpers/addonPaths');
const { BASHIO_STUB_WITH_LOGS } = require('./helpers/bashioStub');

// These tests source the Linux rootfs shell script via bash; only run where a
// POSIX bash is usable (Linux CI, macOS). Skipped on Windows (see helper).
const describeBash = posixBashAvailable() ? describe : describe.skip;

const SCRIPT = addonInit('cgate-project-sync.sh');

// The shared serial-device helper the script sources (issue #28). Points at
// the repo copy so the test never depends on the add-on's real install path.
const SERIAL_DEVICE_LIB = addonLib('serial-device.sh');

// Same for the shared supervisor-wait helper the script sources before its
// first bashio::config read.
const SUPERVISOR_WAIT_LIB = addonLib('supervisor-wait.sh');

// Stub bashio: config keys come from env vars CGW_TEST_<key>. Warnings are
// echoed so tests can assert on them (info/error stay silent).
const BASHIO_STUB = `
    bashio::log.info()    { :; }
    bashio::log.warning() { printf 'WARNING: %s\\n' "$*"; }
    bashio::log.error()   { :; }
    bashio::log.trace()   { :; }
    bashio::config() {
        local key="$1"
        local default_value="\${2:-null}"
        local var_name="CGW_TEST_\${key}"
        if declare -p "$var_name" &>/dev/null; then
            printf '%s' "\${!var_name}"
        else
            printf '%s' "$default_value"
        fi
    }
`;

function makeTmpDirs({ withShare = true, withData = true } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-project-sync-'));
    const shareTag = path.join(root, 'share', 'cgate', 'tag');
    const dataCgate = path.join(root, 'data', 'cgate');
    if (withShare) fs.mkdirSync(shareTag, { recursive: true });
    if (withData) fs.mkdirSync(dataCgate, { recursive: true });
    // C-Gate loads projects from Projects/<NAME>/<NAME>.db, not tag/<NAME>.db.
    const projectsDir = path.join(dataCgate, 'Projects');
    return { root, shareTag, dataCgate, projectsDir };
}

// Where the sync script must place <NAME>.db so managed C-Gate can load it.
function projectDbPath(projectsDir, name) {
    const base = name.replace(/\.db$/, '');
    return path.join(projectsDir, base, `${base}.db`);
}

function runSync({ shareTag, dataCgate, configObject = {}, env: extraEnv = {}, withLogs = false }) {
    // Root of the tmp tree this test's dirs live under (dataCgate is
    // <root>/data/cgate), used to build a guaranteed-nonexistent default for
    // the /config/share/cgate probe so existing tests never see a false
    // positive from a real /config on the host.
    const tmpRoot = path.dirname(path.dirname(dataCgate));
    const env = {
        ...process.env,
        CGATEWEB_SHARE_TAG_DIR: shareTag,
        CGATEWEB_DATA_CGATE_DIR: dataCgate,
        CGATEWEB_CONFIG_SHARE_CGATE_DIR: path.join(tmpRoot, 'no-such-config-share-cgate'),
        // Pass the script path via the environment rather than interpolating it
        // into the bash -c command text, so the absolute path is never part of
        // the executed command string.
        CGW_SYNC_SCRIPT: SCRIPT,
        // Point the script at the repo copy of the shared serial-device
        // helper it sources, rather than the add-on's real install path.
        CGATEWEB_SERIAL_DEVICE_LIB: SERIAL_DEVICE_LIB,
        // Same for the shared supervisor-wait helper.
        CGATEWEB_SUPERVISOR_WAIT_LIB: SUPERVISOR_WAIT_LIB,
        // Default the resolved-device file to a path inside the test's own
        // tree so a test never reads the host's real /run/cgateweb copy; tests
        // that exercise the resolved path create it explicitly.
        CGATEWEB_SERIAL_DEVICE_FILE: path.join(dataCgate, 'serial-device'),
        ...extraEnv
    };
    for (const [k, v] of Object.entries(configObject)) {
        env[`CGW_TEST_${k}`] = v;
    }
    // Source the script so the stub functions are in scope. The script's
    // top-level `exit 0` will terminate this bash -c subshell, which is fine.
    const script = `
        set -u
        ${withLogs ? BASHIO_STUB_WITH_LOGS : BASHIO_STUB}
        source "$CGW_SYNC_SCRIPT"
    `;
    return execFileSync('bash', ['-c', script], { encoding: 'utf8', env });
}

describeBash('cgate-project-sync.sh', () => {
    let dirs;

    beforeEach(() => {
        dirs = makeTmpDirs();
    });

    afterEach(() => {
        fs.rmSync(dirs.root, { recursive: true, force: true });
    });

    // Issue #58: a user's project sat in the share folder for a fortnight
    // while C-Gate ran a different copy, because the only feedback was
    // "Skipped 1 project(s) - destination newer than share copy" - true, but
    // it reads as routine housekeeping rather than "your file is being
    // ignored". The skip path had no test at all, which is part of why the
    // wording was never questioned.
    describe('when C-Gate\'s copy is newer than the share copy', () => {
        function setUpSkippedProject() {
            const src = path.join(dirs.shareTag, 'JUBILEE.db');
            const dest = projectDbPath(dirs.projectsDir, 'JUBILEE');
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(src, 'share-copy');
            fs.writeFileSync(dest, 'cgate-has-written-to-this');
            // What a running C-Gate does: its own copy ends up newer.
            const older = new Date(Date.now() - 60_000);
            fs.utimesSync(src, older, older);
            return { src, dest };
        }

        test('does not overwrite what C-Gate has written', () => {
            const { dest } = setUpSkippedProject();
            runSync({ ...dirs, configObject: { cgate_mode: 'managed' } });
            expect(fs.readFileSync(dest, 'utf8')).toBe('cgate-has-written-to-this');
        });

        test('names the project it ignored and where the live copy actually is', () => {
            setUpSkippedProject();
            const out = runSync({ ...dirs, configObject: { cgate_mode: 'managed' }, withLogs: true });
            expect(out).toContain('JUBILEE');
            expect(out).toMatch(/NOT synced/);
            // The two facts a user needs: which file is live, and how to win.
            expect(out).toContain(path.join(dirs.projectsDir, '<PROJECT>', '<PROJECT>.db'));
            expect(out).toMatch(/touch/);
        });

        test('stays at INFO, because this is the steady state for a working install', () => {
            setUpSkippedProject();
            const out = runSync({ ...dirs, configObject: { cgate_mode: 'managed' }, withLogs: true });
            // A warning on every boot of every healthy managed install would
            // train people to ignore the one that matters.
            expect(out).not.toMatch(/^WARNING:.*NOT synced/m);
        });

        test('a newer share copy is still synced over the top', () => {
            const { src, dest } = setUpSkippedProject();
            const newer = new Date(Date.now() + 60_000);
            fs.utimesSync(src, newer, newer);
            const out = runSync({ ...dirs, configObject: { cgate_mode: 'managed' }, withLogs: true });
            expect(fs.readFileSync(dest, 'utf8')).toBe('share-copy');
            expect(out).toMatch(/Synced project/);
            expect(out).not.toMatch(/NOT synced/);
        });
    });

    test('skips entirely when cgate_mode is not managed', () => {
        fs.writeFileSync(path.join(dirs.shareTag, 'BURSWOOD.db'), 'fake-db');
        runSync({
            shareTag: dirs.shareTag,
            dataCgate: dirs.dataCgate,
            configObject: { cgate_mode: 'remote' }
        });
        expect(fs.existsSync(projectDbPath(dirs.projectsDir, 'BURSWOOD'))).toBe(false);
    });

    test('copies <NAME>.db into Projects/<NAME>/<NAME>.db when in managed mode', () => {
        fs.writeFileSync(path.join(dirs.shareTag, 'BURSWOOD.db'), 'fake-db-content');
        runSync({
            shareTag: dirs.shareTag,
            dataCgate: dirs.dataCgate,
            configObject: { cgate_mode: 'managed' }
        });
        const dest = projectDbPath(dirs.projectsDir, 'BURSWOOD');
        expect(fs.existsSync(dest)).toBe(true);
        expect(fs.readFileSync(dest, 'utf8')).toBe('fake-db-content');
        // The file must NOT be left in the (wrong) tag dir.
        expect(fs.existsSync(path.join(dirs.dataCgate, 'tag', 'BURSWOOD.db'))).toBe(false);
    });

    test('creates the per-project directory if it does not exist', () => {
        fs.writeFileSync(path.join(dirs.shareTag, 'HOME.db'), 'home-db');
        runSync({
            shareTag: dirs.shareTag,
            dataCgate: dirs.dataCgate,
            configObject: { cgate_mode: 'managed' }
        });
        expect(fs.existsSync(path.join(dirs.projectsDir, 'HOME'))).toBe(true);
        expect(fs.readFileSync(projectDbPath(dirs.projectsDir, 'HOME'), 'utf8')).toBe('home-db');
    });

    test('skips files that are not .db', () => {
        fs.writeFileSync(path.join(dirs.shareTag, 'README.txt'), 'readme');
        fs.writeFileSync(path.join(dirs.shareTag, 'PROJECT.xml'), '<x/>');
        runSync({
            shareTag: dirs.shareTag,
            dataCgate: dirs.dataCgate,
            configObject: { cgate_mode: 'managed' }
        });
        expect(fs.existsSync(path.join(dirs.projectsDir, 'README'))).toBe(false);
        expect(fs.existsSync(path.join(dirs.projectsDir, 'PROJECT'))).toBe(false);
    });

    test('names unusable files found when no .db is present (issue #28 follow-up)', () => {
        fs.writeFileSync(path.join(dirs.shareTag, 'HOME.cbz'), 'zip-bytes');
        fs.writeFileSync(path.join(dirs.shareTag, 'HOME.xml'), '<project/>');
        const out = runSync({
            shareTag: dirs.shareTag,
            dataCgate: dirs.dataCgate,
            configObject: { cgate_mode: 'managed' }
        });
        expect(out).toMatch(/HOME\.cbz/);
        expect(out).toMatch(/HOME\.xml/);
        expect(out).toMatch(/label/i);
        expect(out).toMatch(/do not install a project/i);
        expect(out).not.toMatch(/No C-Bus project database found/);
        expect(fs.existsSync(dirs.projectsDir)).toBe(false);
    });

    test('mentions extracting when the unusable file is a .zip', () => {
        fs.writeFileSync(path.join(dirs.shareTag, 'HOME.zip'), 'zip-bytes');
        const out = runSync({
            shareTag: dirs.shareTag,
            dataCgate: dirs.dataCgate,
            configObject: { cgate_mode: 'managed' }
        });
        expect(out).toMatch(/HOME\.zip/);
        expect(out).toMatch(/extract/i);
    });

    test('treats a "<name>.db.txt" near-miss as unusable, not as a project db', () => {
        fs.writeFileSync(path.join(dirs.shareTag, 'HOME.db.txt'), 'not-really-a-db');
        const out = runSync({
            shareTag: dirs.shareTag,
            dataCgate: dirs.dataCgate,
            configObject: { cgate_mode: 'managed' }
        });
        expect(fs.existsSync(projectDbPath(dirs.projectsDir, 'HOME.db'))).toBe(false);
        expect(out).toMatch(/HOME\.db\.txt/);
    });

    test('does not warn about unusable files when a real .db is also present', () => {
        fs.writeFileSync(path.join(dirs.shareTag, 'HOME.db'), 'fake-db');
        fs.writeFileSync(path.join(dirs.shareTag, 'HOME.cbz'), 'zip-bytes');
        const out = runSync({
            shareTag: dirs.shareTag,
            dataCgate: dirs.dataCgate,
            configObject: { cgate_mode: 'managed' }
        });
        expect(fs.existsSync(projectDbPath(dirs.projectsDir, 'HOME'))).toBe(true);
        expect(out).not.toMatch(/cannot be loaded/i);
    });

    test('warns about the /config vs top-level /share mixup when files were placed via File Editor', () => {
        fs.rmSync(dirs.root, { recursive: true, force: true });
        dirs = makeTmpDirs({ withShare: false, withData: true });
        const wrongConfigShareCgateDir = path.join(dirs.root, 'config', 'share', 'cgate');
        fs.mkdirSync(path.join(wrongConfigShareCgateDir, 'tag'), { recursive: true });
        fs.writeFileSync(path.join(wrongConfigShareCgateDir, 'tag', 'HOME.db'), 'fake-db');
        const out = runSync({
            shareTag: dirs.shareTag,
            dataCgate: dirs.dataCgate,
            configObject: { cgate_mode: 'managed' },
            env: { CGATEWEB_CONFIG_SHARE_CGATE_DIR: wrongConfigShareCgateDir }
        });
        expect(out).toMatch(/\/config\/share/);
        expect(out).toMatch(/not the same as/i);
        expect(out).not.toMatch(/No C-Bus project database found/);
    });

    test('is a no-op when the share tag dir does not exist', () => {
        // Re-create dirs but only data, not share.
        fs.rmSync(dirs.root, { recursive: true, force: true });
        dirs = makeTmpDirs({ withShare: false, withData: true });
        runSync({
            shareTag: dirs.shareTag,
            dataCgate: dirs.dataCgate,
            configObject: { cgate_mode: 'managed' }
        });
        expect(fs.existsSync(dirs.projectsDir)).toBe(false);
    });

    test('warns clearly when managed mode has no project .db anywhere (share dir missing)', () => {
        fs.rmSync(dirs.root, { recursive: true, force: true });
        dirs = makeTmpDirs({ withShare: false, withData: true });
        const out = runSync({
            shareTag: dirs.shareTag,
            dataCgate: dirs.dataCgate,
            configObject: { cgate_mode: 'managed' }
        });
        expect(out).toMatch(/No C-Bus project database found/);
        expect(out).toMatch(/401 Network not found/);
        expect(out).toMatch(/labels into the cgateweb web UI does NOT install the project/);
    });

    test('warns clearly when the share dir exists but is empty and no project is installed', () => {
        const out = runSync({
            shareTag: dirs.shareTag,
            dataCgate: dirs.dataCgate,
            configObject: { cgate_mode: 'managed' }
        });
        expect(out).toMatch(/No C-Bus project database found/);
    });

    test('does not warn when a project already exists in Projects (share dir missing)', () => {
        fs.rmSync(dirs.root, { recursive: true, force: true });
        dirs = makeTmpDirs({ withShare: false, withData: true });
        const dest = projectDbPath(dirs.projectsDir, 'HOME');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, 'existing-project');
        const out = runSync({
            shareTag: dirs.shareTag,
            dataCgate: dirs.dataCgate,
            configObject: { cgate_mode: 'managed' }
        });
        expect(out).not.toMatch(/No C-Bus project database found/);
    });

    test('does not overwrite a newer destination .db (managed C-Gate may have saved state)', () => {
        const dest = projectDbPath(dirs.projectsDir, 'BURSWOOD');
        const src = path.join(dirs.shareTag, 'BURSWOOD.db');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(src, 'old-source');
        fs.writeFileSync(dest, 'new-cgate-state');
        // Force source mtime older than dest mtime.
        const past = new Date(Date.now() - 60_000);
        const future = new Date(Date.now() + 0);
        fs.utimesSync(src, past, past);
        fs.utimesSync(dest, future, future);

        runSync({
            shareTag: dirs.shareTag,
            dataCgate: dirs.dataCgate,
            configObject: { cgate_mode: 'managed' }
        });
        expect(fs.readFileSync(dest, 'utf8')).toBe('new-cgate-state');
    });

    test('overwrites destination when source is newer', () => {
        const dest = projectDbPath(dirs.projectsDir, 'BURSWOOD');
        const src = path.join(dirs.shareTag, 'BURSWOOD.db');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, 'stale');
        fs.writeFileSync(src, 'fresh-from-user');
        const past = new Date(Date.now() - 60_000);
        const future = new Date(Date.now() + 0);
        fs.utimesSync(dest, past, past);
        fs.utimesSync(src, future, future);

        runSync({
            shareTag: dirs.shareTag,
            dataCgate: dirs.dataCgate,
            configObject: { cgate_mode: 'managed' }
        });
        expect(fs.readFileSync(dest, 'utf8')).toBe('fresh-from-user');
    });

    test('runs the serial fixup on synced projects when cgate_serial_device is set (issue #28)', () => {
        const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-sync-bin-'));
        const nodeCalls = path.join(binDir, 'node-calls.txt');
        fs.writeFileSync(
            path.join(binDir, 'node'),
            `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${nodeCalls}"\nexit 0\n`,
            { mode: 0o755 }
        );
        fs.writeFileSync(path.join(dirs.shareTag, 'HOME.db'), 'fake-db');
        runSync({
            shareTag: dirs.shareTag,
            dataCgate: dirs.dataCgate,
            configObject: { cgate_mode: 'managed', cgate_serial_device: '/dev/ttyUSB0' },
            env: { PATH: `${binDir}:${process.env.PATH}` }
        });
        const calls = fs.readFileSync(nodeCalls, 'utf8');
        expect(calls).toContain('cgateweb-project-serial-fixup.js');
        expect(calls).toContain('/dev/ttyUSB0');
        expect(calls).toContain('HOME.db');
        fs.rmSync(binDir, { recursive: true, force: true });
    });

    test('fixes up with the path cont-init resolved, not the configured one (issue #28)', () => {
        // The PCI renumbered since the user typed the option: cont-init
        // resolved it to ttyUSB9 and published that. Writing ttyUSB0 into the
        // project would point C-Gate at a device that no longer exists.
        const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-sync-bin-'));
        const nodeCalls = path.join(binDir, 'node-calls.txt');
        fs.writeFileSync(
            path.join(binDir, 'node'),
            `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${nodeCalls}"\nexit 0\n`,
            { mode: 0o755 }
        );
        fs.writeFileSync(path.join(dirs.shareTag, 'HOME.db'), 'fake-db');
        fs.writeFileSync(path.join(dirs.dataCgate, 'serial-device'), '/dev/ttyUSB9');
        runSync({
            shareTag: dirs.shareTag,
            dataCgate: dirs.dataCgate,
            configObject: { cgate_mode: 'managed', cgate_serial_device: '/dev/ttyUSB0' },
            env: { PATH: `${binDir}:${process.env.PATH}` }
        });
        const calls = fs.readFileSync(nodeCalls, 'utf8');
        expect(calls).toContain('/dev/ttyUSB9');
        expect(calls).not.toContain('/dev/ttyUSB0');
        fs.rmSync(binDir, { recursive: true, force: true });
    });

    test('falls back to the configured device when the published file is empty', () => {
        // A publish that failed half-way must not hand the fixup an empty
        // device argument.
        const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-sync-bin-'));
        const nodeCalls = path.join(binDir, 'node-calls.txt');
        fs.writeFileSync(
            path.join(binDir, 'node'),
            `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${nodeCalls}"\nexit 0\n`,
            { mode: 0o755 }
        );
        fs.writeFileSync(path.join(dirs.shareTag, 'HOME.db'), 'fake-db');
        fs.writeFileSync(path.join(dirs.dataCgate, 'serial-device'), '');
        runSync({
            shareTag: dirs.shareTag,
            dataCgate: dirs.dataCgate,
            configObject: { cgate_mode: 'managed', cgate_serial_device: '/dev/ttyUSB0' },
            env: { PATH: `${binDir}:${process.env.PATH}` }
        });
        expect(fs.readFileSync(nodeCalls, 'utf8')).toContain('/dev/ttyUSB0');
        fs.rmSync(binDir, { recursive: true, force: true });
    });

    test('skips the fixup once the option is cleared, even with a device file left over', () => {
        // /run is a tmpfs so this is unlikely, but the opt-in must come from
        // the option alone — never from a file a previous boot published.
        const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-sync-bin-'));
        const nodeCalls = path.join(binDir, 'node-calls.txt');
        fs.writeFileSync(
            path.join(binDir, 'node'),
            `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${nodeCalls}"\nexit 0\n`,
            { mode: 0o755 }
        );
        fs.writeFileSync(path.join(dirs.shareTag, 'HOME.db'), 'fake-db');
        fs.writeFileSync(path.join(dirs.dataCgate, 'serial-device'), '/dev/ttyUSB9');
        runSync({
            shareTag: dirs.shareTag,
            dataCgate: dirs.dataCgate,
            configObject: { cgate_mode: 'managed' },
            env: { PATH: `${binDir}:${process.env.PATH}` }
        });
        expect(fs.existsSync(nodeCalls)).toBe(false);
        fs.rmSync(binDir, { recursive: true, force: true });
    });

    test('asks the fixup to repoint a stale serial port too (issue #28)', () => {
        // Without --repoint-stale-serial the fixup only rewrites Windows COMx
        // addresses, so a PC Interface that renumbered while the add-on was
        // stopped leaves the project naming a dead ttyUSBn and C-Gate opens onto
        // a closed interface — exactly the case the in-running recovery cannot
        // see, because by then the device resolves fine and has not moved.
        const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-sync-bin-'));
        const nodeCalls = path.join(binDir, 'node-calls.txt');
        fs.writeFileSync(
            path.join(binDir, 'node'),
            `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${nodeCalls}"\nexit 0\n`,
            { mode: 0o755 }
        );
        fs.writeFileSync(path.join(dirs.shareTag, 'HOME.db'), 'fake-db');
        runSync({
            shareTag: dirs.shareTag,
            dataCgate: dirs.dataCgate,
            configObject: { cgate_mode: 'managed', cgate_serial_device: '/dev/ttyUSB0' },
            env: { PATH: `${binDir}:${process.env.PATH}` }
        });
        expect(fs.readFileSync(nodeCalls, 'utf8')).toContain('--repoint-stale-serial');
        fs.rmSync(binDir, { recursive: true, force: true });
    });

    describe('boot-time renumber, with the real fixup (issue #28)', () => {
        // No node stub here: the point is what ends up in the project database
        // when a PC Interface renumbers while the add-on is stopped.
        const FIXUP_JS = addonBin('cgateweb-project-serial-fixup.js');
        const FIXTURE_DB = path.join(
            __dirname, '..', 'test-env', 'volumes', 'share', 'cgate', 'tag', 'HOME.db'
        );

        async function installProject(interfaceType, interfaceAddress) {
            const initSqlJs = require('sql.js');
            const dest = projectDbPath(dirs.projectsDir, 'HOME');
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(FIXTURE_DB, dest);
            const SQL = await initSqlJs();
            const db = new SQL.Database(fs.readFileSync(dest));
            db.run('UPDATE interface SET interface_type = ?, interface_address = ? WHERE id = 1',
                [interfaceType, interfaceAddress]);
            fs.writeFileSync(dest, Buffer.from(db.export()));
            db.close();
            return dest;
        }

        async function readInterface(dbPath) {
            const initSqlJs = require('sql.js');
            const SQL = await initSqlJs();
            const db = new SQL.Database(fs.readFileSync(dbPath));
            const rows = db.exec('SELECT interface_type, interface_address FROM interface')[0].values;
            db.close();
            return rows;
        }

        test('repoints a project left naming the port the interface used to have', async () => {
            const dest = await installProject('serial', 'ttyUSB0');
            // cont-init's resolver found the interface again on ttyUSB1.
            fs.writeFileSync(path.join(dirs.dataCgate, 'serial-device'), '/dev/ttyUSB1');
            runSync({
                shareTag: dirs.shareTag,
                dataCgate: dirs.dataCgate,
                configObject: { cgate_mode: 'managed', cgate_serial_device: '/dev/ttyUSB0' },
                env: { CGATEWEB_PROJECT_FIXUP_JS: FIXUP_JS }
            });
            expect(await readInterface(dest)).toEqual([['serial', 'ttyUSB1']]);
        });

        test('leaves a CNI interface row alone on this path as well', async () => {
            // A project can pair a serial PCI on one network with a CNI on
            // another; rewriting the CNI's ip:port would take a working network
            // off the air. The guard has to hold from cont-init, not just from
            // the in-running recovery.
            const dest = await installProject('ip', '192.168.0.2:10001');
            fs.writeFileSync(path.join(dirs.dataCgate, 'serial-device'), '/dev/ttyUSB1');
            runSync({
                shareTag: dirs.shareTag,
                dataCgate: dirs.dataCgate,
                configObject: { cgate_mode: 'managed', cgate_serial_device: '/dev/ttyUSB0' },
                env: { CGATEWEB_PROJECT_FIXUP_JS: FIXUP_JS }
            });
            expect(await readInterface(dest)).toEqual([['ip', '192.168.0.2:10001']]);
        });
    });

    test('skips the serial fixup when cgate_serial_device is not set', () => {
        const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-sync-bin-'));
        const nodeCalls = path.join(binDir, 'node-calls.txt');
        fs.writeFileSync(
            path.join(binDir, 'node'),
            `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${nodeCalls}"\nexit 0\n`,
            { mode: 0o755 }
        );
        fs.writeFileSync(path.join(dirs.shareTag, 'HOME.db'), 'fake-db');
        runSync({
            shareTag: dirs.shareTag,
            dataCgate: dirs.dataCgate,
            configObject: { cgate_mode: 'managed' },
            env: { PATH: `${binDir}:${process.env.PATH}` }
        });
        expect(fs.existsSync(nodeCalls)).toBe(false);
        fs.rmSync(binDir, { recursive: true, force: true });
    });
});
