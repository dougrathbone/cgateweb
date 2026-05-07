const { execFileSync } = require('child_process');
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
    const env = { ...process.env, CGATEWEB_INSTALL_SOURCE_ONLY: '1' };
    for (const [k, v] of Object.entries(configObject || {})) {
        env[`CGW_TEST_${k}`] = v;
    }
    const script = `
        set -u
        ${BASHIO_STUB}
        source "${SCRIPT}"
        ${helperName}
    `;
    return execFileSync('bash', ['-c', script], { encoding: 'utf8', env });
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
});
