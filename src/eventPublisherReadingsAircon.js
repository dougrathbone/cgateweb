// @ts-check
const {
    MQTT_TOPIC_SUFFIX_HVAC_CURRENT_TEMP,
    MQTT_TOPIC_SUFFIX_HVAC_SETPOINT,
    MQTT_TOPIC_SUFFIX_HVAC_MODE,
    MQTT_TOPIC_SUFFIX_HVAC_FAN_MODE,
    MQTT_TOPIC_SUFFIX_HVAC_FAN_SPEED,
    MQTT_TOPIC_SUFFIX_HVAC_ACTION,
    MQTT_TOPIC_SUFFIX_HVAC_ERROR,
    MQTT_TOPIC_SUFFIX_HVAC_ERROR_DESCRIPTION,
    MQTT_TOPIC_SUFFIX_HVAC_SENSOR_STATUS,
    MQTT_TOPIC_SUFFIX_HVAC_PROBLEM,
    MQTT_TOPIC_SUFFIX_HVAC_SENSOR_PROBLEM,
    MQTT_TOPIC_SUFFIX_HVAC_CURRENT_HUMIDITY,
    MQTT_TOPIC_SUFFIX_HVAC_HUMIDITY_SETPOINT,
    MQTT_TOPIC_SUFFIX_HVAC_HUMIDITY_MODE,
    MQTT_TOPIC_SUFFIX_HVAC_HUMIDITY_ACTION,
    MQTT_TOPIC_SUFFIX_HVAC_FAN_SPEED_PCT,
    MQTT_TOPIC_SUFFIX_HVAC_COMFORT_LEVEL,
    MQTT_TOPIC_SUFFIX_HVAC_DAMPER,
    MQTT_TOPIC_SUFFIX_HVAC_BUSY,
    MQTT_TOPIC_SUFFIX_HVAC_EXPANSION,
    MQTT_TOPIC_SUFFIX_HVAC_PLANT_TYPE,
    MQTT_TOPIC_SUFFIX_HVAC_PLANT_TYPE_DESCRIPTION,
    MQTT_TOPIC_SUFFIX_STATE,
    MQTT_STATE_ON,
    MQTT_STATE_OFF
} = require('./constants');

/**
 * Aircon / HVAC reading publishers for EventPublisher.publishReading.
 * Each handler is (ep, base, reading) → void.
 */
module.exports = {
    temperature(ep, base, reading) {
        // celsius is null when the sensor reports total failure (§25.8.6) —
        // surface the status, not the meaningless temperature.
        if (reading.celsius !== null && reading.celsius !== undefined) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_CURRENT_TEMP}`,
                String(reading.celsius),
                ep.mqttOptions
            );
        }
        if (reading.sensorStatus !== null && reading.sensorStatus !== undefined) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_SENSOR_STATUS}`,
                String(reading.sensorStatus),
                ep.mqttOptions
            );
            // Degraded (out of calibration) or failed sensor → problem state
            // for the binary_sensor (spec §25.6.12).
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_SENSOR_PROBLEM}`,
                reading.sensorStatus >= 2 ? MQTT_STATE_ON : MQTT_STATE_OFF,
                ep.mqttOptions
            );
        }
    },

    mode(ep, base, reading) {
        if (reading.mode !== null && reading.mode !== undefined) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_MODE}`,
                reading.mode,
                ep.mqttOptions
            );
        }
        if (reading.setpoint !== null && reading.setpoint !== undefined) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_SETPOINT}`,
                String(reading.setpoint),
                ep.mqttOptions
            );
        }
        // Fan speed/mode from the Aux Level (spec §25.6.11). Fan speed is the
        // raw 0-63 setting (0 = default speed) — HA climate has no numeric
        // fan-speed concept, so it stays an MQTT-only topic.
        if (reading.fanMode !== null && reading.fanMode !== undefined) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_FAN_MODE}`,
                reading.fanMode,
                ep.mqttOptions
            );
        }
        if (reading.fanSpeed !== null && reading.fanSpeed !== undefined) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_FAN_SPEED}`,
                String(reading.fanSpeed),
                ep.mqttOptions
            );
        }
        // Fan speed from the Raw Level (vent/fan, evaporative-manual) as a
        // percentage (§25.12.8), and the evaporative Comfort Level
        // (§25.12.7) — both MQTT-only (no HA climate equivalent).
        if (reading.fanSpeedPercent !== null && reading.fanSpeedPercent !== undefined) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_FAN_SPEED_PCT}`,
                String(reading.fanSpeedPercent),
                ep.mqttOptions
            );
        }
        if (reading.comfortLevel !== null && reading.comfortLevel !== undefined) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_COMFORT_LEVEL}`,
                String(reading.comfortLevel),
                ep.mqttOptions
            );
        }
    },

    state(ep, base, reading) {
        ep._publishIfNeeded(
            `${base}/${MQTT_TOPIC_SUFFIX_STATE}`,
            reading.on ? 'ON' : 'OFF',
            ep.mqttOptions
        );
    },

    action(ep, base, reading) {
        // Live plant running state → Home Assistant climate hvac_action.
        ep._publishIfNeeded(
            `${base}/${MQTT_TOPIC_SUFFIX_HVAC_ACTION}`,
            reading.action,
            ep.mqttOptions
        );
        // The remaining §25.6.6 status bits. cooling/heating/fan are already
        // folded into `action` above; these three carry information that
        // hvac_action cannot express, so they get their own topics rather
        // than being decoded and thrown away:
        //   damper (bit 3) — Closed/Open, ON = open
        //   busy   (bit 5) — the plant is mid-transition, so a mode or
        //                    setpoint write may not take effect yet
        //   expansion (bit 7) — protocol expansion marker with no defined
        //                    meaning in issue 1.12; published for
        //                    completeness, deliberately given no HA entity
        //                    (nothing sensible to show a user).
        ep._publishBooleanIfPresent(reading.damper, `${base}/${MQTT_TOPIC_SUFFIX_HVAC_DAMPER}`);
        ep._publishBooleanIfPresent(reading.busy, `${base}/${MQTT_TOPIC_SUFFIX_HVAC_BUSY}`);
        ep._publishBooleanIfPresent(reading.expansion, `${base}/${MQTT_TOPIC_SUFFIX_HVAC_EXPANSION}`);
        // Plant type (spec §25.6.4): numeric code + human description, the
        // same pairing as the error code below. This is the plant actually
        // reporting status, not the type requested by a mode broadcast —
        // see decodeZonePlantStatus for why only this verb feeds the topic.
        if (reading.type !== null && reading.type !== undefined) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_PLANT_TYPE}`,
                String(reading.type),
                ep.mqttOptions
            );
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_PLANT_TYPE_DESCRIPTION}`,
                reading.typeDescription,
                ep.mqttOptions
            );
        }
        // Plant error state (spec §25.6.5): numeric code + human description.
        if (reading.errorCode !== null && reading.errorCode !== undefined) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_ERROR}`,
                String(reading.errorCode),
                ep.mqttOptions
            );
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_ERROR_DESCRIPTION}`,
                reading.errorDescription,
                ep.mqttOptions
            );
        }
        // Problem binary state for the HA binary_sensor: ON when the status
        // error bit (§25.6.6 bit 6) or a non-zero error code says so.
        if ((reading.error !== null && reading.error !== undefined)
            || (reading.errorCode !== null && reading.errorCode !== undefined)) {
            const problem = reading.error === true || (reading.errorCode || 0) > 0;
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_PROBLEM}`,
                problem ? MQTT_STATE_ON : MQTT_STATE_OFF,
                ep.mqttOptions
            );
        }
    },

    humidity(ep, base, reading) {
        // Zone humidity (spec §25.8.7, 0–100%). Null when the sensor reports
        // total failure — surface nothing rather than a bogus reading.
        if (reading.humidity !== null && reading.humidity !== undefined) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_CURRENT_HUMIDITY}`,
                String(reading.humidity),
                ep.mqttOptions
            );
        }
    },

    humidity_mode(ep, base, reading) {
        // Humidity control mode + target (spec §25.8.12). MQTT-only state;
        // the climate entity reads these as current/target humidity.
        if (reading.mode !== null && reading.mode !== undefined) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_HUMIDITY_MODE}`,
                reading.mode,
                ep.mqttOptions
            );
        }
        if (reading.humiditySetpoint !== null && reading.humiditySetpoint !== undefined) {
            ep._publishIfNeeded(
                `${base}/${MQTT_TOPIC_SUFFIX_HVAC_HUMIDITY_SETPOINT}`,
                String(reading.humiditySetpoint),
                ep.mqttOptions
            );
        }
    },

    humidity_action(ep, base, reading) {
        // Humidity plant running state (spec §25.8.5/§25.6.10).
        ep._publishIfNeeded(
            `${base}/${MQTT_TOPIC_SUFFIX_HVAC_HUMIDITY_ACTION}`,
            reading.action,
            ep.mqttOptions
        );
    }
};
