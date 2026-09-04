// @ts-check
const {
    MQTT_TOPIC_PREFIX_READ,
    MQTT_TOPIC_SUFFIX_HVAC_CURRENT_TEMP,
    MQTT_TOPIC_SUFFIX_VALUE,
    HA_COMPONENT_SENSOR,
    HA_DISCOVERY_SUFFIX
} = require('./constants');

// The two halves of the C-Bus network clock, which app 223 broadcasts as
// separate events. Icons only — deliberately no device_class; see
// ensureClockDiscovery for why a timestamp would be dishonest here.
const CLOCK_VARIANTS = [
    { id: 'date', name: 'Clock Date', icon: 'mdi:calendar' },
    { id: 'time', name: 'Clock Time', icon: 'mdi:clock-outline' }
];

/**
 * Static shape for the app-25 temperature sensor. Identity (label, unique id,
 * area, topic) is resolved per call; everything else is fixed by the wire
 * format (byte/4 → °C).
 */
const TEMPERATURE_ENTITY = {
    component: HA_COMPONENT_SENSOR,
    model: 'C-Bus Temperature Sensor',
    fallbackLabel: (networkId, appId, group) => `CBus Temperature ${networkId}/${appId}/${group}`,
    fields: (networkId, appId, group) => ({
        state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/${group}/${MQTT_TOPIC_SUFFIX_HVAC_CURRENT_TEMP}`,
        device_class: 'temperature',
        state_class: 'measurement',
        unit_of_measurement: '°C'
    })
};

/**
 * Measurement (app 228) is heterogeneous: unit/device_class/state_class come
 * from the decoded reading. Only the model and component are fixed here.
 */
const MEASUREMENT_ENTITY = {
    component: HA_COMPONENT_SENSOR,
    model: 'C-Bus Measurement Sensor',
    fallbackLabel: (networkId, appId, device, channel) =>
        `CBus Measurement ${networkId}/${appId}/${device}/${channel}`,
    fields: (networkId, appId, device, channel, reading) => ({
        state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/${device}/${channel}/${MQTT_TOPIC_SUFFIX_VALUE}`,
        // From the reading, not hardcoded: Home Assistant rejects
        // device_class 'energy' paired with state_class 'measurement', so
        // Wh readings carry 'total_increasing' instead (see UNIT_TABLE).
        state_class: (reading && reading.stateClass) || 'measurement',
        ...(reading && reading.deviceClass ? { device_class: reading.deviceClass } : {}),
        ...(reading && reading.unit ? { unit_of_measurement: reading.unit } : {})
    })
};

class _HaDiscoveryPublishersSensors {
    // Host-provided instance state. This class is never instantiated: its
    // prototype methods are copied onto HaDiscovery (see the Object.assign in
    // haDiscovery.js), which supplies every member declared below. The field
    // declarations exist purely so @ts-check can resolve them; they never run.

    /** @type {ReturnType<typeof import('./logger').createLogger>} */
    logger;

    /** @type {Object} */
    settings;

    /** @type {(topic: string, payload: string, options: Object) => void} */
    _publish;

    /** @type {Set<string>} */
    exclude;

    /** @type {Set<string>} */
    _temperatureSeen;

    /** @type {Set<string>} */
    _measurementSeen;

    // Unlike its siblings this one is not constructed in haDiscovery.js — the
    // clock path initialises it on first use, so it stays self-contained.
    /** @type {Set<string>|undefined} */
    _clockSeen;

    /**
     * Shared skeleton for event-driven ensure*Discovery (implemented in
     * haDiscoveryPublishers).
     * @type {(spec: Object) => boolean}
     */
    _ensureEventDrivenEntity;

    /**
     * @type {(spec: Object) => void}
     */
    _finishEventDrivenEntity;

    /**
     * @type {(topic: string) => void}
     */
    _retractEventDrivenConfig;

    /**
     * @type {(spec: Object) => { finalLabel: string, uniqueId: string, entityId: string|undefined, area: string|undefined, discoveryTopic: string }}
     */
    _resolveEntityIdentity;

    /**
     * Event-driven discovery for the C-Bus Clock and Timekeeping (app 223)
     * network clock. Announces two diagnostic sensors — the network's date and
     * its time — the first time clock traffic is decoded on a network.
     *
     * WHY NO device_class: 'timestamp'
     * --------------------------------
     * It would not be honest. Home Assistant's timestamp device_class requires
     * a full ISO 8601 datetime WITH a UTC offset, and the bus gives us neither
     * half of that: date and time arrive as two separate broadcasts, and
     * neither carries a timezone. Producing one timestamp would mean joining
     * two independent events and assuming the C-Bus network runs in the bridge
     * host's timezone.
     *
     * Worse, it would defeat the point. The reason to surface a network clock
     * at all is to notice when it has DRIFTED — and a timestamp entity is
     * normalised to UTC and rendered as relative time ("2 hours ago"), which
     * launders a wrong clock into a plausible-looking instant. Two plain string
     * sensors show exactly what the panel said, which is the diagnostic.
     *
     * Both sensors sit on the existing "C-Bus Network {n}" device alongside the
     * CNI connectivity sensor: the clock is a property of the network, not of a
     * separate piece of hardware. entity_category 'diagnostic' keeps them off
     * auto-generated dashboards.
     *
     * @param {string|number} network
     * @param {string|number} appId - clock app id (223)
     * @returns {boolean} true if the entities were published this call
     */
    ensureClockDiscovery(network, appId) {
        if (!this.settings.ha_discovery_enabled) return false;
        if (network === null || network === undefined || appId === null || appId === undefined) return false;

        // Initialised lazily: the sibling Seen sets are constructed in
        // haDiscovery.js, and this keeps the clock path self-contained.
        if (!this._clockSeen) this._clockSeen = new Set();

        const key = `${network}/${appId}/clock`;
        return this._ensureEventDrivenEntity({
            key,
            seen: this._clockSeen,
            describe: `network clock ${network}/${appId}`,
            retract: () => {
                for (const variant of CLOCK_VARIANTS) {
                    this._retractEventDrivenConfig(
                        this._clockTopic(this._clockUniqueId(String(network), String(appId), variant.id))
                    );
                }
            },
            create: () => this._createClockDiscovery(String(network), String(appId))
        });
    }

    /**
     * unique_id for one half of the network clock. The discovery topic embeds
     * this, so both must come from here or a retraction would target a topic HA
     * never saw and orphan the entity.
     *
     * @param {string} networkId
     * @param {string} appId
     * @param {string} variantId - 'date' or 'time'
     * @returns {string}
     * @private
     */
    _clockUniqueId(networkId, appId, variantId) {
        return `cgateweb_${networkId}_${appId}_clock_${variantId}`;
    }

    /**
     * @param {string} uniqueId
     * @returns {string}
     * @private
     */
    _clockTopic(uniqueId) {
        return `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_SENSOR}/${uniqueId}/${HA_DISCOVERY_SUFFIX}`;
    }

    /**
     * Build and publish the two network-clock sensor payloads. State comes from
     * the clock decoder via cbus/read/{net}/{app}/clock/date and .../time.
     *
     * @private
     */
    _createClockDiscovery(networkId, appId) {
        for (const variant of CLOCK_VARIANTS) {
            const uniqueId = this._clockUniqueId(networkId, appId, variant.id);
            this._finishEventDrivenEntity({
                discoveryTopic: this._clockTopic(uniqueId),
                uniqueId,
                component: HA_COMPONENT_SENSOR,
                // Two entities on the shared network device, so each needs its
                // own name rather than inheriting the device's.
                name: variant.name,
                fields: {
                    state_topic: `${MQTT_TOPIC_PREFIX_READ}/${networkId}/${appId}/clock/${variant.id}`,
                    // No device_class and no unit_of_measurement, deliberately —
                    // see the note on ensureClockDiscovery.
                    entity_category: 'diagnostic',
                    icon: variant.icon
                },
                deviceIdentifiers: [`cgateweb_network_${networkId}`],
                deviceName: `C-Bus Network ${networkId}`,
                model: 'C-Bus Network Interface'
            });
        }
        this.logger.info(`Network clock sensors published: ${networkId}/${appId}`);
    }

    /**
     * Event-driven discovery for C-Bus Temperature Broadcast (app 25) sensors.
     * Called whenever a temperature reading is published for a group; announces
     * the HA temperature sensor the first time that group is seen. Like the
     * native aircon path, groups announce themselves on the bus — only sensors
     * that actually broadcast get an entity.
     *
     * @param {string|number} network
     * @param {string|number} appId  - temperature app id (e.g. 25)
     * @param {string|number} group  - temperature group address
     * @returns {boolean} true if a new sensor entity was published this call
     */
    ensureTemperatureDiscovery(network, appId, group) {
        if (!this.settings.ha_discovery_enabled) return false;
        if (network === null || network === undefined || appId === null || appId === undefined || group === null || group === undefined) return false;

        const key = `${network}/${appId}/${group}`;
        return this._ensureEventDrivenEntity({
            key,
            seen: this._temperatureSeen,
            describe: `temperature group ${key}`,
            retract: () => this._retractEventDrivenConfig(
                `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_SENSOR}/cgateweb_${network}_${appId}_${group}/${HA_DISCOVERY_SUFFIX}`
            ),
            create: () => this._createTemperatureDiscovery(String(network), String(appId), String(group))
        });
    }

    /**
     * Build and publish the temperature sensor discovery payload for one group.
     * @private
     */
    _createTemperatureDiscovery(networkId, appId, group) {
        const labelKey = `${networkId}/${appId}/${group}`;
        const { finalLabel, uniqueId, entityId, area, discoveryTopic } = this._resolveEntityIdentity({
            networkId, appId, groupId: group, labelKey,
            component: TEMPERATURE_ENTITY.component,
            fallbackLabel: TEMPERATURE_ENTITY.fallbackLabel(networkId, appId, group)
        });

        this._finishEventDrivenEntity({
            discoveryTopic, uniqueId, entityId,
            component: TEMPERATURE_ENTITY.component,
            fields: TEMPERATURE_ENTITY.fields(networkId, appId, group),
            deviceIdentifiers: [uniqueId],
            deviceName: finalLabel,
            model: TEMPERATURE_ENTITY.model,
            area,
            logInfo: `Temperature sensor entity published: ${labelKey} (${finalLabel})`
        });
    }

    /**
     * Event-driven discovery for C-Bus Measurement (app 228) channels. Called
     * whenever a measurement reading is decoded; announces the HA sensor the
     * first time that device/channel is seen. Unlike Temperature (always °C),
     * Measurement covers heterogeneous quantities, so unit/device_class come
     * from the decoded reading rather than being fixed.
     *
     * @param {string|number} network
     * @param {string|number} appId - measurement app id (e.g. 228)
     * @param {string|number} device
     * @param {string|number} channel
     * @param {{unit: string|null, deviceClass: string|null}} reading - decoded measurementDecoder reading
     * @returns {boolean} true if a new sensor entity was published this call
     */
    ensureMeasurementDiscovery(network, appId, device, channel, reading) {
        if (!this.settings.ha_discovery_enabled) return false;
        if (network === null || network === undefined || appId === null || appId === undefined
            || device === null || device === undefined || channel === null || channel === undefined) return false;

        const key = `${network}/${appId}/${device}/${channel}`;
        return this._ensureEventDrivenEntity({
            key,
            seen: this._measurementSeen,
            describe: `measurement channel ${key}`,
            retract: () => this._retractEventDrivenConfig(
                `${this.settings.ha_discovery_prefix}/${HA_COMPONENT_SENSOR}/cgateweb_${network}_${appId}_${device}_${channel}/${HA_DISCOVERY_SUFFIX}`
            ),
            create: () => this._createMeasurementDiscovery(String(network), String(appId), String(device), String(channel), reading)
        });
    }

    /**
     * Build and publish the measurement sensor discovery payload for one
     * device/channel. State comes from the measurementDecoder reading topic
     * (cbus/read/{net}/{app}/{device}/{channel}/value).
     *
     * @private
     */
    _createMeasurementDiscovery(networkId, appId, device, channel, reading) {
        const groupId = `${device}_${channel}`;
        const labelKey = `${networkId}/${appId}/${device}/${channel}`;
        const { finalLabel, uniqueId, entityId, area, discoveryTopic } = this._resolveEntityIdentity({
            networkId, appId, groupId, labelKey,
            component: MEASUREMENT_ENTITY.component,
            fallbackLabel: MEASUREMENT_ENTITY.fallbackLabel(networkId, appId, device, channel)
        });

        this._finishEventDrivenEntity({
            discoveryTopic, uniqueId, entityId,
            component: MEASUREMENT_ENTITY.component,
            fields: MEASUREMENT_ENTITY.fields(networkId, appId, device, channel, reading),
            deviceIdentifiers: [uniqueId],
            deviceName: finalLabel,
            model: MEASUREMENT_ENTITY.model,
            area,
            logInfo: `Measurement sensor entity published: ${labelKey} (${finalLabel})`
        });
    }
}

const methods = {};
for (const name of Object.getOwnPropertyNames(_HaDiscoveryPublishersSensors.prototype)) {
    if (name === 'constructor') continue;
    methods[name] = _HaDiscoveryPublishersSensors.prototype[name];
}
module.exports = methods;
