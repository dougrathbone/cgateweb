#!/usr/bin/with-contenv bashio
# ==============================================================================
# Home Assistant Add-on: C-Gate Web Bridge
# Starts the C-Gate Web Bridge service
# ==============================================================================

bashio::log.info "Starting C-Gate Web Bridge..."

# Verify options file exists (ConfigLoader reads it directly)
OPTIONS_FILE="/data/options.json"
if ! bashio::fs.file_exists "${OPTIONS_FILE}"; then
    bashio::log.error "Configuration file not found: ${OPTIONS_FILE}"
    exit 1
fi

# Log key config values for debugging
CGATE_MODE=$(bashio::config 'cgate_mode' 'remote')
CGATE_HOST=$(bashio::config 'cgate_host')
CGATE_PORT=$(bashio::config 'cgate_port')
MQTT_HOST=$(bashio::config 'mqtt_host')
MQTT_PORT=$(bashio::config 'mqtt_port')
LOG_LEVEL=$(bashio::config 'log_level')

bashio::log.info "C-Gate mode: ${CGATE_MODE}"
bashio::log.info "C-Gate: ${CGATE_HOST}:${CGATE_PORT}, MQTT: ${MQTT_HOST}:${MQTT_PORT}"

export NODE_ENV="production"
export LOG_LEVEL="${LOG_LEVEL}"

cd /app || exit 1

bashio::log.info "Starting C-Gate Web Bridge application..."
exec node index.js
