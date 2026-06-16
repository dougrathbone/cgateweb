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
function applyCgateConfig({ initialConfig, project, commandPort, eventPort }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-install-'));
    const cfg = path.join(dir, 'C-GateConfig.txt');
    fs.writeFileSync(cfg, initialConfig);
    const env = {
        ...process.env,
        CGATEWEB_INSTALL_SOURCE_ONLY: '1',
        CGW_INSTALL_SCRIPT: SCRIPT,
        CGW_CFG_FILE: cfg,
        CGW_CFG_PROJECT: project,
        CGW_CFG_CMD_PORT: String(commandPort),
        CGW_CFG_EVENT_PORT: String(eventPort)
    };
    const script = `
        set -u
        ${BASHIO_STUB}
        source "$CGW_INSTALL_SCRIPT"
        _cgateweb_apply_cgate_config "$CGW_CFG_FILE" "$CGW_CFG_PROJECT" "$CGW_CFG_CMD_PORT" "$CGW_CFG_EVENT_PORT"
    `;
    execFileSync('bash', ['-c', script], { encoding: 'utf8', env });
    const result = fs.readFileSync(cfg, 'utf8');
    fs.rmSync(dir, { recursive: true, force: true });
    return result;
}

describe('cgate-install.sh helpers', () => {
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

        test('appends command-port and event-port when absent', () => {
            const out = applyCgateConfig({
                initialConfig: BASE_CONFIG, project: 'HOME', commandPort: 21000, eventPort: 21001
            });
            expect(out).toMatch(/^command-port=21000$/m);
            expect(out).toMatch(/^event-port=21001$/m);
        });

        test('updates existing command-port / event-port in place', () => {
            const cfg = BASE_CONFIG + 'command-port=20023\nevent-port=20025\n';
            const out = applyCgateConfig({
                initialConfig: cfg, project: 'HOME', commandPort: 30000, eventPort: 30001
            });
            expect(out).toMatch(/^command-port=30000$/m);
            expect(out).toMatch(/^event-port=30001$/m);
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
