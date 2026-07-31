// @ts-check
'use strict';

const { PANEL_TROUBLE_CONDITIONS } = require('./applicationDecoders/securityDecoder');

/**
 * Conditions the panel clears implicitly on disarm. The 2026-07-29 captures in
 * issue #42 never show an explicit clear for panic or fire, and the tester
 * confirmed that disarming "clears all possible trouble conditions" - both the
 * arm-failure and fire-alarm sequences end alarm_on → alarm_off → system_arm 0
 * with no dedicated cleared verb in between.
 *
 * Mains, battery, tamper and line are deliberately absent: a power fault or a
 * cut phone line is a physical condition that disarming the panel cannot fix,
 * and the panel does emit explicit restored/corrected verbs for those.
 */
const CLEARED_ON_DISARM = ['panic', 'arm_failed', 'fire'];

/**
 * Cleared by a *successful* arm, since the previous failure is now moot.
 */
const CLEARED_ON_ARM = ['arm_failed'];

/**
 * Tracks panel-wide trouble state per C-Bus network so the bridge only
 * publishes actual transitions. A panel repeating `mains_failure` while the
 * power is still out should not republish MQTT state or re-log at INFO.
 *
 * Deliberately separate from SecurityEventHandler: the transition and
 * derived-clear rules are the fiddly part of this feature and are far easier to
 * test as a standalone unit than through the handler's line-parsing path.
 */
class SecurityPanelState {
    constructor() {
        /** @type {Map<string, Object<string, boolean>>} network → condition → active */
        this._byNetwork = new Map();
    }

    /**
     * Apply a decoded reading and report which conditions actually changed.
     *
     * Handles both explicit `panel_trouble` readings and the derived clears
     * that ride `system_arm`, so callers can pass every reading through without
     * knowing which verbs imply what.
     *
     * @param {{kind: string, network: string, condition?: string, active?: boolean, mode?: number|null}} reading
     * @returns {Array<{condition: string, active: boolean}>} changed conditions only
     */
    applyReading(reading) {
        if (!reading || reading.network === null || reading.network === undefined) return [];

        if (reading.kind === 'panel_trouble') {
            if (!reading.condition || !PANEL_TROUBLE_CONDITIONS.includes(reading.condition)) return [];
            return this._set(reading.network, reading.condition, reading.active === true);
        }

        if (reading.kind === 'system_arm') {
            const conditions = reading.mode === 0 ? CLEARED_ON_DISARM : CLEARED_ON_ARM;
            const changed = [];
            for (const condition of conditions) {
                changed.push(...this._set(reading.network, condition, false));
            }
            return changed;
        }

        return [];
    }

    /**
     * Seed tamper and panic from a status_report_1, whose prefix bytes are the
     * only authoritative source we have for those two conditions. The other
     * five are event-driven only - the panel offers no way to query them.
     *
     * @param {{kind: string, network: string, tamperActive?: boolean, panicActive?: boolean}} reading
     * @returns {Array<{condition: string, active: boolean}>} changed conditions only
     */
    seedFromStatusReport(reading) {
        if (!reading || reading.network === null || reading.network === undefined) return [];
        const changed = [];
        if (typeof reading.tamperActive === 'boolean') {
            changed.push(...this._set(reading.network, 'tamper', reading.tamperActive));
        }
        if (typeof reading.panicActive === 'boolean') {
            changed.push(...this._set(reading.network, 'panic', reading.panicActive));
        }
        return changed;
    }

    /**
     * All seven conditions and their current values, for seeding state at
     * discovery time. Conditions never seen default to inactive: assuming
     * healthy keeps the entities usable in automations immediately, and a stale
     * value self-corrects on the next transition or disarm. The alternative
     * leaves them Unknown indefinitely on a healthy panel, which is the
     * complaint behind issue #44.
     *
     * @param {string} network
     * @returns {Array<{condition: string, active: boolean}>} all seven
     */
    initialStates(network) {
        const state = this._forNetwork(network);
        return PANEL_TROUBLE_CONDITIONS.map((condition) => ({ condition, active: state[condition] }));
    }

    /**
     * Snapshot of one network's conditions. Returns a copy - callers must not
     * be able to mutate the tracker's state by editing the result.
     *
     * @param {string} network
     * @returns {Object<string, boolean>}
     */
    getState(network) {
        return { ...this._forNetwork(network) };
    }

    /**
     * @param {string} network
     * @returns {Object<string, boolean>}
     * @private
     */
    _forNetwork(network) {
        const key = String(network);
        let state = this._byNetwork.get(key);
        if (!state) {
            state = {};
            for (const condition of PANEL_TROUBLE_CONDITIONS) state[condition] = false;
            this._byNetwork.set(key, state);
        }
        return state;
    }

    /**
     * Set one condition, returning it only if the value actually changed.
     *
     * @param {string} network
     * @param {string} condition
     * @param {boolean} active
     * @returns {Array<{condition: string, active: boolean}>}
     * @private
     */
    _set(network, condition, active) {
        const state = this._forNetwork(network);
        if (state[condition] === active) return [];
        state[condition] = active;
        return [{ condition, active }];
    }
}

module.exports = SecurityPanelState;
