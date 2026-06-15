const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(
    __dirname,
    '..',
    'homeassistant-addon',
    'rootfs',
    'etc',
    'cont-init.d',
    'cgate-project-sync.sh'
);

// Stub bashio: config keys come from env vars CGW_TEST_<key>.
const BASHIO_STUB = `
    bashio::log.info()    { :; }
    bashio::log.warning() { :; }
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
    const dataTag = path.join(root, 'data', 'cgate', 'tag');
    if (withShare) fs.mkdirSync(shareTag, { recursive: true });
    if (withData) fs.mkdirSync(dataTag, { recursive: true });
    return { root, shareTag, dataTag };
}

function runSync({ shareTag, dataTag, configObject = {} }) {
    const env = {
        ...process.env,
        CGATEWEB_SHARE_TAG_DIR: shareTag,
        CGATEWEB_DATA_TAG_DIR: dataTag,
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

describe('cgate-project-sync.sh', () => {
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
            dataTag: dirs.dataTag,
            configObject: { cgate_mode: 'remote' }
        });
        expect(fs.existsSync(path.join(dirs.dataTag, 'BURSWOOD.db'))).toBe(false);
    });

    test('copies .db files from share into C-Gate tag dir when in managed mode', () => {
        fs.writeFileSync(path.join(dirs.shareTag, 'BURSWOOD.db'), 'fake-db-content');
        runSync({
            shareTag: dirs.shareTag,
            dataTag: dirs.dataTag,
            configObject: { cgate_mode: 'managed' }
        });
        const dest = path.join(dirs.dataTag, 'BURSWOOD.db');
        expect(fs.existsSync(dest)).toBe(true);
        expect(fs.readFileSync(dest, 'utf8')).toBe('fake-db-content');
    });

    test('skips files that are not .db', () => {
        fs.writeFileSync(path.join(dirs.shareTag, 'README.txt'), 'readme');
        fs.writeFileSync(path.join(dirs.shareTag, 'PROJECT.xml'), '<x/>');
        runSync({
            shareTag: dirs.shareTag,
            dataTag: dirs.dataTag,
            configObject: { cgate_mode: 'managed' }
        });
        expect(fs.existsSync(path.join(dirs.dataTag, 'README.txt'))).toBe(false);
        expect(fs.existsSync(path.join(dirs.dataTag, 'PROJECT.xml'))).toBe(false);
    });

    test('is a no-op when the share tag dir does not exist', () => {
        // Re-create dirs but only data, not share.
        fs.rmSync(dirs.root, { recursive: true, force: true });
        dirs = makeTmpDirs({ withShare: false, withData: true });
        runSync({
            shareTag: dirs.shareTag,
            dataTag: dirs.dataTag,
            configObject: { cgate_mode: 'managed' }
        });
        const entries = fs.readdirSync(dirs.dataTag);
        expect(entries).toEqual([]);
    });

    test('does not overwrite a newer destination .db (managed C-Gate may have saved state)', () => {
        const dest = path.join(dirs.dataTag, 'BURSWOOD.db');
        const src = path.join(dirs.shareTag, 'BURSWOOD.db');
        fs.writeFileSync(src, 'old-source');
        fs.writeFileSync(dest, 'new-cgate-state');
        // Force source mtime older than dest mtime.
        const past = new Date(Date.now() - 60_000);
        const future = new Date(Date.now() + 0);
        fs.utimesSync(src, past, past);
        fs.utimesSync(dest, future, future);

        runSync({
            shareTag: dirs.shareTag,
            dataTag: dirs.dataTag,
            configObject: { cgate_mode: 'managed' }
        });
        expect(fs.readFileSync(dest, 'utf8')).toBe('new-cgate-state');
    });

    test('overwrites destination when source is newer', () => {
        const dest = path.join(dirs.dataTag, 'BURSWOOD.db');
        const src = path.join(dirs.shareTag, 'BURSWOOD.db');
        fs.writeFileSync(dest, 'stale');
        fs.writeFileSync(src, 'fresh-from-user');
        const past = new Date(Date.now() - 60_000);
        const future = new Date(Date.now() + 0);
        fs.utimesSync(dest, past, past);
        fs.utimesSync(src, future, future);

        runSync({
            shareTag: dirs.shareTag,
            dataTag: dirs.dataTag,
            configObject: { cgate_mode: 'managed' }
        });
        expect(fs.readFileSync(dest, 'utf8')).toBe('fresh-from-user');
    });
});
