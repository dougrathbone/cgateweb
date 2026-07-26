'use strict';

// Shared bashio stand-ins for the shell-script integration tests that
// `source` the Linux rootfs scripts under bash (see posixBash.js for why).
//
// bashio::config mirrors real bashio's "null"-for-unset quirk: upstream's
// `local default_value=${2:-null}` substitutes the literal string "null" for
// both an unset key AND an explicitly empty default. Test config arrives via
// env vars named CGW_TEST_<key>; the stub returns the env value when set or
// the default otherwise.
//
// BASHIO_STUB swallows every log call so tests can assert purely on the
// script's other output (file contents, exit status, stdout).
const BASHIO_STUB = `
    bashio::log.info()    { :; }
    bashio::log.warning() { :; }
    bashio::log.error()   { :; }
    bashio::log.trace()   { :; }
    bashio::log.debug()   { :; }
    bashio::config() {
        local key="$1"
        local default_value="\${2:-null}"
        local var_name="CGW_TEST_\${key}"
        if declare -p "$var_name" &>/dev/null; then
            printf '%s' "\${!var_name}"
        else
            printf '%s' "$default_value"
        fi
    }
`;

// Same as BASHIO_STUB but with log output captured (level-prefixed) instead
// of swallowed, so tests can assert on what a script logged (e.g. warnings)
// without changing the production log call sites.
const BASHIO_STUB_WITH_LOGS = `
    bashio::log.info()    { printf 'INFO: %s\\n' "$*"; }
    bashio::log.warning() { printf 'WARNING: %s\\n' "$*"; }
    bashio::log.error()   { printf 'ERROR: %s\\n' "$*"; }
    bashio::log.debug()   { printf 'DEBUG: %s\\n' "$*"; }
    bashio::log.trace()   { :; }
    bashio::config() {
        local key="$1"
        local default_value="\${2:-null}"
        local var_name="CGW_TEST_\${key}"
        if declare -p "$var_name" &>/dev/null; then
            printf '%s' "\${!var_name}"
        else
            printf '%s' "$default_value"
        fi
    }
`;

module.exports = { BASHIO_STUB, BASHIO_STUB_WITH_LOGS };
