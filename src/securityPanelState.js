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
 * The HA states that mean "this panel is armed", derived from the mode table so
 * a mode added there cannot be forgotten here. Used to decide what the entity
 * should fall back to once an alarm is over.
 */
const ARMED_STATES = new Set(
    Object.values(ALARM_STATE_BY_ARM_MODE).filter((state) => state !== 'disarmed')
);

/**
 * Whether an alarm state is one the readiness verbs (arm_ready / arm_not_ready)
 * are allowed to write over: nothing learned yet, or a panel already sitting
 * disarmed.
 *
 * Both verbs report the readiness of a panel that is *not* armed, so neither may
 * downgrade one that is arming, armed, counting down an entry delay or already
 * sounding. That is the one direction of error that matters: it stops away
 * automations and tells the user the house is open while the panel is armed.
 *
 * @param {string|null} state
 * @returns {boolean}
 * @private
 */
function isIdleAlarmState(state) {
    return state === null || state === 'disarmed';
}

/**
 * Key the isolated-zone list rides under inside a network's persisted entry.
 * Deliberately not a condition name: `restore` only copies keys listed in
 * PANEL_TROUBLE_CONDITIONS, so an older build reading a newer file ignores this
 * key rather than choking on it, and a newer build reading an older file simply
 * finds no isolation.
 */
const ISOLATED_ZONES_KEY = 'isolated_zones';

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
 * Finally it tracks per-zone isolation (the zones the panel bypassed when it
 * armed, spec §5.5.1.15) and each zone's last reported 2-bit state. Isolation
 * lives here rather than in SecurityEventHandler for two reasons:
 *   - it is network-scoped panel state cleared by a network-scoped panel event
 *     (the disarm), which this class already sees and already reasons about;
 *   - it is unqueryable, exactly like the trouble conditions, so it belongs in
 *     the snapshot that survives a restart (see toJSON).
 * The last zone state rides along because it is not separately published state:
 * it exists only so an isolation change can re-render the zone's attributes
 * payload without inventing or dropping the `zone_state` attribute that
 * automations already read.
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
        /**
         * network → { states: zone → last 2-bit state, isolated: set of zones }.
         * Bounded by the panel's zone count (≤128 per network), so no eviction.
         * @type {Map<string, { states: Map<string, string>, isolated: Set<string> }>}
         */
        this._zonesByNetwork = new Map();
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
     * Remember a zone's last reported 2-bit state (sealed/unsealed/open/short).
     *
     * Not published from here and not persisted — the status reports re-seed
     * every zone on connect. It exists so an isolation change can re-render the
     * zone's whole attributes payload: the attributes topic is a full replace in
     * Home Assistant, so publishing isolation without the state the zone was
     * last known to be in would silently delete the `zone_state` attribute.
     *
     * @param {string|number} network
     * @param {string|number} zone
     * @param {string} zoneState
     */
    noteZoneState(network, zone, zoneState) {
        if (network === null || network === undefined || zone === null || zone === undefined) return;
        if (!zoneState) return;
        this._zonesForNetwork(network).states.set(String(zone), zoneState);
    }

    /**
     * The zone's last reported 2-bit state, or null if none has been seen. Null
     * is a real case: a panel can isolate a zone before the initial status
     * report has arrived (or when the report never does).
     *
     * @param {string|number} network
     * @param {string|number} zone
     * @returns {string|null}
     */
    lastZoneState(network, zone) {
        const entry = this._zonesByNetwork.get(String(network));
        if (!entry) return null;
        return entry.states.get(String(zone)) || null;
    }

    /**
     * @param {string|number} network
     * @param {string|number} zone
     * @returns {boolean} whether the zone is currently isolated (bypassed).
     */
    isZoneIsolated(network, zone) {
        const entry = this._zonesByNetwork.get(String(network));
        if (!entry) return false;
        return entry.isolated.has(String(zone));
    }

    /**
     * Record that the panel isolated (bypassed) a zone for this armed period.
     *
     * Returns false for a repeat so callers publish transitions only — a panel
     * re-announcing the same isolation, or a second arm of an already-isolated
     * zone, should not put another message on the attributes topic.
     *
     * @param {string|number} network
     * @param {string|number} zone
     * @returns {boolean} true when this call actually changed the zone.
     */
    setZoneIsolated(network, zone) {
        if (network === null || network === undefined || zone === null || zone === undefined) return false;
        const entry = this._zonesForNetwork(network);
        const key = String(zone);
        if (entry.isolated.has(key)) return false;
        entry.isolated.add(key);
        return true;
    }

    /**
     * Drop every isolation recorded for a network and report what was dropped,
     * so the caller can republish those zones' attributes.
     *
     * Isolation is scoped to one armed period (spec §5.5.1.15) — a disarm ends
     * it for every zone at once, and the panel sends no per-zone "no longer
     * isolated" event. Without this a bypassed zone would keep an `isolated`
     * attribute for the rest of the bridge's life, which is worse than not
     * showing isolation at all: it would claim a door is uncovered while the
     * system is disarmed and, on the next arm, while it is genuinely covered.
     *
     * Each entry carries the zone's last known state so the republished payload
     * keeps `zone_state` intact.
     *
     * @param {string|number} network
     * @returns {Array<{zone: string, zoneState: string|null}>} zones that were isolated.
     */
    clearZoneIsolation(network) {
        if (network === null || network === undefined) return [];
        const entry = this._zonesByNetwork.get(String(network));
        if (!entry || entry.isolated.size === 0) return [];
        const cleared = [...entry.isolated].map((zone) => ({
            zone,
            zoneState: entry.states.get(zone) || null
        }));
        entry.isolated.clear();
        return cleared;
    }

    /**
     * Snapshot every network's conditions for persistence:
     * { network: { condition: active, isolated_zones?: [zone] } }. The panel
     * offers no way to query mains, battery, line, arm-fail or fire, so this
     * snapshot is the only way those survive a bridge restart (#42).
     *
     * Zone isolation is in the snapshot for the same reason — it cannot be
     * queried either — and because forgetting it is the dangerous direction of
     * error: a restart mid-armed-period would otherwise show a bypassed door as
     * covered, which is precisely what making isolation visible is for. The
     * stale-in-the-other-direction risk (a disarm missed while the bridge was
     * down) is reconciled on reconnect, where a status report that says the
     * panel is disarmed clears isolation before the zones are published.
     *
     * The key is omitted when nothing is isolated, so the common file is
     * byte-identical to the pre-isolation format.
     *
     * @returns {Object<string, Object<string, boolean|Array<string>>>}
     */
    toJSON() {
        const out = {};
        for (const [network, state] of this._byNetwork) out[network] = { ...state };
        for (const [network, entry] of this._zonesByNetwork) {
            if (entry.isolated.size === 0) continue;
            if (!out[network]) out[network] = {};
            out[network][ISOLATED_ZONES_KEY] = [...entry.isolated];
        }
        return out;
    }

    /**
     * Load a snapshot written by toJSON. Unknown conditions and non-boolean
     * values are ignored, so a hand-edited or newer-version file cannot
     * corrupt the tracker; unknown networks are adopted as-is.
     *
     * The isolated-zone list gets the same treatment: anything that is not an
     * array of zone-ish scalars is skipped rather than trusted. Zone *states*
     * are never restored — they are queryable, and a stale one would be
     * published as fact on the next isolation change.
     *
     * @param {Object<string, Object<string, boolean|Array<string>>>} data
     */
    restore(data) {
        if (!data || typeof data !== 'object') return;
        for (const [network, state] of Object.entries(data)) {
            if (!state || typeof state !== 'object') continue;
            const target = this._forNetwork(network);
            for (const condition of PANEL_TROUBLE_CONDITIONS) {
                if (typeof state[condition] === 'boolean') target[condition] = state[condition];
            }
            const isolated = state[ISOLATED_ZONES_KEY];
            if (!Array.isArray(isolated)) continue;
            const zones = this._zonesForNetwork(network);
            for (const zone of isolated) {
                if (typeof zone === 'string' || typeof zone === 'number') zones.isolated.add(String(zone));
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
            case 'entry_delay_started':
                // A delay zone opened while the system is armed and the siren
                // follows unless someone disarms in time (spec §5.5.1.4). That
                // is precisely what Home Assistant's 'pending' means, and it is
                // the state worth automating on — hall lights, camera snapshot,
                // phone notification, all before the siren.
                //
                // Applied from every other state, including 'disarmed': the
                // panel only starts an entry delay when it is armed, so a
                // tracker that thinks otherwise is the stale one, and swallowing
                // the event to protect a stale state would defeat the feature.
                //
                // 'triggered' is the exception. Once the siren has gone, a
                // repeat of the verb or a second delay zone opening must not
                // walk the panel back to a countdown that is already over.
                if (entry.state === 'triggered') return null;
                // Remember what the panel was armed as, so alarm_off can revert
                // to it. alarm_on cannot capture it itself: by then the state is
                // 'pending', which is not somewhere to return to.
                if (entry.state && ARMED_STATES.has(entry.state)) entry.preAlarmState = entry.state;
                target = 'pending';
                break;
            case 'arm_not_ready':
                // NOT 'pending': the panel refused to arm because a zone is
                // open, which is a disarmed panel with a complaint — not an
                // intruder mid-entry-delay. 'pending' belongs to
                // entry_delay_started above, where Home Assistant's meaning of
                // it (and any automation keyed on it) actually applies. The open
                // zone still reaches Home Assistant, on the attributes topic,
                // which is where it always went.
                if (!isIdleAlarmState(entry.state)) return null;
                target = 'disarmed';
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
                // panel sitting ready) or from 'disarmed', where it clears the
                // blocking zone an earlier arm_not_ready named once that zone
                // seals. From 'arming', 'pending', 'triggered' or any armed_*
                // state it is ignored and the authoritative system_arm /
                // status_report_1 keeps the entity honest. 'pending' matters
                // most of all now that it means an entry delay: an arm_ready
                // arriving mid-countdown must not tell Home Assistant the
                // countdown is over seconds before the siren.
                if (!isIdleAlarmState(entry.state)) return null;
                target = 'disarmed';
                break;
            case 'alarm_on':
                // 'pending' is the entry delay this alarm almost certainly came
                // from, and it is not somewhere to revert to once the siren
                // stops — the armed state captured when the delay started
                // stands instead.
                if (entry.state !== 'triggered' && entry.state !== 'pending') entry.preAlarmState = entry.state;
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
     * @param {string|number} network
     * @returns {{ states: Map<string, string>, isolated: Set<string> }}
     * @private
     */
    _zonesForNetwork(network) {
        const key = String(network);
        let entry = this._zonesByNetwork.get(key);
        if (!entry) {
            entry = { states: new Map(), isolated: new Set() };
            this._zonesByNetwork.set(key, entry);
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
