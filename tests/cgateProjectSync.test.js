const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { posixBashAvailable } = require('./helpers/posixBash');

// These tests source the Linux rootfs shell script via bash; only run where a
// POSIX bash is usable (Linux CI, macOS). Skipped on Windows (see helper).
const describeBash = posixBashAvailable() ? describe : describe.skip;

const SCRIPT = path.join(
    __dirname,
    '..',
    'homeassistant-addon',
    'rootfs',
    'etc',
    'cont-init.d',
    'cgate-project-sync.sh'
);

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

function runSync({ shareTag, dataCgate, configObject = {} }) {
    const env = {
        ...process.env,
        CGATEWEB_SHARE_TAG_DIR: shareTag,
        CGATEWEB_DATA_CGATE_DIR: dataCgate,
        // Pass the script path via the environment rather than interpolating it
        // into the bash -c command text, so the absolute path is never part of
        // the executed command string.
        CGW_SYNC_SCRIPT: SCRIPT
    };
    for (const [k, v] of Object.entries(configObject)) {
        env[`CGW_TEST_${k}`] = v;
    }
    // Source the script so the stub functions are in scope. The script's
    // top-level `exit 0` will terminate this bash -c subshell, which is fine.
    const script = `
        set -u
        ${BASHIO_STUB}
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
});
