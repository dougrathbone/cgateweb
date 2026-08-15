// @ts-check
'use strict';

/**
 * The C-Bus Security panel's own health conditions, as opposed to its zones.
 *
 * Single source of truth for everything one condition needs: the verbs that
 * raise and clear it on the wire, its Home Assistant entity name and device
 * class, the wording used in logs and the Live Events feed, and whether the
 * panel clears it implicitly rather than sending a dedicated verb. Adding an
 * eighth condition is one record here; previously the same knowledge was spread
 * across four modules where forgetting one left a silent hole (an entity named
 * `undefined`, or a log line showing the raw condition id).
 *
 * Verb pairs are confirmed by the 2026-07-29 captures on a 64-zone Cytech panel
 * (GitHub issue #42) except `low_battery`, `tamper_on` and `panic_off`, whose
 * halves were never captured — the panel only ever emitted
 * `low_battery_corrected`, `tamper_off` and `panic_activated`. Those three names
 * are inferred from the convention of the confirmed pairs. Handling a verb that
 * never arrives costs nothing, and `panic` recovers via `clearedOnDisarm`
 * regardless of whether `panic_off` exists. `gas_alarm` and `other_alarm` are
 * inferred on the same basis — see their records.
 *
 * `detailSensed` marks the three verbs that carry their sense in a
 * `<verb>_raised` / `<verb>_cleared` argument rather than in the verb name; a
 * bare verb with no argument means raised.
 *
 * `clearedOnDisarm` covers conditions the panel never explicitly clears: the
 * tester confirmed disarming "clears all possible trouble conditions", and both
 * the arm-failure and fire captures end alarm_on → alarm_off → system_arm 0 with
 * no cleared verb in between. Mains, battery, tamper and line are deliberately
 * excluded — disarming cannot restore mains power or reconnect a cut phone
 * line, and the panel does send real restored/corrected verbs for those.
 *
 * Order is display order (HA sorts diagnostics by name, but the discovery
 * publish order and status logs follow this).
 */
const PANEL_CONDITIONS = [
    {
        id: 'mains',
        raiseVerb: 'mains_failure',
        clearVerb: 'mains_restored',
        name: 'Mains power',
        deviceClass: 'problem',
        raisedText: 'Mains power failure',
        clearedText: 'Mains power restored'
    },
    {
        id: 'battery',
        raiseVerb: 'low_battery',
        clearVerb: 'low_battery_corrected',
        name: 'Battery',
        deviceClass: 'battery',
        raisedText: 'Battery low',
        clearedText: 'Battery restored'
    },
    {
        id: 'tamper',
        raiseVerb: 'tamper_on',
        clearVerb: 'tamper_off',
        name: 'Tamper',
        deviceClass: 'tamper',
        raisedText: 'Tamper detected',
        clearedText: 'Tamper cleared'
    },
    {
        id: 'panic',
        raiseVerb: 'panic_activated',
        // Two spellings accepted: neither was captured, so both plausible
        // inferences are handled rather than betting on one.
        clearVerb: ['panic_off', 'panic_cleared'],
        clearedOnDisarm: true,
        name: 'Panic',
        deviceClass: 'safety',
        raisedText: 'Panic activated',
        clearedText: 'Panic cleared'
    },
    {
        id: 'line',
        detailVerb: 'line_cut_alarm',
        name: 'Phone line',
        deviceClass: 'problem',
        raisedText: 'Phone line cut',
        clearedText: 'Phone line restored'
    },
    {
        id: 'arm_failed',
        detailVerb: 'arm_failed',
        clearedOnDisarm: true,
        // A successful arm retires an earlier failure to arm.
        clearedOnArm: true,
        name: 'Arm failed',
        deviceClass: 'problem',
        raisedText: 'Arm failed',
        clearedText: 'Arm failure cleared'
    },
    {
        id: 'fire',
        detailVerb: 'fire_alarm',
        clearedOnDisarm: true,
        name: 'Fire alarm',
        deviceClass: 'smoke',
        raisedText: 'Fire alarm',
        clearedText: 'Fire alarm cleared'
    },
    {
        // Gas Alarm Raised/Cleared (spec §5.5.1.33-34, argument $97). Never
        // captured, so `gas_alarm` is inferred from `fire_alarm` — the two are
        // adjacent, identically shaped messages in the spec — on the same basis
        // as the inferred `low_battery` and `tamper_on` above. A verb that never
        // arrives costs nothing; a verb we refuse to decode loses a gas alarm.
        id: 'gas',
        detailVerb: 'gas_alarm',
        // "Some security systems only allow a gas alarm condition to be cleared
        // by Disarming" (§5.5.1.34), exactly as for fire.
        clearedOnDisarm: true,
        name: 'Gas alarm',
        deviceClass: 'gas',
        raisedText: 'Gas alarm',
        clearedText: 'Gas alarm cleared'
    },
    {
        // Other Alarm Raised/Cleared (spec §5.5.1.35-36, argument $98) — the
        // manufacturer-defined catch-all. `other_alarm` is inferred the same way
        // as `gas_alarm`. No device class fits a condition whose meaning is
        // installer-specific, so it is a generic problem sensor.
        id: 'other_alarm',
        detailVerb: 'other_alarm',
        clearedOnDisarm: true,
        name: 'Other alarm',
        deviceClass: 'problem',
        raisedText: 'Other alarm',
        clearedText: 'Other alarm cleared'
    }
];

/** Condition ids in display order. */
const PANEL_TROUBLE_CONDITIONS = PANEL_CONDITIONS.map((c) => c.id);

/** Condition id → record. */
const PANEL_CONDITION_BY_ID = new Map(PANEL_CONDITIONS.map((c) => [c.id, c]));

/**
 * Verb → { condition, active } for verbs that name their own sense.
 * @type {Map<string, { condition: string, active: boolean }>}
 */
const PANEL_TROUBLE_VERBS = new Map();
/**
 * Verb → condition id for verbs whose sense rides a _raised/_cleared argument.
 * @type {Map<string, string>}
 */
const PANEL_TROUBLE_DETAIL_VERBS = new Map();

for (const condition of PANEL_CONDITIONS) {
    if (condition.raiseVerb) {
        PANEL_TROUBLE_VERBS.set(condition.raiseVerb, { condition: condition.id, active: true });
    }
    for (const verb of [].concat(condition.clearVerb || [])) {
        PANEL_TROUBLE_VERBS.set(verb, { condition: condition.id, active: false });
    }
    if (condition.detailVerb) {
        PANEL_TROUBLE_DETAIL_VERBS.set(condition.detailVerb, condition.id);
    }
}

/** Conditions the panel clears implicitly on disarm (system_arm mode 0). */
const CLEARED_ON_DISARM = PANEL_CONDITIONS.filter((c) => c.clearedOnDisarm).map((c) => c.id);

/** Conditions retired by a successful arm (system_arm with a non-zero mode). */
const CLEARED_ON_ARM = PANEL_CONDITIONS.filter((c) => c.clearedOnArm).map((c) => c.id);

/**
 * Human-readable wording for a condition in the given sense. Falls back to the
 * raw id so an unmapped condition is still legible.
 *
 * @param {string} conditionId
 * @param {boolean} active
 * @returns {string}
 */
function describePanelCondition(conditionId, active) {
    const condition = PANEL_CONDITION_BY_ID.get(conditionId);
    if (!condition) return conditionId;
    return active ? condition.raisedText : condition.clearedText;
}

module.exports = {
    PANEL_CONDITIONS,
    PANEL_TROUBLE_CONDITIONS,
    PANEL_TROUBLE_VERBS,
    PANEL_TROUBLE_DETAIL_VERBS,
    CLEARED_ON_DISARM,
    CLEARED_ON_ARM,
    describePanelCondition
};
