const { execFileSync } = require('child_process');
const { posixBashAvailable } = require('./helpers/posixBash');
const { BASHIO_STUB } = require('./helpers/bashioStub');
const { addonLib } = require('./helpers/addonPaths');

// These tests source the Linux rootfs shell helper via bash; only run where a
// POSIX bash is usable (Linux CI, macOS). Skipped on Windows (see helper).
const describeBash = posixBashAvailable() ? describe : describe.skip;

const LIB = addonLib('supervisor-wait.sh');

function runWait({ stubExtra = '', env = {} } = {}) {
    const script = `
        set -u
        ${BASHIO_STUB}
        ${stubExtra}
        source "$CGW_WAIT_LIB"
        cgateweb_wait_for_supervisor
    `;
    return execFileSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: { ...process.env, CGW_WAIT_LIB: LIB, ...env }
    });
}

describeBash('supervisor-wait.sh', () => {
    test('returns immediately when the Supervisor API answers on the first probe', () => {
        // BASHIO_STUB's bashio::config always succeeds, so no retry happens.
        expect(() => runWait()).not.toThrow();
    });

    test('retries while the API is down and succeeds once it answers', () => {
        // Simulate the test-env race: bashio::config dies hard (exit 1, like
        // real bashio::exit.nok) until the third probe. The attempt counter
        // lives in a file because each probe runs in a command substitution
        // subshell whose variable changes would not survive. `sleep` is
        // stubbed out so the retry loop runs fast.
        const stubExtra = `
            COUNTER_FILE="$(mktemp)"
            echo 0 > "$COUNTER_FILE"
            bashio::config() {
                local n
                n=$(cat "$COUNTER_FILE")
                n=$((n + 1))
                echo "$n" > "$COUNTER_FILE"
                if [[ "$n" -lt 3 ]]; then
                    exit 1
                fi
                printf 'managed'
            }
            sleep() { :; }
        `;
        const out = execFileSync('bash', ['-c', `
            set -u
            ${BASHIO_STUB}
            ${stubExtra}
            source "$CGW_WAIT_LIB"
            cgateweb_wait_for_supervisor
            cat "$COUNTER_FILE"
        `], { encoding: 'utf8', env: { ...process.env, CGW_WAIT_LIB: LIB } });
        // Three probes: two hard failures (confined to their subshells) and
        // one success, proving the retry loop survived bashio's exit.
        expect(out.trim()).toBe('3');
    });

    test('gives up with a non-zero status after the attempt budget', () => {
        const stubExtra = `
            bashio::config() { exit 1; }
            sleep() { :; }
        `;
        let status = 0;
        try {
            runWait({ stubExtra, env: { CGATEWEB_SUPERVISOR_WAIT_ATTEMPTS: '3' } });
        } catch (err) {
            status = err.status;
        }
        expect(status).toBe(1);
    });
});
