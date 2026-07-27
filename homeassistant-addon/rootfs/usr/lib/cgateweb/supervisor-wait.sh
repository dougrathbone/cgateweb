#!/usr/bin/env bash
# ==============================================================================
# Shared helper: bounded wait for the Supervisor API at add-on boot.
#
# bashio::config dies hard when the Supervisor API is not yet listening
# (bashio::exit.nok), which under set -e aborts the whole cont-init stage,
# and under deliberately-lax scripts silently yields empty config. On real
# Home Assistant the Supervisor is always up before the add-on starts, but
# the mock supervisor in test-env can lag the add-on container by a moment
# (CI flake: "Failed to get addon config from Supervisor API", after which
# the bridge never became ready), as can a heavily loaded host. Retrying the
# first read for a bounded period turns that race into a short delay.
#
# Sourced, not executed: deliberately does not set -e/-u/pipefail so it
# inherits whatever mode the caller is already running under, the same
# convention as serial-device.sh.
# ==============================================================================

# Probe the Supervisor API once per second until it answers. The probe MUST
# stay inside a command substitution: bashio dies via `exit` on API failure,
# and the substitution confines that exit to a subshell so the loop can retry
# (the caller's set -e is already suppressed inside a while condition).
# Gives up after CGATEWEB_SUPERVISOR_WAIT_ATTEMPTS probes (default 60),
# returning 1 so the caller can log and fail the boot explicitly.
cgateweb_wait_for_supervisor() {
    local max_attempts="${CGATEWEB_SUPERVISOR_WAIT_ATTEMPTS:-60}"
    local attempt=0
    local probe
    # probe's value is never read; the assignment exists only to keep the
    # bashio call inside a command substitution (see above), so SC2034's
    # "unused variable" is the whole point here.
    # shellcheck disable=SC2034
    while ! probe=$(bashio::config 'cgate_mode' 'remote' 2>/dev/null); do
        attempt=$((attempt + 1))
        if [[ ${attempt} -ge ${max_attempts} ]]; then
            return 1
        fi
        sleep 1
    done
    return 0
}
