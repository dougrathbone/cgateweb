// @ts-check
'use strict';

const {
    PANEL_TROUBLE_CONDITIONS,
    CLEARED_ON_DISARM,
    CLEARED_ON_ARM
} = require('./securityPanelConditions');

/**
 * C-Bus arm mode → Home Assistant alarm panel state (HA MQTT alarm contract;
 * arm modes confirmed by the #42 live captures). C-Bus "day/stay" (3) is
 * armed_home — home during the day.
 */
const ALARM_STATE_BY_ARM_MODE = {
    0: 'disarmed',
    1: 'armed_away',
    2: 'armed_night',
    3: 'armed_home',
    4: 'armed_vacation'
};

/**
 * Tracks panel-wide trouble state per C-Bus network so the bridge only
 * publishes actual transitions. A panel repeating `mains_failure` while the
 * power is still out should not republish MQTT state or re-log at INFO.
 *
 * Also tracks the HA alarm_control_panel state per network (armed_away,
 * arming, triggered, …) with the same transitions-only discipline. Unlike the
 * trouble conditions this needs no persistence: status_report_1's arm-state
 * prefix re-seeds it on every connect sync.
 *
 * Deliberately separate from SecurityEventHandler: the transition and
 * derived-clear rules are the fiddly part of this feature and are far easier to
 * test as a standalone unit than through the handler's line-parsing path.
 */
class SecurityPanelState {
    constructor() {
        /** @type {Map<string, Object<string, boolean>>} network → condition → active */
        this._byNetwork = new Map();
        /** @type {Map<string, { state: string|null, preAlarmState: string|null, blockingZone: string|null }>} */
        this._alarmByNetwork = new Map();
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
     * Snapshot every network's conditions for persistence:
     * { network: { condition: active } }. The panel offers no way to query
     * mains, battery, line, arm-fail or fire, so this snapshot is the only way
     * those survive a bridge restart (#42).
     *
     * @returns {Object<string, Object<string, boolean>>}
     */
    toJSON() {
        const out = {};
        for (const [network, state] of this._byNetwork) out[network] = { ...state };
        return out;
    }

    /**
     * Load a snapshot written by toJSON. Unknown conditions and non-boolean
     * values are ignored, so a hand-edited or newer-version file cannot
     * corrupt the tracker; unknown networks are adopted as-is.
     *
     * @param {Object<string, Object<string, boolean>>} data
     */
    restore(data) {
        if (!data || typeof data !== 'object') return;
        for (const [network, state] of Object.entries(data)) {
            if (!state || typeof state !== 'object') continue;
            const target = this._forNetwork(network);
            for (const condition of PANEL_TROUBLE_CONDITIONS) {
                if (typeof state[condition] === 'boolean') target[condition] = state[condition];
            }
        }
    }

    /**
     * Apply a decoded reading to the HA alarm panel state tracker and report
     * the transition, if any. Returns null for readings that carry no alarm
     * state, for repeats (transitions only), and for alarm_off with no
     * trackable pre-alarm state — the captures show alarm_off is always
     * followed by a system_arm broadcast that re-derives the state, so there
     * is nothing to guess there.
     *
     * @param {{kind: string, network: string, mode?: number|null, armState?: number, zone?: string|null}} reading
     * @returns {{ state: string, blockingZone: string|null }|null}
     */
    applyAlarmReading(reading) {
        if (!reading || reading.network === null || reading.network === undefined) return null;
        const entry = this._alarmForNetwork(reading.network);

        let target;
        let blockingZone = null;
        switch (reading.kind) {
            case 'system_arm':
                target = ALARM_STATE_BY_ARM_MODE[reading.mode] || null;
                break;
            case 'status_report_1':
                // The report's arm-state prefix is the one queryable source of
                // panel state — this is how the entity learns it after startup.
                target = ALARM_STATE_BY_ARM_MODE[reading.armState] || null;
                break;
            case 'exit_delay_started':
                target = 'arming';
                break;
            case 'arm_not_ready':
                target = 'pending';
                blockingZone = reading.zone || null;
                break;
            case 'arm_ready':
                target = 'disarmed';
                break;
            case 'alarm_on':
                if (entry.state !== 'triggered') entry.preAlarmState = entry.state;
                target = 'triggered';
                break;
            case 'alarm_off':
                target = entry.preAlarmState;
                entry.preAlarmState = null;
                break;
            default:
                return null;
        }
        if (target === null || target === undefined) return null;

        if (entry.state === target && entry.blockingZone === blockingZone) return null;
        entry.state = target;
        entry.blockingZone = blockingZone;
        return { state: target, blockingZone };
    }

    /**
     * @param {string} network
     * @returns {{ state: string|null, preAlarmState: string|null, blockingZone: string|null }}
     * @private
     */
    _alarmForNetwork(network) {
        const key = String(network);
        let entry = this._alarmByNetwork.get(key);
        if (!entry) {
            entry = { state: null, preAlarmState: null, blockingZone: null };
            this._alarmByNetwork.set(key, entry);
        }
        return entry;
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
