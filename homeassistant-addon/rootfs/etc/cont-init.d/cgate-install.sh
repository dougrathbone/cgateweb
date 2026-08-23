#!/usr/bin/with-contenv bashio
# ==============================================================================
# Install C-Gate if running in managed mode
# ==============================================================================
# Strict-ish mode: -u catches unset-variable typos and pipefail surfaces
# mid-pipeline failures. We deliberately omit -e here: this installer already
# checks and exits explicitly at every step, and -e interacts badly with the
# `find ... | head` command substitutions (SIGPIPE) and the default-less
# bashio::config calls below. The short service scripts use full `set -euo pipefail`.
set -uo pipefail

CGATEWEB_DEFAULT_DOWNLOAD_URL="https://download.se.com/files?p_Doc_Ref=C-Gate_3_Linux_Package_V3.3.2"
# Pinned sha256 of the zip the default URL serves (C-Gate 3.3.2 Linux package,
# containing cgate-3.3.2_1855.zip). Downloads from the default URL are verified
# against this; a user-set cgate_download_sha256 overrides it — the escape
# hatch if Schneider re-releases the zip and this pin goes stale.
#
# Re-pinned 2026-07-27: Schneider repackaged the outer zip on 2026-07-24, which
# broke every new managed-mode install because the download no longer matched.
# The inner payload is byte-for-byte the same C-Gate — still cgate-3.3.2_1855.zip
# — and the bundled release-notes PDF came back named "C-Gate 3 Release Notes
# (3).pdf", a browser download-collision suffix, so this was a manual re-zip
# rather than a new C-Gate build. Expect it to recur: the escape hatch above is
# the supported answer for users, and this constant is the fix for everyone else.
CGATEWEB_DEFAULT_DOWNLOAD_SHA256="1d871bcd38355234a3b5b30a208463c8be079aa9346152476f2209f516cf271d"

# Managed C-Gate log retention (#81). C-Gate writes unbounded files under
# /data/cgate/logs/ and rotated event-file segments; without a cap a busy
# network can fill the host SD card. Pruned on every boot before C-Gate starts.
CGATEWEB_LOG_MAX_BYTES="${CGATEWEB_LOG_MAX_BYTES:-524288000}"   # 500 MiB
CGATEWEB_LOG_MAX_AGE_DAYS="${CGATEWEB_LOG_MAX_AGE_DAYS:-7}"
CGATEWEB_EVENT_FILE_SPLIT_SIZE="${CGATEWEB_EVENT_FILE_SPLIT_SIZE:-5000000}"  # 5 MiB (C-Gate default)
CGATEWEB_EVENT_FILE_SPLIT_COUNT="${CGATEWEB_EVENT_FILE_SPLIT_COUNT:-50}"   # ~250 MiB of event segments

# The identity-aware serial resolver (issue #28) and the file it publishes its
# answer to. Both are overridable so the unit tests can run the repo copy of
# the resolver and keep its bookkeeping out of /run.
CGATEWEB_RESOLVE_SERIAL_JS="${CGATEWEB_RESOLVE_SERIAL_JS:-/usr/bin/cgateweb-resolve-serial.js}"
# The default device-file path is defined once in the shared helper also
# sourced by cgate-project-sync.sh and cgateweb-serial-diagnostics, so all
# three boot scripts agree on it without each inlining their own copy.
CGATEWEB_SERIAL_DEVICE_LIB="${CGATEWEB_SERIAL_DEVICE_LIB:-/usr/lib/cgateweb/serial-device.sh}"
# The path is a variable so tests can point at the repo copy, so this is
# SC1090 ("can't follow non-constant source"), not SC1091 ("file not found").
# The helper is linted directly by CI, so nothing is lost by not following it.
# shellcheck disable=SC1090
source "${CGATEWEB_SERIAL_DEVICE_LIB}"
# Exported so the resolver child process writes the very file this script (and
# the boot scripts after it) reads back, rather than each falling back to its
# own default independently.
export CGATEWEB_SERIAL_DEVICE_FILE="${CGATEWEB_SERIAL_DEVICE_FILE:-${CGATEWEB_SERIAL_DEVICE_DEFAULT_FILE}}"

# bashio::config returns the literal string "null" for unset optional fields,
# even when an empty default is passed (upstream bashio's `${2:-null}` rewrites
# an empty default to "null"). Treat both empty and "null" as unset.
_cgateweb_resolve_download_url() {
    local url
    url=$(bashio::config 'cgate_download_url')
    if [[ -z "${url}" || "${url}" == "null" ]]; then
        url="${CGATEWEB_DEFAULT_DOWNLOAD_URL}"
    fi
    printf '%s' "${url}"
}

# Resolve the effective checksum. A user-set cgate_download_sha256 always wins;
# otherwise a download from the built-in default URL falls back to the pinned
# CGATEWEB_DEFAULT_DOWNLOAD_SHA256. Anything else (custom URL, no user
# checksum) resolves to empty and is rejected by
# _cgateweb_custom_url_without_sha256 before anything is downloaded. The
# optional argument is the resolved download URL; callers without URL context
# (upload mode) omit it and get the user setting only.
_cgateweb_resolve_download_sha256() {
    local url="${1:-}"
    local sha
    sha=$(bashio::config 'cgate_download_sha256')
    if [[ "${sha}" == "null" ]]; then
        sha=""
    fi
    if [[ -z "${sha}" && "${url}" == "${CGATEWEB_DEFAULT_DOWNLOAD_URL}" ]]; then
        sha="${CGATEWEB_DEFAULT_DOWNLOAD_SHA256}"
    fi
    printf '%s' "${sha}"
}

# A custom download URL must be pinned to a checksum: without one the install
# would run whatever bytes the URL happens to serve. The built-in default URL
# is exempt because it is verified against the pinned
# CGATEWEB_DEFAULT_DOWNLOAD_SHA256 instead. Echoes 1 when a sha256 is required
# but missing, else 0.
_cgateweb_custom_url_without_sha256() {
    local url="$1" sha="$2"
    if [[ "${url}" != "${CGATEWEB_DEFAULT_DOWNLOAD_URL}" && -z "${sha}" ]]; then printf '1'; else printf '0'; fi
}

# Read C-Gate's own build metadata instead of inferring its version from the
# archive name. Schneider packages BuildInfo.txt beside cgate.jar, and archive
# names are not stable across download and upload sources.
_cgateweb_installed_version() {
    local cgate_dir="$1"
    local build_info="${cgate_dir}/BuildInfo.txt"
    local version build

    if [[ ! -r "${build_info}" ]]; then
        return 1
    fi

    version=$(awk -F: '
        tolower($1) ~ /^[[:space:]]*version[[:space:]]*$/ {
            value = $2
            sub(/\r$/, "", value)
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
            print value
            exit
        }
    ' "${build_info}")
    build=$(awk -F: '
        tolower($1) ~ /^[[:space:]]*build[[:space:]]*$/ {
            value = $2
            sub(/\r$/, "", value)
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
            print value
            exit
        }
    ' "${build_info}")

    if [[ -z "${version}" ]]; then
        return 1
    fi
    if [[ -n "${build}" ]]; then
        printf '%s_%s' "${version}" "${build}"
    else
        printf '%s' "${version}"
    fi
}

# Keep the marker consumed by bridge diagnostics in sync with BuildInfo.txt.
# The optional fallback preserves support for packages that omit that file but
# whose nested archive still carries a version in its filename.
_cgateweb_record_installed_version() {
    local cgate_dir="$1"
    local fallback_version="${2:-}"
    local detected_version current_version

    detected_version=$(_cgateweb_installed_version "${cgate_dir}" || true)
    if [[ -z "${detected_version}" ]]; then
        detected_version="${fallback_version}"
    fi
    current_version=$(cat "${cgate_dir}/.version" 2>/dev/null || true)

    if [[ -n "${detected_version}" && "${current_version}" != "${detected_version}" ]]; then
        printf '%s\n' "${detected_version}" > "${cgate_dir}/.version"
        bashio::log.info "Recorded C-Gate version: ${detected_version}"
    elif [[ -z "${current_version}" ]]; then
        printf 'unknown\n' > "${cgate_dir}/.version"
    fi
}

# Standard "what to do now" block for every C-Gate download failure. The most
# common external cause is Clipsal/Schneider changing the download URL or
# repackaging the zip (they did on 2026-07-24, breaking every fresh install
# until the pin was updated), so say that plainly and hand the user the two
# working paths: fetch the zip themselves and use upload mode, or point the
# add-on at a URL+checksum they control.
_cgateweb_log_download_guidance() {
    bashio::log.error "One common cause is Clipsal/Schneider changing the download URL or repackaging the zip,"
    bashio::log.error "so the URL or checksum pinned in this add-on no longer matches what is served."
    bashio::log.error "How to get C-Gate installed manually:"
    bashio::log.error "  1. Download the C-Gate 3 Linux package from the Clipsal downloads page:"
    bashio::log.error "     https://updates.clipsal.com/ClipsalSoftwareDownload/mainsite/cis/technical/downloads/index.html"
    bashio::log.error "  2. Set cgate_install_source to 'upload' in the add-on configuration."
    bashio::log.error "  3. Place the zip in /share/cgate/ on your Home Assistant host (via the Samba, SSH or File Editor add-on)."
    bashio::log.error "  4. Restart the add-on — it will install from that zip."
    bashio::log.error "Alternative: set cgate_download_url and cgate_download_sha256 to a mirror you control."
    bashio::log.error "Check this add-on's GitHub releases/issues for an update re-pinning the new official file."
}

# Inspect a zip's central directory and reject any entry name that contains
# path-traversal (..) or starts with an absolute path. Modern unzip ignores
# these by default, but explicit pre-extract validation is defence-in-depth
# and guards against future unzip-variant behaviour changes.
_cgateweb_verify_zip_safe() {
    local zip_path="$1"
    local bad_entries
    bad_entries=$(unzip -Z1 "${zip_path}" 2>/dev/null | awk '
        $0 ~ /(^|\/)\.\.(\/|$)/ { print; next }
        /^\// { print; next }
    ')
    if [[ -n "${bad_entries}" ]]; then
        bashio::log.error "Archive rejected: contains path-traversal or absolute entry names:"
        bashio::log.error "${bad_entries}"
        return 1
    fi
    return 0
}

# Set a single C-GateConfig.txt key, anchored to start-of-line so the comment
# headers (e.g. "#### project.default:") never match. Replaces an existing
# key in place or appends it. Idempotent: repeated runs leave one line per key.
_cgateweb_set_config_key() {
    local config_file="$1" key="$2" value="$3"
    # Escape regex-special dots in the key so "project.default" cannot also match
    # "project.default.dir". Use | as the sed delimiter so path values are safe.
    local key_re="${key//./\\.}"
    if grep -q "^${key_re}=" "${config_file}"; then
        # Temp-file rewrite instead of `sed -i`: portable across GNU and BSD sed
        # (the latter requires an explicit backup-suffix arg to -i).
        local tmp="${config_file}.tmp.$$"
        sed "s|^${key_re}=.*|${key}=${value}|" "${config_file}" > "${tmp}" && mv "${tmp}" "${config_file}"
    else
        printf '%s=%s\n' "${key}" "${value}" >> "${config_file}"
    fi
}

# Apply cgateweb's required C-Gate settings to C-GateConfig.txt. This MUST run
# on every boot (not just on a fresh install) so existing/upgrading managed
# users also get project.start — without it C-Gate never loads the project and
# every command returns "401 Bad object or device ID" (issue #16).
_cgateweb_apply_cgate_config() {
    local config_file="$1"
    local project="$2"
    local command_port="$3"

    # C-Gate generates C-GateConfig.txt on its first start, which happens AFTER
    # cont-init runs -- so on a fresh install there is no file to edit yet. Seed
    # a minimal config: C-Gate preserves an existing file and fills unspecified
    # keys with its built-in defaults, so this is enough to make it auto-load the
    # project on its very first start (project.start, below). Without it the
    # first boot comes up with no project loaded and every command 401s (#16).
    if [[ ! -f "${config_file}" ]]; then
        mkdir -p "$(dirname "${config_file}")"
        printf 'project.default.dir=Projects/\n' > "${config_file}"
    fi

    # Strip legacy invalid keys that older versions of this script appended.
    # C-Gate doesn't recognize CommandInterface.port / EventInterface.port and
    # warns about them at startup. We also strip event-port: older versions of
    # this script forced event-port=20025, which collides with C-Gate's
    # load-change-port (also 20025) — the real-time status stream cgateweb reads.
    # Removing it lets C-Gate fall back to its default event-port (20024) so the
    # status stream stays on 20025 and light statuses update (#21). This is what
    # a working remote/default C-Gate install does.
    local tmp="${config_file}.tmp.$$"
    sed '/^CommandInterface\.port=/d;/^EventInterface\.port=/d;/^event-port=/d' "${config_file}" > "${tmp}" && mv "${tmp}" "${config_file}"

    # project.default names the project; project.start is what actually makes
    # C-Gate load+start it at boot (project.default alone does nothing).
    # event-port is deliberately NOT set: leaving it at C-Gate's default (20024)
    # keeps the load-change/status stream on 20025 for cgateweb (#21).
    _cgateweb_set_config_key "${config_file}" "project.default" "${project}"
    _cgateweb_set_config_key "${config_file}" "project.start" "${project}"
    _cgateweb_set_config_key "${config_file}" "command-port" "${command_port}"

    # Cap C-Gate's on-disk event log when use-event-file is enabled. C-Gate
    # rotates at split-size and keeps split-count segments; without this a
    # single event.log can grow without bound (#81).
    _cgateweb_set_config_key "${config_file}" "event-file.split" "yes"
    _cgateweb_set_config_key "${config_file}" "event-file.split-size" "${CGATEWEB_EVENT_FILE_SPLIT_SIZE}"
    _cgateweb_set_config_key "${config_file}" "event-file.split-count" "${CGATEWEB_EVENT_FILE_SPLIT_COUNT}"
}

# Return 0 when a file under the managed C-Gate install may be pruned.
# Only log directories and rotated event-file segments are eligible — never
# Projects/, config/, or the live event.log C-Gate is writing.
_cgateweb_prune_cgate_logs_is_prunable() {
    local cgate_dir="$1" file="$2"
    case "${file}" in
        "${cgate_dir}/logs"/*|"${cgate_dir}/log"/*) return 0 ;;
        "${cgate_dir}/event."*.log)
            # event.log is the active segment; event.N.log are rotated.
            [[ "${file}" == "${cgate_dir}/event.log" ]] && return 1
            return 0
            ;;
        "${cgate_dir}/event-"*) return 0 ;;
        *) return 1 ;;
    esac
}

# Prune C-Gate log files under the managed install directory. Runs on every
# boot before C-Gate starts so a reinstall is not the only way to reclaim
# space (#81). Echoes a one-line summary when anything was removed.
_cgateweb_prune_cgate_logs() {
    local cgate_dir="$1"
    local max_bytes="${2:-${CGATEWEB_LOG_MAX_BYTES}}"
    local max_age_days="${3:-${CGATEWEB_LOG_MAX_AGE_DAYS}}"
    local -a candidates=()
    local file age_bytes deleted_age=0 deleted_size=0 reclaimed=0

    [[ -d "${cgate_dir}" ]] || return 0

    while IFS= read -r -d '' file; do
        _cgateweb_prune_cgate_logs_is_prunable "${cgate_dir}" "${file}" || continue
        candidates+=("${file}")
    done < <(find "${cgate_dir}" \( -path "${cgate_dir}/logs/*" -o -path "${cgate_dir}/log/*" \
        -o -name 'event.*.log' -o -name 'event-*' \) -type f -print0 2>/dev/null)

    if [[ ${#candidates[@]} -eq 0 ]]; then
        return 0
    fi

    for file in "${candidates[@]}"; do
        [[ -f "${file}" ]] || continue
        if find "${file}" -mtime +"${max_age_days}" -print -quit 2>/dev/null | grep -q .; then
            age_bytes=$(stat -c '%s' "${file}" 2>/dev/null || echo 0)
            rm -f "${file}" && deleted_age=$((deleted_age + 1)) && reclaimed=$((reclaimed + age_bytes))
        fi
    done

    # Rebuild the candidate list after age pruning.
    candidates=()
    while IFS= read -r -d '' file; do
        _cgateweb_prune_cgate_logs_is_prunable "${cgate_dir}" "${file}" || continue
        candidates+=("${file}")
    done < <(find "${cgate_dir}" \( -path "${cgate_dir}/logs/*" -o -path "${cgate_dir}/log/*" \
        -o -name 'event.*.log' -o -name 'event-*' \) -type f -print0 2>/dev/null)

    local total=0 size
    for file in "${candidates[@]}"; do
        [[ -f "${file}" ]] || continue
        size=$(stat -c '%s' "${file}" 2>/dev/null || echo 0)
        total=$((total + size))
    done

    while [[ ${total} -gt ${max_bytes} && ${#candidates[@]} -gt 0 ]]; do
        local oldest="" oldest_mtime=9999999999 oldest_size=0 idx=-1 i mtime
        for i in "${!candidates[@]}"; do
            file="${candidates[$i]}"
            [[ -f "${file}" ]] || continue
            mtime=$(stat -c '%Y' "${file}" 2>/dev/null || echo 0)
            if [[ ${mtime} -lt ${oldest_mtime} ]]; then
                oldest_mtime=${mtime}
                oldest="${file}"
                oldest_size=$(stat -c '%s' "${file}" 2>/dev/null || echo 0)
                idx=${i}
            fi
        done
        [[ -n "${oldest}" && ${idx} -ge 0 ]] || break
        rm -f "${oldest}" && deleted_size=$((deleted_size + 1)) && reclaimed=$((reclaimed + oldest_size)) \
            && total=$((total - oldest_size))
        unset "candidates[${idx}]"
        # Compact sparse array after unset.
        local compact=()
        for file in "${candidates[@]}"; do
            [[ -n "${file}" ]] && compact+=("${file}")
        done
        candidates=("${compact[@]}")
    done

    if [[ $((deleted_age + deleted_size)) -gt 0 ]]; then
        bashio::log.info "Pruned C-Gate log files: ${deleted_age} older than ${max_age_days} day(s), ${deleted_size} over the ${max_bytes}-byte cap (~$((reclaimed / 1048576)) MiB reclaimed)"
    fi
}

# Whether the user explicitly asked to reinstall/upgrade C-Gate via the
# cgate_force_reinstall toggle. Echoes 1 (yes) or 0 (no). Once C-Gate is on the
# persistent /data volume the installer otherwise skips it forever, so this is
# the explicit escape hatch for upgrading the bundled binary (issue #16 follow-up:
# a user stuck on 3.3.2 could not move to 3.7.1).
_cgateweb_force_reinstall_requested() {
    local v
    v=$(bashio::config 'cgate_force_reinstall')
    if [[ "${v}" == "true" ]]; then printf '1'; else printf '0'; fi
}

# Upload-mode auto-upgrade: echo 1 when the newest *.zip in the share dir is
# newer than the recorded install marker (or no marker exists yet), else 0.
# Lets a user upgrade simply by dropping a newer C-Gate zip into /share/cgate,
# mirroring the `-nt` newer-than check used by cgate-project-sync.sh.
_cgateweb_upload_zip_is_newer() {
    local share_dir="$1" marker="$2"
    local zip
    zip=$(find "${share_dir}" -maxdepth 1 -name '*.zip' -type f 2>/dev/null | head -1)
    if [[ -z "${zip}" ]]; then printf '0'; return; fi
    if [[ ! -e "${marker}" || "${zip}" -nt "${marker}" ]]; then printf '1'; else printf '0'; fi
}

# The dead end both serial-resolution paths share: the configured device is
# not there and nothing could stand in for it. Says where to find the real
# path rather than just naming the one that failed.
_cgateweb_serial_device_not_found() {
    bashio::log.error "Serial device not found: $1"
    bashio::log.error "Find the real path in Home Assistant: Settings > System > Hardware > ⋮ (top right) > All hardware"
    bashio::log.error "Look for /dev/ttyUSB* or /dev/ttyACM*; prefer the stable /dev/serial/by-id/ path"
}

# ─── ALPHA: USB-serial PCI passthrough (issue #28) ─────────────────────────
# Validate the opt-in cgate_serial_device option. The option is deliberately
# absent from `options` in config.yaml, so it is unset for every existing user
# and this helper is a silent no-op unless explicitly configured. When it IS
# set we fail hard on a clearly wrong path: better to stop the add-on at
# cont-init with a readable error than let C-Gate boot and silently never
# open the port. Returns 1 when the configured path is invalid.
_cgateweb_check_serial_device() {
    local device
    device=$(bashio::config 'cgate_serial_device' '')
    # bashio::config yields the literal string "null" for unset optional fields
    # (see the note above _cgateweb_resolve_download_url); treat it as unset.
    if [[ -z "${device}" || "${device}" == "null" ]]; then
        bashio::log.debug "cgate_serial_device not set — USB-serial PCI passthrough disabled"
        return 0
    fi

    bashio::log.warning "==================================================================="
    bashio::log.warning " USB-serial PC Interface support (beta): 5500PC/5500PCU"
    bashio::log.warning " cgate_serial_device = ${device}"
    bashio::log.warning " Field-tested with both interfaces. Report problems on GitHub issue #28:"
    bashio::log.warning "   https://github.com/dougrathbone/cgateweb/issues/28"
    bashio::log.warning "==================================================================="

    if [[ "${device}" != /dev/* ]]; then
        bashio::log.error "cgate_serial_device must be a device path starting with /dev/ (got: ${device})"
        bashio::log.error "Example: /dev/ttyUSB0 — or better, a stable /dev/serial/by-id/ path"
        return 1
    fi

    # Log every serial-looking device the host exposes, so a user who picked
    # the wrong path (or whose dongle enumerated differently than expected)
    # can see what actually exists. nullglob keeps unmatched patterns from
    # reaching ls as literal strings; a missing /dev/serial/by-id/ is fine.
    local inventory
    inventory=$(shopt -s nullglob; ls -l /dev/ttyUSB* /dev/ttyACM* /dev/serial/by-id/ 2>/dev/null)
    if [[ -n "${inventory}" ]]; then
        bashio::log.info "Detected serial devices on this host:"
        bashio::log.info "${inventory}"
    else
        bashio::log.info "No /dev/ttyUSB* or /dev/ttyACM* devices found and no /dev/serial/by-id/ directory — is the PCI plugged in?"
    fi

    # Turn the configured path into a live one. A PC Interface that is
    # unplugged and replugged can come back as a different ttyUSBn (issue #28),
    # so the resolver falls back to the identity recorded on the last good boot
    # instead of failing on a path that no longer exists. It prints the chosen
    # path on stdout and its diagnostics on stderr; the two streams are captured
    # separately so the answer never depends on how Node happened to interleave
    # them, and the diagnostics are replayed through bashio so they reach the
    # add-on log with a level prefix.
    local resolved
    if command -v node >/dev/null 2>&1; then
        # Node exits 1 for its own failures too — a missing or unreadable
        # script after a packaging slip, or a module load error — and the
        # exit-code contract below reads 1 as "the device is not there". Check
        # the script up front so a broken image is named as a broken image
        # instead of sending the user hunting for hardware that never moved.
        if [[ ! -r "${CGATEWEB_RESOLVE_SERIAL_JS}" ]]; then
            bashio::log.error "The serial device resolver is missing or unreadable: ${CGATEWEB_RESOLVE_SERIAL_JS}"
            bashio::log.error "This is a broken add-on image, not a missing device — your ${device} was not checked at all"
            bashio::log.error "Reinstall or update the add-on; if it persists, report it on https://github.com/dougrathbone/cgateweb/issues/28"
            return 1
        fi

        # Kept in the temp dir rather than beside the device file: a device
        # file the add-on cannot write is a warning below, not a reason to lose
        # the resolver's diagnostics or fail startup.
        local err_file resolver_status=0
        err_file=$(mktemp "${TMPDIR:-/tmp}/cgateweb-resolve-serial.XXXXXX")
        resolved=$(node "${CGATEWEB_RESOLVE_SERIAL_JS}" "${device}" 2>"${err_file}") || resolver_status=$?
        # The resolver tags each diagnostic with the level it deserves: advice
        # ("prefer the stable by-id path") is not a warning. Anything untagged
        # is unexpected output — a node crash, say — so it warns.
        # `|| [[ -n ... ]]` keeps a final line with no trailing newline.
        while IFS= read -r line || [[ -n "${line}" ]]; do
            case "${line}" in
                '')       ;;
                'INFO: '*) bashio::log.info "${line#INFO: }" ;;
                'WARN: '*) bashio::log.warning "${line#WARN: }" ;;
                *)        bashio::log.warning "${line}" ;;
            esac
        done < "${err_file}"
        rm -f "${err_file}"
        # Exit 1 means the device genuinely is not there; anything else means
        # the resolver failed for its own reasons (it exits 2 when it recovered
        # a new path but could not publish it). Reporting both as "device not
        # found" sent users hunting for a device that was plugged in the whole
        # time. The readability check above covers the other way node itself
        # produces a 1 — a missing or unreadable script.
        if [[ ${resolver_status} -eq 1 ]]; then
            _cgateweb_serial_device_not_found "${device}"
            return 1
        elif [[ ${resolver_status} -ne 0 ]]; then
            bashio::log.error "Could not determine which serial device to use (resolver exited ${resolver_status}) — see the messages above"
            return 1
        fi
    else
        # No node means no resolver and no recovery from a renumber; fall back
        # to the plain existence check used before issue #28, which is correct
        # whenever the device has not moved.
        bashio::log.warning "node is unavailable — checking ${device} directly, without identity-based recovery"
        if [[ ! -e "${device}" ]]; then
            _cgateweb_serial_device_not_found "${device}"
            return 1
        fi
        resolved="${device}"
    fi

    # Publish the agreed path. cgate-project-sync.sh and the serial diagnostics
    # read this file instead of re-resolving cgate_serial_device themselves: a
    # second resolution can disagree with this one if the device renumbers in
    # between, which is how the install check could pass while the project
    # fixup wrote a port name that no longer existed.
    #
    # The resolver already wrote the file whenever it could, so this write
    # covers the node-less fallback above and re-affirms the file otherwise.
    # It can still fail: the resolver returns success (rather than aborting
    # startup) when the file is unwritable but the path it resolved is the
    # configured one, because the consumers' fallback to cgate_serial_device
    # then yields exactly the same answer. That is the only way to reach the
    # warning below with node present — a resolved path that *differs* from the
    # configured one and cannot be published has already exited non-zero above.
    mkdir -p "${CGATEWEB_SERIAL_DEVICE_FILE%/*}" 2>/dev/null
    if ! { printf '%s' "${resolved}" > "${CGATEWEB_SERIAL_DEVICE_FILE}"; } 2>/dev/null; then
        bashio::log.warning "Could not record the resolved serial device in ${CGATEWEB_SERIAL_DEVICE_FILE} — later steps will re-read cgate_serial_device (${device}), which is the same path"
    fi

    # Show the selected device's details and resolve symlinks so a
    # /dev/serial/by-id/ path also logs its real target (e.g. ../../ttyUSB0).
    bashio::log.info "Selected device: $(ls -l "${resolved}" 2>/dev/null)"
    # Only the configured path and the resolved path are related by
    # configuration; the readlink target belongs to the resolved path alone.
    # Pairing "${device} resolves to ${target}" after a recovery read as a
    # symlink relationship that does not exist.
    if [[ "${resolved}" != "${device}" ]]; then
        bashio::log.info "Resolved to a different device: ${resolved} (the configured ${device} renumbered)"
    fi
    local target
    target=$(readlink -f "${resolved}" 2>/dev/null || printf '%s' "${resolved}")
    bashio::log.info "Serial device ${resolved} resolves to ${target}"

    if [[ ! -c "${resolved}" ]]; then
        bashio::log.warning "${resolved} exists but is not a character device — C-Gate may fail to open it"
    fi

    # A local serial device is only meaningful when C-Gate runs inside this
    # add-on. In remote mode C-Gate runs on another machine, so warn (not
    # fail) that the option has no effect there.
    local mode
    mode=$(bashio::config 'cgate_mode' 'remote')
    if [[ "${mode}" != "managed" ]]; then
        bashio::log.warning "cgate_mode is '${mode}': C-Gate runs outside this add-on, so a local serial device is never used"
        bashio::log.warning "cgate_serial_device only takes effect in managed mode — continuing anyway"
    fi

    bashio::log.info "USB-serial PCI: your C-Bus Toolkit project (.db) must define a serial PC Interface for the network"
    bashio::log.info "Projects saved on Windows reference a COMx port — the project sync will rewrite it to this device automatically"
    return 0
}

# ─── C-Gate access control ─────────────────────────────────────────────────
# Markers delimiting the block this script owns. Anything outside them is the
# user's and is preserved across boots.
CGATEWEB_ACCESS_BEGIN='# >>> cgateweb managed block - do not edit <<<'
CGATEWEB_ACCESS_END='# <<< cgateweb managed block >>>'

# One "remote <address> <level>" line per configured external client, or
# nothing when the list is empty. Split out so it can be stubbed in tests
# without depending on bashio's list flattening.
_cgateweb_external_client_rules() {
    local count
    count=$(bashio::config 'cgate_external_clients|length' '0')
    [[ "${count}" =~ ^[0-9]+$ ]] || count=0

    local i address level
    for ((i = 0; i < count; i++)); do
        address=$(bashio::config "cgate_external_clients[${i}].address" '')
        level=$(bashio::config "cgate_external_clients[${i}].level" '')

        # A blank address used to be skipped silently, so a user who added a row
        # and left the address empty got no rule and no message, and would
        # believe external access had been granted. Fail like the level check
        # below does, naming which entry is at fault.
        if [[ -z "${address}" || "${address}" == "null" ]]; then
            bashio::log.error "Missing address for cgate_external_clients entry ${i} (the first entry is 0); set the client's IP address or hostname, or remove the entry"
            return 1
        fi

        # A newline embedded in the option value (a copy-paste slip, say)
        # would otherwise split the printf below into two lines, each read
        # and validated independently by the caller as its own `remote`
        # rule the user never authored. No privilege escalation results --
        # the emitted keyword is always the literal "remote" regardless of
        # what a split line parses as -- but it is still an unintended rule.
        # Reject any whitespace in the address outright instead.
        if [[ "${address}" =~ [[:space:]] ]]; then
            bashio::log.error "Invalid address in cgate_external_clients: contains whitespace (check for an embedded newline)"
            return 1
        fi

        # Unreachable through the HA UI today (the schema's level field is a
        # required list()), but a hand-edited options.json could still hit
        # this. Fail loud like every other invalid level rather than
        # silently downgrading to monitor.
        if [[ -z "${level}" || "${level}" == "null" ]]; then
            bashio::log.error "Missing level for cgate_external_clients address '${address}'; use monitor, operate or program"
            return 1
        fi

        printf 'remote %s %s\n' "${address}" "${level}"
    done
}

# Given a dotted-quad IPv4 address, echoes the "meaning" of any wildcard (255)
# octets with each replaced by 'x' -- e.g. "192.168.1.255" -> "192.168.1.x" --
# since an octet of 255 in a `remote` rule matches any value in that position
# (manual 4.10.1). Echoes nothing when the address is not a 4-octet dotted
# form, or has no 255 octet (nothing to warn about).
_cgateweb_ipv4_wildcard_meaning() {
    local address="$1"
    [[ "${address}" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || return 0

    local o1 o2 o3 o4
    IFS='.' read -r o1 o2 o3 o4 <<< "${address}"

    local has_wildcard=0
    [[ "${o1}" == "255" ]] && { o1='x'; has_wildcard=1; }
    [[ "${o2}" == "255" ]] && { o2='x'; has_wildcard=1; }
    [[ "${o3}" == "255" ]] && { o3='x'; has_wildcard=1; }
    [[ "${o4}" == "255" ]] && { o4='x'; has_wildcard=1; }
    [[ ${has_wildcard} -eq 1 ]] || return 0

    printf '%s.%s.%s.%s' "${o1}" "${o2}" "${o3}" "${o4}"
}

# Write C-Gate's access control file (manual 4.10.1).
#
# The grammar is `<keyword> <address> <level>` with exactly three keywords:
# interface (the server NIC a connection arrives on), remote (the connecting
# client's address), and user. Levels, increasing, are none, connect, monitor,
# operate, admin, program, debug. Faulty lines are silently ignored.
#
# The C-Gate distribution zip ships its own config/access.txt, and the install
# step above (`cp -r "${EXTRACTED_DIR}"/* "${CGATE_DIR}/"`) always copies it
# onto disk, so managed installs have never actually run with an empty access
# list. The stock file grants `interface`-level Program to the IPv4 and IPv6
# loopback NICs:
#   interface 0:0:0:0:0:0:0:1 Program
#   interface 127.0.0.1 Program
#   interface localhost Program
# (An earlier version of this comment claimed a "only if the file is missing"
# guard left managed installs relying on a malformed, effectively-empty access
# list. That guard — `if [[ ! -f "${ACCESS_FILE}" ]]` — was always false
# because the stock file above already existed by the time it ran, so the
# malformed heredoc it guarded never actually executed. That claim was wrong
# and is corrected here.)
#
# This function adds an explicit, correctly-formed `remote` block scoped to
# the add-on's own loopback connection on top of — not instead of — that
# stock grant; the stock lines are preserved untouched outside the managed
# block below. It deliberately never emits an `interface` rule itself: unlike
# `remote`, an interface rule matches every connection arriving on the NIC it
# names, so one intended as a per-client grant silently becomes a blanket
# grant for everything on that NIC. The three awk patterns below that strip
# bare `interface 127.0.0.1` / `program 127.0.0.1` / `monitor 127.0.0.1`
# lines (level names used as keywords, which C-Gate silently ignores) are
# defensive cleanup for any C-Gate release whose zip omits the stock
# access.txt, or an install this script mis-wrote before this fix — not the
# common case.
#
# Report a failed rewrite and decide whether it should stop the boot.
#
# An install that already has an access control file keeps working with the one
# it has: C-Gate reads that file, not this function's intentions. A cont-init
# script returning non-zero stops the add-on from starting altogether, and
# 1.17.6 did nothing at all when the file already existed — so failing the boot
# to add a rule to a file that is already granting the add-on access trades a
# working system for a broken one. Warn and carry on instead, the same
# deliberate choice the serial path makes when it cannot publish its resolved
# device. Only a fresh install with no file to fall back on is fatal.
#
# The diagnosis is chosen here rather than at each call site because an
# unwritable directory makes every step fail, and reporting that as "the
# existing file could not be parsed" sent people examining the contents of a
# file that was perfectly fine.
_cgateweb_access_rewrite_failed() {
    local access_file="$1"
    local detail="$2"
    local dir
    dir=$(dirname "${access_file}")

    local diagnosis="${detail}"
    if [[ ! -w "${dir}" ]]; then
        diagnosis="the directory ${dir} is not writable"
    fi

    if [[ -f "${access_file}" ]]; then
        bashio::log.warning "Could not update the C-Gate access control file: ${diagnosis}"
        bashio::log.warning "Keeping the existing ${access_file}; C-Gate will start with the access rules already in it"
        if [[ -n "${CGATE_EXTERNAL_CLIENTS_CONFIGURED:-}" ]]; then
            bashio::log.warning "Any cgate_external_clients rules you configured are NOT active until this file can be written"
        fi
        return 0
    fi

    bashio::log.error "Failed to write the C-Gate access control file ${access_file}: ${diagnosis}"
    return 1
}

_cgateweb_write_access_control() {
    local access_file="$1"
    local dir
    dir=$(dirname "${access_file}")

    if ! mkdir -p "${dir}" 2>/dev/null; then
        bashio::log.error "Could not create directory for C-Gate access control file: ${dir}"
        return 1
    fi

    if [[ -d "${access_file}" ]]; then
        bashio::log.error "C-Gate access control path is a directory, not a file: ${access_file}"
        return 1
    fi

    # cgateweb and managed C-Gate share this container, so the bridge connects
    # from loopback. `program` is not required by anything cgateweb itself
    # does: C-Gate loads and starts the project from project.start in
    # C-GateConfig.txt, not over an access-controlled client connection.
    # cgateweb's own traffic (TREEXML, GET, ON/OFF/RAMP, EVENT ON, LOGIN) only
    # ever needs `operate` (`monitor` is enough on the event port). `program`
    # is kept here because it matches the stock access.txt's own loopback
    # grant (see the block comment above) rather than narrowing it — the
    # container runs with host_network: false, so the blast radius of that
    # extra headroom is nil.
    local -a rules=(
        "remote 127.0.0.1 program"
        "remote 0:0:0:0:0:0:0:1 program"
    )

    # External clients (issue #37): C-Gate is a multi-client server, so Toolkit
    # and friends connect to it directly rather than sharing the serial port.
    # Validate here so a typo fails cont-init with a readable error instead of
    # being silently dropped by C-Gate.
    #
    # Captured via command substitution (not process substitution) so this
    # function's own exit status is visible: _cgateweb_external_client_rules
    # can now fail (e.g. MINOR 2/3 below) and that failure must abort
    # cont-init rather than being silently swallowed by a background reader.
    local external_rules external_rules_status=0
    external_rules=$(_cgateweb_external_client_rules) || external_rules_status=$?
    if [[ ${external_rules_status} -ne 0 ]]; then
        bashio::log.error "Failed to read cgate_external_clients -- see the message above"
        return 1
    fi

    local line keyword address level extra wildcard_meaning
    while IFS= read -r line; do
        [[ -z "${line}" ]] && continue
        # `read` splits on whitespace without performing pathname expansion,
        # unlike the unquoted `set -- ${line}` this replaced: that let a glob
        # character in a hand-typed address (e.g. an address of "et?" with
        # cwd "/") expand against the filesystem before validation ever saw
        # it. A 4th field (extra) catches entries with too many words.
        read -r keyword address level extra <<< "${line}"
        if [[ -z "${keyword}" || -z "${address}" || -z "${level}" || -n "${extra}" ]]; then
            bashio::log.error "Invalid cgate_external_clients entry: '${line}'"
            return 1
        fi
        if [[ "${address}" == "255.255.255.255" ]]; then
            bashio::log.error "Invalid address in cgate_external_clients: '255.255.255.255'"
            bashio::log.error "Every octet of 255 matches any value, so this grants every address on the internet -- narrow it to the specific address or subnet you intend to allow."
            return 1
        fi
        if [[ ! "${address}" =~ ^[A-Za-z0-9_.:-]+$ ]]; then
            bashio::log.error "Invalid address in cgate_external_clients: '${address}'"
            bashio::log.error "Use an IP address or hostname. An octet of 255 matches any value, e.g. 192.168.1.255 for the whole subnet."
            return 1
        fi
        case "${level}" in
            monitor|operate|program) ;;
            *)
                bashio::log.error "Invalid level '${level}' for ${address}; use monitor, operate or program"
                return 1
                ;;
        esac
        wildcard_meaning=$(_cgateweb_ipv4_wildcard_meaning "${address}")
        if [[ -n "${wildcard_meaning}" ]]; then
            bashio::log.warning "C-Gate address ${address} grants every address on ${wildcard_meaning} (an octet of 255 matches any value)"
        fi
        rules+=("remote ${address} ${level}")
        bashio::log.warning "C-Gate access granted to ${address} at ${level} level"
    done <<< "${external_rules}"

    if [[ ${#rules[@]} -gt 2 ]]; then
        bashio::log.warning "C-Gate has no authentication on its command ports; only publish them if you need external access"
        # Deliberately not `local`: _cgateweb_access_rewrite_failed reads it to
        # warn that configured external rules are not active if the write fails.
        CGATE_EXTERNAL_CLIENTS_CONFIGURED=1
    fi

    # Cleaned up on every return from this function (success or failure) via
    # the RETURN trap below, so a failed rewrite never leaves a stray .tmp or
    # awk-stderr file behind. The trap clears itself (`trap - RETURN`) as its
    # last act: a RETURN trap set inside a function also fires again when an
    # enclosing `source` of this whole script finishes (a real bash quirk,
    # not just a function-to-function call) — at which point the local
    # variables it references no longer exist. Self-clearing means it only
    # ever fires once, for this function's own return.
    local tmp_file="${access_file}.tmp"
    # The awk stderr capture lives in the temp dir, not beside the access file.
    # Inside the target directory it turned an unwritable config directory into
    # a phantom parse failure: the shell could not create the redirection
    # target, reported its own raw "Permission denied" outside bashio's log
    # formatting, and failed the command substitution before awk ever ran — so
    # the diagnosis blamed the contents of a file that had not been read. Same
    # reasoning, and the same TMPDIR convention, as the resolver's err_file.
    local awk_err_file=""
    if ! awk_err_file=$(mktemp "${TMPDIR:-/tmp}/cgateweb-access-awkerr.XXXXXX" 2>/dev/null); then
        awk_err_file=""
        bashio::log.warning "Could not create a temporary file for access-control diagnostics; continuing without them"
    fi
    trap 'rm -f "${tmp_file}"; [[ -z "${awk_err_file}" ]] || rm -f "${awk_err_file}"; trap - RETURN' RETURN

    # Stop here when the directory cannot be written: every step below would
    # fail, and the shell reports a failed redirection itself, in raw bash form,
    # outside bashio. Checked after the cgate_external_clients validation above
    # so a typo in that option is still reported loudly rather than being
    # skipped along with the write. mkdir -p does not catch this — it succeeds
    # for a directory that already exists, whatever its permissions.
    if [[ ! -w "${dir}" ]]; then
        _cgateweb_access_rewrite_failed "${access_file}" "the directory ${dir} is not writable"
        return $?
    fi

    local preserved=""
    if [[ -f "${access_file}" ]]; then
        if [[ ! -r "${access_file}" ]]; then
            _cgateweb_access_rewrite_failed "${access_file}" "the existing file cannot be read"
            return $?
        fi

        # Keep everything outside our markers; drop the old block and any
        # pre-marker lines this script previously generated. Marker
        # comparison trims trailing whitespace and a trailing \r before
        # comparing, so a hand-edited or Windows-saved file (CRLF endings)
        # still resolves to a single managed block instead of growing a
        # second, stale one that stays live because C-Gate's Java readLine()
        # strips \r but awk's exact-match comparison would not. An orphaned
        # begin marker (no matching end — a hand-mangled file) preserves
        # everything after it instead of silently deleting it; a warning is
        # logged below when that happens.
        if ! preserved=$(awk -v b="${CGATEWEB_ACCESS_BEGIN}" -v e="${CGATEWEB_ACCESS_END}" '
            function norm(s) { sub(/\r$/, "", s); sub(/[ \t]+$/, "", s); return s }
            {
                marker = norm($0)
            }
            inblock && marker == e { inblock = 0; buffered = 0; next }
            marker == b { inblock = 1; buffered = 0; next }
            inblock {
                buffered++
                buf[buffered] = $0
                next
            }
            /^interface 127\.0\.0\.1$/ { next }
            /^program 127\.0\.0\.1$/   { next }
            /^monitor 127\.0\.0\.1$/   { next }
            { print }
            END {
                if (inblock) {
                    for (i = 1; i <= buffered; i++) print buf[i]
                    print "orphaned begin marker" > "/dev/stderr"
                }
            }
        ' "${access_file}" 2>"${awk_err_file:-/dev/null}"); then
            _cgateweb_access_rewrite_failed "${access_file}" "the existing file could not be parsed"
            return $?
        fi
        if [[ -n "${awk_err_file}" && -s "${awk_err_file}" ]]; then
            bashio::log.warning "C-Gate access control file ${access_file} had an orphaned managed-block begin marker with no matching end — preserving the content after it instead of discarding it"
        fi
    else
        preserved="# C-Gate Access Control
# Lines outside the cgateweb block below are preserved across restarts."
    fi

    # Two things about this redirection, both verified against bash 5.3 as a
    # non-root user:
    #
    #   - `2>/dev/null` precedes the stdout redirection deliberately.
    #     Redirections are applied left to right, so stderr is already discarded
    #     by the time bash tries to create tmp_file, which keeps the shell's own
    #     raw "Permission denied" out of the add-on log. The diagnosis comes from
    #     _cgateweb_access_rewrite_failed instead.
    #   - the status is captured with `|| write_status=$?` rather than tested by
    #     wrapping the group in `if ! ...`. A redirection that fails to open its
    #     target does set a non-zero status for the group, but that status is
    #     swallowed when the group is the condition of an `if !`, so the guard
    #     this replaced could never fire; the failure only surfaced at the `mv`
    #     below, one step later and with a misleading message.
    local write_status=0
    {
        printf '%s\n' "${preserved}"
        printf '%s\n' "${CGATEWEB_ACCESS_BEGIN}"
        local rule
        for rule in "${rules[@]}"; do printf '%s\n' "${rule}"; done
        printf '%s\n' "${CGATEWEB_ACCESS_END}"
    } 2>/dev/null > "${tmp_file}" || write_status=$?
    if [[ ${write_status} -ne 0 ]]; then
        _cgateweb_access_rewrite_failed "${access_file}" "the temporary file ${tmp_file} could not be written"
        return $?
    fi

    if ! mv "${tmp_file}" "${access_file}" 2>/dev/null; then
        _cgateweb_access_rewrite_failed "${access_file}" "the new file could not be moved into place"
        return $?
    fi

    bashio::log.info "Wrote C-Gate access control (${#rules[@]} rule(s))"
    return 0
}

# Allow tests to source this script for unit testing the helpers above without
# running the install flow.
if [[ "${CGATEWEB_INSTALL_SOURCE_ONLY:-0}" == "1" ]]; then
    return 0 2>/dev/null || exit 0
fi

# Wait for the Supervisor API before the first bashio::config read: bashio
# dies hard when the API is not yet listening, which would abort the whole
# cont-init stage (test-env CI flake, "Failed to get addon config from
# Supervisor API"). Sourced here, after the source-only guard, so unit tests
# never touch the add-on's real install path.
# shellcheck disable=SC1090
source "${CGATEWEB_SUPERVISOR_WAIT_LIB:-/usr/lib/cgateweb/supervisor-wait.sh}"
if ! cgateweb_wait_for_supervisor; then
    bashio::log.error "Supervisor API did not respond within ${CGATEWEB_SUPERVISOR_WAIT_ATTEMPTS:-60}s — cannot read add-on config"
    exit 1
fi

CGATE_MODE=$(bashio::config 'cgate_mode' 'remote')

# ALPHA serial PCI check (issue #28): validate cgate_serial_device in BOTH
# modes, before the remote-mode early exit below, so a configured value is
# always surfaced (in remote mode a local serial device is meaningless, but
# the user should still hear about it). No-op when the option is unset; a
# bad path fails here, up front, instead of after a lengthy C-Gate install.
if ! _cgateweb_check_serial_device; then
    exit 1
fi

if [[ "${CGATE_MODE}" != "managed" ]]; then
    bashio::log.info "C-Gate mode is '${CGATE_MODE}', skipping C-Gate installation"
    exit 0
fi

# Overridable so tests can point the whole install flow at a temp dir instead
# of the real /data/cgate, the same test-seam pattern used by
# CGATEWEB_SERIAL_DEVICE_FILE above. Unset in production, so this always
# resolves to /data/cgate there.
CGATE_DIR="${CGATE_DIR:-/data/cgate}"
CGATE_JAR="${CGATE_DIR}/cgate.jar"
INSTALL_SOURCE=$(bashio::config 'cgate_install_source' 'download')
DOWNLOAD_SHA256=$(_cgateweb_resolve_download_sha256)
WORK_DIR=$(mktemp -d /tmp/cgate-install.XXXXXX)

cleanup() {
    rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

# Decide whether to (re)install the C-Gate binary. Once installed on the
# persistent /data volume it is normally kept as-is and only the config block at
# the end refreshes every boot (so the issue #16 project.start fix still reaches
# existing installs). Reinstall when the user toggles cgate_force_reinstall, or
# — in upload mode — when a newer C-Gate zip is dropped into /share/cgate. These
# are the upgrade path the original #16 fix lacked: it froze the binary version
# on /data, leaving a user stuck on 3.3.2 unable to move to 3.7.1.
NEED_INSTALL=0
REINSTALL=0
if [[ ! -f "${CGATE_JAR}" ]]; then
    NEED_INSTALL=1
    bashio::log.info "C-Gate not found, installing from source: ${INSTALL_SOURCE}"
elif [[ "$(_cgateweb_force_reinstall_requested)" == "1" ]]; then
    NEED_INSTALL=1
    REINSTALL=1
    bashio::log.warning "cgate_force_reinstall is set — reinstalling C-Gate from source: ${INSTALL_SOURCE}"
    bashio::log.warning "Set cgate_force_reinstall back to false after the upgrade, or C-Gate reinstalls on every boot"
elif [[ "${INSTALL_SOURCE}" == "upload" && "$(_cgateweb_upload_zip_is_newer "/share/cgate" "${CGATE_DIR}/.version")" == "1" ]]; then
    NEED_INSTALL=1
    REINSTALL=1
    bashio::log.info "A newer C-Gate zip was found in /share/cgate — upgrading the installed C-Gate"
else
    bashio::log.info "C-Gate already installed at ${CGATE_DIR}; skipping install, refreshing config"
fi

if [[ "${NEED_INSTALL}" == "1" ]]; then

mkdir -p "${CGATE_DIR}"

if [[ "${INSTALL_SOURCE}" == "download" ]]; then
    DOWNLOAD_URL=$(_cgateweb_resolve_download_url)
    # Re-resolve the checksum now that the URL is known: with no user-set
    # cgate_download_sha256, a download from the built-in default URL falls
    # back to the pinned CGATEWEB_DEFAULT_DOWNLOAD_SHA256.
    DOWNLOAD_SHA256=$(_cgateweb_resolve_download_sha256 "${DOWNLOAD_URL}")

    bashio::log.info "Downloading C-Gate from: ${DOWNLOAD_URL}"

    # Validate URL scheme (allow only https, or http for local/dev)
    case "${DOWNLOAD_URL}" in
        https://*) ;;
        http://127.0.0.1*|http://localhost*) bashio::log.warning "Using insecure HTTP for local URL" ;;
        *)
            bashio::log.error "Invalid download URL scheme: ${DOWNLOAD_URL}"
            bashio::log.error "Only https:// URLs are allowed (or http://localhost for development)"
            exit 1
            ;;
    esac

    # Refuse a custom download URL with no pinned checksum before downloading
    # anything. Downloads from the built-in default URL reach the verification
    # step below with the pinned default checksum already resolved, so every
    # download is verified and fails hard on mismatch.
    if [[ "$(_cgateweb_custom_url_without_sha256 "${DOWNLOAD_URL}" "${DOWNLOAD_SHA256}")" == "1" ]]; then
        bashio::log.error "cgate_download_sha256 is required when cgate_download_url is set to a custom URL"
        bashio::log.error "Compute the zip's checksum ('sha256sum cgate.zip' or 'shasum -a 256 cgate.zip') and set cgate_download_sha256,"
        bashio::log.error "or clear cgate_download_url to use the built-in default download"
        exit 1
    fi

    TEMP_ZIP="${WORK_DIR}/cgate-download.zip"
    HTTP_CODE=""
    ACTUAL_SHA256=""
    DOWNLOAD_SIZE=0
    DOWNLOAD_OK=0
    EXPECTED_SHA256=$(echo "${DOWNLOAD_SHA256}" | tr '[:upper:]' '[:lower:]')

    # Retry the download a few times: field reports show CDN/proxy paths that
    # hand back truncated or error-page content (different bytes each run), and
    # a fresh attempt is the cheapest fix. Size + zip-magic logging makes a bad
    # download obvious in the log even when it ultimately fails.
    for attempt in 1 2 3; do
        CURL_EXIT=0
        HTTP_CODE=$(curl -fSL --max-time 600 --connect-timeout 30 -w "%{http_code}" -o "${TEMP_ZIP}" "${DOWNLOAD_URL}" 2>"${WORK_DIR}/curl.err") || CURL_EXIT=$?

        if [[ ${CURL_EXIT} -ne 0 ]]; then
            CURL_ERR=$(cat "${WORK_DIR}/curl.err" 2>/dev/null || echo "unknown")
            bashio::log.error "Failed to download C-Gate (HTTP ${HTTP_CODE}, curl exit ${CURL_EXIT})"
            bashio::log.error "URL: ${DOWNLOAD_URL}"
            bashio::log.error "Error: ${CURL_ERR}"
            if [[ "${HTTP_CODE}" == "404" ]]; then
                bashio::log.error "The download URL returned 404 — the file is no longer at that location."
            fi
            _cgateweb_log_download_guidance
            exit 1
        fi

        DOWNLOAD_SIZE=$(stat -c%s "${TEMP_ZIP}" 2>/dev/null || stat -f%z "${TEMP_ZIP}" 2>/dev/null || echo 0)
        bashio::log.info "Downloaded ${DOWNLOAD_SIZE} bytes (attempt ${attempt}/3)"

        # A real zip starts with PK; an HTML error page or proxy block page does not.
        if ! head -c 2 "${TEMP_ZIP}" | grep -q '^PK'; then
            bashio::log.warning "Downloaded file is not a zip archive (no PK header — likely an error or block page)"
            if [[ ${attempt} -lt 3 ]]; then
                bashio::log.warning "Retrying the download..."
                sleep $((attempt * 10))
                continue
            fi
            break
        fi

        if [[ -z "${DOWNLOAD_SHA256}" ]]; then
            bashio::log.warning "No cgate_download_sha256 configured; integrity verification skipped"
            DOWNLOAD_OK=1
            break
        fi

        ACTUAL_SHA256=$(sha256sum "${TEMP_ZIP}" | awk '{print $1}')
        if [[ "${ACTUAL_SHA256}" == "${EXPECTED_SHA256}" ]]; then
            bashio::log.info "Checksum verification passed"
            DOWNLOAD_OK=1
            break
        fi

        if [[ ${attempt} -lt 3 ]]; then
            bashio::log.warning "Checksum mismatch (attempt ${attempt}/3) — download may be truncated or rewritten by a proxy; retrying..."
            sleep $((attempt * 10))
        fi
    done

    if [[ ${DOWNLOAD_OK} -ne 1 ]]; then
        bashio::log.error "C-Gate download failed verification after 3 attempts"
        if [[ -z "${ACTUAL_SHA256}" ]]; then
            # No attempt produced a real zip: the URL served a web page.
            bashio::log.error "The URL served a web page, not the C-Gate package. If this URL came from Schneider's"
            bashio::log.error "portal, note that newer C-Gate versions require a Schneider login — download it in"
            bashio::log.error "a browser instead of pointing the add-on at the portal URL."
        else
            bashio::log.error "Expected: ${EXPECTED_SHA256}"
            bashio::log.error "Actual:   ${ACTUAL_SHA256} (${DOWNLOAD_SIZE} bytes)"
            bashio::log.error "Either the download path is corrupting the file (flaky network, proxy or CDN block page),"
            bashio::log.error "or Clipsal/Schneider repackaged the zip — they did on 2026-07-24, breaking fresh"
            bashio::log.error "installs until this add-on's pinned checksum was updated."
        fi
        _cgateweb_log_download_guidance
        exit 1
    fi

    # Reject suspiciously large downloads (>500MB)
    DOWNLOAD_SIZE=$(stat -c%s "${TEMP_ZIP}" 2>/dev/null || stat -f%z "${TEMP_ZIP}" 2>/dev/null || echo 0)
    if [[ ${DOWNLOAD_SIZE} -gt 524288000 ]]; then
        bashio::log.error "Downloaded file is too large (${DOWNLOAD_SIZE} bytes, max 500MB)"
        _cgateweb_log_download_guidance
        exit 1
    fi

    bashio::log.info "Download complete (${DOWNLOAD_SIZE} bytes), extracting..."
    _cgateweb_verify_zip_safe "${TEMP_ZIP}" || exit 1
    if ! unzip -o "${TEMP_ZIP}" -d "${WORK_DIR}/extract" 2>&1; then
        bashio::log.error "Failed to extract C-Gate zip file"
        exit 1
    fi

elif [[ "${INSTALL_SOURCE}" == "upload" ]]; then
    SHARE_DIR="/share/cgate"
    if [[ ! -d "${SHARE_DIR}" ]]; then
        bashio::log.error "Upload directory not found: ${SHARE_DIR}"
        bashio::log.error "Create the directory and place a C-Gate .zip file in it"
        exit 1
    fi

    ZIP_FILE=$(find "${SHARE_DIR}" -maxdepth 1 -name '*.zip' -type f | head -1)
    if [[ -z "${ZIP_FILE}" ]]; then
        bashio::log.error "No .zip file found in ${SHARE_DIR}"
        bashio::log.error "Download C-Gate from Clipsal and place the .zip in ${SHARE_DIR}"
        exit 1
    fi

    bashio::log.info "Found C-Gate zip: ${ZIP_FILE}"
    bashio::log.info "Extracting..."
    if [[ -n "${DOWNLOAD_SHA256}" ]]; then
        ACTUAL_SHA256=$(sha256sum "${ZIP_FILE}" | awk '{print $1}')
        EXPECTED_SHA256=$(echo "${DOWNLOAD_SHA256}" | tr '[:upper:]' '[:lower:]')
        if [[ "${ACTUAL_SHA256}" != "${EXPECTED_SHA256}" ]]; then
            bashio::log.error "Uploaded C-Gate checksum mismatch"
            bashio::log.error "Expected: ${EXPECTED_SHA256}"
            bashio::log.error "Actual:   ${ACTUAL_SHA256}"
            exit 1
        fi
        bashio::log.info "Checksum verification passed"
    else
        bashio::log.warning "No cgate_download_sha256 configured; integrity verification skipped for uploaded C-Gate zip"
    fi

    _cgateweb_verify_zip_safe "${ZIP_FILE}" || exit 1
    if ! unzip -o "${ZIP_FILE}" -d "${WORK_DIR}/extract" 2>&1; then
        bashio::log.error "Failed to extract ${ZIP_FILE}"
        exit 1
    fi
else
    bashio::log.error "Unknown install source: ${INSTALL_SOURCE}"
    exit 1
fi

# Security: reject symlinks in extracted content (prevent path traversal)
SYMLINKS=$(find "${WORK_DIR}/extract" -type l 2>/dev/null)
if [[ -n "${SYMLINKS}" ]]; then
    bashio::log.error "Extracted archive contains symbolic links — rejecting for security"
    bashio::log.error "Symlinks found: ${SYMLINKS}"
    exit 1
fi

# The Schneider download is a zip-within-a-zip: the outer archive contains a
# release notes PDF and an inner cgate-X.X.X_NNNN.zip with the actual files.
# If cgate.jar is not yet visible, look for and extract any nested zip files.
CGATE_VERSION=""
NESTED_JAR=$(find "${WORK_DIR}/extract" -name 'cgate.jar' -type f | head -1)
if [[ -z "${NESTED_JAR}" ]]; then
    bashio::log.info "cgate.jar not found at top level, checking for nested zip..."
    NESTED_ZIP=$(find "${WORK_DIR}/extract" -name '*.zip' -type f | head -1)
    if [[ -n "${NESTED_ZIP}" ]]; then
        # Extract version from filename pattern: cgate-3.3.2_1855.zip -> 3.3.2_1855
        NESTED_NAME=$(basename "${NESTED_ZIP}" .zip)
        CGATE_VERSION="${NESTED_NAME#cgate-}"
        bashio::log.info "Extracting nested archive: $(basename "${NESTED_ZIP}")"
        _cgateweb_verify_zip_safe "${NESTED_ZIP}" || exit 1
        if ! unzip -o "${NESTED_ZIP}" -d "${WORK_DIR}/extract" 2>&1; then
            bashio::log.error "Failed to extract nested zip: ${NESTED_ZIP}"
            exit 1
        fi
        # Re-check for symlinks after nested extraction
        SYMLINKS=$(find "${WORK_DIR}/extract" -type l 2>/dev/null)
        if [[ -n "${SYMLINKS}" ]]; then
            bashio::log.error "Nested archive contains symbolic links — rejecting for security"
            exit 1
        fi
    fi
fi

# Find and copy the C-Gate files to the persistent data directory
EXTRACTED_JAR=$(find "${WORK_DIR}/extract" -name 'cgate.jar' -type f | head -1)
if [[ -z "${EXTRACTED_JAR}" ]]; then
    bashio::log.error "cgate.jar not found in extracted archive"
    bashio::log.error "The zip file may not be a valid C-Gate package"
    exit 1
fi

EXTRACTED_DIR=$(dirname "${EXTRACTED_JAR}")
bashio::log.info "Found C-Gate installation in: ${EXTRACTED_DIR}"

# On reinstall/upgrade, preserve the user's project DBs and C-Gate config across
# the binary swap, then clear stale program files so old jars don't linger next
# to the new ones. Extraction has already succeeded here, so the wipe window is
# minimal. The preserved Projects/ and config/ are restored over any defaults
# shipped in the fresh package.
PRESERVE_DIR=""
if [[ "${REINSTALL}" == "1" ]]; then
    PRESERVE_DIR=$(mktemp -d "${WORK_DIR}/preserve.XXXXXX")
    [[ -d "${CGATE_DIR}/Projects" ]] && mv "${CGATE_DIR}/Projects" "${PRESERVE_DIR}/"
    [[ -d "${CGATE_DIR}/config" ]] && mv "${CGATE_DIR}/config" "${PRESERVE_DIR}/"
    rm -rf "${CGATE_DIR:?}/"*
fi

cp -r "${EXTRACTED_DIR}"/* "${CGATE_DIR}/"

if [[ -n "${PRESERVE_DIR}" ]]; then
    [[ -d "${PRESERVE_DIR}/Projects" ]] && cp -rp "${PRESERVE_DIR}/Projects" "${CGATE_DIR}/"
    [[ -d "${PRESERVE_DIR}/config" ]] && cp -rp "${PRESERVE_DIR}/config" "${CGATE_DIR}/"
    bashio::log.info "Preserved existing project DBs and C-Gate config across the upgrade"
fi

# Restrict permissions on installed files
chmod -R go-w "${CGATE_DIR}/" 2>/dev/null || true

fi  # end NEED_INSTALL

# Refresh the diagnostic version on every boot so existing managed installs
# whose marker says "unknown" are repaired without forcing a reinstall.
_cgateweb_record_installed_version "${CGATE_DIR}" "${CGATE_VERSION:-}"

# Configure access.txt. Runs on every boot, not only when the file is absent,
# so the grammar fix and any configured external clients reach existing installs.
ACCESS_FILE="${CGATE_DIR}/config/access.txt"
if ! _cgateweb_write_access_control "${ACCESS_FILE}"; then
    bashio::log.error "Failed to write C-Gate access control file"
    exit 1
fi

# Set the project name and port configuration in C-Gate config. This runs on
# every boot (see the install guard above) so settings changes and the
# project.start fix reach existing installs, not just fresh ones.
CGATE_PROJECT=$(bashio::config 'cgate_project' 'HOME')
CGATE_PORT=$(bashio::config 'cgate_port' '20023')
CGATE_CONFIG="${CGATE_DIR}/config/C-GateConfig.txt"
# Always apply: the helper seeds the file if C-Gate has not generated it yet
# (fresh install), so project.start is in place before C-Gate's first start.
# event-port is intentionally left at C-Gate's default (20024); cgateweb reads
# the load-change/status stream on 20025 (#21).
_cgateweb_apply_cgate_config "${CGATE_CONFIG}" "${CGATE_PROJECT}" "${CGATE_PORT}"
bashio::log.info "Set project to: ${CGATE_PROJECT} (project.default + project.start)"
bashio::log.info "Set command port to: ${CGATE_PORT}"
bashio::log.info "Left event-port at C-Gate default (status stream stays on 20025 for cgateweb)"
bashio::log.info "Capped C-Gate event-file logs at ${CGATEWEB_EVENT_FILE_SPLIT_COUNT} x ${CGATEWEB_EVENT_FILE_SPLIT_SIZE} bytes"
_cgateweb_prune_cgate_logs "${CGATE_DIR}"

bashio::log.info "C-Gate installation complete"
