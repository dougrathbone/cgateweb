// @ts-check
/**
 * Default settings for the cgateweb bridge.
 * These can be overridden by user settings in settings.js
 *
 * The values themselves — and the reasoning behind each one — now live in
 * `src/config/schema.js`, the single declarative source of truth for runtime
 * settings. This module simply materialises that schema into the plain object
 * the rest of the codebase spreads over user settings, so the exported shape
 * is unchanged: same keys, same values, same types.
 *
 * To add, remove or change a setting, edit the schema, not this file.
 */
const { buildDefaults } = require('./config/schema');

const defaultSettings = buildDefaults();

module.exports = { defaultSettings };
