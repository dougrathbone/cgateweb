const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { posixBashAvailable } = require('./helpers/posixBash');
const { BASHIO_STUB, BASHIO_STUB_WITH_LOGS } = require('./helpers/bashioStub');

const describeBash = posixBashAvailable() ? describe : describe.skip;

// Permission-denial probes (unreadable file, read-only directory) are
// meaningless when the test runner is root: root bypasses the permission
// bits that would otherwise cause the read/write/mkdir to fail, so the
// assertion would pass for the wrong reason. Skip those specific cases there
// rather than skip the whole suite.
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const itUnlessRoot = isRoot ? it.skip : it;

// Whether jq is on PATH. The real-reader suite below sources bashio::config's
// actual upstream query logic (github.com/hassio-addons/bashio, lib/config.sh
// + lib/jq.sh, MIT-licensed -- vendored under tests/vendor/bashio/, see the
// README there), which shells out to jq exactly as it does inside the add-on
// container. Skipped (not failed) where jq is absent so this file still runs
// on a bare dev machine; GitHub Actions ubuntu runners ship jq.
function jqAvailable() {
    try {
        execFileSync('jq', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}
const jqOk = jqAvailable();
// MINOR 4: jq ships in the add-on image and on every GitHub Actions runner,
// so this describe.skip is currently theoretical in CI -- but if a runner
// image ever drops jq, describe.skip would make three tests vanish while the
// build stayed green. Fail loudly instead of skipping whenever CI is set.
if (process.env.CI && !jqOk) {
    throw new Error(
        'jq is required in CI to run the real-bashio-reader suite in tests/cgateAccessControl.test.js ' +
        '(it shells out to jq, matching the add-on container) but was not found on PATH. ' +
        'Install jq in the CI image rather than letting this suite silently skip.'
    );
}
const describeJq = (posixBashAvailable() && jqOk) ? describe : describe.skip;

const SCRIPT = path.join(
    __dirname, '..', 'homeassistant-addon', 'rootfs', 'etc', 'cont-init.d', 'cgate-install.sh'
);

// The shared serial-device helper the script sources (issue #28). Points at
// the repo copy so the test never depends on the add-on's real install path.
const SERIAL_DEVICE_LIB = path.join(
    __dirname, '..', 'homeassistant-addon', 'rootfs', 'usr', 'lib', 'cgateweb', 'serial-device.sh'
);

const FIXTURE_STOCK_ACCESS = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'access-stock-cgate-3.3.2.txt'), 'utf8'
);

// Overrides the real _cgateweb_external_client_rules so tests can feed rules in
// directly instead of reimplementing bashio's object-list flattening. Must be
// sourced AFTER the script, so it wins.
const EXTERNAL_RULES_STUB = `
    _cgateweb_external_client_rules() {
        if [[ -n "\${CGW_EXTERNAL_RULES:-}" ]]; then
            printf '%s\\n' "\${CGW_EXTERNAL_RULES}"
        fi
    }
`;

// MINOR 5: the vendored files under tests/vendor/bashio/ are byte-for-byte
// copies of bashio::config's real query logic (config.sh + jq.sh, from
// https://github.com/hassio-addons/bashio, MIT-licensed -- see
// tests/vendor/bashio/README.md for the exact commit copied and why they're
// vendored rather than reimplemented inline). This stub supplies only the
// handful of names those two files reference but don't themselves define
// (bashio::log.*, bashio::app.config -- the one call real bashio makes out
// to the Supervisor API -- and bashio's __BASHIO_EXIT_OK/__BASHIO_EXIT_NOK
// constants), then sources the vendored files. This exercises
// _cgateweb_external_client_rules's own bashio::config calls (the
// "key|length" and "key[i].field" jq paths) against bashio's real
// object-list flattening, rather than the EXTERNAL_RULES_STUB used
// everywhere else in this file to test validation in isolation.
const VENDOR_BASHIO_DIR = path.join(__dirname, 'vendor', 'bashio');
const VENDOR_CONFIG_SH = path.join(VENDOR_BASHIO_DIR, 'config.sh');
const VENDOR_JQ_SH = path.join(VENDOR_BASHIO_DIR, 'jq.sh');

const REAL_BASHIO_CONFIG_STUB = `
    bashio::log.info()    { :; }
    bashio::log.warning() { :; }
    bashio::log.error()   { :; }
    bashio::log.trace()   { :; }
    bashio::log.debug()   { :; }
    bashio::app.config() { printf '%s' "\${CGW_OPTIONS_JSON}"; }
    __BASHIO_EXIT_OK=0
    __BASHIO_EXIT_NOK=1
    source "\${CGW_VENDOR_JQ_SH}"
    source "\${CGW_VENDOR_CONFIG_SH}"
`;

// Run _cgateweb_write_access_control against an already-prepared access file
// path (the caller owns creation/permissions/cleanup of the containing
// directory). Returns { status, output } where output is stdout+stderr
// combined (only meaningful content when withLogs is set — BASHIO_STUB
// swallows all log calls).
function runAccessControlOn(file, { config = {}, withLogs = false } = {}) {
    const env = {
        ...process.env,
        CGATEWEB_INSTALL_SOURCE_ONLY: '1',
        CGW_INSTALL_SCRIPT: SCRIPT,
        CGATEWEB_SERIAL_DEVICE_LIB: SERIAL_DEVICE_LIB,
        CGW_ACCESS_FILE: file
    };
    for (const [k, v] of Object.entries(config)) {
        env[k.startsWith('CGW_') ? k : `CGW_TEST_${k}`] = v;
    }

    const stub = withLogs ? BASHIO_STUB_WITH_LOGS : BASHIO_STUB;
    const script = `
        set -u
        ${stub}
        source "$CGW_INSTALL_SCRIPT"
        ${EXTERNAL_RULES_STUB}
        _cgateweb_write_access_control "$CGW_ACCESS_FILE"
    `;
    let status = 0;
    let output;
    try {
        output = execFileSync('bash', ['-c', script], { encoding: 'utf8', env, stdio: 'pipe' });
    } catch (e) {
        status = typeof e.status === 'number' ? e.status : 1;
        output = `${e.stdout || ''}${e.stderr || ''}`;
    }
    return { status, output };
}

// Run _cgateweb_write_access_control against a temp access file and return
// { status, contents, dir, file }. initial === null models a fresh install.
// The temp dir is removed automatically unless keepDir is set (for tests
// that need to inspect leftover .tmp files afterwards).
function writeAccessControl({ initial = null, config = {}, withLogs = false, keepDir = false } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-access-'));
    const file = path.join(dir, 'access.txt');
    if (initial !== null) fs.writeFileSync(file, initial);

    const { status, output } = runAccessControlOn(file, { config, withLogs });
    const contents = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (!keepDir) fs.rmSync(dir, { recursive: true, force: true });
    return { status, contents, output, dir, file };
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
            CGATEWEB_SERIAL_DEVICE_LIB: SERIAL_DEVICE_LIB,
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

    it('strips bare pre-existing malformed lines (level names used as keywords)', () => {
        // Reproduces what an install written by the old buggy version of this
        // script (before the managed-block rewrite) looks like on disk: these
        // three lines predate the marker system entirely. Deleting the three
        // awk strip patterns would make this test fail, closing the gap where
        // no test previously covered them.
        const initial = [
            'interface 127.0.0.1',
            'program 127.0.0.1',
            'monitor 127.0.0.1',
            'keep-me'
        ].join('\n') + '\n';

        const { contents } = writeAccessControl({ initial });

        expect(contents).not.toMatch(/^interface 127\.0\.0\.1$/m);
        expect(contents).not.toMatch(/^program 127\.0\.0\.1$/m);
        expect(contents).not.toMatch(/^monitor 127\.0\.0\.1$/m);
        expect(contents).toContain('keep-me');
    });

    // External clients (issue #37): C-Bus Toolkit and similar tools connect to
    // the managed C-Gate directly rather than sharing the serial PCI.
    it('adds a remote rule per configured external client', () => {
        const { status, contents } = writeAccessControl({
            config: { CGW_EXTERNAL_RULES: 'remote 192.168.1.60 program\nremote 192.168.1.255 monitor' }
        });

        expect(status).toBe(0);
        expect(contents).toContain('remote 192.168.1.60 program');
        expect(contents).toContain('remote 192.168.1.255 monitor');
        // Localhost access is never dropped when external clients are added.
        expect(contents).toContain('remote 127.0.0.1 program');
    });

    it('revokes access when an address is removed from the option', () => {
        const withClient = writeAccessControl({
            config: { CGW_EXTERNAL_RULES: 'remote 192.168.1.60 program' }
        }).contents;
        expect(withClient).toContain('192.168.1.60');

        const withoutClient = writeAccessControl().contents;
        expect(withoutClient).not.toContain('192.168.1.60');
    });

    it('rejects an address that is not an IP or hostname', () => {
        const { status } = writeAccessControl({
            config: { CGW_EXTERNAL_RULES: 'remote not@a@host program' }
        });

        expect(status).not.toBe(0);
    });

    it('rejects a level outside monitor/operate/program', () => {
        const { status } = writeAccessControl({
            config: { CGW_EXTERNAL_RULES: 'remote 192.168.1.60 debug' }
        });

        expect(status).not.toBe(0);
    });

    it('rejects an entry with a missing level', () => {
        const { status } = writeAccessControl({
            config: { CGW_EXTERNAL_RULES: 'remote 192.168.1.60' }
        });

        expect(status).not.toBe(0);
    });

    // Fix round 2, IMPORTANT: an octet of 255 in a `remote` rule matches any
    // value in that position, so 255.255.255.255 is literally "any address
    // on the internet" -- there is no legitimate reason to configure it, and
    // this option exists to narrow access, not remove it.
    it('rejects 255.255.255.255 outright rather than granting the entire internet', () => {
        const { status } = writeAccessControl({
            config: { CGW_EXTERNAL_RULES: 'remote 255.255.255.255 program' }
        });

        expect(status).not.toBe(0);
    });

    it('states the expanded subnet meaning when an octet is wildcarded, not just the address', () => {
        const { status, output } = writeAccessControl({
            config: { CGW_EXTERNAL_RULES: 'remote 192.168.1.255 monitor' },
            withLogs: true
        });

        expect(status).toBe(0);
        // Must be unmistakable that this grants a whole /24, not read as an
        // ordinary single-host address.
        expect(output).toMatch(/WARNING:.*192\.168\.1\.x/);
    });

    // Fix round 2, MINOR 1: probed in review with cwd "/" and address "et?",
    // which the old unquoted `set -- ${line}` silently glob-expanded to
    // "etc" (a real top-level directory) before validation ever saw the "?"
    // -- yielding "remote etc monitor" instead of an error.
    it('rejects an address containing a glob character instead of letting it expand against the filesystem', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-access-'));
        const file = path.join(dir, 'access.txt');
        const env = {
            ...process.env,
            CGATEWEB_INSTALL_SOURCE_ONLY: '1',
            CGW_INSTALL_SCRIPT: SCRIPT,
            CGATEWEB_SERIAL_DEVICE_LIB: SERIAL_DEVICE_LIB,
            CGW_ACCESS_FILE: file,
            CGW_EXTERNAL_RULES: 'remote et? monitor'
        };
        const script = `
            set -u
            ${BASHIO_STUB}
            source "$CGW_INSTALL_SCRIPT"
            ${EXTERNAL_RULES_STUB}
            _cgateweb_write_access_control "$CGW_ACCESS_FILE"
        `;
        let status = 0;
        try {
            execFileSync('bash', ['-c', script], { encoding: 'utf8', env, stdio: 'pipe', cwd: '/' });
        } catch (e) {
            status = typeof e.status === 'number' ? e.status : 1;
        }
        fs.rmSync(dir, { recursive: true, force: true });

        expect(status).not.toBe(0);
    });
});

// MINOR 1: the real-world upgrade shape. The stock C-Gate 3.3.2 zip ships its
// own config/access.txt (captured verbatim in the fixture below from a real
// install at test-env/volumes/data/cgate/config/access.txt) containing valid
// `interface ... Program` loopback grants — not the malformed lines this
// suite's other tests are about. A managed install upgrading from a version
// that never touched access.txt sees exactly this file on first boot.
describeBash('_cgateweb_write_access_control (stock C-Gate access.txt upgrade shape)', () => {
    it('preserves the stock interface rules verbatim and appends exactly one managed block', () => {
        const { contents } = writeAccessControl({ initial: FIXTURE_STOCK_ACCESS });

        expect(contents).toContain('interface 0:0:0:0:0:0:0:1 Program');
        expect(contents).toContain('interface 127.0.0.1 Program');
        expect(contents).toContain('interface localhost Program');
        expect(contents.match(/cgateweb managed block/g)).toHaveLength(2);
        expect(contents).toContain('remote 127.0.0.1 program');
    });

    it('is byte-identical on a second run against the stock file', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-access-'));
        const file = path.join(dir, 'access.txt');
        fs.writeFileSync(file, FIXTURE_STOCK_ACCESS);

        runAccessControlOn(file);
        const first = fs.readFileSync(file, 'utf8');
        runAccessControlOn(file);
        const second = fs.readFileSync(file, 'utf8');
        fs.rmSync(dir, { recursive: true, force: true });

        expect(second).toBe(first);
        expect(second.match(/cgateweb managed block/g)).toHaveLength(2);
    });
});

// IMPORTANT 1: an awk failure (or any read/write/move failure) must not
// silently commit a file with every hand-added rule deleted, and the
// function must return non-zero so the caller's error branch is reachable.
// Every scenario below is a genuine production failure mode (unreadable
// file, read-only directory, path-is-a-directory) — not a stubbed-out awk —
// per the explicit instruction not to prove this branch with a fake.
describeBash('_cgateweb_write_access_control failure handling (IMPORTANT 1)', () => {
    itUnlessRoot('fails and leaves the original file untouched when it cannot be read', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-access-'));
        const file = path.join(dir, 'access.txt');
        const original = '# my own rule\nremote 10.0.0.9 monitor\n';
        fs.writeFileSync(file, original);
        fs.chmodSync(file, 0o000);

        const { status } = runAccessControlOn(file);

        // Restore read permission so the test can verify contents, then clean up.
        fs.chmodSync(file, 0o644);
        const contents = fs.readFileSync(file, 'utf8');
        const leftoverTmp = fs.readdirSync(dir).filter((f) => f.includes('.tmp') || f.includes('.awkerr'));
        fs.rmSync(dir, { recursive: true, force: true });

        expect(status).not.toBe(0);
        expect(contents).toBe(original);
        // MINOR 4: no leftover .tmp/.awkerr file after a failed rewrite.
        expect(leftoverTmp).toHaveLength(0);
    });

    it('fails without writing anything when the access file path is a directory', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-access-'));
        const file = path.join(dir, 'access.txt');
        fs.mkdirSync(file);

        const { status } = runAccessControlOn(file);

        const stillADir = fs.statSync(file).isDirectory();
        fs.rmSync(dir, { recursive: true, force: true });

        expect(status).not.toBe(0);
        expect(stillADir).toBe(true);
    });

    itUnlessRoot('fails when the config directory exists but is not writable', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-access-'));
        const configDir = path.join(dir, 'config');
        fs.mkdirSync(configDir);
        const file = path.join(configDir, 'access.txt');
        fs.chmodSync(configDir, 0o555);

        const { status } = runAccessControlOn(file);

        fs.chmodSync(configDir, 0o755);
        const wrote = fs.existsSync(file);
        fs.rmSync(dir, { recursive: true, force: true });

        expect(status).not.toBe(0);
        expect(wrote).toBe(false);
    });

    itUnlessRoot('fails when the parent directory cannot be created (unwritable grandparent)', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-access-'));
        fs.chmodSync(dir, 0o555);
        const file = path.join(dir, 'newsubdir', 'access.txt');

        const { status } = runAccessControlOn(file);

        fs.chmodSync(dir, 0o755);
        const wrote = fs.existsSync(file);
        fs.rmSync(dir, { recursive: true, force: true });

        expect(status).not.toBe(0);
        expect(wrote).toBe(false);
    });
});

// IMPORTANT 2: an orphaned begin marker (no matching end — a hand-mangled
// file) must not silently delete everything after it. Reproduces the exact
// probe input from the review: a hand-added deny/allow rule and trailing
// content after an unterminated managed block.
describeBash('_cgateweb_write_access_control orphaned marker handling (IMPORTANT 2)', () => {
    it('preserves content after an orphaned begin marker and warns', () => {
        const initial = [
            'keep-me-before',
            '# >>> cgateweb managed block - do not edit <<<',
            'remote 127.0.0.1 program',
            'user hand added admin',
            'keep-me-after'
        ].join('\n') + '\n';

        const { contents, output } = writeAccessControl({ initial, withLogs: true });

        expect(contents).toContain('keep-me-before');
        // The security-relevant loss called out in the review: a hand-added
        // rule (here a `user ... admin` grant, but the same fate would befall
        // a `remote <addr> none` deny rule) must survive.
        expect(contents).toContain('user hand added admin');
        expect(contents).toContain('keep-me-after');
        // A single well-formed managed block is still appended afterwards.
        expect(contents.match(/cgateweb managed block/g)).toHaveLength(2);
        expect(output).toMatch(/WARNING:.*orphan/i);
    });
});

// IMPORTANT 3: marker matching must tolerate CRLF endings / trailing
// whitespace so a hand-edited or Windows-saved file still resolves to one
// live managed block instead of two (the second, unrecognised "old" block
// stays live because C-Gate's Java readLine() strips \r but a naive awk
// exact-match does not).
describeBash('_cgateweb_write_access_control tolerant marker matching (IMPORTANT 3)', () => {
    it('recognises a begin marker with a trailing space and an end marker with a trailing \\r', () => {
        const initial = 'keep-me\r\n'
            + '# >>> cgateweb managed block - do not edit <<< \n'
            + 'remote 10.0.0.5 monitor\n'
            + '# <<< cgateweb managed block >>>\r\n';

        const { contents } = writeAccessControl({ initial });

        expect(contents).toContain('keep-me');
        // The old block's content must be recognised and replaced, not
        // preserved as ordinary text alongside a second fresh block.
        expect(contents).not.toContain('remote 10.0.0.5 monitor');
        expect(contents.match(/cgateweb managed block/g)).toHaveLength(2);
    });
});

// MINOR 2: pin the production call site. Runs the actual script body (not
// just the sourced-in-isolation helper) in managed mode with a pre-seeded
// cgate.jar so the install/download flow is skipped and the real call site
// (~line 702, `_cgateweb_write_access_control "${ACCESS_FILE}"`) is what
// writes the file. Guards against the heredoc this replaced ever coming back.
describeBash('cgate-install.sh call site (MINOR 2)', () => {
    it('invokes _cgateweb_write_access_control from the main managed-mode flow', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-install-e2e-'));
        const cgateDir = path.join(dir, 'cgate');
        fs.mkdirSync(cgateDir, { recursive: true });
        // Pre-seed cgate.jar so NEED_INSTALL stays 0 and the script skips the
        // whole download/extract flow (which needs network access), reaching
        // the access-control call site without any download/unzip mocking.
        fs.writeFileSync(path.join(cgateDir, 'cgate.jar'), 'stub');

        const env = {
            ...process.env,
            CGW_INSTALL_SCRIPT: SCRIPT,
            CGATEWEB_SERIAL_DEVICE_LIB: SERIAL_DEVICE_LIB,
            CGATE_DIR: cgateDir,
            CGW_TEST_cgate_mode: 'managed'
        };
        const script = `
            set -u
            ${BASHIO_STUB}
            source "$CGW_INSTALL_SCRIPT"
        `;
        execFileSync('bash', ['-c', script], { encoding: 'utf8', env, stdio: 'pipe' });

        const accessFile = path.join(cgateDir, 'config', 'access.txt');
        const contents = fs.readFileSync(accessFile, 'utf8');
        fs.rmSync(dir, { recursive: true, force: true });

        expect(contents).toContain('remote 127.0.0.1 program');
        expect(contents).toContain('remote 0:0:0:0:0:0:0:1 program');
        expect(contents.match(/cgateweb managed block/g)).toHaveLength(2);
    });
});

// Proves the real _cgateweb_external_client_rules reader (not the
// EXTERNAL_RULES_STUB used above) actually flattens bashio's object-list
// config correctly. See REAL_BASHIO_CONFIG_STUB for what's faithful-copy vs.
// simplified from upstream bashio.
describeJq('_cgateweb_external_client_rules (real bashio::config reader)', () => {
    function runExternalClientRules(optionsObj, { withLogs = false } = {}) {
        const env = {
            ...process.env,
            CGATEWEB_INSTALL_SOURCE_ONLY: '1',
            CGW_INSTALL_SCRIPT: SCRIPT,
            CGATEWEB_SERIAL_DEVICE_LIB: SERIAL_DEVICE_LIB,
            CGW_VENDOR_CONFIG_SH: VENDOR_CONFIG_SH,
            CGW_VENDOR_JQ_SH: VENDOR_JQ_SH,
            CGW_OPTIONS_JSON: JSON.stringify(optionsObj)
        };
        // The vendored bashio needs the log functions defined before it is
        // sourced, so surfacing them is a redefinition afterwards rather than a
        // different stub.
        const logCapture = withLogs
            ? `bashio::log.error() { printf 'ERROR: %s\\n' "$*"; }`
            : '';
        const script = `
            set -u
            ${REAL_BASHIO_CONFIG_STUB}
            source "$CGW_INSTALL_SCRIPT"
            ${logCapture}
            # bash 3.2 (macOS's system /bin/bash) throws "unbound variable"
            # expanding an empty array inside the vendored bashio::jq under
            # set -u -- a real upstream bug, fixed in bash 4.4+. CI's
            # ubuntu-latest ships a modern bash and is unaffected; relax
            # nounset here (cgate-install.sh's own "set -uo pipefail" just
            # re-enabled it via the source above) rather than patch the
            # vendored file to route around a bash version it was never
            # written to support.
            set +u
            _cgateweb_external_client_rules
        `;
        return execFileSync('bash', ['-c', script], { encoding: 'utf8', env });
    }

    it('flattens a real object-list config into remote rules', () => {
        const output = runExternalClientRules({
            cgate_external_clients: [
                { address: '192.168.1.60', level: 'program' },
                { address: '192.168.1.255', level: 'monitor' }
            ]
        });

        expect(output).toContain('remote 192.168.1.60 program');
        expect(output).toContain('remote 192.168.1.255 monitor');
    });

    it('emits nothing for an empty list, matching the inert default', () => {
        const output = runExternalClientRules({ cgate_external_clients: [] });
        expect(output.trim()).toBe('');
    });

    it('emits nothing when the option is entirely absent (pre-upgrade config)', () => {
        const output = runExternalClientRules({});
        expect(output.trim()).toBe('');
    });

    // Fix round 2, MINOR 2: a newline embedded in one option entry's address
    // (a copy-paste slip) used to split the printf output into two lines,
    // each independently validated and written as an extra `remote` rule the
    // user never authored. Must abort loudly instead.
    it('aborts rather than emitting extra rules when an address contains a newline', () => {
        expect(() => runExternalClientRules({
            cgate_external_clients: [
                { address: '192.168.1.60\n8.8.8.8', level: 'monitor' }
            ]
        })).toThrow();
    });

    // A blank address was skipped with a bare `continue`, so a user who added
    // a row and left the address empty got no rule and no message -- and would
    // believe external access had been granted. Must fail like the level check.
    it('rejects a blank address instead of silently skipping the entry', () => {
        expect(() => runExternalClientRules({
            cgate_external_clients: [
                { address: '', level: 'monitor' }
            ]
        })).toThrow();
    });

    it('rejects an entirely missing address instead of silently skipping the entry', () => {
        expect(() => runExternalClientRules({
            cgate_external_clients: [
                { level: 'monitor' }
            ]
        })).toThrow();
    });

    it('names the offending entry index when an address is blank', () => {
        // The user has to know WHICH row to fix; the rules reader logs nothing
        // else identifying about the entry.
        let output = '';
        try {
            runExternalClientRules(
                {
                    cgate_external_clients: [
                        { address: '192.168.1.60', level: 'monitor' },
                        { address: '', level: 'monitor' }
                    ]
                },
                { withLogs: true }
            );
        } catch (err) {
            output = `${err.stdout || ''}${err.stderr || ''}`;
        }
        expect(output).toMatch(/ERROR: Missing address for cgate_external_clients entry 1/);
    });

    // Fix round 2, MINOR 3: unreachable through the HA UI (the schema's
    // level field is a required list()), but a hand-edited options.json
    // could still hit this. Must fail loud like every other invalid level
    // rather than silently downgrading to monitor.
    it('rejects a missing level instead of silently defaulting to monitor', () => {
        expect(() => runExternalClientRules({
            cgate_external_clients: [
                { address: '192.168.1.60' }
            ]
        })).toThrow();
    });
});
