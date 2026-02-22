#!/usr/bin/with-contenv bashio
# ==============================================================================
# Install C-Gate if running in managed mode
# ==============================================================================

CGATE_MODE=$(bashio::config 'cgate_mode' 'remote')

if [[ "${CGATE_MODE}" != "managed" ]]; then
    bashio::log.info "C-Gate mode is '${CGATE_MODE}', skipping C-Gate installation"
    exit 0
fi

CGATE_DIR="/data/cgate"
CGATE_JAR="${CGATE_DIR}/cgate.jar"
INSTALL_SOURCE=$(bashio::config 'cgate_install_source' 'download')

# Check if C-Gate is already installed
if [[ -f "${CGATE_JAR}" ]]; then
    bashio::log.info "C-Gate already installed at ${CGATE_DIR}"
    exit 0
fi

bashio::log.info "C-Gate not found, installing from source: ${INSTALL_SOURCE}"

mkdir -p "${CGATE_DIR}"

if [[ "${INSTALL_SOURCE}" == "download" ]]; then
    DOWNLOAD_URL=$(bashio::config 'cgate_download_url' '')
    if [[ -z "${DOWNLOAD_URL}" ]]; then
        DOWNLOAD_URL="https://updates.clipsal.com/ClipsalSoftwareDownload/mainsite/cis/technical/downloads/C-Gate3_Linux.zip"
    fi

    bashio::log.info "Downloading C-Gate from: ${DOWNLOAD_URL}"

    TEMP_ZIP="/tmp/cgate-download.zip"
    if ! curl -fSL -o "${TEMP_ZIP}" "${DOWNLOAD_URL}" 2>&1; then
        bashio::log.error "Failed to download C-Gate from ${DOWNLOAD_URL}"
        bashio::log.error "Try using 'upload' install source instead"
        exit 1
    fi

    bashio::log.info "Download complete, extracting..."
    if ! unzip -o "${TEMP_ZIP}" -d /tmp/cgate-extract 2>&1; then
        bashio::log.error "Failed to extract C-Gate zip file"
        rm -f "${TEMP_ZIP}"
        exit 1
    fi
    rm -f "${TEMP_ZIP}"

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
    if ! unzip -o "${ZIP_FILE}" -d /tmp/cgate-extract 2>&1; then
        bashio::log.error "Failed to extract ${ZIP_FILE}"
        exit 1
    fi
else
    bashio::log.error "Unknown install source: ${INSTALL_SOURCE}"
    exit 1
fi

# Find and copy the C-Gate files to the persistent data directory
EXTRACTED_JAR=$(find /tmp/cgate-extract -name 'cgate.jar' -type f | head -1)
if [[ -z "${EXTRACTED_JAR}" ]]; then
    bashio::log.error "cgate.jar not found in extracted archive"
    bashio::log.error "The zip file may not be a valid C-Gate package"
    rm -rf /tmp/cgate-extract
    exit 1
fi

EXTRACTED_DIR=$(dirname "${EXTRACTED_JAR}")
bashio::log.info "Found C-Gate installation in: ${EXTRACTED_DIR}"

cp -r "${EXTRACTED_DIR}"/* "${CGATE_DIR}/"
rm -rf /tmp/cgate-extract

# Configure access.txt to allow local connections
ACCESS_FILE="${CGATE_DIR}/config/access.txt"
if [[ ! -f "${ACCESS_FILE}" ]]; then
    mkdir -p "${CGATE_DIR}/config"
    cat > "${ACCESS_FILE}" << 'ACCESSEOF'
# C-Gate Access Control
# Allow local connections from the addon
interface 0.0.0.0
program 127.0.0.1
monitor 127.0.0.1
ACCESSEOF
    bashio::log.info "Created default access.txt"
fi

# Set the project name in C-Gate config
CGATE_PROJECT=$(bashio::config 'cgate_project' 'HOME')
CGATE_CONFIG="${CGATE_DIR}/config/C-GateConfig.txt"
if [[ -f "${CGATE_CONFIG}" ]]; then
    if grep -q "project.default" "${CGATE_CONFIG}"; then
        sed -i "s/project.default=.*/project.default=${CGATE_PROJECT}/" "${CGATE_CONFIG}"
    else
        echo "project.default=${CGATE_PROJECT}" >> "${CGATE_CONFIG}"
    fi
    bashio::log.info "Set default project to: ${CGATE_PROJECT}"
fi

bashio::log.info "C-Gate installation complete"
