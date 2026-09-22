// @ts-check
'use strict';

/**
 * Pure builders for the repeated fragments of Home Assistant MQTT Discovery
 * payloads. Every discovery entity (light, cover, switch, climate, button,
 * scene, ...) embeds the same `device` and `origin` objects; keeping them in
 * one place stops the per-entity builders in haDiscovery.js from drifting and
 * shrinks that module. These functions are side-effect free.
 */

const {
    HA_DEVICE_VIA,
    HA_DEVICE_MANUFACTURER,
    HA_ORIGIN_NAME,
    HA_ORIGIN_SW_VERSION,
    HA_ORIGIN_SUPPORT_URL,
    MQTT_TOPIC_STATUS,
    MQTT_PAYLOAD_STATUS_ONLINE,
    MQTT_PAYLOAD_STATUS_OFFLINE,
    entityIdFields
} = require('./constants');

/**
 * The HA discovery `origin` block identifying cgateweb as the source
 * integration. Identical for every entity.
 * @returns {{name: string, sw_version: string, support_url: string}}
 */
function buildOriginBlock() {
    return {
        name: HA_ORIGIN_NAME,
        sw_version: HA_ORIGIN_SW_VERSION,
        support_url: HA_ORIGIN_SUPPORT_URL
    };
}

/**
 * The HA discovery `device` block. `suggested_area` is only included when an
 * area is provided, matching Home Assistant's expectation that the key is
 * omitted (not null) when unknown.
 * @param {Object} opts
 * @param {string[]} opts.identifiers - Device identifiers array.
 * @param {string} opts.name - Device display name.
 * @param {string} opts.model - Device model string.
 * @param {string} [opts.area] - Optional suggested area.
 * @returns {Object}
 */
function buildDeviceBlock({ identifiers, name, model, area }) {
    return {
        identifiers,
        name,
        manufacturer: HA_DEVICE_MANUFACTURER,
        model,
        via_device: HA_DEVICE_VIA,
        ...(area && { suggested_area: area })
    };
}

/**
 * Shared bridge availability fields for entity and device discovery.
 * @returns {{availability_topic: string, payload_available: string, payload_not_available: string}}
 */
function buildAvailabilityBlock() {
    return {
        availability_topic: MQTT_TOPIC_STATUS,
        payload_available: MQTT_PAYLOAD_STATUS_ONLINE,
        payload_not_available: MQTT_PAYLOAD_STATUS_OFFLINE
    };
}

/**
 * Component entry used inside a device-discovery `components` map.
 * @param {Object} spec
 * @returns {Object}
 */
function buildComponentDiscoveryPayload(spec) {
    return {
        platform: spec.component,
        name: spec.name,
        unique_id: spec.uniqueId,
        ...(spec.entityId && entityIdFields(spec.component, spec.entityId)),
        ...spec.fields
    };
}

/**
 * Standalone entity-discovery payload used before and during migration.
 * @param {Object} spec
 * @param {Object} device
 * @returns {Object}
 */
function buildStandaloneDiscoveryPayload(spec, device) {
    const { platform: _platform, ...component } = buildComponentDiscoveryPayload(spec);
    return {
        ...component,
        qos: 0,
        ...buildAvailabilityBlock(),
        device,
        origin: buildOriginBlock()
    };
}

module.exports = {
    buildOriginBlock,
    buildDeviceBlock,
    buildAvailabilityBlock,
    buildComponentDiscoveryPayload,
    buildStandaloneDiscoveryPayload
};
