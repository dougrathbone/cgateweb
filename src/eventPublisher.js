const { createLogger } = require('./logger');
const {
    MQTT_TOPIC_PREFIX_READ,
    MQTT_TOPIC_SUFFIX_STATE,
    MQTT_TOPIC_SUFFIX_LEVEL,
    MQTT_TOPIC_SUFFIX_POSITION,
    MQTT_TOPIC_SUFFIX_TILT,
    MQTT_TOPIC_SUFFIX_EVENT,
    MQTT_TOPIC_SUFFIX_HVAC_CURRENT_TEMP,
    MQTT_TOPIC_SUFFIX_HVAC_SETPOINT,
    MQTT_TOPIC_SUFFIX_HVAC_MODE,
    MQTT_STATE_ON,
    MQTT_STATE_OFF,
    CGATE_CMD_ON,
    CGATE_LEVEL_MAX
} = require('./constants');

class EventPublisher {
    /**
     * Creates a new EventPublisher instance.
     *
     * @param {Object}   options - Configuration options
     * @param {Object}   options.settings - Bridge settings containing PIR sensor config
     * @param {Function} options.publishFn - Direct MQTT publish function: (topic, payload, options) => void
     * @param {Object}   options.mqttOptions - MQTT publishing options (retain, qos, etc.)
     * @param {Object}   [options.labelLoader] - Optional LabelLoader for type override awareness
     * @param {Object}   [options.logger] - Optional logger instance
     * @param {Object}   [options.coverRampTracker] - Optional CoverRampTracker to cancel on real events
     */
    constructor(options) {
        this.settings = options.settings;
        this.publishFn = options.publishFn;
        this.mqttOptions = options.mqttOptions;
        this.labelLoader = options.labelLoader || null;
        this.coverRampTracker = options.coverRampTracker || null;
        this.onEventLog = options.onEventLog || null;
        this.eventPublishDedupWindowMs = Math.max(0, Number(this.settings.eventPublishDedupWindowMs) || 0);
        this.eventPublishDedupMaxEntries = Math.max(100, Number(this.settings.eventPublishDedupMaxEntries) || 5000);
        this.topicCacheMaxEntries = Math.max(100, Number(this.settings.topicCacheMaxEntries) || 5000);
        this.eventPublishCoalesce = this.settings.eventPublishCoalesce === true;
        this._recentPublishes = new Map();
        this._topicCache = new Map();
        this._coalesceBuffer = new Map();
        this._coalesceTimer = null;
        this._publishStats = {
            publishAttempts: 0,
            published: 0,
            dedupDropped: 0,
            dedupEvicted: 0,
            coalesced: 0,
            topicCacheHit: 0,
            topicCacheMiss: 0
        };
        
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

        const network = event.getNetwork();
        const application = event.getApplication();
        const group = event.getGroup();
        const action = event.getAction();
        const rawLevel = event.getLevel();
        const actionIsOn = action === CGATE_CMD_ON.toLowerCase();

        const topics = this._getTopicsForAddress(network, application, group);
        const isPirSensor = application === this.settings.ha_discovery_pir_app_id;
        const isTrigger = application === this.settings.ha_discovery_trigger_app_id;
        const isCoverApp = application === this.settings.ha_discovery_cover_app_id;
        const isCoverOverride = this._isTypeOverride(network, application, group, 'cover');
        const isCover = isCoverApp || isCoverOverride;

        // Cancel any active interpolated ramp for this cover address so the real
        // C-Gate event value takes over immediately without further estimated updates.
        if (isCover && this.coverRampTracker) {
            this.coverRampTracker.cancelRamp(`${network}/${application}/${group}`);
        }
        const isHvac = this.settings.ha_discovery_hvac_app_id &&
            application === String(this.settings.ha_discovery_hvac_app_id);
        const isTiltApp = this.settings.ha_discovery_cover_tilt_app_id &&
            application === String(this.settings.ha_discovery_cover_tilt_app_id);
        
        // Calculate level percentage for Home Assistant.
        // Math.round is intentional: HA expects integer 0-100. This means two adjacent
        // C-Bus levels can map to the same percentage (e.g. 127 and 128 both → 50).
        const levelPercent = rawLevel !== null
            ? Math.round(rawLevel / CGATE_LEVEL_MAX * 100)
            : (actionIsOn ? 100 : 0);

        let state;
        if (isPirSensor) {
            // PIR sensors: state based on action (motion detected/cleared)
            state = actionIsOn ? MQTT_STATE_ON : MQTT_STATE_OFF;
        } else if (isCover) {
            // Covers: state is open/closed based on raw level, not quantized percent.
            // rawLevel 1-2 rounds to 0% but the cover IS open.
            state = (rawLevel > 0) ? MQTT_STATE_ON : MQTT_STATE_OFF;
        } else {
            // Lighting devices: state based on raw level (avoids quantization loss
            // where rawLevel 1-2 rounds to 0% but the light IS on)
            state = rawLevel !== null
                ? ((rawLevel > 0) ? MQTT_STATE_ON : MQTT_STATE_OFF)
                : (actionIsOn ? MQTT_STATE_ON : MQTT_STATE_OFF);
        }
       
        // Emit event log entry for live event stream (before any early returns)
        if (this.onEventLog) {
            const action = event.getAction();
            let eventType = 'update';
            if (action === 'ramp') eventType = 'ramp';
            else if (action === 'on') eventType = 'on';
            else if (action === 'off') eventType = 'off';
            this.onEventLog({
                ts: Date.now(),
                network: network,
                app: application,
                group: group,
                level: rawLevel !== null ? rawLevel : (actionIsOn ? 255 : 0),
                type: eventType
            });
        }

        // Trigger groups publish as HA event entities - never retain
        if (isTrigger) {
            const eventPayload = rawLevel !== null
                ? JSON.stringify({ event_type: 'trigger', level: rawLevel })
                : JSON.stringify({ event_type: 'trigger' });

            if (this.logger.isLevelEnabled && this.logger.isLevelEnabled('debug')) {
                this.logger.debug(`C-Bus Trigger ${source}: ${network}/${application}/${group}` + (rawLevel !== null ? ` level=${rawLevel}` : ''));
            }

            // Trigger events must not be retained - always publish with retain: false
            this._publishIfNeeded(
                topics.event,
                eventPayload,
                { ...this.mqttOptions, retain: false }
            );
            return;
        }

        // HVAC groups publish temperature/mode to dedicated climate topics
        if (isHvac) {
            this._publishHvacEvent(network, application, group, rawLevel, action, source);
            return;
        }

        // Tilt app groups publish tilt angle to the tilt topic only (0-100%)
        if (isTiltApp) {
            const tiltPercent = rawLevel !== null
                ? Math.round(rawLevel / CGATE_LEVEL_MAX * 100)
                : (actionIsOn ? 100 : 0);

            if (this.logger.isLevelEnabled && this.logger.isLevelEnabled('debug')) {
                this.logger.debug(`C-Bus Tilt ${source}: ${network}/${application}/${group} ${tiltPercent}%`);
            }

            this._publishIfNeeded(
                `${MQTT_TOPIC_PREFIX_READ}/${network}/${application}/${group}/${MQTT_TOPIC_SUFFIX_TILT}`,
                tiltPercent.toString(),
                this.mqttOptions
            );
            return;
        }

        if (this.logger.isLevelEnabled && this.logger.isLevelEnabled('debug')) {
            this.logger.debug(`C-Bus Status ${source}: ${network}/${application}/${group} ${state}` + (isPirSensor ? '' : ` (${levelPercent}%)`));
        }

        // Publish state message directly (no throttle)
        this._publishIfNeeded(
            topics.state,
            state,
            this.mqttOptions
        );

        // Publish level/position message for non-PIR sensors
        if (!isPirSensor) {
            this._publishIfNeeded(
                topics.level,
                levelPercent.toString(),
                this.mqttOptions
            );

            // Also publish position for covers (same value, different topic for HA cover entity)
            if (isCover) {
                this._publishIfNeeded(
                    topics.position,
                    levelPercent.toString(),
                    this.mqttOptions
                );
            }
        }
    }

    /**
     * Convert a C-Bus level value (0-255) to a temperature in °C.
     *
     * C-Bus HVAC (Application 201) temperature encoding:
     *   The C-Bus HVAC thermostat (5000CT2 series) encodes temperature using a
     *   fixed-point scheme with 0.5°C resolution across a 0–50°C range:
     *     temperature_celsius = level / 2
     *   This gives: level 0 = 0.0°C, level 100 = 50.0°C, level 50 = 25.0°C
     *
     * TODO: Hardware validation required. This formula is based on community
     * reports for the 5000CT2 thermostat. Other HVAC units on App 201 may use
     * different encoding. Validate against real hardware before deployment.
     *
     * @param {number} level - C-Bus raw level (0-255)
     * @returns {number} Temperature in degrees Celsius
     * @private
     */
    _cbusLevelToTemperature(level) {
        return level / 2;
    }

    /**
     * Convert a temperature in °C to a C-Bus level value (0-255).
     * Inverse of _cbusLevelToTemperature.
     *
     * @param {number} tempCelsius - Temperature in degrees Celsius
     * @returns {number} C-Bus raw level (0-255), clamped to valid range
     * @private
     */
    _temperatureToCbusLevel(tempCelsius) {
        return Math.max(0, Math.min(255, Math.round(tempCelsius * 2)));
    }

    /**
     * Publish HVAC events to climate-specific MQTT topics.
     *
     * When C-Gate reports a level change on an HVAC group address, we interpret it
     * as both a current temperature reading and a setpoint update (the C-Bus HVAC
     * thermostat reports both via the same group address in most implementations).
     *
     * Mode is not updated by standard level events — mode changes require separate
     * C-Gate events that are not yet captured in this implementation.
     *
     * TODO: Hardware validation required for mode detection. If the hardware reports
     * mode changes on a separate group address, this will need extending.
     *
     * @param {string} network - C-Bus network number
     * @param {string} application - C-Bus application number
     * @param {string} group - C-Bus group number
     * @param {number|null} rawLevel - C-Bus level value (0-255), or null if not present
     * @param {string} action - C-Gate action ('on', 'off', 'ramp', etc.)
     * @param {string} source - Source identifier for logging
     * @private
     */
    _publishHvacEvent(network, application, group, rawLevel, action, source) {
        const readBase = `${MQTT_TOPIC_PREFIX_READ}/${network}/${application}/${group}`;

        if (rawLevel !== null) {
            const tempCelsius = this._cbusLevelToTemperature(rawLevel);
            const tempStr = tempCelsius.toFixed(1);

            if (this.logger.isLevelEnabled && this.logger.isLevelEnabled('debug')) {
                this.logger.debug(`C-Bus HVAC ${source}: ${network}/${application}/${group} level=${rawLevel} temp=${tempStr}°C`);
            }

            // Publish current temperature reading
            this._publishIfNeeded(
                `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_CURRENT_TEMP}`,
                tempStr,
                this.mqttOptions
            );

            // Publish setpoint (same value — C-Bus level represents the controlled setpoint)
            this._publishIfNeeded(
                `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_SETPOINT}`,
                tempStr,
                this.mqttOptions
            );
        }

        // Publish mode based on action and level: 'off' action or level 0 → 'off'
        // TODO: Hardware validation — real HVAC units may report heat/cool/fan_only via
        // dedicated group addresses or extended C-Gate event fields not yet handled here.
        const mode = (action === 'off' || rawLevel === 0) ? 'off' : 'auto';
        this._publishIfNeeded(
            `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_MODE}`,
            mode,
            this.mqttOptions
        );
    }

    /**
     * Checks whether the event's group has a type override matching the given type.
     * Falls back to false when no labelLoader is configured.
     */
    _isTypeOverride(network, application, group, type) {
        if (!this.labelLoader) return false;
        const typeOverrides = this.labelLoader.getTypeOverrides();
        if (!typeOverrides) return false;
        const labelKey = `${network}/${application}/${group}`;
        return typeOverrides.get(labelKey) === type;
    }

    _publishIfNeeded(topic, payload, options) {
        this._publishStats.publishAttempts += 1;
        if (this.eventPublishCoalesce) {
            const hadExisting = this._coalesceBuffer.has(topic);
            this._coalesceBuffer.set(topic, { payload, options });
            if (hadExisting) {
                this._publishStats.coalesced += 1;
            }
            this._scheduleCoalesceFlush();
            return;
        }

        this._publishNow(topic, payload, options);
    }

    _publishNow(topic, payload, options) {
        if (!this.eventPublishDedupWindowMs) {
            this.publishFn(topic, payload, options);
            this._publishStats.published += 1;
            return;
        }

        const now = Date.now();
        const previous = this._recentPublishes.get(topic);
        if (previous && previous.payload === payload && (now - previous.atMs) <= this.eventPublishDedupWindowMs) {
            this._publishStats.dedupDropped += 1;
            return;
        }

        this._recentPublishes.set(topic, { payload, atMs: now });
        this._pruneDedupCache(now);
        this.publishFn(topic, payload, options);
        this._publishStats.published += 1;
    }

    _scheduleCoalesceFlush() {
        if (this._coalesceTimer) return;
        this._coalesceTimer = setImmediate(() => {
            this._coalesceTimer = null;
            this._flushCoalesceBuffer();
        });
    }

    _flushCoalesceBuffer() {
        if (this._coalesceBuffer.size === 0) {
            return;
        }
        const entries = [...this._coalesceBuffer.entries()];
        this._coalesceBuffer.clear();
        for (const [topic, value] of entries) {
            this._publishNow(topic, value.payload, value.options);
        }
    }

    _getTopicsForAddress(network, application, group) {
        const key = `${network}/${application}/${group}`;
        const cached = this._topicCache.get(key);
        if (cached) {
            this._publishStats.topicCacheHit += 1;
            return cached;
        }

        const topicBase = `${MQTT_TOPIC_PREFIX_READ}/${key}`;
        const topics = {
            state: `${topicBase}/${MQTT_TOPIC_SUFFIX_STATE}`,
            level: `${topicBase}/${MQTT_TOPIC_SUFFIX_LEVEL}`,
            position: `${topicBase}/${MQTT_TOPIC_SUFFIX_POSITION}`,
            event: `${topicBase}/${MQTT_TOPIC_SUFFIX_EVENT}`
        };

        if (this._topicCache.size >= this.topicCacheMaxEntries) {
            this._topicCache.delete(this._topicCache.keys().next().value);
        }
        this._topicCache.set(key, topics);
        this._publishStats.topicCacheMiss += 1;
        return topics;
    }

    _pruneDedupCache(now) {
        if (this._recentPublishes.size <= this.eventPublishDedupMaxEntries) {
            return;
        }

        // First pass: remove expired entries.
        const expiryCutoff = now - this.eventPublishDedupWindowMs;
        for (const [key, value] of this._recentPublishes) {
            if (value.atMs < expiryCutoff) {
                this._recentPublishes.delete(key);
                this._publishStats.dedupEvicted += 1;
            }
        }

        // Second pass: enforce max size by oldest insertion order.
        while (this._recentPublishes.size > this.eventPublishDedupMaxEntries) {
            const oldestKey = this._recentPublishes.keys().next().value;
            if (oldestKey === undefined) break;
            this._recentPublishes.delete(oldestKey);
            this._publishStats.dedupEvicted += 1;
        }
    }

    shutdown() {
        if (this._coalesceTimer) {
            clearImmediate(this._coalesceTimer);
            this._coalesceTimer = null;
        }
        this._coalesceBuffer.clear();
        this._recentPublishes.clear();
        this._topicCache.clear();
    }

    getStats() {
        return {
            ...this._publishStats,
            dedupWindowMs: this.eventPublishDedupWindowMs,
            dedupCacheSize: this._recentPublishes.size,
            topicCacheSize: this._topicCache.size,
            coalesceEnabled: this.eventPublishCoalesce,
            coalesceBufferSize: this._coalesceBuffer.size
        };
    }
}

module.exports = EventPublisher;
