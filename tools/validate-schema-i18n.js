#!/usr/bin/env node
'use strict';

/**
 * CI guard cross-checking homeassistant-addon/config.yaml against the English
 * translations (translations/en.yaml).
 *
 * Every option in the add-on `schema` must have a matching entry under the
 * `configuration` section of en.yaml (so the HA config UI shows a translated
 * name/description), and en.yaml must not describe options that no longer
 * exist in the schema. validate-translations.js then guarantees the other 16
 * languages match en.yaml, so this single check keeps the whole i18n set in
 * sync with the actual configuration surface.
 */

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const CONFIG_PATH = path.join(__dirname, '..', 'homeassistant-addon', 'config.yaml');
const EN_PATH = path.join(__dirname, '..', 'homeassistant-addon', 'translations', 'en.yaml');

// Returns { missing, extra } comparing schema keys to en.yaml configuration keys.
function diffSchemaAgainstTranslations(config, enDoc) {
    const schemaKeys = new Set(Object.keys((config && config.schema) || {}));
    const translationKeys = new Set(Object.keys((enDoc && enDoc.configuration) || {}));

    return {
        missing: [...schemaKeys].filter((k) => !translationKeys.has(k)),
        extra: [...translationKeys].filter((k) => !schemaKeys.has(k))
    };
}

function main() {
    const config = YAML.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const enDoc = YAML.parse(fs.readFileSync(EN_PATH, 'utf8'));

    const { missing, extra } = diffSchemaAgainstTranslations(config, enDoc);

    if (missing.length || extra.length) {
        console.error('config.yaml <-> translations/en.yaml parity FAILED:\n');
        if (missing.length) {
            console.error(`  Schema options missing a translation entry (${missing.length}):`);
            for (const k of missing) {
                console.error(`    - ${k}`);
            }
        }
        if (extra.length) {
            console.error(`  Translation entries with no schema option (${extra.length}):`);
            for (const k of extra) {
                console.error(`    - ${k}`);
            }
        }
        console.error('\nAdd/remove entries under "configuration" in translations/en.yaml to match config.yaml schema.');
        process.exit(1);
    }

    console.log(
        `Schema/i18n parity OK: ${Object.keys(config.schema || {}).length} schema options ` +
        'all have en.yaml translations.'
    );
}

if (require.main === module) {
    main();
}

module.exports = { diffSchemaAgainstTranslations };
