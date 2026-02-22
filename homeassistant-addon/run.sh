#!/usr/bin/with-contenv bashio
# ==============================================================================
# Home Assistant Add-on: C-Gate Web Bridge
# Main entrypoint - delegates to s6 services or runs directly
# ==============================================================================

bashio::log.info "Starting C-Gate Web Bridge..."

OPTIONS_FILE="/data/options.json"
if ! bashio::fs.file_exists "${OPTIONS_FILE}"; then
    bashio::log.error "Configuration file not found: ${OPTIONS_FILE}"
    exit 1
fi

CGATE_MODE=$(bashio::config 'cgate_mode' 'remote')
CGATE_HOST=$(bashio::config 'cgate_host')
CGATE_PORT=$(bashio::config 'cgate_port')
MQTT_HOST=$(bashio::config 'mqtt_host')
MQTT_PORT=$(bashio::config 'mqtt_port')
LOG_LEVEL=$(bashio::config 'log_level')

bashio::log.info "C-Gate mode: ${CGATE_MODE}"

if [[ "${CGATE_MODE}" == "managed" ]]; then
    bashio::log.info "Managed mode: C-Gate and cgateweb will be started via s6 services"
    bashio::log.info "MQTT: ${MQTT_HOST}:${MQTT_PORT}"
    # s6-overlay takes over from here -- services in /etc/services.d/ will be started
    exec sleep infinity
else
    bashio::log.info "Remote mode: C-Gate at ${CGATE_HOST}:${CGATE_PORT}, MQTT: ${MQTT_HOST}:${MQTT_PORT}"

    export NODE_ENV="production"
    export LOG_LEVEL="${LOG_LEVEL}"

    cd /app || exit 1

    bashio::log.info "Starting C-Gate Web Bridge application..."
    exec node index.js
fi
