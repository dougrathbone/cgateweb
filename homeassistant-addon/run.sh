#!/usr/bin/with-contenv bashio
# ==============================================================================
# Home Assistant Add-on: C-Gate Web Bridge
# Main entrypoint - delegates to s6 services for both modes
# ==============================================================================

bashio::log.info "Starting C-Gate Web Bridge..."

OPTIONS_FILE="/data/options.json"
if ! bashio::fs.file_exists "${OPTIONS_FILE}"; then
    bashio::log.error "Configuration file not found: ${OPTIONS_FILE}"
    exit 1
fi

CGATE_MODE=$(bashio::config 'cgate_mode' 'remote')
bashio::log.info "C-Gate mode: ${CGATE_MODE}"

if [[ "${CGATE_MODE}" == "managed" ]]; then
    bashio::log.info "Managed mode: C-Gate and cgateweb will be started via s6 services"
else
    CGATE_HOST=$(bashio::config 'cgate_host')
    CGATE_PORT=$(bashio::config 'cgate_port')
    bashio::log.info "Remote mode: C-Gate at ${CGATE_HOST}:${CGATE_PORT}"
    bashio::log.info "cgateweb will be started via s6 service"
fi

# s6-overlay handles starting services in /etc/services.d/
exec sleep infinity
