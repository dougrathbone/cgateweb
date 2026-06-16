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

_cgateweb_resolve_download_sha256() {
    local sha
    sha=$(bashio::config 'cgate_download_sha256')
    if [[ "${sha}" == "null" ]]; then
        sha=""
    fi
    printf '%s' "${sha}"
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
    local event_port="$4"

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
    # C-Gate doesn't recognize these and warns about them at startup.
    local tmp="${config_file}.tmp.$$"
    sed '/^CommandInterface\.port=/d;/^EventInterface\.port=/d' "${config_file}" > "${tmp}" && mv "${tmp}" "${config_file}"

    # project.default names the project; project.start is what actually makes
    # C-Gate load+start it at boot (project.default alone does nothing).
    _cgateweb_set_config_key "${config_file}" "project.default" "${project}"
    _cgateweb_set_config_key "${config_file}" "project.start" "${project}"
    _cgateweb_set_config_key "${config_file}" "command-port" "${command_port}"
    _cgateweb_set_config_key "${config_file}" "event-port" "${event_port}"
}

# Allow tests to source this script for unit testing the helpers above without
# running the install flow.
if [[ "${CGATEWEB_INSTALL_SOURCE_ONLY:-0}" == "1" ]]; then
    return 0 2>/dev/null || exit 0
fi

CGATE_MODE=$(bashio::config 'cgate_mode' 'remote')

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

# Install C-Gate only if it is not already present. The config block at the end
# runs on EVERY boot regardless, so existing/upgrading installs still pick up
# settings changes (e.g. the project.start fix in issue #16).
if [[ -f "${CGATE_JAR}" ]]; then
    bashio::log.info "C-Gate already installed at ${CGATE_DIR}; skipping install, refreshing config"
else
bashio::log.info "C-Gate not found, installing from source: ${INSTALL_SOURCE}"

mkdir -p "${CGATE_DIR}"

if [[ "${INSTALL_SOURCE}" == "download" ]]; then
    DOWNLOAD_URL=$(_cgateweb_resolve_download_url)

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

cp -r "${EXTRACTED_DIR}"/* "${CGATE_DIR}/"

# Restrict permissions on installed files
chmod -R go-w "${CGATE_DIR}/" 2>/dev/null || true

# Record installed version for diagnostics reporting
if [[ -n "${CGATE_VERSION}" ]]; then
    echo "${CGATE_VERSION}" > "${CGATE_DIR}/.version"
    bashio::log.info "Recorded C-Gate version: ${CGATE_VERSION}"
else
    echo "unknown" > "${CGATE_DIR}/.version"
fi

fi  # end install-if-not-present

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
CGATE_EVENT_PORT=$(bashio::config 'cgate_event_port' '20025')
CGATE_CONFIG="${CGATE_DIR}/config/C-GateConfig.txt"
# Always apply: the helper seeds the file if C-Gate has not generated it yet
# (fresh install), so project.start is in place before C-Gate's first start.
_cgateweb_apply_cgate_config "${CGATE_CONFIG}" "${CGATE_PROJECT}" "${CGATE_PORT}" "${CGATE_EVENT_PORT}"
bashio::log.info "Set project to: ${CGATE_PROJECT} (project.default + project.start)"
bashio::log.info "Set command port to: ${CGATE_PORT}"
bashio::log.info "Set event port to: ${CGATE_EVENT_PORT}"

bashio::log.info "C-Gate installation complete"
