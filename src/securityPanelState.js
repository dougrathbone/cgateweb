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
 * Where an arm mode this table has never seen lands. The spec (§5.5.1.1) only
 * fixes $00 disarmed, $01 fully armed and $02 partially armed, and hands
 * $03-$7F to "manufacturers discretion" — so a panel broadcasting a custom
 * sub-mode is conformant, not broken. Publishing nothing for those (the old
 * behaviour) left Home Assistant showing whatever it last knew, which after a
 * disarm→custom-arm sequence reads "disarmed" on a panel that is armed. That is
 * the one direction of error that matters: it silently disables away
 * automations and tells the user the house is open when it is not. armed_away
 * is the most protective of the armed states, so unknown non-zero modes land
 * there and the raw mode rides along in `armMode` for anyone who needs the
 * detail.
 */
const UNKNOWN_ARM_MODE_STATE = 'armed_away';

/**
 * HA alarm panel state for a raw C-Bus arm mode.
 *
 * Mode 0 is disarmed and stays disarmed — never guess "armed" from the one
 * value the spec defines as not-armed. A non-integer or absent mode says
 * nothing at all, so it maps to null (no publish) rather than to a state.
 *
 * @param {number|null|undefined} mode
 * @returns {string|null}
 * @private
 */
function alarmStateForArmMode(mode) {
    if (!Number.isInteger(mode)) return null;
    const known = ALARM_STATE_BY_ARM_MODE[/** @type {number} */(mode)];
    if (known) return known;
    return /** @type {number} */(mode) > 0 ? UNKNOWN_ARM_MODE_STATE : null;
}

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
        /** @type {Map<string, { state: string|null, preAlarmState: string|null, blockingZone: string|null, armMode: number|null }>} */
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
     * Every condition and its current value, for seeding state at
     * discovery time. Conditions never seen default to inactive: assuming
     * healthy keeps the entities usable in automations immediately, and a stale
     * value self-corrects on the next transition or disarm. The alternative
     * leaves them Unknown indefinitely on a healthy panel, which is the
     * complaint behind issue #44.
     *
     * @param {string} network
     * @returns {Array<{condition: string, active: boolean}>} one per condition
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
     * The reported `armMode` is the raw C-Bus arm mode last broadcast for the
     * network (null until one arrives). It exists because unknown modes all
     * collapse onto one HA state: the number is the only way to tell which
     * manufacturer sub-mode the panel is actually in, so it belongs on the
     * panel's attributes topic alongside the blocking zone. Readings that carry
     * no mode inherit the tracked one rather than clearing it — alarm_on does
     * not un-arm the panel.
     *
     * @param {{kind: string, network: string, mode?: number|null, armState?: number, zone?: string|null}} reading
     * @returns {{ state: string, blockingZone: string|null, armMode: number|null }|null}
     */
    applyAlarmReading(reading) {
        if (!reading || reading.network === null || reading.network === undefined) return null;
        const entry = this._alarmForNetwork(reading.network);

        let target;
        let blockingZone = null;
        let armMode = entry.armMode;
        switch (reading.kind) {
            case 'system_arm':
                target = alarmStateForArmMode(reading.mode);
                armMode = Number.isInteger(reading.mode) ? /** @type {number} */(reading.mode) : armMode;
                break;
            case 'status_report_1':
                // The report's arm-state prefix is the one queryable source of
                // panel state — this is how the entity learns it after startup.
                target = alarmStateForArmMode(reading.armState);
                armMode = Number.isInteger(reading.armState) ? /** @type {number} */(reading.armState) : armMode;
                break;
            case 'exit_delay_started':
                target = 'arming';
                break;
            case 'arm_not_ready':
                target = 'pending';
                blockingZone = reading.zone || null;
                break;
            case 'arm_ready':
                // arm_ready is emitted *during* arming to report that nothing is
                // blocking (spec §5.5.1.25) — with a zone of 0 it means the
                // system armed correctly. It is not a disarm notification, and
                // treating it as one meant a late, repeated or post-arm
                // arm_ready overwrote a live armed_away with disarmed. That is
                // the worst possible direction to be wrong in: away automations
                // stop, and the alarm card reassures the user the house is open
                // while the panel is armed.
                //
                // So it may only seed or restore the idle state, never downgrade
                // one: from unknown (nothing learned yet — the common case, a
                // panel sitting ready) or from 'pending' (the blocking zone an
                // earlier arm_not_ready named has now sealed). From 'arming',
                // 'triggered' or any armed_* state it is ignored and the
                // authoritative system_arm / status_report_1 keeps the entity
                // honest.
                if (entry.state !== null && entry.state !== 'pending') return null;
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

        // armMode joins the dedupe key: two custom sub-modes can share one HA
        // state, and a move between them is a real change the attributes topic
        // has to carry.
        if (entry.state === target && entry.blockingZone === blockingZone && entry.armMode === armMode) return null;
        entry.state = target;
        entry.blockingZone = blockingZone;
        entry.armMode = armMode;
        return { state: target, blockingZone, armMode };
    }

    /**
     * Forget the last published alarm state for a network, so the next reading
     * counts as a transition and publishes even if the value has not changed.
     *
     * Needed because "publish transitions only" and "resend everything after
     * Home Assistant restarts" are in direct conflict. HA drops entity state on
     * restart, the bridge keeps running, and the resync's status_report_1 then
     * reports the same armed state it already knew — so nothing was published
     * and the alarm card sat blank until the panel next actually changed (#51).
     *
     * preAlarmState is deliberately kept: it is not published state, it is how
     * alarm_off knows what to revert to, and a resync should not lose it. The
     * tracked armMode is kept for the same reason — clearing state is enough to
     * force the republish, and the next reading carries the mode with it.
     *
     * @param {string|number} network - Stringified internally, as elsewhere here.
     */
    forgetAlarmState(network) {
        if (network === null || network === undefined) return;
        const entry = this._alarmByNetwork.get(String(network));
        if (!entry) return;
        entry.state = null;
        entry.blockingZone = null;
    }

    /**
     * @param {string} network
     * @returns {{ state: string|null, preAlarmState: string|null, blockingZone: string|null, armMode: number|null }}
     * @private
     */
    _alarmForNetwork(network) {
        const key = String(network);
        let entry = this._alarmByNetwork.get(key);
        if (!entry) {
            entry = { state: null, preAlarmState: null, blockingZone: null, armMode: null };
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
