const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { posixBashAvailable } = require('./helpers/posixBash');
const { addonPath } = require('./helpers/addonPaths');
const { BASHIO_STUB_WITH_LOGS } = require('./helpers/bashioStub');

// This suite sources the Linux rootfs service script via bash; only run where
// a POSIX bash is usable (Linux CI, macOS). Skipped on Windows (see helper).
const describeBash = posixBashAvailable() ? describe : describe.skip;

const SCRIPT = addonPath('etc', 'services.d', 'cgate', 'run');

// The script ends in `exec java ...` (or `exec sleep infinity`), so a shell
// function cannot stand in for either - exec bypasses functions. Put real
// stubs on PATH instead; each prints the argv the script built and exits, and
// the exec replaces the test's bash with them, so stdout is what we assert on.
function makeStubBin(root) {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'java'), '#!/bin/sh\necho "JAVA $*"\n');
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\necho "SLEEP $*"\n');
    fs.chmodSync(path.join(bin, 'java'), 0o755);
    fs.chmodSync(path.join(bin, 'sleep'), 0o755);
    return bin;
}

function runService({ mode = 'managed', installJar = true } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgate-service-run-'));
    const cgateDir = path.join(root, 'cgate');
    fs.mkdirSync(cgateDir, { recursive: true });
    if (installJar) fs.writeFileSync(path.join(cgateDir, 'cgate.jar'), 'not-really-a-jar');

    const env = {
        ...process.env,
        PATH: `${makeStubBin(root)}${path.delimiter}${process.env.PATH}`,
        CGATE_DIR: cgateDir,
        // Passed through the environment rather than interpolated into the
        // command text, so the absolute path is never part of the command.
        CGW_SERVICE_SCRIPT: SCRIPT,
        CGW_TEST_cgate_mode: mode
    };

    try {
        return execFileSync('bash', ['-c', `
            set -u
            ${BASHIO_STUB_WITH_LOGS}
            source "$CGW_SERVICE_SCRIPT"
        `], { encoding: 'utf8', env });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

describeBash('services.d/cgate/run', () => {
    // Issue #122: the add-on started C-Gate with -s, which answers `get cgate
    // ServerMode` with yes. C-Bus Toolkit reads that and loads the unit
    // catalogue locally instead of from this C-Gate, so it reports "No Catalog
    // Available" and lists no networks against an otherwise healthy server.
    test('does not start C-Gate in server mode', () => {
        const out = runService();

        expect(out).toContain('JAVA ');
        expect(out).not.toMatch(/(^|\s)-s(\s|$)/m);
        expect(out).not.toContain('--servermode');
    });

    test('runs the installed jar headless', () => {
        const out = runService();

        expect(out).toMatch(/JAVA .*-Djava\.awt\.headless=true/);
        expect(out).toMatch(/JAVA .*-jar \S+cgate\.jar/);
    });

    test('sleeps instead of starting C-Gate in remote mode', () => {
        const out = runService({ mode: 'remote' });

        expect(out).toContain('SLEEP infinity');
        expect(out).not.toContain('JAVA ');
    });

    test('reports a missing install rather than starting java', () => {
        let error;
        try {
            runService({ installJar: false });
        } catch (e) {
            error = e;
        }

        expect(error).toBeDefined();
        expect(error.status).toBe(1);
        expect(error.stdout).toContain('C-Gate not installed');
        expect(error.stdout).not.toContain('JAVA ');
    });
});
