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
    HA_ORIGIN_SUPPORT_URL
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

module.exports = { buildOriginBlock, buildDeviceBlock };
