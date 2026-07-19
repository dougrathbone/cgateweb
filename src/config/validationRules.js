// @ts-check
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

// C-Gate project / username: alphanumeric + underscore only (matches EVENT_REGEX \w+).
const CGATE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_]{1,32}$/;
// Printable ASCII excluding space — LOGIN is space-delimited with no quoting.
const CGATE_PASSWORD_PATTERN = /^[\x21-\x7E]{1,64}$/;

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

/**
 * True when a C-Gate project name is safe to interpolate into command paths.
 * @param {*} name
 * @returns {boolean}
 */
function isValidCgateProjectName(name) {
    return typeof name === 'string' && CGATE_IDENTIFIER_PATTERN.test(name);
}

/**
 * True when a C-Gate LOGIN username is safe (no spaces/newlines/metachars).
 * @param {*} user
 * @returns {boolean}
 */
function isValidCgateUsername(user) {
    return typeof user === 'string' && CGATE_IDENTIFIER_PATTERN.test(user);
}

/**
 * True when a C-Gate LOGIN password is safe to send on a space-delimited line.
 * @param {*} pass
 * @returns {boolean}
 */
function isValidCgatePassword(pass) {
    return typeof pass === 'string' && CGATE_PASSWORD_PATTERN.test(pass);
}

module.exports = {
    MIN_TCP_PORT,
    MAX_TCP_PORT,
    CGATE_IDENTIFIER_PATTERN,
    CGATE_PASSWORD_PATTERN,
    isPortInRange,
    isValidMqttAddress,
    isValidCgateProjectName,
    isValidCgateUsername,
    isValidCgatePassword
};
