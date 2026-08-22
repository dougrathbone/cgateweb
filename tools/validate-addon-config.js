#!/usr/bin/env node
'use strict';

/**
 * CI guard for homeassistant-addon/config.yaml.
 *
 * Enforces the upgrade-safety rules documented in CLAUDE.md
 * ("Home Assistant Add-on config.yaml Rules"):
 *
 *   1. Every non-optional schema field (a type that does NOT end in "?") must
 *      have a default in `options`. HA Supervisor validates that all
 *      non-optional schema fields exist in the user's saved config; a field
 *      missing from `options` causes "Missing option" errors when users with
 *      an older saved config upgrade.
 *   2. Array and object-list schemas cannot be optional, so they must always
 *      appear in `options`.
 *   3. Every key in `options` must have a matching `schema` entry (no orphans).
 *
 * Exits non-zero with a clear message on any violation.
 */

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

// Overridable so the release workflow can re-run this against the RENDERED
// distribution copy, not just the source tree. The rendered file is what
// users install, and it is the one the version rewrite touches.
const ADDON_DIR = process.env.CGATEWEB_ADDON_DIR
    || path.join(__dirname, '..', 'homeassistant-addon');
const CONFIG_PATH = path.join(ADDON_DIR, 'config.yaml');

// Only scalar string schema types can be optional, marked by a trailing "?".
function isOptional(schemaValue) {
    return typeof schemaValue === 'string' && schemaValue.trim().endsWith('?');
}

// Returns an array of human-readable violation strings (empty when valid).
function validateAddonConfig(config) {
    const schema = config.schema || {};
    const options = config.options || {};
    const optionKeys = new Set(Object.keys(options));
    const schemaKeys = new Set(Object.keys(schema));

    const errors = [];

    // Rules 1 + 2: required schema fields must be present in options.
    for (const [key, value] of Object.entries(schema)) {
        if (!isOptional(value) && !optionKeys.has(key)) {
            const kind = Array.isArray(value) ? 'an array/object-list' : 'a required scalar';
            errors.push(
                `schema."${key}" is ${kind} field but has no default in options. ` +
                'Users upgrading from an older saved config will get a "Missing option" ' +
                `validation error. Add "${key}" to options.`
            );
        }
    }

    // Rule 3: no orphan options without a schema entry.
    for (const key of optionKeys) {
        if (!schemaKeys.has(key)) {
            errors.push(`options."${key}" has no matching schema entry. Remove it or add it to schema.`);
        }
    }

    return errors;
}

function main() {
    const config = YAML.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const schema = config.schema || {};
    const options = config.options || {};
    const errors = validateAddonConfig(config);

    if (errors.length > 0) {
        console.error('config.yaml validation FAILED:\n');
        for (const e of errors) {
            console.error(`  - ${e}`);
        }
        console.error('\nSee the "Home Assistant Add-on config.yaml Rules" section in CLAUDE.md.');
        process.exit(1);
    }

    console.log(
        `config.yaml OK: ${Object.keys(schema).length} schema fields, ` +
        `${Object.keys(options).length} option defaults, upgrade-safety rules satisfied.`
    );

    // Supervisor shows a generic puzzle piece without these, and the
    // distribution workflow copies them on every tag — a missing file fails
    // the release after quality has already passed.
    const branding = ['icon.png', 'logo.png'];
    for (const name of branding) {
        const p = path.join(ADDON_DIR, name);
        if (!fs.existsSync(p)) {
            errors.push(`missing ${name} (Home Assistant add-on store branding)`);
        }
    }
    if (errors.length > 0) {
        console.error('add-on branding validation FAILED:\n');
        for (const e of errors) console.error(`  - ${e}`);
        process.exit(1);
    }
    console.log('add-on branding OK: icon.png and logo.png are present.');
}

if (require.main === module) {
    main();
}

module.exports = { isOptional, validateAddonConfig };
