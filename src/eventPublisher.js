const { createLogger } = require('./logger');
const {
    LOG_PREFIX,
    MQTT_TOPIC_PREFIX_READ,
    MQTT_TOPIC_SUFFIX_STATE,
    MQTT_TOPIC_SUFFIX_LEVEL,
    MQTT_TOPIC_SUFFIX_POSITION,
    MQTT_STATE_ON,
    MQTT_STATE_OFF,
    CGATE_CMD_ON,
    CGATE_LEVEL_MAX
} = require('./constants');

/**
 * Handles publishing C-Bus events to MQTT topics.
 * 
 * This class is responsible for:
 * - Converting C-Bus events to MQTT messages
 * - Handling special logic for PIR sensors vs lighting devices
 * - Managing MQTT topic construction and payload formatting
 * - Queueing messages for publishing
 */
class EventPublisher {
    /**
     * Creates a new EventPublisher instance.
     * 
     * @param {Object} options - Configuration options
     * @param {Object} options.settings - Bridge settings containing PIR sensor config
     * @param {Object} options.mqttPublishQueue - Queue for MQTT publishing
     * @param {Object} options.mqttOptions - MQTT publishing options (retain, qos, etc.)
     * @param {Object} [options.logger] - Optional logger instance
     */
    constructor(options) {
        this.settings = options.settings;
        this.mqttPublishQueue = options.mqttPublishQueue;
        this.mqttOptions = options.mqttOptions;
        
        this.logger = options.logger || createLogger({ 
            component: 'event-publisher', 
            level: this.settings.logging ? 'info' : 'warn',
            enabled: true 
        });
    }

    /**
     * Publishes a C-Bus event to MQTT topics for Home Assistant and other consumers.
     * 
     * Converts C-Bus events into MQTT messages:
     * - C-Bus "lighting on 254/56/4" → MQTT "cbus/read/254/56/4/state" with "ON"
     * - C-Bus "lighting ramp 254/56/4 128" → MQTT "cbus/read/254/56/4/level" with "50"
     * - C-Bus "enable ramp 254/203/1 128" → MQTT "cbus/read/254/203/1/position" with "50"
     * 
     * Special handling for:
     * - PIR sensors (motion detectors) that only publish state
     * - Covers that publish position in addition to state
     * 
     * @param {CBusEvent} event - Parsed C-Bus event to publish
     * @param {string} [source=''] - Source identifier for logging (e.g., '(Evt)', '(Cmd)')
     */
    publishEvent(event, source = '') {
        if (!event || !event.isValid()) {
            return;
        }

        const topicBase = `${MQTT_TOPIC_PREFIX_READ}/${event.getNetwork()}/${event.getApplication()}/${event.getGroup()}`;
        const isPirSensor = event.getApplication() === this.settings.ha_discovery_pir_app_id;
        const isCover = event.getApplication() === this.settings.ha_discovery_cover_app_id;
        
        // Calculate level percentage for Home Assistant
        let levelPercent;
        if (event.getLevel() !== null) {
            // Explicit level from ramp events (0-255) -> (0-100)
            levelPercent = Math.round(event.getLevel() / CGATE_LEVEL_MAX * 100);
        } else {
            // Implicit level from on/off events: ON=100%, OFF=0%
            levelPercent = (event.getAction() === CGATE_CMD_ON.toLowerCase()) ? 100 : 0;
        }

        let state;
        if (isPirSensor) {
            // PIR sensors: state based on action (motion detected/cleared)
            state = (event.getAction() === CGATE_CMD_ON.toLowerCase()) ? MQTT_STATE_ON : MQTT_STATE_OFF;
        } else if (isCover) {
            // Covers: state is open/closed based on level
            // Position 0 = closed, Position > 0 = open
            state = (levelPercent > 0) ? MQTT_STATE_ON : MQTT_STATE_OFF;
        } else {
            // Lighting devices: state based on action or level
            if (event.getLevel() !== null) {
                // Ramp events with explicit level (0-255)
                state = (levelPercent > 0) ? MQTT_STATE_ON : MQTT_STATE_OFF;
            } else {
                // On/Off events without explicit level - use action
                state = (event.getAction() === CGATE_CMD_ON.toLowerCase()) ? MQTT_STATE_ON : MQTT_STATE_OFF;
            }
        }
       
        this.logger.info(`${LOG_PREFIX} C-Bus Status ${source}: ${event.getNetwork()}/${event.getApplication()}/${event.getGroup()} ${state}` + (isPirSensor ? '' : ` (${levelPercent}%)`));

        // Publish state message
        this.mqttPublishQueue.add({ 
            topic: `${topicBase}/${MQTT_TOPIC_SUFFIX_STATE}`, 
            payload: state, 
            options: this.mqttOptions 
        });
        
        // Publish level/position message for non-PIR sensors
        if (!isPirSensor) {
            // Publish level for lighting devices
            this.mqttPublishQueue.add({ 
                topic: `${topicBase}/${MQTT_TOPIC_SUFFIX_LEVEL}`, 
                payload: levelPercent.toString(), 
                options: this.mqttOptions 
            });
            
            // Also publish position for covers (same value, different topic for HA cover entity)
            if (isCover) {
                this.mqttPublishQueue.add({ 
                    topic: `${topicBase}/${MQTT_TOPIC_SUFFIX_POSITION}`, 
                    payload: levelPercent.toString(), 
                    options: this.mqttOptions 
                });
            }
        }
    }
}

module.exports = EventPublisher;
