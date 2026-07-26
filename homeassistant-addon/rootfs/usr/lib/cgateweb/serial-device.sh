#!/usr/bin/env bash
# ==============================================================================
# Shared helper for the cgateweb add-on's serial-device boot scripts
# (issue #28's renumber-recovery contract).
#
# cont-init's identity-aware resolver (cgateweb-resolve-serial.js) decides
# which device path C-Gate actually ends up using each boot -- it may differ
# from the configured cgate_serial_device after a replug renumbered the PC
# Interface -- and publishes that answer to CGATEWEB_SERIAL_DEVICE_FILE so
# later boot steps agree with it instead of each re-resolving independently
# (which could disagree with the install-time answer if the device renumbers
# again in between).
#
# cgate-install.sh, cgate-project-sync.sh and cgateweb-serial-diagnostics run
# as separate processes under s6, so an exported variable set by one does not
# reach the others -- each sources this file instead. This is the one place
# the default file path lives, and the one place the "read the resolver's
# answer, fall back to the configured option" logic is implemented.
#
# Sourced, not executed: deliberately does not set -e/-u/pipefail so it
# inherits whatever mode the caller is already running under.
# ==============================================================================

CGATEWEB_SERIAL_DEVICE_DEFAULT_FILE="/run/cgateweb/serial-device"

# Effective serial device path for this boot: the resolver's published answer
# when the file is present and non-empty, else the configured
# cgate_serial_device value. The file is missing or empty only when the
# resolver could not run (no node) or could not publish its answer, so this
# fallback is what keeps a boot step correct in that case.
#
# Args:
#   $1 - configured cgate_serial_device value (may be empty).
cgateweb_effective_serial_device() {
    local configured="${1:-}"
    local device_file="${CGATEWEB_SERIAL_DEVICE_FILE:-${CGATEWEB_SERIAL_DEVICE_DEFAULT_FILE}}"
    local device=""
    if [[ -r "${device_file}" ]]; then
        device=$(cat "${device_file}")
    fi
    if [[ -z "${device}" ]]; then
        device="${configured}"
    fi
    printf '%s' "${device}"
}
