#!/usr/bin/with-contenv bashio
# ==============================================================================
# Sync user-provided C-Gate project DBs from /share/cgate/tag/ into the managed
# C-Gate tag directory. Lets users in managed mode supply a pre-built
# <PROJECTNAME>.db file (exported from Toolkit or another C-Gate instance)
# without rebuilding the C-Gate image. Uses `cp -u` so we never clobber a
# newer .db that running C-Gate may have written.
# ==============================================================================
set -euo pipefail

# Paths are overridable for unit tests.
SHARE_TAG_DIR="${CGATEWEB_SHARE_TAG_DIR:-/share/cgate/tag}"
DATA_TAG_DIR="${CGATEWEB_DATA_TAG_DIR:-/data/cgate/tag}"

CGATE_MODE=$(bashio::config 'cgate_mode' 'remote')
if [[ "${CGATE_MODE}" != "managed" ]]; then
    exit 0
fi

if [[ ! -d "${SHARE_TAG_DIR}" ]]; then
    bashio::log.info "No project tag directory at ${SHARE_TAG_DIR}; skipping project sync"
    exit 0
fi

# Ensure destination exists. If the install script has already populated it
# C-Gate's tag dir will be there; otherwise this is a no-op safety net.
mkdir -p "${DATA_TAG_DIR}"

shopt -s nullglob
SYNCED=0
SKIPPED=0
for src in "${SHARE_TAG_DIR}"/*.db; do
    name=$(basename "${src}")
    dest="${DATA_TAG_DIR}/${name}"
    # Copy only when source is newer than dest or when dest is missing, so we
    # never clobber a .db that running C-Gate has written.
    if [[ ! -e "${dest}" || "${src}" -nt "${dest}" ]]; then
        if cp -p "${src}" "${dest}"; then
            bashio::log.info "Synced project tag: ${name}"
            SYNCED=$((SYNCED + 1))
        else
            bashio::log.warning "Failed to sync project tag: ${name}"
        fi
    else
        SKIPPED=$((SKIPPED + 1))
    fi
done
shopt -u nullglob

if [[ ${SYNCED} -eq 0 && ${SKIPPED} -eq 0 ]]; then
    bashio::log.info "No .db files found in ${SHARE_TAG_DIR}; nothing to sync"
elif [[ ${SKIPPED} -gt 0 ]]; then
    bashio::log.info "Skipped ${SKIPPED} project tag(s) - destination newer than share copy"
fi
