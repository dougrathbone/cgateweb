// @ts-check
const {
    MQTT_TOPIC_SUFFIX_VALUE,
    MQTT_TOPIC_SUFFIX_UNIT
} = require('./constants');

/**
 * Clock and measurement reading publishers for EventPublisher.publishReading.
 * Each handler is (ep, base, reading) → void.
 */
module.exports = {
    clock(ep, base, reading) {
        // Clock and Timekeeping (app 223): the network's date and time
        // arrive as two separate broadcasts, so each gets its own topic
        // and neither waits on the other. Published verbatim as the
        // network reported them — see the note in clockDecoder.js on why
        // they are deliberately not combined into a timestamp.
        ep._publishIfNeeded(
            `${base}/${reading.variant}`,
            reading.value,
            ep.mqttOptions
        );
    },

    measurement(ep, base, reading) {
        // Measurement application (app 228): `group` is "{device}/{channel}",
        // so `base` already addresses cbus/read/{net}/{app}/{device}/{channel}.
        ep._publishIfNeeded(
            `${base}/${MQTT_TOPIC_SUFFIX_VALUE}`,
            String(reading.value),
            ep.mqttOptions
        );
        ep._publishIfNeeded(
            `${base}/${MQTT_TOPIC_SUFFIX_UNIT}`,
            reading.unit || '',
            ep.mqttOptions
        );
    }
};
