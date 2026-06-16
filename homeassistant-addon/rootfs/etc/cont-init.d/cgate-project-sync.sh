#!/usr/bin/with-contenv bashio
# ==============================================================================
# Sync user-provided C-Gate project DBs from /share/cgate/tag/ into the managed
# C-Gate project directory. Lets users in managed mode supply a pre-built
# <PROJECTNAME>.db file (exported from Toolkit or another C-Gate instance)
# without rebuilding the C-Gate image.
#
# C-Gate 3.x loads a project from project.default.dir (default "Projects/"),
# i.e. Projects/<PROJECTNAME>/<PROJECTNAME>.db -- NOT tag/<PROJECTNAME>.db.
# A .db left in tag/ is ignored: `project list` reports "no projects found" and
# every command returns "401 Bad object or device ID". So each <NAME>.db is
# placed at Projects/<NAME>/<NAME>.db. Uses `cp -p` with a newer-only check so
# we never clobber a .db that running C-Gate has written back.
# ==============================================================================
set -euo pipefail

# Paths are overridable for unit tests.
SHARE_TAG_DIR="${CGATEWEB_SHARE_TAG_DIR:-/share/cgate/tag}"
DATA_CGATE_DIR="${CGATEWEB_DATA_CGATE_DIR:-/data/cgate}"
PROJECTS_DIR="${DATA_CGATE_DIR}/Projects"

CGATE_MODE=$(bashio::config 'cgate_mode' 'remote')
if [[ "${CGATE_MODE}" != "managed" ]]; then
    exit 0
fi

if [[ ! -d "${SHARE_TAG_DIR}" ]]; then
    bashio::log.info "No project tag directory at ${SHARE_TAG_DIR}; skipping project sync"
    exit 0
fi

shopt -s nullglob
SYNCED=0
SKIPPED=0
for src in "${SHARE_TAG_DIR}"/*.db; do
    name=$(basename "${src}")          # e.g. HOME.db
    project="${name%.db}"              # e.g. HOME
    dest_dir="${PROJECTS_DIR}/${project}"
    dest="${dest_dir}/${name}"         # e.g. .../Projects/HOME/HOME.db
    # Copy only when source is newer than dest or when dest is missing, so we
    # never clobber a .db that running C-Gate has written.
    if [[ ! -e "${dest}" || "${src}" -nt "${dest}" ]]; then
        mkdir -p "${dest_dir}"
        if cp -p "${src}" "${dest}"; then
            bashio::log.info "Synced project '${project}' to ${dest}"
            SYNCED=$((SYNCED + 1))
        else
            bashio::log.warning "Failed to sync project: ${name}"
        fi
    else
        SKIPPED=$((SKIPPED + 1))
    fi
done
shopt -u nullglob

if [[ ${SYNCED} -eq 0 && ${SKIPPED} -eq 0 ]]; then
    bashio::log.info "No .db files found in ${SHARE_TAG_DIR}; nothing to sync"
elif [[ ${SKIPPED} -gt 0 ]]; then
    bashio::log.info "Skipped ${SKIPPED} project(s) - destination newer than share copy"
fi
