const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { posixBashAvailable } = require('./helpers/posixBash');

// These tests run the Linux rootfs shell script via bash; only run where a
// POSIX bash is usable (Linux CI, macOS). Skipped on Windows (see helper).
const describeBash = posixBashAvailable() ? describe : describe.skip;

const SCRIPT = path.join(
    __dirname,
    '..',
    'homeassistant-addon',
    'rootfs',
    'usr',
    'bin',
    'cgateweb-serial-diagnostics'
);

// Mirrors the stub in cgateInstallScript.test.js: logs are printed with a
// level prefix so tests can assert on them, and bashio::config reproduces
// real bashio's "null"-for-unset quirk. Test config arrives via CGW_TEST_*
// env vars.
const BASHIO_STUB_WITH_LOGS = `
    bashio::log.info()    { printf 'INFO: %s\\n' "$*"; }
    bashio::log.warning() { printf 'WARNING: %s\\n' "$*"; }
    bashio::log.error()   { printf 'ERROR: %s\\n' "$*"; }
    bashio::log.debug()   { printf 'DEBUG: %s\\n' "$*"; }
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

// An nc stub that records its argv and stdin (what the script asked C-Gate)
// into CGW_NC_DIR, then answers with a canned PORT LIST/IFLIST response.
const NC_STUB_SUCCESS = `#!/usr/bin/env bash
printf '%s\\n' "$*" > "\${CGW_NC_DIR}/nc-args.txt"
cat > "\${CGW_NC_DIR}/nc-stdin.txt"
printf '%s\\n' '300-Ports on this server:' '300- Port 1: /dev/ttyUSB0 state=open' '200 OK.'
exit 0
`;

// An nc stub that fails the way a refused/timed-out connection does: error
// text on stderr and a non-zero exit.
const NC_STUB_FAILURE = `#!/usr/bin/env bash
printf '%s\\n' "$*" > "\${CGW_NC_DIR}/nc-args.txt"
cat > /dev/null
printf 'nc: connect to %s port %s failed: Connection refused\\n' "$2" "$3" >&2
exit 1
`;

// Run the diagnostics script under the bashio stub and capture exit status
// plus everything it logged. config maps to CGW_TEST_* vars (bashio config),
// extraEnv is passed through verbatim (CGATEWEB_CGATE_HOST/PORT overrides),
// and ncStub selects which nc stand-in is put first on PATH.
function runDiagnostics({ config = {}, extraEnv = {}, ncStub = null, stripNc = false } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-serial-diag-'));
    const env = { ...process.env, CGW_DIAG_SCRIPT: SCRIPT, CGW_NC_DIR: dir };
    for (const [k, v] of Object.entries(config)) {
        env[`CGW_TEST_${k}`] = v;
    }
    Object.assign(env, extraEnv);

    let bashCmd = 'bash';
    if (ncStub) {
        const binDir = path.join(dir, 'bin');
        fs.mkdirSync(binDir);
        fs.writeFileSync(path.join(binDir, 'nc'), ncStub, { mode: 0o755 });
        env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
    } else if (stripNc) {
        // Simulate a container without nc: PATH contains only a bin dir with
        // the one external tool the script needs before the nc check
        // (readlink). Use an absolute bash since PATH no longer finds it.
        const binDir = path.join(dir, 'bin');
        fs.mkdirSync(binDir);
        fs.symlinkSync(fs.realpathSync('/usr/bin/readlink'), path.join(binDir, 'readlink'));
        env.PATH = binDir;
        bashCmd = '/bin/bash';
    }

    const script = `
        ${BASHIO_STUB_WITH_LOGS}
        source "$CGW_DIAG_SCRIPT"
    `;
    try {
        const output = execFileSync(bashCmd, ['-c', script], { encoding: 'utf8', env });
        return { status: 0, output, dir };
    } catch (err) {
        return { status: err.status, output: `${err.stdout || ''}${err.stderr || ''}`, dir };
    }
}

function cleanup(result) {
    fs.rmSync(result.dir, { recursive: true, force: true });
}

describeBash('cgateweb-serial-diagnostics (alpha USB-serial PCI, #28)', () => {
    test('is a silent no-op when cgate_serial_device is unset', () => {
        const r = runDiagnostics({ config: { cgate_mode: 'managed' } });
        try {
            expect(r.status).toBe(0);
            expect(r.output.trim()).toBe('');
        } finally {
            cleanup(r);
        }
    });

    test('is a silent no-op in remote mode even when the device is set', () => {
        // In remote mode C-Gate runs on another machine; the diagnostics
        // script is only wired up in managed mode, but even if invoked it
        // must do nothing.
        const r = runDiagnostics({
            config: { cgate_serial_device: '/dev/null', cgate_mode: 'remote' },
            ncStub: NC_STUB_SUCCESS
        });
        try {
            expect(r.status).toBe(0);
            expect(r.output.trim()).toBe('');
            expect(fs.existsSync(path.join(r.dir, 'nc-args.txt'))).toBe(false);
        } finally {
            cleanup(r);
        }
    });

    test('queries C-Gate and logs the issue #28 banner when set and managed', () => {
        const r = runDiagnostics({
            config: { cgate_serial_device: '/dev/null', cgate_mode: 'managed' },
            ncStub: NC_STUB_SUCCESS
        });
        try {
            expect(r.status).toBe(0);
            expect(r.output).toMatch(/C-Gate serial diagnostics/);
            expect(r.output).toMatch(/issue #28/);
            // The configured device and its resolved target are re-logged so
            // the pasted block is self-contained.
            expect(r.output).toMatch(/cgate_serial_device = \/dev\/null/);
            expect(r.output).toMatch(/resolves to \/dev\/null/);
            // The canned C-Gate response is relayed line by line.
            expect(r.output).toMatch(/CGATE> 300- Port 1: \/dev\/ttyUSB0 state=open/);
            expect(r.output).toMatch(/End of C-Gate serial diagnostics/);

            // The script sent PORT LIST + PORT IFLIST + NET LIST_ALL to the
            // default in-container C-Gate address (127.0.0.1, cgate_port 20023).
            const stdin = fs.readFileSync(path.join(r.dir, 'nc-stdin.txt'), 'utf8');
            expect(stdin).toMatch(/^PORT LIST$/m);
            expect(stdin).toMatch(/^PORT IFLIST$/m);
            expect(stdin).toMatch(/^NET LIST_ALL$/m);
            const args = fs.readFileSync(path.join(r.dir, 'nc-args.txt'), 'utf8');
            expect(args).toContain('-w 10 127.0.0.1 20023');
        } finally {
            cleanup(r);
        }
    });

    test('honours CGATEWEB_CGATE_HOST / CGATEWEB_CGATE_PORT overrides', () => {
        const r = runDiagnostics({
            config: { cgate_serial_device: '/dev/null', cgate_mode: 'managed' },
            extraEnv: { CGATEWEB_CGATE_HOST: '192.0.2.10', CGATEWEB_CGATE_PORT: '29999' },
            ncStub: NC_STUB_SUCCESS
        });
        try {
            expect(r.status).toBe(0);
            const args = fs.readFileSync(path.join(r.dir, 'nc-args.txt'), 'utf8');
            expect(args).toContain('-w 10 192.0.2.10 29999');
            expect(r.output).toMatch(/192\.0\.2\.10:29999/);
        } finally {
            cleanup(r);
        }
    });

    test('logs a warning and still exits 0 when nc fails', () => {
        // Startup must never break because diagnostics could not run.
        const r = runDiagnostics({
            config: { cgate_serial_device: '/dev/null', cgate_mode: 'managed' },
            ncStub: NC_STUB_FAILURE
        });
        try {
            expect(r.status).toBe(0);
            expect(r.output).toMatch(/WARNING: Could not query C-Gate/);
            expect(r.output).toMatch(/nc output: nc: connect/);
            expect(r.output).not.toMatch(/CGATE> 300-/);
        } finally {
            cleanup(r);
        }
    });

    test('logs a warning and still exits 0 when nc is not installed', () => {
        const r = runDiagnostics({
            config: { cgate_serial_device: '/dev/null', cgate_mode: 'managed' },
            stripNc: true
        });
        try {
            expect(r.status).toBe(0);
            expect(r.output).toMatch(/WARNING: Could not query C-Gate/);
        } finally {
            cleanup(r);
        }
    });
});
