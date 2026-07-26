const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { posixBashAvailable } = require('./helpers/posixBash');

// Runs the Linux rootfs recovery script via bash; skipped where no POSIX bash
// is usable (see helper).
const describeBash = posixBashAvailable() ? describe : describe.skip;

const SCRIPT = path.join(
    __dirname, '..', 'homeassistant-addon', 'rootfs', 'usr', 'bin', 'cgateweb-recover-serial'
);

// The repo copies of the two node helpers. `node` itself is stubbed below, so
// these are never executed — but the script now checks the resolver is readable
// before running it (node exits 1 for a missing script too, which the exit-code
// contract would otherwise read as "the device is absent"), so the default has
// to be a path that really exists.
const RESOLVER_JS = path.join(
    __dirname, '..', 'homeassistant-addon', 'rootfs', 'usr', 'bin', 'cgateweb-resolve-serial.js'
);
const FIXUP_JS = path.join(
    __dirname, '..', 'homeassistant-addon', 'rootfs', 'usr', 'bin', 'cgateweb-project-serial-fixup.js'
);

// Stand-ins for the three externals the script uses. `node` dispatches on the
// script it was handed (resolver vs project fixup) and records every call;
// `kill` is a shell builtin, so it can only be intercepted by a function.
const STUBS = `
    node() {
        local script="$1"; shift
        printf '%s %s\\n' "$script" "$*" >> "\${CGW_DIR}/node-calls.txt"
        case "\${script}" in
            *resolve-serial*)
                printf 'WARN: Serial device not found: %s\\n' "$1" >&2
                if [[ "\${CGW_RESOLVER_STATUS:-0}" == "0" ]]; then
                    printf 'INFO: chatter on stderr\\n' >&2
                    printf '%s\\n' "\${CGW_RESOLVED:-/dev/ttyUSB1}"
                fi
                return "\${CGW_RESOLVER_STATUS:-0}"
                ;;
            *serial-fixup*)
                printf 'rewrote project interface network 254: serial/ttyUSB0 -> serial/ttyUSB1\\n'
                return "\${CGW_FIXUP_STATUS:-0}"
                ;;
            *)
                printf 'unexpected node script: %s\\n' "\${script}" >&2
                return 99
                ;;
        esac
    }
    kill() {
        printf '%s\\n' "$*" >> "\${CGW_DIR}/kill-calls.txt"
        return "\${CGW_KILL_STATUS:-0}"
    }
`;

/**
 * Build a throwaway environment: a fake /proc containing (by default) a running
 * C-Gate JVM, and a projects dir with two project databases.
 */
function makeEnv({ cgateRunning = true, projects = ['HOME', 'SHED'] } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-recover-'));
    const procRoot = path.join(dir, 'proc');
    // A non-numeric entry (excluded by the pid glob) and an unrelated process.
    fs.mkdirSync(path.join(procRoot, 'self'), { recursive: true });
    fs.mkdirSync(path.join(procRoot, '1'), { recursive: true });
    fs.writeFileSync(path.join(procRoot, '1', 'cmdline'), '/bin/bash\0/run.sh\0');
    if (cgateRunning) {
        fs.mkdirSync(path.join(procRoot, '4242'), { recursive: true });
        fs.writeFileSync(
            path.join(procRoot, '4242', 'cmdline'),
            'java\0-Djava.awt.headless=true\0-jar\0/data/cgate/cgate.jar\0-s\0'
        );
    }
    const projectsDir = path.join(dir, 'Projects');
    for (const project of projects) {
        fs.mkdirSync(path.join(projectsDir, project), { recursive: true });
        fs.writeFileSync(path.join(projectsDir, project, `${project}.db`), 'db');
    }
    return { dir, procRoot, projectsDir };
}

function runRecover({ env: envOverrides = {}, args = ['/dev/ttyUSB0'], setup = {} } = {}) {
    const { dir, procRoot, projectsDir } = makeEnv(setup);
    const env = {
        ...process.env,
        CGW_SCRIPT: SCRIPT,
        CGW_DIR: dir,
        CGATEWEB_PROC_ROOT: procRoot,
        CGATEWEB_PROJECTS_DIR: projectsDir,
        CGATEWEB_RESOLVE_SERIAL_JS: RESOLVER_JS,
        CGATEWEB_PROJECT_FIXUP_JS: FIXUP_JS,
        ...envOverrides
    };
    const quoted = args.map(a => `'${a}'`).join(' ');
    const script = `${STUBS}\n source "$CGW_SCRIPT" ${quoted}`;
    // spawnSync, not execFileSync: stderr is asserted on the success paths too.
    const proc = spawnSync('bash', ['-c', script], { encoding: 'utf8', env });
    const read = f => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : '');
    return {
        status: proc.status,
        stdout: proc.stdout || '',
        stderr: proc.stderr || '',
        nodeCalls: read('node-calls.txt'),
        killCalls: read('kill-calls.txt'),
        dir,
        projectsDir
    };
}

function cleanup(result) {
    fs.rmSync(result.dir, { recursive: true, force: true });
}

describeBash('cgateweb-recover-serial (issue #28)', () => {
    it('re-resolves, repoints every project, then SIGTERMs C-Gate', () => {
        const r = runRecover();
        try {
            expect(r.status).toBe(0);
            // Contract with SerialDeviceRecovery: resolved path on the last stdout line.
            expect(r.stdout.trim().split('\n').pop()).toBe('/dev/ttyUSB1');

            // The resolver is asked about the *configured* option, not the
            // already-resolved path; the fixup is then given the resolved one.
            expect(r.nodeCalls).toMatch(/cgateweb-resolve-serial\.js \/dev\/ttyUSB0/);
            expect(r.nodeCalls).toMatch(/cgateweb-project-serial-fixup\.js .*HOME\/HOME\.db \/dev\/ttyUSB1 --repoint-stale-serial/);
            expect(r.nodeCalls).toMatch(/cgateweb-project-serial-fixup\.js .*SHED\/SHED\.db \/dev\/ttyUSB1 --repoint-stale-serial/);

            // SIGTERM (not SIGKILL) so the JVM closes the project db cleanly.
            expect(r.killCalls.trim()).toBe('-TERM 4242');
        } finally {
            cleanup(r);
        }
    });

    it('exits 2 with a usage message when no configured device is given', () => {
        const r = runRecover({ args: [] });
        try {
            expect(r.status).toBe(2);
            expect(r.stderr).toMatch(/usage: cgateweb-recover-serial/);
            expect(r.nodeCalls).toBe('');
        } finally {
            cleanup(r);
        }
    });

    it('exits 1 and restarts nothing when the device cannot be found again', () => {
        // Resolver exit 1 = the configured device is absent and unrecoverable.
        // Restarting C-Gate would be pointless churn, and the project must not
        // be repointed at a device that is not there.
        const r = runRecover({ env: { CGW_RESOLVER_STATUS: '1' } });
        try {
            expect(r.status).toBe(1);
            expect(r.stderr).toMatch(/not present/i);
            expect(r.nodeCalls).not.toMatch(/serial-fixup/);
            expect(r.killCalls).toBe('');
        } finally {
            cleanup(r);
        }
    });

    it('exits 2, not 1, when the resolver script is missing from the image', () => {
        // node exits 1 for a missing or unreadable script as well, and the caller
        // reads 1 as "the device was absent" - which deliberately does NOT charge
        // the attempt budget, so that the poll loop is still watching whenever the
        // interface is plugged back in. A broken image reported that way would
        // therefore re-spawn this helper on every poll for ever, while telling the
        // user their PC Interface could not be found. It has to be exit 2.
        const r = runRecover({ env: { CGATEWEB_RESOLVE_SERIAL_JS: '/nonexistent/cgateweb-resolve-serial.js' } });
        try {
            expect(r.status).toBe(2);
            expect(r.stderr).toMatch(/missing or unreadable/);
            expect(r.stderr).toMatch(/broken add-on image/);
            // The device was never examined, so nothing may claim it was absent.
            expect(r.stderr).not.toMatch(/not present/i);
            expect(r.nodeCalls).toBe('');
            expect(r.killCalls).toBe('');
        } finally {
            cleanup(r);
        }
    });

    it('exits 2 and restarts nothing when the resolver fails for another reason', () => {
        // Resolver exit 2 = e.g. a recovered path that could not be published,
        // so the later steps would disagree about which device is in use.
        const r = runRecover({ env: { CGW_RESOLVER_STATUS: '2' } });
        try {
            expect(r.status).toBe(2);
            expect(r.stderr).toMatch(/resolver exited 2/);
            expect(r.nodeCalls).not.toMatch(/serial-fixup/);
            expect(r.killCalls).toBe('');
        } finally {
            cleanup(r);
        }
    });

    it('still restarts C-Gate when a project fixup fails', () => {
        // Best-effort, as at cont-init: C-Gate may still open correctly (the
        // project could already name the right port), so a fixup crash must not
        // block the restart that is the whole point of recovery.
        const r = runRecover({ env: { CGW_FIXUP_STATUS: '1' } });
        try {
            expect(r.status).toBe(0);
            expect(r.stderr).toMatch(/project serial fixup failed/);
            expect(r.killCalls.trim()).toBe('-TERM 4242');
        } finally {
            cleanup(r);
        }
    });

    it('succeeds when there are no project databases to repoint', () => {
        const r = runRecover({ setup: { projects: [] } });
        try {
            expect(r.status).toBe(0);
            expect(r.nodeCalls).not.toMatch(/serial-fixup/);
            expect(r.killCalls.trim()).toBe('-TERM 4242');
        } finally {
            cleanup(r);
        }
    });

    it('exits 2 when no C-Gate process is running', () => {
        const r = runRecover({ setup: { cgateRunning: false } });
        try {
            expect(r.status).toBe(2);
            expect(r.stderr).toMatch(/C-Gate/);
            expect(r.killCalls).toBe('');
        } finally {
            cleanup(r);
        }
    });

    it('exits 2 when the signal cannot be delivered', () => {
        const r = runRecover({ env: { CGW_KILL_STATUS: '1' } });
        try {
            expect(r.status).toBe(2);
            expect(r.stderr).toMatch(/could not signal/i);
        } finally {
            cleanup(r);
        }
    });
});
