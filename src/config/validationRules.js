'use strict';

/**
 * Shared, pure configuration validation rules.
 *
 * Both the startup validator (ConfigLoader.validate) and the standalone
 * SettingsValidator historically re-implemented the same field constraints
 * (TCP port range, MQTT broker address format). Centralising the rules here
 * keeps them defined once so the two validators can never drift apart.
 *
 * These helpers are intentionally side-effect free (no logging, no throwing)
 * so callers keep full control over how a failure is reported.
 */

const MIN_TCP_PORT = 1;
const MAX_TCP_PORT = 65535;

// Accepts "host:port" or "mqtt://host:port".
const MQTT_ADDRESS_PATTERN = /^(mqtt:\/\/)?[\w.-]+:\d+$/;

/**
 * True when a numeric port sits within the valid TCP range. Non-numbers are
 * treated as "not a violation" here so presence/type checks stay the caller's
 * responsibility (matching the existing validators' behaviour).
 * @param {*} port
 * @returns {boolean}
 */
function isPortInRange(port) {
    if (typeof port !== 'number') {
        return true;
    }
    return port >= MIN_TCP_PORT && port <= MAX_TCP_PORT;
}

/**
 * True when a string looks like a valid MQTT broker address.
 * @param {*} address
 * @returns {boolean}
 */
function isValidMqttAddress(address) {
    if (typeof address !== 'string') {
        return false;
    }
    return MQTT_ADDRESS_PATTERN.test(address);
}

module.exports = {
    MIN_TCP_PORT,
    MAX_TCP_PORT,
    isPortInRange,
    isValidMqttAddress
};
