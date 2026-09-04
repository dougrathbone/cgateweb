// @ts-check
const { createLogger, resolveLogLevelFromSettings } = require('./logger');
const { evictOldestFifo, cbusLevelToTemperature } = require('./utils');
const { resolveClampedSetting } = require('./config/schema');
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
    MQTT_TOPIC_SUFFIX_SOURCE_UNIT,
    MQTT_STATE_ON,
    MQTT_STATE_OFF,
    CGATE_CMD_ON,
    CGATE_LEVEL_MAX
} = require('./constants');

/**
 * Dispatch table for publishReading: kind → handler(ep, base, reading).
 * Handlers keep the historical publish semantics (skip nulls, pre-rendered
 * security payloads, etc.); domain modules only remove the monolith.
 */
const READING_KIND_HANDLERS = {
    ...require('./eventPublisherReadingsAircon'),
    ...require('./eventPublisherReadingsSecurity'),
    ...require('./eventPublisherReadingsSensors')
};

/**
 * Dispatch table for publishEvent after shared classification/setup:
 * kind → handler(ep, ctx). Handlers keep the historical publish semantics;
 * the table only removes the if/else chain among trigger / hvac / tilt / status.
 */
const EVENT_KIND_HANDLERS = {
    trigger(ep, ctx) {
        const eventPayload = ctx.rawLevel !== null
            ? JSON.stringify({ event_type: 'trigger', level: ctx.rawLevel })
            : JSON.stringify({ event_type: 'trigger' });

        if (ep.logger.isLevelEnabled && ep.logger.isLevelEnabled('debug')) {
            ep.logger.debug(
                `C-Bus Trigger ${ctx.source}: ${ctx.network}/${ctx.application}/${ctx.group}`
                + (ctx.rawLevel !== null ? ` level=${ctx.rawLevel}` : '')
            );
        }

        ep._publishIfNeeded(
            ctx.topics.event,
            eventPayload,
            ep._triggerMqttOptions
        );
    },

    hvac(ep, ctx) {
        ep._publishHvacEvent(
            ctx.network,
            ctx.application,
            ctx.group,
            ctx.rawLevel,
            ctx.action,
            ctx.source
        );
    },

    tilt(ep, ctx) {
        // Same 0-100 rounding as levelPercent (HA integer percent).
        if (ep.logger.isLevelEnabled && ep.logger.isLevelEnabled('debug')) {
            ep.logger.debug(
                `C-Bus Tilt ${ctx.source}: ${ctx.network}/${ctx.application}/${ctx.group} ${ctx.levelPercent}%`
            );
        }

        ep._publishIfNeeded(
            `${MQTT_TOPIC_PREFIX_READ}/${ctx.network}/${ctx.application}/${ctx.group}/${MQTT_TOPIC_SUFFIX_TILT}`,
            ctx.levelPercent.toString(),
            ep.mqttOptions
        );
    },

    // Lighting, cover, and PIR: state always; level/position unless PIR.
    status(ep, ctx) {
        if (ep.logger.isLevelEnabled && ep.logger.isLevelEnabled('debug')) {
            ep.logger.debug(
                `C-Bus Status ${ctx.source}: ${ctx.network}/${ctx.application}/${ctx.group} ${ctx.state}`
                + (ctx.isPirSensor ? '' : ` (${ctx.levelPercent}%)`)
            );
        }

        ep._publishIfNeeded(
            ctx.topics.state,
            ctx.state,
            ep.mqttOptions
        );

        if (!ctx.isPirSensor) {
            ep._publishIfNeeded(
                ctx.topics.level,
                ctx.levelPercent.toString(),
                ep.mqttOptions
            );

            // Position mirrors level on a separate topic for the HA cover entity.
            if (ctx.isCover) {
                ep._publishIfNeeded(
                    ctx.topics.position,
                    ctx.levelPercent.toString(),
                    ep.mqttOptions
                );
            }
        }
    }
};

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
     * @param {Function} [options.onEventLog] - Optional callback receiving event-log entries for live streaming (SSE)
     */
    constructor(options) {
        this.settings = options.settings;
        this.publishFn = options.publishFn;
        this.mqttOptions = options.mqttOptions;
        // Trigger events must never be retained; prebuilt once (mqtt.js does
        // not mutate the options object) instead of spread per publish.
        this._triggerMqttOptions = Object.freeze({ ...this.mqttOptions, retain: false });
        this.labelLoader = options.labelLoader || null;
        this.coverRampTracker = options.coverRampTracker || null;
        this.onEventLog = options.onEventLog || null;
        this.eventPublishDedupWindowMs = resolveClampedSetting(this.settings, 'eventPublishDedupWindowMs', { min: 0 });
        this.eventPublishDedupMaxEntries = resolveClampedSetting(this.settings, 'eventPublishDedupMaxEntries', { min: 100 });
        this.topicCacheMaxEntries = resolveClampedSetting(this.settings, 'topicCacheMaxEntries', { min: 100 });
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
            level: resolveLogLevelFromSettings(this.settings),
            enabled: true 
        });
    }

    /**
     * Publishes a C-Bus event to MQTT topics for Home Assistant and other consumers.
     * 
     * Publishes directly to MQTT without throttling -- QoS 0 publishes are
     * near-instant TCP buffer writes handled asynchronously by the mqtt library.
     * 
     * @param {import('./cbusEvent')} event - Parsed C-Bus event to publish
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

        // Specialised application decoders (e.g. Temperature Broadcast, app 25)
        // attach a structured reading to the event. Publish it to the dedicated
        // reading topic and skip the lighting/state path entirely.
        const reading = /** @type {{kind?: string}|null} */ (event.getReading && event.getReading());
        if (reading) {
            if (this.logger.isLevelEnabled && this.logger.isLevelEnabled('debug')) {
                this.logger.debug(`C-Bus Reading ${source}: ${network}/${application}/${group} ${reading.kind}`);
            }
            this.publishReading(network, application, group, reading);
            return;
        }

        const topics = this._getTopicsForAddress(network, application, group);

        // The event's origin unit (#sourceunit metadata) — which C-Bus unit
        // changed the group. Lets automations react to physical switch presses
        // and distinguish them from bridge/CNI-originated writes (issue #35).
        const sourceUnit = event.getSourceUnit && event.getSourceUnit();
        if (sourceUnit !== null && sourceUnit !== undefined) {
            this._publishIfNeeded(
                `${MQTT_TOPIC_PREFIX_READ}/${network}/${application}/${group}/${MQTT_TOPIC_SUFFIX_SOURCE_UNIT}`,
                sourceUnit,
                this.mqttOptions
            );
        }
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
            // PIR: ON/OFF from action (motion detected/cleared), not level.
            state = actionIsOn ? MQTT_STATE_ON : MQTT_STATE_OFF;
        } else {
            // Covers and lighting: state from raw level, not quantized percent —
            // rawLevel 1-2 rounds to 0% but the device IS on/open.
            state = rawLevel !== null
                ? ((rawLevel > 0) ? MQTT_STATE_ON : MQTT_STATE_OFF)
                : (actionIsOn ? MQTT_STATE_ON : MQTT_STATE_OFF);
        }
       
        // Emit event log entry for live event stream (before any early returns)
        if (this.onEventLog) {
            const logAction = event.getAction();
            let eventType = 'update';
            if (logAction === 'ramp') eventType = 'ramp';
            else if (logAction === 'on') eventType = 'on';
            else if (logAction === 'off') eventType = 'off';
            this.onEventLog({
                ts: Date.now(),
                network: network,
                app: application,
                group: group,
                level: rawLevel !== null ? rawLevel : (actionIsOn ? 255 : 0),
                type: eventType
            });
        }

        const kind = isTrigger ? 'trigger'
            : isHvac ? 'hvac'
                : isTiltApp ? 'tilt'
                    : 'status';
        EVENT_KIND_HANDLERS[kind](this, {
            network,
            application,
            group,
            action,
            rawLevel,
            actionIsOn,
            source,
            topics,
            isPirSensor,
            isCover,
            state,
            levelPercent
        });
    }

    /**
     * Publishes a structured reading produced by a specialised application
     * decoder (e.g. Air Conditioning). Routes by reading.kind:
     *
     *   temperature → cbus/read/{net}/{app}/{group}/current_temperature (if celsius non-null)
     *               → cbus/read/{net}/{app}/{group}/sensor_status + sensor_problem (if decoded)
     *   mode        → cbus/read/{net}/{app}/{group}/mode  (if mode non-null)
     *               → cbus/read/{net}/{app}/{group}/setpoint (if setpoint non-null)
     *               → cbus/read/{net}/{app}/{group}/fan_mode + fan_speed (if aux level decoded)
     *   state       → cbus/read/{net}/{app}/{group}/state  ('ON'|'OFF')
     *   action      → cbus/read/{net}/{app}/{group}/action + problem
     *               → cbus/read/{net}/{app}/{group}/error + error_description (if error code decoded)
     *               → cbus/read/{net}/{app}/{group}/damper|busy|expansion (§25.6.6 bits, if decoded)
     *               → cbus/read/{net}/{app}/{group}/plant_type + plant_type_description (§25.6.4)
     *   humidity       → cbus/read/{net}/{app}/{group}/current_humidity (if non-null)
     *   humidity_mode  → cbus/read/{net}/{app}/{group}/humidity_mode + humidity_setpoint
     *   humidity_action → cbus/read/{net}/{app}/{group}/humidity_action
     *   security_zone  → cbus/read/{net}/{app}/{zone}/state (ON for unsealed/open/short)
     *                  → cbus/read/{net}/{app}/{zone}/attributes (raw 2-bit state
     *                    name, plus `isolated` while the panel has the zone bypassed)
     *   security_bypassed_zones → cbus/read/{net}/{app}/panel/bypassed_zones/state
     *                  → .../attributes (`zones` ids and `names` for dashboards)
     *   measurement    → cbus/read/{net}/{app}/{device}/{channel}/value (decoded number)
     *                  → cbus/read/{net}/{app}/{device}/{channel}/unit (unit string, '' if none)
     *   clock          → cbus/read/{net}/{app}/clock/date ('YYYY-MM-DD') or
     *                    cbus/read/{net}/{app}/clock/time ('HH:MM:SS'), whichever
     *                    the broadcast carried — the two arrive separately
     */
    publishReading(network, application, group, reading) {
        if (!reading) return;

        const base = `${MQTT_TOPIC_PREFIX_READ}/${network}/${application}/${group}`;
        const handler = READING_KIND_HANDLERS[reading.kind];
        if (handler) {
            handler(this, base, reading);
        }
    }

    /**
     * Publish a decoded boolean flag as an ON/OFF binary state, or publish
     * nothing at all when the decoder didn't produce the field.
     *
     * The absent case matters: the flag topics are retained, so emitting OFF for
     * a field a reading never carried would assert "this is off" about something
     * we simply don't know, and would then stick in the broker.
     *
     * @param {*} value - Decoded flag; only true/false publish.
     * @param {string} topic - Full topic to publish to.
     * @private
     */
    _publishBooleanIfPresent(value, topic) {
        if (value === null || value === undefined) return;
        this._publishIfNeeded(topic, value ? MQTT_STATE_ON : MQTT_STATE_OFF, this.mqttOptions);
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
            // HVAC-via-lighting temperature encoding: level / 2 across a
            // 0-50C range at 0.5C resolution (level 0 = 0.0C, 100 = 50.0C).
            const tempCelsius = cbusLevelToTemperature(rawLevel);
            const tempStr = tempCelsius.toFixed(1);

            if (this.logger.isLevelEnabled && this.logger.isLevelEnabled('debug')) {
                this.logger.debug(`C-Bus HVAC ${source}: ${network}/${application}/${group} level=${rawLevel} temp=${tempStr}°C`);
            }

            this._publishIfNeeded(
                `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_CURRENT_TEMP}`,
                tempStr,
                this.mqttOptions
            );

            // Same value — C-Bus level represents the controlled setpoint.
            this._publishIfNeeded(
                `${readBase}/${MQTT_TOPIC_SUFFIX_HVAC_SETPOINT}`,
                tempStr,
                this.mqttOptions
            );
        }

        // Publish mode based on action only. C-Gate sends explicit 'off' action when
        // the HVAC unit is turned off. rawLevel=0 is NOT used because it maps to 0°C
        // setpoint, which is a valid (if unusual) temperature, not an off state.
        // off/auto is all this path can ever report, which is why discovery advertises
        // only those two — see _createHvacDiscovery. Anything richer needs the native
        // Air Conditioning application (cbus_aircon_app_id).
        // TODO: Hardware validation — real HVAC units may report heat/cool/fan_only via
        // dedicated group addresses or extended C-Gate event fields not yet handled here.
        const mode = (action === 'off') ? 'off' : 'auto';
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
            evictOldestFifo(this._topicCache);
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
            const oldestKey = evictOldestFifo(this._recentPublishes);
            if (oldestKey === undefined) break;
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
