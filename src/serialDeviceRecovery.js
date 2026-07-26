// @ts-check
'use strict';

const nodeFs = require('fs');
const nodePath = require('path');
const { execFileSync } = require('child_process');
const { backoffDelay } = require('./backoff');
const { defaultSettings } = require('./defaultSettings');

const DEFAULT_DEVICE_FILE = '/run/cgateweb/serial-device';
const DEFAULT_RECOVER_SCRIPT = '/usr/bin/cgateweb-recover-serial';

// The recovery script's exit codes (shared with cgateweb-resolve-serial.js):
// 1 means the device is genuinely absent, anything else non-zero is a failure
// of the recovery itself.
const EXIT_DEVICE_ABSENT = 1;

/**
 * Recover from a USB PC Interface that renumbered while the add-on was running
 * (issue #28).
 *
 * A replugged PCI can come back on a different ttyUSBn. C-Gate keeps holding the
 * port it opened, the network sits at InterfaceState=closed, and until now only
 * an add-on restart fixed it. NetworkInterfaceMonitor already polls each
 * network's interface state, so recovery hangs off that - off every offline
 * reading, not just the transition, because the transition happens while the
 * PCI is still out and the replug that follows changes nothing the monitor can
 * report.
 *
 * Two signals distinguish a renumber from a genuine fault:
 *   - the device path C-Gate was pointed at has vanished (a raw /dev/ttyUSBn
 *     configuration), or
 *   - that path still exists but now resolves to a different port (a
 *     /dev/serial/by-id configuration, where udev recreates the same link name
 *     over the new tty).
 * A CNI dropout does neither — and a CNI install has no cgate_serial_device at
 * all, so recovery is inert for it.
 *
 * The work itself is a rootfs script (cgateweb-recover-serial): re-resolve the
 * device by its remembered identity, repoint every project database at the new
 * port, then signal C-Gate so s6 restarts it. All three steps are needed;
 * restarting the service does not re-run cont-init, so a project left naming the
 * old port would reopen straight onto a closed interface.
 */
class SerialDeviceRecovery {
    /**
     * @param {object} deps
     * @param {Record<string, any>} [deps.settings]
     * @param {{info: Function, warn: Function, error: Function, debug: Function}} [deps.logger]
     * @param {any} [deps.fsImpl] - injected for tests (existsSync/readFileSync/realpathSync)
     * @param {(file: string, args: string[]) => {status: number, stdout?: string, stderr?: string, error?: any}} [deps.execImpl]
     * @param {() => number} [deps.now]
     */
    constructor({ settings, logger, fsImpl, execImpl, now } = {}) {
        this.settings = settings || {};
        this.logger = logger || null;
        this.fs = fsImpl || nodeFs;
        this.exec = execImpl || ((file, args) => this._runScript(file, args));
        this.now = now || Date.now;
        /**
         * Per-network recovery state. `reported` holds the messages already
         * logged loudly during the current outage (see _reportOnce).
         * @type {Map<string, {attempts: number, lastAttemptAt: number, lastUpAt: number|null, portInUse: string|null, reported: Set<string>}>}
         */
        this.networks = new Map();
    }

    /**
     * @param {string} key
     * @returns {any} The configured value, or the shipped default.
     */
    _setting(key) {
        const value = this.settings[key];
        return value === undefined || value === null ? defaultSettings[key] : value;
    }

    /** @returns {boolean} True only when a local serial PCI is in play at all. */
    _appliesHere() {
        if (!this.settings.cgate_serial_device) return false;
        return String(this.settings.cgate_mode) === 'managed';
    }

    /**
     * The device path C-Gate was actually pointed at: the one cont-init's
     * resolver published, falling back to the configured option when the
     * resolver never ran or could not publish. Reading the option alone would
     * mistake a renumber cont-init already handled for a fresh one.
     * @returns {string}
     */
    _effectiveDevicePath() {
        const deviceFile = process.env.CGATEWEB_SERIAL_DEVICE_FILE || DEFAULT_DEVICE_FILE;
        try {
            const published = String(this.fs.readFileSync(deviceFile, 'utf8')).trim();
            if (published) return published;
        } catch {
            // Not the add-on, or the resolver could not publish: use the option.
        }
        return String(this.settings.cgate_serial_device);
    }

    /**
     * The port a device path currently resolves to (its realpath), or null when
     * the path is gone. Used to notice a by-id link whose target moved.
     * @param {string} devicePath
     * @returns {string|null}
     */
    _portFor(devicePath) {
        try {
            return String(this.fs.realpathSync(devicePath));
        } catch {
            return null;
        }
    }

    /** @param {string} networkId */
    _stateFor(networkId) {
        const id = String(networkId);
        let state = this.networks.get(id);
        if (!state) {
            state = { attempts: 0, lastAttemptAt: 0, lastUpAt: null, portInUse: null, reported: new Set() };
            this.networks.set(id, state);
        }
        return state;
    }

    /**
     * Log an outage report at its natural level the first time it is seen, and at
     * debug if it repeats. handleInterfaceDown runs on every poll while the
     * interface is down (that is how a replug gets noticed), so a PC Interface
     * left unplugged would otherwise repeat the same warning every poll for as
     * long as it stays out. The set is cleared when the interface comes back, so
     * the next outage says everything again.
     * @param {{reported: Set<string>}} state
     * @param {'info'|'warn'|'error'|'debug'} level
     * @param {string} message
     */
    _reportOnce(state, level, message) {
        const firstTimeThisOutage = !state.reported.has(message);
        state.reported.add(message);
        this._log(firstTimeThisOutage ? level : 'debug', message);
    }

    /**
     * Called for every reading that shows a network's interface down - not only
     * the transition. C-Gate reports a closed network as closed on every poll, so
     * the transition is the one moment the PC Interface is guaranteed still to be
     * unplugged; the replug that follows produces no transition at all. Repeats
     * are throttled by the backoff and the attempt cap below, and their reports
     * are deduplicated by _reportOnce.
     * @param {string} networkId
     * @returns {{action: 'ignored'|'reported'|'recovered'|'failed', message: string|null}}
     */
    handleInterfaceDown(networkId) {
        if (!this._appliesHere()) {
            return { action: 'ignored', message: null };
        }

        const device = this._effectiveDevicePath();
        const state = this._stateFor(networkId);
        const port = this._portFor(device);
        const vanished = port === null;
        // A by-id path survives a replug, so only its target moving betrays the
        // renumber. portInUse is unknown until the interface has been seen up,
        // in which case stay conservative and treat this as a genuine fault.
        const moved = !vanished && state.portInUse !== null && port !== state.portInUse;

        if (!vanished && !moved) {
            this._log('debug', `C-Bus network ${networkId} interface went down but ${device} is unchanged; not a PC Interface renumber.`);
            return { action: 'reported', message: null };
        }

        const message = vanished
            ? `C-Bus PC Interface ${device} is no longer present (network ${networkId})`
            : `C-Bus PC Interface ${device} now points at ${port} instead of ${state.portInUse} (network ${networkId})`;
        this._reportOnce(state, 'warn', message);

        if (this._setting('serialRecoveryEnabled') === false) {
            return { action: 'reported', message };
        }

        // A new outage after the interface stayed up for a stable period is not
        // the same trouble as the last one, so it gets a fresh budget. A rapid
        // flap does not, which is what stops a loose connector restarting C-Gate
        // indefinitely.
        const now = this.now();
        const stableWindowMs = Number(this._setting('serialRecoveryStableWindowMs'));
        if (state.attempts > 0 && state.lastUpAt !== null && (now - state.lastUpAt) >= stableWindowMs) {
            state.attempts = 0;
        }

        const maxAttempts = Number(this._setting('serialRecoveryMaxAttempts'));
        if (state.attempts >= maxAttempts) {
            const exhausted = `${message}. Recovery gave up after ${maxAttempts} attempt(s); `
                + 'reconnect the PC Interface and restart the add-on.';
            this._reportOnce(state, 'error', exhausted);
            return { action: 'reported', message: exhausted };
        }

        // Spread repeated attempts: restarting C-Gate is disruptive, and an
        // interface that flaps faster than it can be recovered must not turn
        // into a restart loop.
        if (state.attempts > 0) {
            const waitMs = backoffDelay(state.attempts - 1, {
                initialMs: Number(this._setting('serialRecoveryInitialDelayMs')),
                maxMs: Number(this._setting('serialRecoveryMaxDelayMs')),
                // No jitter: there is one local device, so there is no herd to
                // spread, and a predictable delay is easier to read in a log.
                jitter: false
            });
            const dueAt = state.lastAttemptAt + waitMs;
            if (now < dueAt) {
                const waiting = `${message}. Waiting ${Math.ceil((dueAt - now) / 1000)}s before the next recovery attempt `
                    + `(${state.attempts} of ${maxAttempts} already tried).`;
                this._reportOnce(state, 'warn', waiting);
                return { action: 'reported', message: waiting };
            }
        }

        state.attempts += 1;
        state.lastAttemptAt = now;

        // One script, all three steps: re-resolve, repoint the project
        // databases, restart C-Gate.
        const script = process.env.CGATEWEB_RECOVER_SCRIPT || DEFAULT_RECOVER_SCRIPT;
        const result = this.exec(script, [String(this.settings.cgate_serial_device)]);

        if (result.status !== 0) {
            const failed = `${message}. Recovery failed: ${this._failureReason(script, result)}`;
            this._reportOnce(state, 'error', failed);
            return { action: 'failed', message: failed };
        }

        // The script's stderr carries the resolver's and the project fixup's
        // narration of what moved where - worth keeping for issue triage.
        for (const line of String(result.stderr || '').split('\n')) {
            if (line.trim()) this._log('debug', `cgateweb-recover-serial: ${line.trim()}`);
        }

        const newPath = String(result.stdout || '').trim().split('\n').pop();
        const recovered = `Re-resolved the PC Interface to ${newPath}, repointed the project and restarted C-Gate `
            + `to reopen network ${networkId}`;
        this._log('warn', recovered);
        return { action: 'recovered', message: recovered };
    }

    /**
     * Called when a network's interface comes back. Records the port C-Gate is
     * now running on (the baseline a later renumber is measured against) and
     * when it came up (which decides whether the next outage gets a fresh
     * attempt budget).
     * @param {string} networkId
     */
    handleInterfaceUp(networkId) {
        if (!this._appliesHere()) return;
        const state = this._stateFor(networkId);
        state.lastUpAt = this.now();
        // The outage is over, so its reports may all be said again next time.
        state.reported.clear();
        state.portInUse = this._portFor(this._effectiveDevicePath());
        if (state.attempts > 0) {
            this._log('info', `C-Bus network ${networkId} interface is back on ${state.portInUse} `
                + `after ${state.attempts} recovery attempt(s).`);
        }
    }

    /**
     * @param {string} script
     * @param {{status: number, stdout?: string, stderr?: string, error?: any}} result
     * @returns {string}
     */
    _failureReason(script, result) {
        if (result.error && result.error.code === 'ENOENT') {
            return `the recovery helper ${script} is not installed (it ships with the Home Assistant add-on)`;
        }
        if (result.error && result.error.code === 'ETIMEDOUT') {
            return `the recovery helper ${script} timed out`;
        }
        // The script tags its lines WARN:/INFO:; the last one is the verdict.
        const lines = String(result.stderr || '').split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length) return lines[lines.length - 1];
        return result.status === EXIT_DEVICE_ABSENT
            ? 'the PC Interface could not be found under any name'
            : `${nodePath.basename(script)} exited ${result.status}`;
    }

    /**
     * Default child-process runner. Synchronous on purpose: recovery is a rare,
     * ordered sequence (resolve, repoint, restart) and the bridge has nothing
     * useful to do until C-Gate is back. The timeout is what keeps a wedged
     * helper from wedging the bridge with it.
     * @param {string} file
     * @param {string[]} args
     * @returns {{status: number, stdout: string, stderr: string, error?: any}}
     */
    _runScript(file, args) {
        try {
            const stdout = execFileSync(file, args, {
                encoding: 'utf8',
                timeout: Number(this._setting('serialRecoveryTimeoutMs')),
                stdio: ['ignore', 'pipe', 'pipe']
            });
            return { status: 0, stdout, stderr: '' };
        } catch (e) {
            const err = /** @type {any} */ (e);
            return {
                status: typeof err.status === 'number' ? err.status : 1,
                stdout: String(err.stdout || ''),
                stderr: String(err.stderr || ''),
                error: err
            };
        }
    }

    /**
     * @param {'info'|'warn'|'error'|'debug'} level
     * @param {string} message
     */
    _log(level, message) {
        if (this.logger && typeof this.logger[level] === 'function') this.logger[level](message);
    }
}

module.exports = SerialDeviceRecovery;
