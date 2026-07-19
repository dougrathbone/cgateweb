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
CGATEWEB_DEFAULT_DOWNLOAD_SHA256="b6a3f8b8e722b239c0974036ab316d8ec7e1c74ad8d9976a08dbcdec9a43948c"

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
    bashio::log.warning " ALPHA FEATURE ACTIVE: USB-serial PC Interface (5500PC/5500PCU)"
    bashio::log.warning " cgate_serial_device = ${device}"
    bashio::log.warning " This support is experimental and largely untested. Please report"
    bashio::log.warning " success or failure on GitHub issue #28:"
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

    if [[ ! -e "${device}" ]]; then
        bashio::log.error "Serial device not found: ${device}"
        bashio::log.error "Find the real path in Home Assistant: Settings > System > Hardware > ⋮ (top right) > All hardware"
        bashio::log.error "Look for /dev/ttyUSB* or /dev/ttyACM*; prefer the stable /dev/serial/by-id/ path"
        return 1
    fi

    # Show the selected device's details and resolve symlinks so a
    # /dev/serial/by-id/ path also logs its real target (e.g. ../../ttyUSB0).
    bashio::log.info "Selected device: $(ls -l "${device}" 2>/dev/null)"
    local resolved
    resolved=$(readlink -f "${device}" 2>/dev/null || printf '%s' "${device}")
    bashio::log.info "Serial device ${device} resolves to ${resolved}"

    if [[ ! -c "${device}" ]]; then
        bashio::log.warning "${device} exists but is not a character device — C-Gate may fail to open it"
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
    bashio::log.info "Projects saved on Windows may reference a COMx port — re-point the interface at the Linux device path in Toolkit"
    return 0
}

# Allow tests to source this script for unit testing the helpers above without
# running the install flow.
if [[ "${CGATEWEB_INSTALL_SOURCE_ONLY:-0}" == "1" ]]; then
    return 0 2>/dev/null || exit 0
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

CGATE_DIR="/data/cgate"
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
    HTTP_CODE=$(curl -fSL --max-time 600 --connect-timeout 30 -w "%{http_code}" -o "${TEMP_ZIP}" "${DOWNLOAD_URL}" 2>"${WORK_DIR}/curl.err" || true)
    CURL_EXIT=$?

    if [[ ${CURL_EXIT} -ne 0 ]]; then
        CURL_ERR=$(cat "${WORK_DIR}/curl.err" 2>/dev/null || echo "unknown")
        bashio::log.error "Failed to download C-Gate (HTTP ${HTTP_CODE}, curl exit ${CURL_EXIT})"
        bashio::log.error "URL: ${DOWNLOAD_URL}"
        bashio::log.error "Error: ${CURL_ERR}"
        if [[ "${HTTP_CODE}" == "404" ]]; then
            bashio::log.error "The download URL returned 404. Schneider Electric may have updated the download location."
            bashio::log.error "Visit https://www.se.com and search for 'C-Gate 3 Linux' to find the current URL."
            bashio::log.error "Then set cgate_download_url in the addon configuration."
        fi
        bashio::log.error "Alternative: set cgate_install_source to 'upload' and place the C-Gate zip in /share/cgate/"
        exit 1
    fi

    if [[ -n "${DOWNLOAD_SHA256}" ]]; then
        ACTUAL_SHA256=$(sha256sum "${TEMP_ZIP}" | awk '{print $1}')
        EXPECTED_SHA256=$(echo "${DOWNLOAD_SHA256}" | tr '[:upper:]' '[:lower:]')
        if [[ "${ACTUAL_SHA256}" != "${EXPECTED_SHA256}" ]]; then
            bashio::log.error "C-Gate download checksum mismatch"
            bashio::log.error "Expected: ${EXPECTED_SHA256}"
            bashio::log.error "Actual:   ${ACTUAL_SHA256}"
            exit 1
        fi
        bashio::log.info "Checksum verification passed"
    else
        bashio::log.warning "No cgate_download_sha256 configured; integrity verification skipped"
    fi

    # Reject suspiciously large downloads (>500MB)
    DOWNLOAD_SIZE=$(stat -c%s "${TEMP_ZIP}" 2>/dev/null || stat -f%z "${TEMP_ZIP}" 2>/dev/null || echo 0)
    if [[ ${DOWNLOAD_SIZE} -gt 524288000 ]]; then
        bashio::log.error "Downloaded file is too large (${DOWNLOAD_SIZE} bytes, max 500MB)"
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

# Record installed version for diagnostics reporting
if [[ -n "${CGATE_VERSION}" ]]; then
    echo "${CGATE_VERSION}" > "${CGATE_DIR}/.version"
    bashio::log.info "Recorded C-Gate version: ${CGATE_VERSION}"
else
    echo "unknown" > "${CGATE_DIR}/.version"
fi

fi  # end NEED_INSTALL

# Configure access.txt to allow local connections
ACCESS_FILE="${CGATE_DIR}/config/access.txt"
if [[ ! -f "${ACCESS_FILE}" ]]; then
    mkdir -p "${CGATE_DIR}/config"
    cat > "${ACCESS_FILE}" << 'ACCESSEOF'
# C-Gate Access Control
# Allow local connections from the addon
interface 127.0.0.1
program 127.0.0.1
monitor 127.0.0.1
ACCESSEOF
    bashio::log.info "Created default access.txt"
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

bashio::log.info "C-Gate installation complete"
