const { createLogger } = require('./logger');
const {
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
 * - Publishing messages directly to MQTT (no throttle queue)
 */
class EventPublisher {
    /**
     * Creates a new EventPublisher instance.
     * 
     * @param {Object} options - Configuration options
     * @param {Object} options.settings - Bridge settings containing PIR sensor config
     * @param {Function} options.publishFn - Direct MQTT publish function: (topic, payload, options) => void
     * @param {Object} options.mqttOptions - MQTT publishing options (retain, qos, etc.)
     * @param {Object} [options.labelLoader] - Optional LabelLoader for type override awareness
     * @param {Object} [options.logger] - Optional logger instance
     */
    constructor(options) {
        this.settings = options.settings;
        this.publishFn = options.publishFn;
        this.mqttOptions = options.mqttOptions;
        this.labelLoader = options.labelLoader || null;
        
        this.logger = options.logger || createLogger({ 
            component: 'event-publisher', 
            level: this.settings.log_level || (this.settings.logging ? 'info' : 'warn'),
            enabled: true 
        });
    }

    /**
     * Publishes a C-Bus event to MQTT topics for Home Assistant and other consumers.
     * 
     * Publishes directly to MQTT without throttling -- QoS 0 publishes are
     * near-instant TCP buffer writes handled asynchronously by the mqtt library.
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
        const isCoverApp = event.getApplication() === this.settings.ha_discovery_cover_app_id;
        const isCoverOverride = this._isTypeOverride(event, 'cover');
        const isCover = isCoverApp || isCoverOverride;
        
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
       
        this.logger.info(`C-Bus Status ${source}: ${event.getNetwork()}/${event.getApplication()}/${event.getGroup()} ${state}` + (isPirSensor ? '' : ` (${levelPercent}%)`));

        // Publish state message directly (no throttle)
        this.publishFn(
            `${topicBase}/${MQTT_TOPIC_SUFFIX_STATE}`, 
            state, 
            this.mqttOptions
        );
        
        // Publish level/position message for non-PIR sensors
        if (!isPirSensor) {
            this.publishFn(
                `${topicBase}/${MQTT_TOPIC_SUFFIX_LEVEL}`, 
                levelPercent.toString(), 
                this.mqttOptions
            );
            
            // Also publish position for covers (same value, different topic for HA cover entity)
            if (isCover) {
                this.publishFn(
                    `${topicBase}/${MQTT_TOPIC_SUFFIX_POSITION}`, 
                    levelPercent.toString(), 
                    this.mqttOptions
                );
            }
        }
    }

    /**
     * Checks whether the event's group has a type override matching the given type.
     * Falls back to false when no labelLoader is configured.
     */
    _isTypeOverride(event, type) {
        if (!this.labelLoader) return false;
        const typeOverrides = this.labelLoader.getTypeOverrides();
        if (!typeOverrides) return false;
        const labelKey = `${event.getNetwork()}/${event.getApplication()}/${event.getGroup()}`;
        return typeOverrides.get(labelKey) === type;
    }
}

module.exports = EventPublisher;
