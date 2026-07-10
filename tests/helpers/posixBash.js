'use strict';

const { execFileSync } = require('child_process');

/**
 * Whether the add-on shell-script integration tests can actually run here.
 *
 * These suites spawn `bash` to `source` the Linux rootfs scripts and pass the
 * script path plus config through environment variables. That model only works
 * on a POSIX host:
 *   - On Windows the resolved `bash` is typically WSL, which does not inherit
 *     the parent process's Windows environment variables (so the script-path
 *     var arrives empty) and cannot read `D:\...` style paths. The scripts
 *     themselves are only ever executed inside the Linux add-on container, so
 *     there is nothing meaningful to verify on Windows.
 *
 * When this returns false the caller should use `describe.skip` so the suite is
 * reported as skipped (not failed) locally while still running on Linux CI.
 *
 * @returns {boolean}
 */
function posixBashAvailable() {
    if (process.platform === 'win32') {
        return false;
    }
    try {
        // Confirm a bash that inherits env vars is on PATH.
        const out = execFileSync('bash', ['-c', 'printf %s "$CGW_BASH_PROBE"'], {
            encoding: 'utf8',
            env: { ...process.env, CGW_BASH_PROBE: 'ok' }
        });
        return out.trim() === 'ok';
    } catch {
        return false;
    }
}

module.exports = { posixBashAvailable };
