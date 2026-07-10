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
    'cgate-install.sh'
);

const DEFAULT_DOWNLOAD_URL = 'https://download.se.com/files?p_Doc_Ref=C-Gate_3_Linux_Package_V3.3.2';

// Real bashio's bashio::config returns the literal string "null" when a key
// is unset, even when the caller passes an empty string as the default
// (because upstream bashio uses `local default_value=${2:-null}`, which
// substitutes "null" for both unset AND empty defaults).
//
// This stub mirrors that behavior. Test config is passed via env vars named
// CGW_TEST_<key>; the stub returns the env value when set or the default
// otherwise — matching real bashio's behavior including the "null" quirk.
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

function callHelper(helperName, configObject) {
    const env = { ...process.env, CGATEWEB_INSTALL_SOURCE_ONLY: '1', CGW_INSTALL_SCRIPT: SCRIPT };
    for (const [k, v] of Object.entries(configObject || {})) {
        env[`CGW_TEST_${k}`] = v;
    }
    // Pass the script path via the environment rather than interpolating it into
    // the bash -c command text, so the absolute path is never part of the
    // executed command string.
    const script = `
        set -u
        ${BASHIO_STUB}
        source "$CGW_INSTALL_SCRIPT"
        ${helperName}
    `;
    return execFileSync('bash', ['-c', script], { encoding: 'utf8', env });
}

// Run _cgateweb_apply_cgate_config against a temp config file and return its
// resulting contents. The config path and call args are passed via the
// environment so they are never interpolated into the executed command string.
function applyCgateConfig({ initialConfig, project, commandPort }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-install-'));
    const cfg = path.join(dir, 'C-GateConfig.txt');
    // initialConfig === null models a fresh install where C-Gate has not yet
    // generated its config file.
    if (initialConfig !== null) fs.writeFileSync(cfg, initialConfig);
    const env = {
        ...process.env,
        CGATEWEB_INSTALL_SOURCE_ONLY: '1',
        CGW_INSTALL_SCRIPT: SCRIPT,
        CGW_CFG_FILE: cfg,
        CGW_CFG_PROJECT: project,
        CGW_CFG_CMD_PORT: String(commandPort)
    };
    // event-port is intentionally not passed: the helper no longer sets it (#21).
    const script = `
        set -u
        ${BASHIO_STUB}
        source "$CGW_INSTALL_SCRIPT"
        _cgateweb_apply_cgate_config "$CGW_CFG_FILE" "$CGW_CFG_PROJECT" "$CGW_CFG_CMD_PORT"
    `;
    execFileSync('bash', ['-c', script], { encoding: 'utf8', env });
    const result = fs.readFileSync(cfg, 'utf8');
    fs.rmSync(dir, { recursive: true, force: true });
    return result;
}

// Run a helper that takes positional arguments. Args are passed through the
// environment (CGW_ARG_N) and referenced by variable inside the bash -c body,
// so absolute paths are never interpolated into the executed command string —
// matching the no-interpolation philosophy of callHelper/applyCgateConfig.
function runHelperWithArgs(helperName, args = [], configObject = {}) {
    const env = { ...process.env, CGATEWEB_INSTALL_SOURCE_ONLY: '1', CGW_INSTALL_SCRIPT: SCRIPT };
    for (const [k, v] of Object.entries(configObject)) {
        env[`CGW_TEST_${k}`] = v;
    }
    args.forEach((a, i) => { env[`CGW_ARG_${i}`] = a; });
    const argRefs = args.map((_, i) => `"$CGW_ARG_${i}"`).join(' ');
    const script = `
        set -u
        ${BASHIO_STUB}
        source "$CGW_INSTALL_SCRIPT"
        ${helperName} ${argRefs}
    `;
    return execFileSync('bash', ['-c', script], { encoding: 'utf8', env });
}

describeBash('cgate-install.sh helpers', () => {
    describe('_cgateweb_resolve_download_url', () => {
        test('falls back to default URL when cgate_download_url is unset', () => {
            const url = callHelper('_cgateweb_resolve_download_url', {});
            expect(url).toBe(DEFAULT_DOWNLOAD_URL);
        });

        test('uses configured URL when cgate_download_url is set', () => {
            const url = callHelper('_cgateweb_resolve_download_url', {
                cgate_download_url: 'https://example.com/cgate.zip'
            });
            expect(url).toBe('https://example.com/cgate.zip');
        });
    });

    describe('_cgateweb_resolve_download_sha256', () => {
        test('returns empty string when cgate_download_sha256 is unset', () => {
            const sha = callHelper('_cgateweb_resolve_download_sha256', {});
            expect(sha).toBe('');
        });

        test('returns configured checksum when cgate_download_sha256 is set', () => {
            const expected = 'a'.repeat(64);
            const sha = callHelper('_cgateweb_resolve_download_sha256', {
                cgate_download_sha256: expected
            });
            expect(sha).toBe(expected);
        });
    });

    describe('_cgateweb_force_reinstall_requested', () => {
        test('returns 0 when cgate_force_reinstall is unset (default off)', () => {
            const out = callHelper('_cgateweb_force_reinstall_requested', {});
            expect(out).toBe('0');
        });

        test('returns 1 when cgate_force_reinstall is true', () => {
            const out = callHelper('_cgateweb_force_reinstall_requested', {
                cgate_force_reinstall: 'true'
            });
            expect(out).toBe('1');
        });

        test('returns 0 when cgate_force_reinstall is false', () => {
            const out = callHelper('_cgateweb_force_reinstall_requested', {
                cgate_force_reinstall: 'false'
            });
            expect(out).toBe('0');
        });
    });

    describe('_cgateweb_upload_zip_is_newer', () => {
        // Models upload-mode auto-upgrade: when the user drops a newer C-Gate zip
        // into /share/cgate, the installer must reinstall instead of keeping the
        // version frozen on the /data volume (issue #16 follow-up: stuck on 3.3.2).
        function makeShareAndMarker({ zipMtime, markerMtime }) {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-upgrade-'));
            const shareDir = path.join(dir, 'share');
            fs.mkdirSync(shareDir);
            const marker = path.join(dir, '.version');
            if (zipMtime !== null) {
                const zip = path.join(shareDir, 'cgate-3.7.1_2222.zip');
                fs.writeFileSync(zip, 'x');
                fs.utimesSync(zip, zipMtime, zipMtime);
            }
            if (markerMtime !== null) {
                fs.writeFileSync(marker, '3.3.2_1855\n');
                fs.utimesSync(marker, markerMtime, markerMtime);
            }
            return { dir, shareDir, marker };
        }

        test('returns 0 when no zip is present in the share dir', () => {
            const { dir, shareDir, marker } = makeShareAndMarker({ zipMtime: null, markerMtime: 1000 });
            try {
                const out = runHelperWithArgs('_cgateweb_upload_zip_is_newer', [shareDir, marker]);
                expect(out).toBe('0');
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        test('returns 1 when the uploaded zip is newer than the install marker', () => {
            const { dir, shareDir, marker } = makeShareAndMarker({ zipMtime: 5000, markerMtime: 1000 });
            try {
                const out = runHelperWithArgs('_cgateweb_upload_zip_is_newer', [shareDir, marker]);
                expect(out).toBe('1');
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        test('returns 0 when the uploaded zip is older than the install marker', () => {
            const { dir, shareDir, marker } = makeShareAndMarker({ zipMtime: 1000, markerMtime: 5000 });
            try {
                const out = runHelperWithArgs('_cgateweb_upload_zip_is_newer', [shareDir, marker]);
                expect(out).toBe('0');
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        test('returns 1 when a zip is present but no install marker exists', () => {
            const { dir, shareDir, marker } = makeShareAndMarker({ zipMtime: 1000, markerMtime: null });
            try {
                const out = runHelperWithArgs('_cgateweb_upload_zip_is_newer', [shareDir, marker]);
                expect(out).toBe('1');
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    describe('_cgateweb_apply_cgate_config', () => {
        const BASE_CONFIG = [
            '#### project.default:',
            'project.default=',
            'project.default.dir=Projects/',
            '#### project.start:',
            'project.start=',
            ''
        ].join('\n');

        test('sets project.default to the configured project', () => {
            const out = applyCgateConfig({
                initialConfig: BASE_CONFIG, project: 'HOME', commandPort: 20023, eventPort: 20025
            });
            expect(out).toMatch(/^project\.default=HOME$/m);
        });

        test('sets project.start so C-Gate auto-loads the project on boot', () => {
            const out = applyCgateConfig({
                initialConfig: BASE_CONFIG, project: 'HOME', commandPort: 20023, eventPort: 20025
            });
            // project.default alone does not load a project; project.start is what
            // makes managed C-Gate start it at boot. This is the issue #16 fix.
            expect(out).toMatch(/^project\.start=HOME$/m);
        });

        test('does not disturb project.default.dir when setting project.default', () => {
            const out = applyCgateConfig({
                initialConfig: BASE_CONFIG, project: 'HOME', commandPort: 20023, eventPort: 20025
            });
            expect(out).toMatch(/^project\.default\.dir=Projects\/$/m);
        });

        test('appends command-port but does not write event-port (#21)', () => {
            // Managed C-Gate must keep event-port at its default (20024) so the
            // load-change/status stream stays on 20025 where cgateweb reads it.
            // Writing event-port=20025 collided with the load-change-port and
            // broke light status updates (#21).
            const out = applyCgateConfig({
                initialConfig: BASE_CONFIG, project: 'HOME', commandPort: 21000, eventPort: 21001
            });
            expect(out).toMatch(/^command-port=21000$/m);
            expect(out).not.toMatch(/^event-port=/m);
        });

        test('updates command-port in place and strips any event-port (#21 self-heal)', () => {
            // A previously broken install persisted event-port=20025; applying
            // config must remove it so C-Gate falls back to its default
            // event-port (20024) and the status stream returns to 20025.
            const cfg = BASE_CONFIG + 'command-port=20023\nevent-port=20025\n';
            const out = applyCgateConfig({
                initialConfig: cfg, project: 'HOME', commandPort: 30000, eventPort: 30001
            });
            expect(out).toMatch(/^command-port=30000$/m);
            expect(out).not.toMatch(/^event-port=/m);
            // No duplicate lines left behind.
            expect(out.match(/^command-port=/gm)).toHaveLength(1);
        });

        test('strips legacy invalid CommandInterface.port / EventInterface.port keys', () => {
            const cfg = BASE_CONFIG + 'CommandInterface.port=20023\nEventInterface.port=20025\n';
            const out = applyCgateConfig({
                initialConfig: cfg, project: 'HOME', commandPort: 20023, eventPort: 20025
            });
            expect(out).not.toMatch(/CommandInterface\.port=/);
            expect(out).not.toMatch(/EventInterface\.port=/);
        });

        test('seeds a config with project.start when none exists yet (fresh install)', () => {
            // C-Gate generates C-GateConfig.txt only on its first start, which is
            // after cont-init runs — so on a fresh install there is no file to
            // edit. The helper must create one carrying our project settings so
            // C-Gate auto-loads the project on its very first start (issue #16).
            const out = applyCgateConfig({
                initialConfig: null, project: 'HOME', commandPort: 20023, eventPort: 20025
            });
            expect(out).toMatch(/^project\.start=HOME$/m);
            expect(out).toMatch(/^project\.default=HOME$/m);
            expect(out).toMatch(/^project\.default\.dir=Projects\/$/m);
            expect(out).toMatch(/^command-port=20023$/m);
            expect(out).not.toMatch(/^event-port=/m);
        });

        test('is idempotent across repeated runs (no duplicate keys)', () => {
            const once = applyCgateConfig({
                initialConfig: BASE_CONFIG, project: 'HOME', commandPort: 20023, eventPort: 20025
            });
            const twice = applyCgateConfig({
                initialConfig: once, project: 'HOME', commandPort: 20023, eventPort: 20025
            });
            expect(twice.match(/^project\.start=/gm)).toHaveLength(1);
            expect(twice.match(/^project\.default=/gm)).toHaveLength(1);
        });
    });
});
