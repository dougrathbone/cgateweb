const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { posixBashAvailable } = require('./helpers/posixBash');

const describeBash = posixBashAvailable() ? describe : describe.skip;

const SCRIPT = path.join(
    __dirname, '..', 'homeassistant-addon', 'rootfs', 'etc', 'cont-init.d', 'cgate-install.sh'
);

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

// Run _cgateweb_write_access_control against a temp access file and return
// { status, contents }. initial === null models a fresh install.
function writeAccessControl({ initial = null, config = {} } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-access-'));
    const file = path.join(dir, 'access.txt');
    if (initial !== null) fs.writeFileSync(file, initial);

    const env = {
        ...process.env,
        CGATEWEB_INSTALL_SOURCE_ONLY: '1',
        CGW_INSTALL_SCRIPT: SCRIPT,
        CGW_ACCESS_FILE: file
    };
    for (const [k, v] of Object.entries(config)) env[`CGW_TEST_${k}`] = v;

    const script = `
        set -u
        ${BASHIO_STUB}
        source "$CGW_INSTALL_SCRIPT"
        _cgateweb_write_access_control "$CGW_ACCESS_FILE"
    `;
    let status = 0;
    try {
        execFileSync('bash', ['-c', script], { encoding: 'utf8', env, stdio: 'pipe' });
    } catch (e) {
        status = e.status;
    }
    const contents = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    fs.rmSync(dir, { recursive: true, force: true });
    return { status, contents };
}

describeBash('_cgateweb_write_access_control', () => {
    it('writes localhost rules using the documented grammar', () => {
        const { status, contents } = writeAccessControl();

        expect(status).toBe(0);
        expect(contents).toContain('remote 127.0.0.1 program');
        expect(contents).toContain('remote 0:0:0:0:0:0:0:1 program');
    });

    it('never emits the malformed lines the old version wrote', () => {
        const { contents } = writeAccessControl();

        // "program" and "monitor" are access levels, not keywords: lines using
        // them as keywords are silently ignored by C-Gate (manual 4.10.1).
        expect(contents).not.toMatch(/^program /m);
        expect(contents).not.toMatch(/^monitor /m);
        // An interface rule matches the server NIC a connection arrives on, so
        // it silently becomes a blanket grant. The add-on must never write one.
        expect(contents).not.toMatch(/^interface /m);
    });

    it('replaces its own managed block on a second run rather than duplicating it', () => {
        const first = writeAccessControl().contents;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-access-'));
        const file = path.join(dir, 'access.txt');
        fs.writeFileSync(file, first);

        const env = {
            ...process.env,
            CGATEWEB_INSTALL_SOURCE_ONLY: '1',
            CGW_INSTALL_SCRIPT: SCRIPT,
            CGW_ACCESS_FILE: file
        };
        execFileSync('bash', ['-c', `
            set -u
            ${BASHIO_STUB}
            source "$CGW_INSTALL_SCRIPT"
            _cgateweb_write_access_control "$CGW_ACCESS_FILE"
        `], { encoding: 'utf8', env });
        const second = fs.readFileSync(file, 'utf8');
        fs.rmSync(dir, { recursive: true, force: true });

        expect(second).toBe(first);
        expect(second.match(/cgateweb managed block/g)).toHaveLength(2); // begin + end
    });

    it('preserves hand-added lines outside the managed block', () => {
        const initial = [
            '# my own rule',
            'remote 10.0.0.9 monitor',
            '# >>> cgateweb managed block - do not edit <<<',
            'remote 127.0.0.1 program',
            '# <<< cgateweb managed block >>>'
        ].join('\n') + '\n';

        const { contents } = writeAccessControl({ initial });

        expect(contents).toContain('# my own rule');
        expect(contents).toContain('remote 10.0.0.9 monitor');
    });
});
