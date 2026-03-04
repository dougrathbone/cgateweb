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
        const isCoverApp = application === this.settings.ha_discovery_cover_app_id;
        const isCoverOverride = this._isTypeOverride(event, 'cover');
        const isCover = isCoverApp || isCoverOverride;
        
        // Calculate level percentage for Home Assistant
        const levelPercent = rawLevel !== null
            ? Math.round(rawLevel / CGATE_LEVEL_MAX * 100)
            : (actionIsOn ? 100 : 0);

        let state;
        if (isPirSensor) {
            // PIR sensors: state based on action (motion detected/cleared)
            state = actionIsOn ? MQTT_STATE_ON : MQTT_STATE_OFF;
        } else if (isCover) {
            // Covers: state is open/closed based on level
            // Position 0 = closed, Position > 0 = open
            state = (levelPercent > 0) ? MQTT_STATE_ON : MQTT_STATE_OFF;
        } else {
            // Lighting devices: state based on action or level
            state = rawLevel !== null
                ? ((levelPercent > 0) ? MQTT_STATE_ON : MQTT_STATE_OFF)
                : (actionIsOn ? MQTT_STATE_ON : MQTT_STATE_OFF);
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
            position: `${topicBase}/${MQTT_TOPIC_SUFFIX_POSITION}`
        };

        if (this._topicCache.size >= this.topicCacheMaxEntries) {
            const oldestKey = this._topicCache.keys().next().value;
            if (oldestKey !== undefined) {
                this._topicCache.delete(oldestKey);
            }
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
