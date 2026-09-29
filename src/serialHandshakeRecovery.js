// @ts-check
'use strict';

const { backoffDelay } = require('./backoff');
const { resolveSetting, resolveClampedSetting } = require('./config/schema');
const { NEWLINE } = require('./constants');

const INTERFACE_OPENING = 'opening';
const INTERFACE_RUNNING = 'running';
const STATE_NEW = 'new';
// Later attempts back off from serialHandshakeRetryAfterMs up to this multiple.
const MAX_BACKOFF_MULTIPLIER = 8;

/**
 * Close and reopen a USB PC Interface network whose handshake never finishes
 * (issue #122).
 *
 * C-Gate creates the serial network, starts opening the port, and can sit at
 * InterfaceState=opening / State=new indefinitely. The device path is present
 * and unchanged, so SerialDeviceRecovery rightly does nothing, and restarting
 * the add-on repeats the same handshake. NET CLOSE then NET OPEN retries the
 * handshake on the running C-Gate.
 *
 * Inert unless managed mode has a cgate_serial_device configured, so CNI
 * installs never see it.
 */
class SerialHandshakeRecovery {
    /**
     * @param {object} deps
     * @param {Record<string, any>} [deps.settings]
     * @param {{info: Function, warn: Function, error: Function, debug: Function}} [deps.logger]
     * @param {(command: string) => void} deps.sendCommand
     * @param {() => number} [deps.now]
     */
    constructor({ settings, logger, sendCommand, now }) {
        this.settings = settings || {};
        this.logger = logger || null;
        this.sendCommand = sendCommand;
        this.now = now || Date.now;
        /**
         * @type {Map<string, {openingSince: number|null, attempts: number, lastAttemptAt: number, gaveUp: boolean, reopenHandle: NodeJS.Timeout|null}>}
         */
        this.networks = new Map();
    }

    /** @returns {boolean} */
    _appliesHere() {
        if (!this.settings.cgate_serial_device) return false;
        if (String(this.settings.cgate_mode) !== 'managed') return false;
        return resolveSetting(this.settings, 'serialHandshakeEnabled') !== false;
    }

    /** @param {string} networkId */
    _stateFor(networkId) {
        let state = this.networks.get(networkId);
        if (!state) {
            state = { openingSince: null, attempts: 0, lastAttemptAt: 0, gaveUp: false, reopenHandle: null };
            this.networks.set(networkId, state);
        }
        return state;
    }

    /**
     * Called with the merged InterfaceState/State reading after every poll.
     *
     * @param {string|number} networkId
     * @param {{interfaceState: ?string, state: ?string}|null} snapshot
     * @returns {'ignored'|'waiting'|'reopened'|'gave-up'|'recovered'}
     */
    handleReading(networkId, snapshot) {
        if (!this._appliesHere() || !snapshot) return 'ignored';
        const id = String(networkId);

        if (snapshot.interfaceState === INTERFACE_RUNNING) {
            const state = this.networks.get(id);
            if (!state) return 'ignored';
            if (state.attempts > 0) {
                this._log('info', `C-Bus network ${id} PC Interface finished opening after ${state.attempts} reopen attempt(s).`);
            }
            this._clear(id);
            return 'recovered';
        }

        const stuckOpening = snapshot.interfaceState === INTERFACE_OPENING
            && (snapshot.state === null || snapshot.state === STATE_NEW);
        const state = this._stateFor(id);
        if (!stuckOpening) {
            state.openingSince = null;
            return 'ignored';
        }

        const now = this.now();
        if (state.openingSince === null) state.openingSince = now;
        if (state.gaveUp || state.reopenHandle) return 'waiting';

        const retryAfterMs = resolveClampedSetting(this.settings, 'serialHandshakeRetryAfterMs', { min: 1000 });
        if (now - state.openingSince < retryAfterMs) return 'waiting';

        const maxAttempts = resolveClampedSetting(this.settings, 'serialHandshakeMaxAttempts', { min: 1 });
        if (state.attempts >= maxAttempts) {
            state.gaveUp = true;
            this._log('error',
                `C-Bus network ${id} PC Interface never finished opening after ${maxAttempts} reopen attempt(s). ` +
                'Check the PC Interface cable and C-Bus power, then restart the add-on.');
            return 'gave-up';
        }

        if (state.attempts > 0) {
            const waitMs = backoffDelay(state.attempts - 1, {
                initialMs: retryAfterMs,
                maxMs: retryAfterMs * MAX_BACKOFF_MULTIPLIER,
                jitter: false
            });
            if (now - state.lastAttemptAt < waitMs) return 'waiting';
        }

        this._reopen(id, state, now, Math.round((now - state.openingSince) / 1000), maxAttempts);
        return 'reopened';
    }

    /**
     * @param {string} networkId
     * @param {ReturnType<SerialHandshakeRecovery['_stateFor']>} state
     * @param {number} now
     * @param {number} openingForSec
     * @param {number} maxAttempts
     * @private
     */
    _reopen(networkId, state, now, openingForSec, maxAttempts) {
        state.attempts += 1;
        state.lastAttemptAt = now;
        const address = `//${this.settings.cbusname}/${networkId}`;
        this._log('warn',
            `C-Bus network ${networkId} PC Interface has been opening for ${openingForSec}s; ` +
            `closing and reopening it (attempt ${state.attempts} of ${maxAttempts}).`);
        this.sendCommand(`NET CLOSE ${address}${NEWLINE}`);
        const delayMs = resolveClampedSetting(this.settings, 'serialHandshakeReopenDelayMs', { min: 0 });
        state.reopenHandle = setTimeout(() => {
            state.reopenHandle = null;
            // The close restarts the handshake clock: the next attempt measures
            // from the reopen, not from when the first handshake began.
            state.openingSince = null;
            this.sendCommand(`NET OPEN ${address}${NEWLINE}`);
        }, delayMs);
        state.reopenHandle.unref?.();
    }

    /** @param {string} networkId */
    _clear(networkId) {
        const state = this.networks.get(networkId);
        if (state && state.reopenHandle) clearTimeout(state.reopenHandle);
        this.networks.delete(networkId);
    }

    stop() {
        for (const id of [...this.networks.keys()]) this._clear(id);
    }

    /**
     * @param {'info'|'warn'|'error'|'debug'} level
     * @param {string} message
     */
    _log(level, message) {
        if (this.logger && typeof this.logger[level] === 'function') this.logger[level](message);
    }
}

module.exports = SerialHandshakeRecovery;
