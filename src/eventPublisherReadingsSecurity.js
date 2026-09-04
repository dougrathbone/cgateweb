// @ts-check
const {
    MQTT_TOPIC_SUFFIX_STATE,
    MQTT_TOPIC_SUFFIX_ATTRIBUTES,
    MQTT_TOPIC_SUFFIX_LOOP_FAULT,
    MQTT_TOPIC_SUFFIX_PASSWORD_ENTRY,
    MQTT_STATE_ON,
    MQTT_STATE_OFF
} = require('./constants');

// Security zone JSON-attributes payloads. Only four zone states exist, so the
// payload string for each is built once instead of JSON-stringifying per zone
// per status report. Frozen so the shared strings can't be mutated.
//
// Zone isolation (the panel bypassing a zone for an armed period) doubles the
// table rather than composing JSON at publish time, because the state space is
// still tiny and closed: 4 zone states x isolated/not. The overwhelmingly common
// publish — a plain sealed/unsealed zone, 80 of them per status report — costs
// exactly what it did before (one property read off a frozen object) and still
// allocates nothing; the isolated variant is just as cheap. A composed
// JSON.stringify would have put an object literal and a serialisation on that
// path for the benefit of the rare case.
//
// Absence, not `"isolated":false`, means not isolated. That keeps the
// non-isolated payloads byte-identical to what shipped before, so existing
// automations and templates reading `zone_state` see no change at all, and
// `state_attr(...,'isolated')` is falsy for them either way.
const SECURITY_ZONE_ATTRIBUTES_PAYLOAD = Object.freeze({
    sealed: '{"zone_state":"sealed"}',
    unsealed: '{"zone_state":"unsealed"}',
    open: '{"zone_state":"open"}',
    short: '{"zone_state":"short"}'
});

const SECURITY_ZONE_ISOLATED_ATTRIBUTES_PAYLOAD = Object.freeze({
    sealed: '{"zone_state":"sealed","isolated":true}',
    unsealed: '{"zone_state":"unsealed","isolated":true}',
    open: '{"zone_state":"open","isolated":true}',
    short: '{"zone_state":"short","isolated":true}'
});

// A panel can isolate a zone before we have ever seen that zone's state (the
// initial status report may not have arrived, or may never arrive). Isolation is
// still worth publishing on its own — and the empty payload is what clears it
// again, since the attributes topic is a whole-document replace.
const SECURITY_ZONE_ISOLATED_ONLY_PAYLOAD = '{"isolated":true}';
const SECURITY_ZONE_NO_ATTRIBUTES_PAYLOAD = '{}';

/**
 * Security reading publishers for EventPublisher.publishReading.
 * Each handler is (ep, base, reading) → void.
 */
module.exports = {
    security_zone(ep, base, reading) {
        // Security zone state (app 208): the binary_sensor state is ON for
        // unsealed/open/short and OFF for sealed; the raw 2-bit state name
        // goes to the JSON attributes topic so automations can distinguish
        // fault states (open/short) from a normal unsealed zone.
        //
        // `isolated` is extra context on the attributes topic only — an
        // isolated zone that is unsealed is still unsealed, so the state
        // topic's meaning is untouched. A reading with no zoneState is an
        // isolation-only update (the panel bypassed a zone without
        // reporting its state), which publishes attributes and nothing else.
        const hasZoneState = reading.zoneState !== null && reading.zoneState !== undefined;
        const isolated = reading.isolated === true;
        if (hasZoneState) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_STATE}`,
                reading.zoneState === 'sealed' ? MQTT_STATE_OFF : MQTT_STATE_ON,
                ep.mqttOptions
            );
        }
        const attributesPayload = hasZoneState
            ? (isolated ? SECURITY_ZONE_ISOLATED_ATTRIBUTES_PAYLOAD : SECURITY_ZONE_ATTRIBUTES_PAYLOAD)[reading.zoneState]
            : (isolated ? SECURITY_ZONE_ISOLATED_ONLY_PAYLOAD : SECURITY_ZONE_NO_ATTRIBUTES_PAYLOAD);
        if (attributesPayload) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_ATTRIBUTES}`,
                attributesPayload,
                ep.mqttOptions
            );
        }
        if (hasZoneState) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_LOOP_FAULT}`,
                (reading.zoneState === 'open' || reading.zoneState === 'short')
                    ? MQTT_STATE_ON
                    : MQTT_STATE_OFF,
                ep.mqttOptions
            );
        }
    },

    security_panel(ep, base, reading) {
        // Panel-wide trouble condition (app 208): ON means the trouble is
        // present. `group` is the "panel/<condition>" path segment, so the
        // base already addresses the right topic.
        ep._publishIfNeeded(
            `${base}/${MQTT_TOPIC_SUFFIX_STATE}`,
            reading.active ? MQTT_STATE_ON : MQTT_STATE_OFF,
            ep.mqttOptions
        );
    },

    security_alarm(ep, base, reading) {
        // HA alarm_control_panel state (app 208): one of disarmed,
        // armed_home/away/night/vacation, arming, pending, triggered.
        // `group` is "panel", so the base is cbus/read/{net}/{app}/panel.
        // The blocking zone (arm_not_ready) rides the attributes topic and
        // is republished on every transition so it clears with the state.
        ep._publishIfNeeded(
            `${base}/${MQTT_TOPIC_SUFFIX_STATE}`,
            reading.alarmState,
            ep.mqttOptions
        );
        const attributes = reading.blockingZone ? { blocking_zone: reading.blockingZone } : {};
        ep._publishIfNeeded(
            `${base}/${MQTT_TOPIC_SUFFIX_ATTRIBUTES}`,
            JSON.stringify(attributes),
            ep.mqttOptions
        );
    },

    security_password_entry(ep, base, reading) {
        ep._publishIfNeeded(
            `${base}/${MQTT_TOPIC_SUFFIX_PASSWORD_ENTRY}`,
            String(reading.code),
            ep.mqttOptions
        );
    },

    security_bypassed_zones(ep, base, reading) {
        // Dashboard list of zones the panel bypassed for this armed period
        // (#62). State is a comma-separated name list (or "none"); zone ids
        // and names also ride the attributes topic for templates.
        ep._publishIfNeeded(
            `${base}/${MQTT_TOPIC_SUFFIX_STATE}`,
            reading.state,
            ep.mqttOptions
        );
        ep._publishIfNeeded(
            `${base}/${MQTT_TOPIC_SUFFIX_ATTRIBUTES}`,
            JSON.stringify({ zones: reading.zones, names: reading.names }),
            ep.mqttOptions
        );
    }
};
