// @ts-check
'use strict';

/**
 * Command builders for the C-Bus Scene Module (C-Gate SCENE PLAY|RECORD).
 *
 * C-Gate documents `SCENE PLAY|RECORD <set> <scene>` with no network path in
 * the command snippet. Record overwrites module memory, so the MQTT path is
 * gated behind cbus_scene_module_enabled.
 *
 * @param {Object} opts
 * @param {string|number} opts.set - Scene set number
 * @param {string|number} opts.scene - Scene number within the set
 * @returns {string}
 */
function buildScenePlayCommand({ set, scene }) {
    return `scene play ${set} ${scene}`;
}

/**
 * @param {Object} opts
 * @param {string|number} opts.set
 * @param {string|number} opts.scene
 * @returns {string}
 */
function buildSceneRecordCommand({ set, scene }) {
    return `scene record ${set} ${scene}`;
}

module.exports = { buildScenePlayCommand, buildSceneRecordCommand };
