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
# Probed only when SHARE_TAG_DIR is missing (issue #28 follow-up): File
# Editor's root is the Home Assistant config directory, so a "share/cgate/tag"
# folder made there lands under it rather than in the top-level /share/cgate/tag
# this add-on maps (config.yaml: share:ro). That directory is mounted at
# /homeassistant since the switch off the deprecated `config` map option (#44);
# /config is still checked so the hint keeps working on an add-on that has not
# been rebuilt yet. Overridable for unit tests.
CONFIG_SHARE_CGATE_DIR="${CGATEWEB_CONFIG_SHARE_CGATE_DIR:-/homeassistant/share/cgate}"
if [ ! -d "${CONFIG_SHARE_CGATE_DIR}" ] && [ -d "/config/share/cgate" ]; then
    CONFIG_SHARE_CGATE_DIR="/config/share/cgate"
fi
CONFIG_SHARE_TAG_DIR="${CONFIG_SHARE_CGATE_DIR}/tag"

# Wait for the Supervisor API before the first bashio::config read: bashio
# dies hard when the API is not yet listening, which under set -e would abort
# this cont-init script and take the add-on down with it (test-env CI flake,
# "Failed to get addon config from Supervisor API"). The path is a variable
# so tests can point at the repo copy (SC1090, same pattern as
# CGATEWEB_SERIAL_DEVICE_LIB).
# shellcheck disable=SC1090
source "${CGATEWEB_SUPERVISOR_WAIT_LIB:-/usr/lib/cgateweb/supervisor-wait.sh}"
if ! cgateweb_wait_for_supervisor; then
    bashio::log.error "Supervisor API did not respond within ${CGATEWEB_SUPERVISOR_WAIT_ATTEMPTS:-60}s — cannot read add-on config"
    exit 1
fi

CGATE_MODE=$(bashio::config 'cgate_mode' 'remote')
if [[ "${CGATE_MODE}" != "managed" ]]; then
    exit 0
fi

# True when the managed C-Gate already has at least one project .db to load.
_cgateweb_have_project_db() {
    shopt -s nullglob
    local dbs=("${PROJECTS_DIR}"/*/*.db)
    shopt -u nullglob
    ((${#dbs[@]} > 0))
}

# Managed mode with no project anywhere is the #28 startup trap: C-Gate then
# answers every network command with "401 Network not found" and discovery
# loops until the retries exhaust. Say exactly what's wrong and how to fix it —
# importing labels into the cgateweb web UI is NOT a project install.
_cgateweb_warn_no_project() {
    bashio::log.warning "No C-Bus project database found — managed C-Gate cannot open any network without one."
    bashio::log.warning "Every network command will fail with '401 Network not found'."
    bashio::log.warning "Install your C-Bus Toolkit project: place <PROJECT>.db in ${SHARE_TAG_DIR}/ (e.g. via the Samba add-on share), then restart this add-on."
    bashio::log.warning "Note: importing labels into the cgateweb web UI does NOT install the project into C-Gate."
}

# issue #28 follow-up: a user placed a .cbz (Toolkit export) in the tag dir
# and got only the generic "no project found" warning above -- nothing named
# the file, so he reasonably concluded from the web UI's label importer (which
# does accept .cbz/.xml) that the format was fine for a project install too.
# Called only when SHARE_TAG_DIR has files the *.db loop could not use and no
# .db was found at all; name what we found and head off that exact mix-up.
_cgateweb_warn_unusable_files() {
    local -a names=("$@")
    local name
    local has_zip=0
    for name in "${names[@]}"; do
        [[ "${name}" == *.zip ]] && has_zip=1
    done
    bashio::log.warning "Found file(s) in ${SHARE_TAG_DIR}/ that cannot be loaded into C-Gate: ${names[*]}"
    bashio::log.warning "Only <PROJECT>.db is synced into C-Gate; every other file type is ignored."
    bashio::log.warning ".cbz and .xml are accepted by the web UI to import labels ONLY — they do not install a project into C-Gate."
    if [[ "${has_zip}" -eq 1 ]]; then
        bashio::log.warning "A .zip may be a C-Bus Toolkit project archive — extract it to find the <PROJECT>.db inside."
    fi
    bashio::log.warning "The file you need is <PROJECT>.db from C-Gate's tag/ directory in your Toolkit install, not an XML export."
}

# issue #28 follow-up: File Editor's root is the Home Assistant config
# directory, so a user creating "share/cgate/tag" there via File Editor actually
# creates it under that directory, not the top-level /share/cgate/tag this
# add-on maps (config.yaml: share:ro). Without naming the mistake, the plain
# "directory does not exist" message gives no hint. Call it out when detected.
_cgateweb_warn_wrong_share_location() {
    bashio::log.warning "No project tag directory at ${SHARE_TAG_DIR}, but found ${CONFIG_SHARE_TAG_DIR} instead."
    bashio::log.warning "The Home Assistant config directory's 'share' folder (what the File Editor add-on shows) is not the same as the top-level /share this add-on reads."
    bashio::log.warning "Move your project files to ${SHARE_TAG_DIR} (accessible via the Samba, SSH, or File Editor add-ons' top-level 'share' folder) and restart."
}

if [[ ! -d "${SHARE_TAG_DIR}" ]]; then
    if [[ -d "${CONFIG_SHARE_TAG_DIR}" || -d "${CONFIG_SHARE_CGATE_DIR}" ]]; then
        _cgateweb_warn_wrong_share_location
    elif _cgateweb_have_project_db; then
        bashio::log.info "No project tag directory at ${SHARE_TAG_DIR}; skipping project sync"
    else
        _cgateweb_warn_no_project
    fi
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
    # No *.db matched at all. Distinguish "nothing here" from "files here we
    # just can't use" (issue #28 follow-up) so the latter names the files
    # instead of falling back to the generic warning.
    shopt -s nullglob
    tag_dir_entries=("${SHARE_TAG_DIR}"/*)
    shopt -u nullglob
    unusable_names=()
    # Guard the iteration on length first: with `set -u`, expanding
    # "${arr[@]}" on a zero-element array is an "unbound variable" error on
    # the bash 3.2 shipped by macOS (fixed in 4.4+), even though `${#arr[@]}`
    # is always safe.
    if ((${#tag_dir_entries[@]} > 0)); then
        for entry in "${tag_dir_entries[@]}"; do
            [[ -f "${entry}" ]] && unusable_names+=("$(basename "${entry}")")
        done
    fi
    if ((${#unusable_names[@]} > 0)); then
        _cgateweb_warn_unusable_files "${unusable_names[@]}"
    elif _cgateweb_have_project_db; then
        bashio::log.info "No .db files found in ${SHARE_TAG_DIR}; nothing to sync"
    else
        _cgateweb_warn_no_project
    fi
elif [[ ${SKIPPED} -gt 0 ]]; then
    bashio::log.info "Skipped ${SKIPPED} project(s) - destination newer than share copy"
fi

# ALPHA (issue #28): point the project's serial interface at the configured
# USB-serial PCI. Two cases, both leaving the network at InterfaceState=closed
# with every TREEXML empty:
#   - a Toolkit project saved on Windows names a COMx port, which cannot exist
#     on Linux at all; and
#   - a project written by this add-on names the ttyUSBn it used last boot,
#     which a PC Interface that renumbered while we were stopped no longer
#     answers to.
# Rewrite either to the resolved cgate_serial_device port name BEFORE C-Gate
# loads the project. --repoint-stale-serial is what covers the second case; the
# in-running recovery (cgateweb-recover-serial) cannot, because from its point
# of view the device resolves fine and has not moved since boot. The flag only
# ever touches a row the project itself calls serial whose address has a serial
# port's shape, so a CNI's ip:port row is left alone. Runs every boot
# (idempotent). Only meaningful in managed mode with the alpha opt-in set.
#
# Use the path cont-init's resolver already agreed on rather than resolving
# cgate_serial_device again here: a PC Interface that renumbered still has its
# old path in the option, and rewriting the project to a device that no longer
# exists leaves the network closed. The file is missing or empty only when the
# resolver could not run (no node) or could not publish, so fall back to the
# option there.
# Shared with cgate-install.sh and cgateweb-serial-diagnostics: one definition
# of the default file path and the "read the resolver's answer, fall back to
# the configured option" logic (see the helper for why this can't just be an
# exported variable).
CGATEWEB_SERIAL_DEVICE_LIB="${CGATEWEB_SERIAL_DEVICE_LIB:-/usr/lib/cgateweb/serial-device.sh}"
# Non-constant path, so this is SC1090 ("can't follow non-constant source"),
# not SC1091 ("file not found"). The helper is linted directly by CI.
# shellcheck disable=SC1090
source "${CGATEWEB_SERIAL_DEVICE_LIB}"
CONFIGURED_SERIAL_DEVICE=$(bashio::config 'cgate_serial_device' '')
SERIAL_DEVICE=$(cgateweb_effective_serial_device "${CONFIGURED_SERIAL_DEVICE}")
# The opt-in is the configured option and nothing else: a resolved-device file
# left behind by a boot where it *was* set must never re-enable the rewrite for
# a user who has since cleared the option.
PROJECT_FIXUP_JS="${CGATEWEB_PROJECT_FIXUP_JS:-/usr/bin/cgateweb-project-serial-fixup.js}"
if [[ -n "${CONFIGURED_SERIAL_DEVICE}" && "${CONFIGURED_SERIAL_DEVICE}" != "null" ]]; then
    if command -v node >/dev/null 2>&1; then
        shopt -s nullglob
        for db in "${PROJECTS_DIR}"/*/*.db; do
            if ! OUT=$(node "${PROJECT_FIXUP_JS}" "${db}" "${SERIAL_DEVICE}" --repoint-stale-serial 2>&1); then
                bashio::log.warning "Project serial fixup failed for ${db}: ${OUT}"
            elif [[ "${OUT}" == *"rewrote project interface"* ]]; then
                bashio::log.info "${OUT}"
            fi
        done
        shopt -u nullglob
    else
        bashio::log.warning "cgate_serial_device is set but node is unavailable — skipping project serial fixup"
    fi
fi
