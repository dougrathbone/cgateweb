const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { posixBashAvailable } = require('./helpers/posixBash');
const { BASHIO_STUB, BASHIO_STUB_WITH_LOGS } = require('./helpers/bashioStub');

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

// The shared serial-device helper the script sources (issue #28). Points at
// the repo copy so the test never depends on the add-on's real install path.
const SERIAL_DEVICE_LIB = path.join(
    __dirname,
    '..',
    'homeassistant-addon',
    'rootfs',
    'usr',
    'lib',
    'cgateweb',
    'serial-device.sh'
);

const DEFAULT_DOWNLOAD_URL = 'https://download.se.com/files?p_Doc_Ref=C-Gate_3_Linux_Package_V3.3.2';
// sha256 of the zip the default URL serves, pinned in cgate-install.sh as
// CGATEWEB_DEFAULT_DOWNLOAD_SHA256. Duplicated here so a regression in the
// script's constant fails the unit tests.
const DEFAULT_DOWNLOAD_SHA256 = '1d871bcd38355234a3b5b30a208463c8be079aa9346152476f2209f516cf271d';

function callHelper(helperName, configObject) {
    const env = {
        ...process.env,
        CGATEWEB_INSTALL_SOURCE_ONLY: '1',
        CGW_INSTALL_SCRIPT: SCRIPT,
        CGATEWEB_SERIAL_DEVICE_LIB: SERIAL_DEVICE_LIB
    };
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
        CGATEWEB_SERIAL_DEVICE_LIB: SERIAL_DEVICE_LIB,
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
    const env = {
        ...process.env,
        CGATEWEB_INSTALL_SOURCE_ONLY: '1',
        CGW_INSTALL_SCRIPT: SCRIPT,
        CGATEWEB_SERIAL_DEVICE_LIB: SERIAL_DEVICE_LIB
    };
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

// The identity-aware resolver the serial check shells out to (issue #28).
// Installed at /usr/bin in the add-on image; the tests point the script at the
// repo copy through CGATEWEB_RESOLVE_SERIAL_JS.
const RESOLVER = path.join(
    __dirname,
    '..',
    'homeassistant-addon',
    'rootfs',
    'usr',
    'bin',
    'cgateweb-resolve-serial.js'
);

// Temp dirs handed out to serial tests, removed once the suite finishes.
const serialTmpDirs = [];
function makeSerialTmpDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-serial-'));
    serialTmpDirs.push(dir);
    return dir;
}
afterAll(() => {
    for (const dir of serialTmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// Run _cgateweb_check_serial_device with the given config and capture both
// the exit status and everything it logged. execFileSync throws on non-zero
// exit, so status/output are recovered from the thrown error.
//
// The resolver's two bookkeeping files are redirected into a per-call temp dir
// so no test ever reads or writes the real /run/cgateweb/serial-device or
// /data/serial-identity.json. `dir` reuses a caller-made temp dir (needed when
// the test also has to build a stub-binary dir inside it), extraEnv layers on
// top (PATH surgery), and bashCmd allows an absolute bash when PATH is
// stripped down.
function checkSerialDevice(configObject, { dir = null, extraEnv = {}, bashCmd = 'bash' } = {}) {
    const tmp = dir || makeSerialTmpDir();
    const deviceFile = path.join(tmp, 'serial-device');
    const env = {
        ...process.env,
        CGATEWEB_INSTALL_SOURCE_ONLY: '1',
        CGW_INSTALL_SCRIPT: SCRIPT,
        CGATEWEB_SERIAL_DEVICE_LIB: SERIAL_DEVICE_LIB,
        CGATEWEB_RESOLVE_SERIAL_JS: RESOLVER,
        CGATEWEB_SERIAL_DEVICE_FILE: deviceFile,
        CGATEWEB_SERIAL_IDENTITY_FILE: path.join(tmp, 'serial-identity.json')
    };
    for (const [k, v] of Object.entries(configObject || {})) {
        env[`CGW_TEST_${k}`] = v;
    }
    Object.assign(env, extraEnv);
    const script = `
        set -u
        ${BASHIO_STUB_WITH_LOGS}
        source "$CGW_INSTALL_SCRIPT"
        _cgateweb_check_serial_device
    `;
    try {
        const output = execFileSync(bashCmd, ['-c', script], { encoding: 'utf8', env });
        return { status: 0, output, deviceFile, dir: tmp };
    } catch (err) {
        return {
            status: err.status,
            output: `${err.stdout || ''}${err.stderr || ''}`,
            deviceFile,
            dir: tmp
        };
    }
}

// A bin dir containing only the listed system tools, for tests that strip PATH
// down to prove a "tool is missing" branch really fires.
function makeStubBinDir(tmp, tools) {
    const binDir = path.join(tmp, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    for (const tool of tools) {
        fs.symlinkSync(fs.realpathSync(`/bin/${tool}`), path.join(binDir, tool));
    }
    return binDir;
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
        test('returns empty string when cgate_download_sha256 is unset and no URL context is given', () => {
            // Upload mode calls the helper without a URL: the user setting
            // only, never the pinned default-download checksum.
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

        test('falls back to the pinned checksum for the built-in default URL', () => {
            const sha = runHelperWithArgs('_cgateweb_resolve_download_sha256', [DEFAULT_DOWNLOAD_URL]);
            expect(sha).toBe(DEFAULT_DOWNLOAD_SHA256);
        });

        test('user-configured checksum wins over the pin for the default URL', () => {
            // The explicit setting is the escape hatch if Clipsal re-releases
            // the zip and the pinned checksum goes stale.
            const expected = 'b'.repeat(64);
            const sha = runHelperWithArgs('_cgateweb_resolve_download_sha256', [DEFAULT_DOWNLOAD_URL], {
                cgate_download_sha256: expected
            });
            expect(sha).toBe(expected);
        });

        test('returns empty string for a custom URL with no configured checksum', () => {
            // Resolving to empty here is what makes
            // _cgateweb_custom_url_without_sha256 reject the install before
            // anything is downloaded.
            const sha = runHelperWithArgs('_cgateweb_resolve_download_sha256', ['https://example.com/cgate.zip']);
            expect(sha).toBe('');
        });
    });

    describe('_cgateweb_custom_url_without_sha256', () => {
        // A custom download URL is only installed when pinned to a checksum;
        // the built-in default URL is covered by the script's pinned checksum
        // instead, so it needs nothing from the user.
        test('returns 1 for a custom URL with no sha256', () => {
            const out = runHelperWithArgs('_cgateweb_custom_url_without_sha256', ['https://example.com/cgate.zip', '']);
            expect(out).toBe('1');
        });

        test('returns 0 for a custom URL with a sha256 set', () => {
            const out = runHelperWithArgs('_cgateweb_custom_url_without_sha256', ['https://example.com/cgate.zip', 'a'.repeat(64)]);
            expect(out).toBe('0');
        });

        test('returns 0 for the built-in default URL with no sha256', () => {
            const out = runHelperWithArgs('_cgateweb_custom_url_without_sha256', [DEFAULT_DOWNLOAD_URL, '']);
            expect(out).toBe('0');
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

    describe('_cgateweb_check_serial_device (USB-serial PCI, #28)', () => {
        // The helper signals failure with `return 1`; sourced and invoked as
        // the last command of the bash process, that return code becomes the
        // process exit code, which checkSerialDevice captures.
        test('is a silent no-op when cgate_serial_device is unset', () => {
            const r = checkSerialDevice({});
            expect(r.status).toBe(0);
            expect(r.output).not.toMatch(/ALPHA/);
        });

        test('is a silent no-op when cgate_serial_device is empty', () => {
            const r = checkSerialDevice({ cgate_serial_device: '' });
            expect(r.status).toBe(0);
            expect(r.output).not.toMatch(/ALPHA/);
        });

        test('fails when the value does not start with /dev/', () => {
            const r = checkSerialDevice({ cgate_serial_device: 'ttyUSB0', cgate_mode: 'managed' });
            expect(r.status).toBe(1);
            expect(r.output).toMatch(/must be a device path starting with \/dev\//);
        });

        test('fails when the /dev/ path does not exist', () => {
            const r = checkSerialDevice({
                cgate_serial_device: '/dev/cgw-no-such-serial-device', cgate_mode: 'managed'
            });
            expect(r.status).toBe(1);
            expect(r.output).toMatch(/Serial device not found/);
        });

        test('succeeds and logs the beta banner for an existing device', () => {
            // /dev/null: exists, is a character device, and starts with /dev/
            // on every POSIX host these bash tests run on. (A regular temp
            // file cannot stand in here: it lives outside /dev/ and would
            // trip the prefix check tested above.)
            const r = checkSerialDevice({ cgate_serial_device: '/dev/null', cgate_mode: 'managed' });
            expect(r.status).toBe(0);
            expect(r.output).toMatch(/USB-serial PC Interface support \(beta\)/);
        });

        test('warns but does not fail when the path is not a character device', () => {
            // /dev/. resolves to the /dev directory on every POSIX host: it
            // exists and matches the /dev/ prefix but is not a character
            // device — the exotic-setup branch must be warn-only.
            const r = checkSerialDevice({ cgate_serial_device: '/dev/.', cgate_mode: 'managed' });
            expect(r.status).toBe(0);
            expect(r.output).toMatch(/not a character device/);
        });

        test('warns but does not fail in remote mode (local device is meaningless)', () => {
            const r = checkSerialDevice({ cgate_serial_device: '/dev/null', cgate_mode: 'remote' });
            expect(r.status).toBe(0);
            expect(r.output).toMatch(/only takes effect in managed mode/);
        });

        test('logs an inventory of detected serial devices when the option is set', () => {
            // The inventory runs on every configured boot — both branches
            // (devices listed vs. none found) prove it fired.
            const r = checkSerialDevice({ cgate_serial_device: '/dev/null', cgate_mode: 'managed' });
            expect(r.status).toBe(0);
            expect(r.output).toMatch(
                /Detected serial devices on this host|No \/dev\/ttyUSB\* or \/dev\/ttyACM\* devices found/
            );
        });

        test('logs the device inventory even when the configured device is missing', () => {
            // A user who picked the wrong path needs the inventory most —
            // it must appear before the hard failure, not be skipped by it.
            const r = checkSerialDevice({
                cgate_serial_device: '/dev/cgw-no-such-serial-device', cgate_mode: 'managed'
            });
            expect(r.status).toBe(1);
            expect(r.output).toMatch(/Serial device not found/);
            expect(r.output).toMatch(
                /Detected serial devices on this host|No \/dev\/ttyUSB\* or \/dev\/ttyACM\* devices found/
            );
        });

        test('logs ls -l details and the resolved target of the selected device', () => {
            // readlink -f resolution is what lets a /dev/serial/by-id/ path
            // show its real ttyUSB*/ttyACM* target in the log. /dev/null is
            // not a symlink, so it resolves to itself on every POSIX host.
            const r = checkSerialDevice({ cgate_serial_device: '/dev/null', cgate_mode: 'managed' });
            expect(r.status).toBe(0);
            expect(r.output).toMatch(/Selected device: .*\/dev\/null/);
            expect(r.output).toMatch(/resolves to \/dev\/null/);
        });
    });

    describe('_cgateweb_check_serial_device resolver wiring (#28)', () => {
        // A stand-in resolver that answers the way the real one does after a
        // replug: the chosen path on stdout, diagnostics on stderr. stdout is
        // written FIRST so a caller that merged the two streams and took the
        // last line would pick the message instead of the path.
        const NODE_STUB_RECOVERED = `#!/usr/bin/env bash
printf '/dev/ttyUSB7\\n'
printf 'WARN: Recovered: the previously-used device is now at /dev/ttyUSB7\\n' >&2
printf 'INFO: Update cgate_serial_device to /dev/serial/by-id/usb-x so this survives future replugs\\n' >&2
exit 0
`;
        // A resolver that resolved a device but could not publish it (exit 2).
        // Only the exit-status mapping is stubbed here; that the real resolver
        // exits 2 in this situation is proven end-to-end in
        // cgateResolveSerial.test.js ("fails naming the write when a recovered
        // path cannot be published").
        const NODE_STUB_PUBLISH_FAILED = `#!/usr/bin/env bash
printf 'WARN: Could not write /run/cgateweb/serial-device: EROFS\\n' >&2
printf 'WARN: The device was recovered at /dev/ttyUSB7, but that could not be shared\\n' >&2
exit 2
`;

        function withNodeStub(body) {
            const dir = makeSerialTmpDir();
            const binDir = path.join(dir, 'bin');
            fs.mkdirSync(binDir, { recursive: true });
            fs.writeFileSync(path.join(binDir, 'node'), body, { mode: 0o755 });
            return { dir, binDir };
        }

        test('publishes the resolved path so the later boot scripts agree on it', () => {
            const r = checkSerialDevice({ cgate_serial_device: '/dev/null', cgate_mode: 'managed' });
            expect(r.status).toBe(0);
            expect(fs.readFileSync(r.deviceFile, 'utf8')).toBe('/dev/null');
        });

        test('surfaces the resolver messages through the add-on log', () => {
            // /dev/null has no /dev/serial/by-id link and no sysfs USB parent
            // on any host these tests run on, so the real resolver reports
            // that identity-based recovery will not be possible.
            const r = checkSerialDevice({ cgate_serial_device: '/dev/null', cgate_mode: 'managed' });
            expect(r.status).toBe(0);
            expect(r.output).toMatch(/WARNING: No stable identity found for \/dev\/null/);
        });

        test('adopts the path the resolver printed, not the configured one', () => {
            const { dir, binDir } = withNodeStub(NODE_STUB_RECOVERED);
            const r = checkSerialDevice(
                { cgate_serial_device: '/dev/ttyUSB0', cgate_mode: 'managed' },
                { dir, extraEnv: { PATH: `${binDir}${path.delimiter}${process.env.PATH}` } }
            );
            expect(r.status).toBe(0);
            expect(fs.readFileSync(r.deviceFile, 'utf8')).toBe('/dev/ttyUSB7');
            expect(r.output).toMatch(/WARNING: Recovered: .*\/dev\/ttyUSB7/);
        });

        test('logs the configured and resolved paths as separate facts after a recovery', () => {
            // "/dev/ttyUSB0 resolves to /dev/ttyUSB7" reads as a symlink
            // relationship that does not exist; the readlink target belongs to
            // the resolved path alone.
            const { dir, binDir } = withNodeStub(NODE_STUB_RECOVERED);
            const r = checkSerialDevice(
                { cgate_serial_device: '/dev/ttyUSB0', cgate_mode: 'managed' },
                { dir, extraEnv: { PATH: `${binDir}${path.delimiter}${process.env.PATH}` } }
            );
            expect(r.status).toBe(0);
            expect(r.output).toMatch(
                /Resolved to a different device: \/dev\/ttyUSB7 \(the configured \/dev\/ttyUSB0 renumbered\)/
            );
            expect(r.output).not.toMatch(/Serial device \/dev\/ttyUSB0 resolves to/);
        });

        test('logs resolver advice as info rather than as a warning', () => {
            // All resolver stderr used to become a warning, including "here is
            // a nicer path you could configure" — noise that teaches users to
            // ignore the warnings that matter.
            const { dir, binDir } = withNodeStub(NODE_STUB_RECOVERED);
            const r = checkSerialDevice(
                { cgate_serial_device: '/dev/ttyUSB0', cgate_mode: 'managed' },
                { dir, extraEnv: { PATH: `${binDir}${path.delimiter}${process.env.PATH}` } }
            );
            expect(r.status).toBe(0);
            expect(r.output).toMatch(/INFO: Update cgate_serial_device to/);
            expect(r.output).not.toMatch(/WARNING: Update cgate_serial_device to/);
        });

        test('replays a final resolver line that has no trailing newline', () => {
            const { dir, binDir } = withNodeStub(`#!/usr/bin/env bash
printf '/dev/null\\n'
printf 'WARN: truncated last line' >&2
exit 0
`);
            const r = checkSerialDevice(
                { cgate_serial_device: '/dev/null', cgate_mode: 'managed' },
                { dir, extraEnv: { PATH: `${binDir}${path.delimiter}${process.env.PATH}` } }
            );
            expect(r.status).toBe(0);
            expect(r.output).toMatch(/WARNING: truncated last line/);
        });

        test('fails when the resolver cannot resolve the device', () => {
            const r = checkSerialDevice({
                cgate_serial_device: '/dev/cgw-no-such-serial-device', cgate_mode: 'managed'
            });
            expect(r.status).toBe(1);
            // The resolver's own diagnosis, plus the script's guidance.
            expect(r.output).toMatch(/No previously-recorded device identity/);
            expect(r.output).toMatch(/ERROR: Serial device not found/);
            expect(fs.existsSync(r.deviceFile)).toBe(false);
        });

        test('leaves the device file untouched when cgate_serial_device is unset', () => {
            const r = checkSerialDevice({ cgate_mode: 'managed' });
            expect(r.status).toBe(0);
            expect(fs.existsSync(r.deviceFile)).toBe(false);
        });

        test('falls back to a plain existence check when node is unavailable', () => {
            // PATH is cut down to the handful of externals the fallback path
            // uses, so `command -v node` fails the way it would in an image
            // without node rather than being faked.
            const dir = makeSerialTmpDir();
            const binDir = makeStubBinDir(dir, ['ls', 'mkdir', 'rm']);
            const r = checkSerialDevice(
                { cgate_serial_device: '/dev/null', cgate_mode: 'managed' },
                { dir, extraEnv: { PATH: binDir }, bashCmd: '/bin/bash' }
            );
            expect(r.status).toBe(0);
            expect(r.output).toMatch(/WARNING: node is unavailable/);
            expect(fs.readFileSync(r.deviceFile, 'utf8')).toBe('/dev/null');
        });

        test('still fails on a missing device when node is unavailable', () => {
            const dir = makeSerialTmpDir();
            const binDir = makeStubBinDir(dir, ['ls', 'mkdir', 'rm']);
            const r = checkSerialDevice(
                { cgate_serial_device: '/dev/cgw-no-such-serial-device', cgate_mode: 'managed' },
                { dir, extraEnv: { PATH: binDir }, bashCmd: '/bin/bash' }
            );
            expect(r.status).toBe(1);
            expect(r.output).toMatch(/ERROR: Serial device not found/);
            expect(fs.existsSync(r.deviceFile)).toBe(false);
        });

        test('warns and continues when the resolved path cannot be recorded', () => {
            // Device file inside a path whose parent is a regular file: neither
            // the real resolver nor this script can publish there. Startup must
            // not fail — the configured path was not changed, so the consumers'
            // fallback to cgate_serial_device lands on the same device. This
            // runs the REAL resolver: the previous version of this test used a
            // stub that never wrote the file, hiding the fact that the resolver
            // used to hard-exit on exactly this condition.
            const dir = makeSerialTmpDir();
            const blocker = path.join(dir, 'blocker');
            fs.writeFileSync(blocker, '');
            const r = checkSerialDevice(
                { cgate_serial_device: '/dev/null', cgate_mode: 'managed' },
                {
                    dir,
                    extraEnv: { CGATEWEB_SERIAL_DEVICE_FILE: path.join(blocker, 'serial-device') }
                }
            );
            expect(r.status).toBe(0);
            // The resolver's own non-fatal verdict, then the script's.
            expect(r.output).toMatch(/WARNING: Could not write .*serial-device/);
            expect(r.output).toMatch(/WARNING: Could not record the resolved serial device/);
        });

        test('blames a broken image, not the device, when the resolver script is absent', () => {
            // node exits 1 for a missing script, and the exit-code contract
            // reads 1 as "the configured device is not present" — so a
            // packaging slip used to send users hunting for a device that was
            // plugged in the whole time.
            const r = checkSerialDevice(
                { cgate_serial_device: '/dev/null', cgate_mode: 'managed' },
                { extraEnv: { CGATEWEB_RESOLVE_SERIAL_JS: '/nonexistent/cgateweb-resolve-serial.js' } }
            );
            expect(r.status).toBe(1);
            expect(r.output).toMatch(/ERROR: The serial device resolver is missing or unreadable/);
            expect(r.output).toMatch(/broken add-on image, not a missing device/);
            expect(r.output).not.toMatch(/Serial device not found/);
        });

        test('reports a resolver failure other than a missing device accurately', () => {
            // Exit 2 means the resolver found the device but could not agree on
            // it with the later boot steps. Reporting that as "Serial device
            // not found" sent users hunting for hardware that was plugged in.
            const { dir, binDir } = withNodeStub(NODE_STUB_PUBLISH_FAILED);
            const r = checkSerialDevice(
                { cgate_serial_device: '/dev/ttyUSB0', cgate_mode: 'managed' },
                { dir, extraEnv: { PATH: `${binDir}${path.delimiter}${process.env.PATH}` } }
            );
            expect(r.status).toBe(1);
            expect(r.output).toMatch(/ERROR: Could not determine which serial device to use \(resolver exited 2\)/);
            expect(r.output).not.toMatch(/Serial device not found/);
        });
    });
});
